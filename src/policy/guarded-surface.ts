// GuardedSurface wraps any Surface so that no code path reaches act() without
// holding the control lease and passing the policy gate. Discovery, replay and the operator console all hold
// a GuardedSurface, never the raw one.

import type { Policy } from '../schema/policy.js';
import type { TargetSpec } from '../schema/target.js';
import type { Risk } from '../schema/values.js';
import type {
  ActResult,
  Action,
  Actor,
  Observation,
  ObserveOptions,
  Resolution,
  ResolveOptions,
  Surface,
} from '../surface/types.js';
import { ControlLease } from '../session/lease.js';
import { checkAction, type GateDecision, type GateRequest, type Mode } from './gate.js';

export interface RunPolicyContext {
  mode: Mode;
  artifactApproved?: boolean;
  callerConfirmedIrreversible?: boolean;
}

/** Per-action facts only the caller knows. */
export interface StepPolicyContext {
  declaredRisk?: Risk;
  humanApproved?: boolean;
}

export class PolicyBlockedError extends Error {
  constructor(readonly decision: Extract<GateDecision, { verdict: 'block' }>) {
    super(`policy blocked (${decision.rule}): ${decision.reason}`);
    this.name = 'PolicyBlockedError';
  }
}

export class ApprovalRequiredError extends Error {
  constructor(readonly decision: Extract<GateDecision, { verdict: 'needs_approval' }>) {
    super(decision.reason);
    this.name = 'ApprovalRequiredError';
  }
}

export type DecisionListener = (req: GateRequest, decision: GateDecision) => void;

export class GuardedSurface implements Surface {
  readonly kind;
  /** Who may act on this session right now. Checked before the policy gate. */
  readonly lease = new ControlLease('automation');
  private last: Observation | undefined;

  constructor(
    readonly inner: Surface,
    readonly policy: Policy,
    private readonly run: RunPolicyContext,
    private readonly onDecision: DecisionListener = () => undefined,
  ) {
    this.kind = inner.kind;
  }

  async observe(options?: ObserveOptions): Promise<Observation> {
    this.last = await this.inner.observe(options);
    return this.last;
  }

  async resolve(target: TargetSpec, options?: ResolveOptions): Promise<Resolution> {
    return this.inner.resolve(target, {
      ...options,
      allowVisualFallback:
        (options?.allowVisualFallback ?? false) && this.policy.allowVisualFallback,
    });
  }

  async act(action: Action, actor: Actor, step: StepPolicyContext = {}): Promise<ActResult> {
    this.lease.assertHeld(actor);
    const req = this.buildRequest(action, actor, step);
    const decision = checkAction(this.policy, req);
    this.onDecision(req, decision);
    if (decision.verdict === 'block') throw new PolicyBlockedError(decision);
    if (decision.verdict === 'needs_approval') throw new ApprovalRequiredError(decision);
    return this.inner.act(action, actor);
  }

  /** Dry-run the gate without acting, e.g. to escalate before an irreversible click. */
  check(action: Action, actor: Actor, step: StepPolicyContext = {}): GateDecision {
    return checkAction(this.policy, this.buildRequest(action, actor, step));
  }

  /** The most recent observation taken through this surface. */
  lastObservation(): Observation | undefined {
    return this.last;
  }

  location(): Promise<string> {
    return this.inner.location();
  }

  screenshot(): Promise<Buffer> {
    return this.inner.screenshot();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  setRunContext(patch: Partial<RunPolicyContext>): void {
    Object.assign(this.run, patch);
  }

  private buildRequest(action: Action, actor: Actor, step: StepPolicyContext): GateRequest {
    const element =
      'ref' in action ? this.last?.elements.find((e) => e.ref === action.ref) : undefined;
    const frameUrl = element
      ? this.last?.frames.find((f) => samePath(f.path, element.framePath))?.url
      : undefined;
    return {
      ...this.run,
      ...step,
      actor,
      action,
      ...(element ? { element } : {}),
      ...(frameUrl ? { frameUrl } : {}),
    };
  }
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
