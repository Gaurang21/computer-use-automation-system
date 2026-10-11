import type { Policy } from '../schema/policy.js';
import { PlaywrightSurface, type PlaywrightSurfaceOptions } from '../surface/playwright.js';
import { urlBlockedReason } from './gate.js';
import { GuardedSurface, type DecisionListener, type RunPolicyContext } from './guarded-surface.js';

export interface GuardedLaunch {
  surface: GuardedSurface;
  raw: PlaywrightSurface;
}

/**
 * Launches a browser with both layers of enforcement: the action gate
 * (GuardedSurface) and network routing that aborts any request off the
 * allowlist. The second layer catches redirects and anything a click triggers
 * that the gate could not predict.
 */
export async function launchGuardedWeb(
  policy: Policy,
  run: RunPolicyContext,
  hooks: {
    onDecision?: DecisionListener;
    onBlockedRequest?: (url: string, reason: string) => void;
  } = {},
  options: Omit<PlaywrightSurfaceOptions, 'allowRequest' | 'onBlockedRequest'> = {},
): Promise<GuardedLaunch> {
  const raw = await PlaywrightSurface.launch({
    ...options,
    allowRequest: (url) => urlBlockedReason(policy, url) === undefined,
    onBlockedRequest: (url) =>
      hooks.onBlockedRequest?.(url, urlBlockedReason(policy, url) ?? 'blocked'),
  });
  return { raw, surface: new GuardedSurface(raw, policy, run, hooks.onDecision) };
}
