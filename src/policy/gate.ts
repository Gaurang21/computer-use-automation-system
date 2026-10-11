// The policy gate. Every action, in discovery and replay alike, is checked
// here before it reaches the surface. GuardedSurface makes that unavoidable.

import { readFileSync } from 'node:fs';
import type { Policy } from '../schema/policy.js';
import { Policy as PolicySchema } from '../schema/policy.js';
import { maxRisk, type Risk } from '../schema/values.js';
import type { Action, Actor, ObservedElement } from '../surface/types.js';

export type Mode = 'discovery' | 'replay';

export interface GateRequest {
  mode: Mode;
  actor: Actor;
  action: Action;
  /** The element the action targets, as last observed. */
  element?: ObservedElement;
  /** URL of the frame holding the element (or the page, for page-level actions). */
  frameUrl?: string;
  /** Risk the artifact (or the model) declared for this step. */
  declaredRisk?: Risk;
  /** Discovery: a human approved this irreversible step. */
  humanApproved?: boolean;
  /** Replay: the artifact is approved. */
  artifactApproved?: boolean;
  /** Replay: the caller passed --confirm-irreversible. */
  callerConfirmedIrreversible?: boolean;
}

export type GateDecision =
  | { verdict: 'allow'; risk: Risk }
  | { verdict: 'block'; risk: Risk; rule: string; reason: string }
  | { verdict: 'needs_approval'; risk: Risk; reason: string };

export function loadPolicy(path = 'policy/default.policy.json'): Policy {
  return PolicySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function checkAction(policy: Policy, req: GateRequest): GateDecision {
  const { action, actor } = req;

  if (action.type === 'goto') {
    const why = urlBlockedReason(policy, action.url);
    if (why) return { verdict: 'block', risk: 'read', rule: 'allowlist', reason: why };
  }
  // The network allowlist binds the human too; action-level checks do not,
  // because the human is the authority being asked.
  if (actor === 'human') return { verdict: 'allow', risk: 'read' };

  if (!(policy.allowedActions as string[]).includes(action.type)) {
    return {
      verdict: 'block',
      risk: 'read',
      rule: 'action_type',
      reason: `action ${action.type} is not allowed`,
    };
  }
  if (req.frameUrl) {
    const why = urlBlockedReason(policy, req.frameUrl);
    if (why)
      return {
        verdict: 'block',
        risk: 'read',
        rule: 'allowlist',
        reason: `acting on a page outside the allowlist: ${why}`,
      };
  }

  const risk = effectiveRisk(policy, req);
  if (risk !== 'irreversible') return { verdict: 'allow', risk };

  if (req.mode === 'discovery') {
    if (policy.irreversible.discovery === 'block') {
      return {
        verdict: 'block',
        risk,
        rule: 'irreversible',
        reason: 'irreversible actions are blocked in discovery',
      };
    }
    return req.humanApproved
      ? { verdict: 'allow', risk }
      : {
          verdict: 'needs_approval',
          risk,
          reason: `irreversible action "${describe(req)}" needs a human decision`,
        };
  }
  if (policy.irreversible.replay === 'block') {
    return {
      verdict: 'block',
      risk,
      rule: 'irreversible',
      reason: 'irreversible actions are blocked in replay',
    };
  }
  if (!req.artifactApproved) {
    return {
      verdict: 'block',
      risk,
      rule: 'irreversible',
      reason: 'irreversible step in an unapproved artifact',
    };
  }
  if (!req.callerConfirmedIrreversible) {
    return {
      verdict: 'block',
      risk,
      rule: 'irreversible',
      reason: 'irreversible step without caller confirmation (--confirm-irreversible)',
    };
  }
  return { verdict: 'allow', risk };
}

/** Declared risk, raised (never lowered) by the policy's text hints. */
export function effectiveRisk(
  policy: Policy,
  req: Pick<GateRequest, 'action' | 'element' | 'declaredRisk'>,
): Risk {
  const declared = req.declaredRisk ?? 'read';
  if (req.action.type !== 'click' || !req.element) return declared;
  const label = req.element.name || req.element.nearText?.text || '';
  const hinted = policy.riskHints
    .filter((h) => new RegExp(`\\b(${h.textMatches})\\b`, 'i').test(label))
    .map((h) => h.risk);
  return maxRisk(declared, ...hinted);
}

/** Why a URL is outside the allowlist, or undefined when it is allowed. */
export function urlBlockedReason(policy: Policy, url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `not a URL: ${url}`;
  }
  if (parsed.protocol === 'about:' || parsed.protocol === 'data:') return undefined;
  if (!policy.allowedOrigins.includes(parsed.origin))
    return `origin ${parsed.origin} is not allowed`;
  const path = parsed.pathname;
  if (policy.blockedRoutes.some((g) => globMatch(g, path))) return `route ${path} is blocked`;
  if (!policy.allowedRoutes.some((g) => globMatch(g, path)))
    return `route ${path} is not in the allowlist`;
  return undefined;
}

export function globMatch(glob: string, path: string): boolean {
  const re = glob
    .split('**')
    .map((part) => part.split('*').map(escapeRegex).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${re}$`).test(path);
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function describe(req: GateRequest): string {
  return req.element
    ? `${req.action.type} ${req.element.role} "${req.element.name}"`
    : req.action.type;
}
