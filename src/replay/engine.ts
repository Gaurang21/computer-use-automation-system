// Deterministic replay: the production execution path. No model is called.
//
// Replay is a loop of act, then classify. After every action the engine must
// recognise the state it is in (the step's expectation, a business outcome, or
// a known app condition) before it does anything else. An unrecognised state
// is never stepped past: it becomes UNEXPECTED_STATE and goes to escalation.

import { setTimeout as sleep } from 'node:timers/promises';
import { RunLogger } from '../evidence/logger.js';
import { launchGuardedWeb } from '../policy/launch.js';
import { GuardedSurface, PolicyBlockedError } from '../policy/guarded-surface.js';
import { Redactor } from '../policy/redact.js';
import type { Condition } from '../schema/app-profile.js';
import type { Capability, Step, ValueBinding } from '../schema/capability.js';
import { describeMatcher, type StateMatcher } from '../schema/matcher.js';
import type { Policy } from '../schema/policy.js';
import {
  FailureCode as FailureCodeSchema,
  type FailureCode,
  type RunMeta,
  type RunResult,
} from '../schema/result.js';
import type { TargetSpec } from '../schema/target.js';
import { summarizeObservation } from '../surface/describe.js';
import { resolveTarget } from '../surface/resolve.js';
import type { Action, Observation, ObservedElement } from '../surface/types.js';
import { classify, retryAllowed } from './classify.js';
import { isApproved } from './hash.js';
import { matches } from './matcher.js';
import { EnvSecretProvider, type SecretProvider } from './secrets.js';
import {
  CapabilityDisabledError,
  type CapabilityStore,
  type EffectiveCapability,
} from './store.js';
import { parseOutput, toUiText, validateInputs, type TypedValue } from './values.js';
import { versionInRange } from './version.js';

// --- Escalation seam -------------------------------------------------------

export interface StuckContext {
  runId: string;
  capabilityId: string;
  stepId: string | null;
  stepIntent?: string;
  reasonCode: FailureCode | 'IRREVERSIBLE_STEP';
  reason: string;
  expected: string;
  observed: string;
  obs: Observation;
  /** retry/continue are only offered when they are safe. */
  allowed: ('retry' | 'continue' | 'abort' | 'approve' | 'reject')[];
  /** The live session, so a human can take it over. */
  surface: GuardedSurface;
  logger: RunLogger;
  /** Masked screenshot saved in the run folder. */
  screenshotPath?: string;
}

export type HumanResolution =
  | { kind: 'retry' | 'continue' | 'approve'; interventionId: string; note?: string }
  | { kind: 'abort' | 'reject'; interventionId: string; note?: string }
  | { kind: 'timeout'; interventionId: string };

/** How replay asks a person for help. Without one, a stuck run simply fails. */
export interface Escalation {
  request(ctx: StuckContext): Promise<HumanResolution>;
  /** After a handback: whether the automation's resume check passed. */
  resumed?(interventionId: string, ok: boolean): void;
}

// --- Options ---------------------------------------------------------------

export interface ReplayOptions {
  store: CapabilityStore;
  capabilityId: string;
  tenantId: string;
  inputs: Record<string, unknown>;
  policy: Policy;
  evidenceDir?: string;
  allowDraft?: boolean;
  confirmIrreversible?: boolean;
  /** Override the overlay's base URL (tests run tenants on random ports). */
  baseUrl?: string;
  /** Use an existing session instead of launching a browser. */
  surface?: GuardedSurface;
  headless?: boolean;
  secrets?: SecretProvider;
  escalation?: Escalation;
  pollMs?: number;
  /** Called once the run folder exists, before anything happens. */
  onStart?: (info: {
    runId: string;
    dir: string;
    logger: RunLogger;
    surface: GuardedSurface;
  }) => void;
}

type Directive = 'next' | 'retry' | 'restart';

const NAVIGATING: ReadonlySet<Action['type']> = new Set(['click', 'press', 'goto']);
const CHANGE_WAIT_MS = 1500;

interface StopFailure {
  status: 'failure';
  code: FailureCode;
  atStep: string | null;
  expected: string;
  observed: string;
}
interface StopOutcome {
  status: 'business_outcome';
  code: string;
  message: string;
  atStep: string;
}

class StopRun extends Error {
  constructor(readonly stop: StopFailure | StopOutcome) {
    super(stop.code);
  }
}

const RETRYABLE: ReadonlySet<FailureCode> = new Set([
  'UNEXPECTED_STATE',
  'RECOVERY_EXHAUSTED',
  'APP_ERROR',
  'ESCALATION_TIMEOUT',
  'INTERNAL_ERROR',
]);

const STUCK_ESCALATES: ReadonlySet<string> = new Set([
  'UNEXPECTED_STATE',
  'TARGET_NOT_FOUND',
  'TARGET_AMBIGUOUS',
  'RECOVERY_EXHAUSTED',
  'RETRY_UNSAFE',
]);

export async function replay(opts: ReplayOptions): Promise<RunResult> {
  return new ReplayRun(opts).run();
}

class ReplayRun {
  private readonly redactor = new Redactor();
  private readonly startedAt = new Date();
  private readonly poll: number;
  private logger!: RunLogger;
  private surface!: GuardedSurface;
  private ownsSurface = false;
  private main!: EffectiveCapability;
  private secrets!: SecretProvider;
  private inputs: Record<string, TypedValue> = {};
  private outputs: Record<string, TypedValue> = {};
  private attempts = new Map<string, number>();
  private versionChecked = false;
  /** Intervention whose handback has not been confirmed by a passing step yet. */
  private pendingResume: string | undefined;
  private resumeFailures = 0;
  private readonly meta: Omit<RunMeta, 'durationMs'>;

  constructor(private readonly opts: ReplayOptions) {
    this.poll = opts.pollMs ?? 250;
    this.meta = {
      runId: '',
      capabilityId: opts.capabilityId,
      version: '',
      effectiveHash: '',
      tenantId: opts.tenantId,
      startedAt: this.startedAt.toISOString(),
      warnings: [],
      recoveries: [],
      locatorDrift: [],
      humanInterventions: [],
    };
  }

  async run(): Promise<RunResult> {
    this.logger = RunLogger.create(
      this.opts.evidenceDir ?? 'runs',
      'replay',
      this.redactor,
      this.opts.policy.sensitiveLabels,
    );
    this.meta.runId = this.logger.runId;
    let result: RunResult;
    try {
      result = await this.execute();
    } catch (err) {
      result = await this.toResult(err);
    } finally {
      if (this.ownsSurface) await this.surface?.close();
    }
    this.logger.event({ actor: 'system', type: 'result', detail: { result } });
    this.logger.writeJson('result.json', result);
    return result;
  }

  // --- Before the first step ---------------------------------------------

  private async execute(): Promise<RunResult> {
    const { store, capabilityId, tenantId } = this.opts;
    try {
      this.main = store.effective(
        capabilityId,
        tenantId,
        this.opts.baseUrl ? { baseUrl: this.opts.baseUrl } : {},
      );
    } catch (err) {
      if (err instanceof CapabilityDisabledError)
        this.fail('CAPABILITY_DISABLED', null, 'capability enabled for tenant', err.message);
      throw err;
    }
    const cap = this.main.capability;
    this.meta.version = cap.version;
    this.meta.effectiveHash = this.main.effectiveHash;
    this.logger.event({
      actor: 'system',
      type: 'run',
      detail: {
        capability: cap.id,
        version: cap.version,
        effectiveHash: this.main.effectiveHash,
        tenant: tenantId,
        status: cap.status,
        file: this.main.file,
      },
    });

    // 1. Inputs, before the UI is touched.
    const checked = validateInputs(cap.inputs, this.opts.inputs);
    if (!checked.ok) {
      this.fail(
        'INVALID_INPUT',
        null,
        `inputs matching ${JSON.stringify(Object.keys(cap.inputs))}`,
        checked.errors.map((e) => `${e.name}: ${e.problem}`).join('; '),
      );
    }
    this.inputs = checked.values;
    for (const [name, value] of Object.entries(this.inputs)) {
      this.redactor.addKnown(value, cap.inputs[name]?.sensitivity ?? 'pii');
    }

    // 2. Approval.
    const approved = isApproved(cap);
    if (!approved && !this.opts.allowDraft) {
      this.fail(
        'NOT_APPROVED',
        null,
        'an approved capability (or --allow-draft)',
        `status ${cap.status}`,
      );
    }
    if (!approved) this.meta.warnings.push('ran a draft capability (--allow-draft)');

    // 3. Static version check and secrets, still before the UI.
    if (!versionInRange(this.main.overlay.appVersion, cap.app.versions)) {
      this.versionProblem(
        `tenant runs ${this.main.overlay.appVersion}, capability supports ${cap.app.versions}`,
      );
    }
    this.secrets = this.opts.secrets ?? new EnvSecretProvider(this.main.overlay);
    this.checkSecrets();

    // 4. The session.
    if (this.opts.surface) {
      this.surface = this.opts.surface;
      this.surface.setRunContext({
        mode: 'replay',
        artifactApproved: approved,
        callerConfirmedIrreversible: !!this.opts.confirmIrreversible,
      });
    } else {
      const { surface } = await launchGuardedWeb(
        this.opts.policy,
        {
          mode: 'replay',
          artifactApproved: approved,
          callerConfirmedIrreversible: !!this.opts.confirmIrreversible,
        },
        {
          onDecision: (req, d) =>
            this.logger.event({
              actor: req.actor,
              type: 'policy',
              detail: {
                action: req.action.type,
                ...d,
                element: req.element ? `${req.element.role} "${req.element.name}"` : undefined,
              },
            }),
          onBlockedRequest: (url, reason) =>
            this.logger.event({
              actor: 'system',
              type: 'policy',
              detail: { verdict: 'block', network: true, url, reason },
            }),
        },
        { headless: this.opts.headless ?? true },
      );
      this.surface = surface;
      this.ownsSurface = true;
    }
    this.opts.onStart?.({
      runId: this.logger.runId,
      dir: this.logger.dir,
      logger: this.logger,
      surface: this.surface,
    });

    // 5. The flow, preconditions first.
    await this.runFlow(this.main, '');

    // 6. Outputs.
    for (const [name, spec] of Object.entries(cap.outputs)) {
      if (spec.required && this.outputs[name] === undefined) {
        this.fail('OUTPUT_PARSE_ERROR', null, `output ${name}`, 'no step produced it');
      }
    }
    const final = await this.surface.observe({ screenshot: true });
    if (final.screenshot) this.logger.saveScreenshot('final', final.screenshot, final);
    return { status: 'success', outputs: this.outputs, meta: this.finishMeta() };
  }

  private checkSecrets(): void {
    const needed = new Set<string>();
    const collect = (cap: Capability) => {
      for (const s of cap.steps)
        if (s.value && 'from' in s.value && s.value.from.startsWith('secrets.'))
          needed.add(s.value.from.slice(8));
    };
    collect(this.main.capability);
    const related = [
      ...this.main.capability.preconditions.map((p) => p.capability),
      ...this.main.profile.conditions
        .map((c) => c.recover?.runCapability)
        .filter((x): x is string => !!x),
    ];
    for (const id of new Set(related)) collect(this.opts.store.capability(id));
    for (const name of needed) {
      const value = this.secrets.get(name);
      if (value === undefined || value === '') {
        const env = this.main.overlay.secrets[name]?.env ?? '(no mapping in overlay)';
        this.fail('MISSING_SECRET', null, `secret ${name} from ${env}`, 'not set');
      }
      this.redactor.addKnown(value, 'secret');
    }
  }

  private versionProblem(msg: string): void {
    if (this.main.capability.risk === 'read')
      this.meta.warnings.push(`untested app version: ${msg}`);
    else this.fail('APP_VERSION_UNSUPPORTED', null, this.main.capability.app.versions, msg);
  }

  private checkScreenVersion(obs: Observation): void {
    if (this.versionChecked) return;
    this.versionChecked = true;
    const re = new RegExp(this.main.profile.identity.versionPattern);
    const found = obs.elements.map((e) => re.exec(e.name)?.[1]).find((v) => v !== undefined);
    if (!found) {
      this.meta.warnings.push('could not read the app version from the screen');
      return;
    }
    this.meta.appVersion = found;
    if (found !== this.main.overlay.appVersion) {
      this.meta.warnings.push(
        `overlay says ${this.main.overlay.appVersion}, screen shows ${found}`,
      );
    }
    if (!this.main.profile.identity.testedVersions.includes(found))
      this.versionProblem(`version ${found} is not in testedVersions`);
  }

  // --- The flow ------------------------------------------------------------

  private async runFlow(eff: EffectiveCapability, prefix: string): Promise<void> {
    const cap = eff.capability;
    for (const pre of cap.preconditions) {
      const obs = await this.surface.observe();
      if (pre.skipWhen && matches(obs, pre.skipWhen)) {
        this.logger.event({
          actor: 'automation',
          type: 'classify',
          detail: { precondition: pre.capability, skipped: true },
        });
        continue;
      }
      await this.runFlow(this.sub(pre.capability), `${pre.capability}:`);
    }

    const start = async () => {
      if (cap.entry?.path) {
        await this.act(
          { type: 'goto', url: new URL(cap.entry.path, eff.overlay.baseUrl).toString() },
          `${prefix}entry`,
          'read',
        );
      }
      if (cap.entry?.ready) await this.waitFor(cap.entry.ready, `${prefix}entry`, 15_000);
    };

    await start();
    if (!this.versionChecked) this.checkScreenVersion(await this.surface.observe());

    let executed: Step[] = [];
    for (let i = 0; i < cap.steps.length;) {
      const step = cap.steps[i] as Step;
      const directive = await this.runStep(eff, step, executed, prefix);
      if (directive === 'next') {
        this.confirmResume(true);
        executed.push(step);
        i++;
      } else if (directive === 'restart') {
        this.logger.event({
          actor: 'automation',
          type: 'recover',
          stepId: prefix + step.id,
          detail: { restart: cap.id },
        });
        executed = [];
        await start();
        i = 0;
      }
    }

    const ok = await this.waitFor(cap.success, `${prefix}success`, 5000, false);
    if (!ok) {
      const obs = await this.surface.observe();
      this.fail(
        'CHECKPOINT_FAILED',
        `${prefix}success`,
        describeMatcher(cap.success),
        summarizeObservation(obs),
      );
    }
    this.logger.event({
      actor: 'automation',
      type: 'classify',
      stepId: `${prefix}success`,
      detail: { checkpoint: describeMatcher(cap.success), held: true },
    });
  }

  private sub(id: string): EffectiveCapability {
    return this.opts.store.effective(
      id,
      this.opts.tenantId,
      this.opts.baseUrl ? { baseUrl: this.opts.baseUrl } : {},
    );
  }

  // --- One step ------------------------------------------------------------

  private async runStep(
    eff: EffectiveCapability,
    step: Step,
    executed: Step[],
    prefix: string,
  ): Promise<Directive> {
    const stepId = prefix + step.id;
    let element: ObservedElement | undefined;

    if (step.target) {
      const found = await this.waitForTarget(eff, step, executed, prefix);
      if (typeof found === 'string') return found;
      element = found;
    }

    if (step.action === 'read' && element) {
      // The element's text IS the value being read: register it before anything is logged.
      const sensitivity =
        eff.capability.outputs[(step.into ?? '').slice('outputs.'.length)]?.sensitivity ?? 'pii';
      this.redactor.addKnown(element.name, sensitivity);
      if (element.value) this.redactor.addKnown(element.value, sensitivity);
    }
    const action = this.toAction(step, element);
    this.logger.event({
      actor: 'automation',
      type: 'act',
      stepId,
      intent: step.intent,
      detail: {
        action: step.action,
        ...(element
          ? { element: `${element.role} "${element.name}"`, framePath: element.framePath }
          : {}),
        ...(step.value ? { value: describeBinding(step.value) } : {}),
      },
    });
    const result = await this.act(action, stepId, step.risk);

    if (step.action === 'read' && step.into) {
      const name = step.into.slice('outputs.'.length);
      const spec = eff.capability.outputs[name];
      const text = result.value ?? '';
      const parsed = spec ? parseOutput(text, spec) : { ok: true as const, value: text };
      if (!parsed.ok)
        this.fail('OUTPUT_PARSE_ERROR', stepId, `${name} as ${spec?.type}`, parsed.problem);
      else {
        this.outputs[name] = parsed.value;
        this.redactor.addKnown(parsed.value, spec?.sensitivity ?? 'pii');
        this.redactor.addKnown(text, spec?.sensitivity ?? 'pii');
      }
    }

    return this.settle(eff, step, [...executed, step], prefix);
  }

  /** Polls until the target resolves, or the screen is classified as something else. */
  private async waitForTarget(
    eff: EffectiveCapability,
    step: Step,
    executed: Step[],
    prefix: string,
  ): Promise<ObservedElement | Directive> {
    const stepId = prefix + step.id;
    const target = step.target as TargetSpec;
    let deadline = Date.now() + Math.min(step.timeoutMs, 10_000);
    for (;;) {
      const obs = await this.surface.observe();
      const res = resolveTarget(obs.elements, target, {
        allowVisualFallback: this.opts.policy.allowVisualFallback,
      });
      if (res.ok) {
        if (res.locatorIndex > 0) {
          const kind =
            'locators' in target ? (target.locators[res.locatorIndex]?.kind ?? '?') : 'table_cell';
          this.meta.locatorDrift.push({ stepId, usedLocator: res.locatorIndex, kind });
          this.logger.event({
            actor: 'automation',
            type: 'classify',
            stepId,
            detail: { locatorDrift: res.attempts },
          });
        }
        return res.element;
      }
      const c = classify({
        obs,
        stepId: step.id,
        outcomes: eff.capability.outcomes,
        conditions: eff.profile.conditions,
      });
      if (c.kind === 'outcome') this.outcome(c.outcome.code, c.outcome.message, stepId);
      if (c.kind === 'condition') {
        const d = await this.handleCondition(c.condition, step, executed, prefix, obs);
        if (d !== 'continue') return d;
        deadline = Date.now() + Math.min(step.timeoutMs, 10_000);
        continue;
      }
      if (res.code === 'TARGET_AMBIGUOUS' || Date.now() > deadline) {
        const r = await this.stuck(
          res.code,
          step,
          prefix,
          describeTarget(target),
          `${res.detail}; screen: ${summarizeObservation(obs)}`,
          obs,
          executed,
        );
        if (r === 'continue') {
          // The human did this step by hand. Verify its expectation before moving on.
          const now = await this.surface.observe();
          if (!step.expect || matches(now, step.expect)) return 'next';
          this.confirmResume(false);
          this.fail(
            'UNEXPECTED_STATE',
            stepId,
            describeMatcher(step.expect),
            `after handback: ${summarizeObservation(now)}`,
          );
        }
        if (r === 'retry') {
          deadline = Date.now() + Math.min(step.timeoutMs, 10_000);
          continue;
        }
        return r;
      }
      await sleep(this.poll);
    }
  }

  /** After acting: classify until the step's expectation holds. */
  private async settle(
    eff: EffectiveCapability,
    step: Step,
    executed: Step[],
    prefix: string,
  ): Promise<Directive> {
    const stepId = prefix + step.id;
    const quick = !step.expect;
    let deadline = Date.now() + step.timeoutMs;
    for (;;) {
      const obs = await this.surface.observe();
      const c = classify({
        obs,
        stepId: step.id,
        expect: step.expect,
        outcomes: eff.capability.outcomes,
        conditions: eff.profile.conditions,
      });
      if (c.kind === 'expected') {
        this.logger.event({
          actor: 'automation',
          type: 'classify',
          stepId,
          detail: { expected: describeMatcher(step.expect as StateMatcher) },
        });
        return 'next';
      }
      if (c.kind === 'outcome') this.outcome(c.outcome.code, c.outcome.message, stepId);
      if (c.kind === 'condition') {
        const d = await this.handleCondition(c.condition, step, executed, prefix, obs);
        if (d !== 'continue') return d;
        if (quick) return 'next';
        deadline = Date.now() + step.timeoutMs;
        continue;
      }
      if (quick) return 'next';
      if (Date.now() > deadline) {
        const expected = describeMatcher(step.expect as StateMatcher);
        let r = await this.stuck(
          'UNEXPECTED_STATE',
          step,
          prefix,
          expected,
          summarizeObservation(obs),
          obs,
          executed,
        );
        // Resume is never blind. "continue" means the human says the expectation now holds: verify it.
        // A failed check goes back to the human once, then the run fails.
        for (;;) {
          if (r === 'retry' || r === 'restart') return r;
          const now = await this.surface.observe();
          if (step.expect && matches(now, step.expect)) return 'next';
          this.confirmResume(false);
          if (++this.resumeFailures >= 2) {
            this.fail(
              'UNEXPECTED_STATE',
              stepId,
              expected,
              `after handback: ${summarizeObservation(now)}`,
            );
          }
          r = await this.stuck(
            'UNEXPECTED_STATE',
            step,
            prefix,
            expected,
            `after handback the expectation still does not hold: ${summarizeObservation(now)}`,
            now,
            executed,
          );
        }
      }
      await sleep(this.poll);
    }
  }

  private async handleCondition(
    cond: Condition,
    step: Step,
    executed: Step[],
    prefix: string,
    obs: Observation,
  ): Promise<Directive | 'continue'> {
    const stepId = prefix + step.id;
    this.logger.event({
      actor: 'automation',
      type: 'classify',
      stepId,
      detail: { condition: cond.id, class: cond.class },
    });
    if (cond.class === 'business_outcome')
      this.outcome(cond.code ?? cond.id.toUpperCase(), cond.message, stepId);
    if (cond.class === 'hard_failure') {
      this.fail(
        asFailureCode(cond.code),
        stepId,
        step.expect ? describeMatcher(step.expect) : step.intent,
        summarizeObservation(obs),
      );
    }

    const n = (this.attempts.get(cond.id) ?? 0) + 1;
    this.attempts.set(cond.id, n);
    if (n > cond.maxAttempts) {
      const r = await this.stuck(
        'RECOVERY_EXHAUSTED',
        step,
        prefix,
        `${cond.id} to clear within ${cond.maxAttempts} attempt(s)`,
        summarizeObservation(obs),
        obs,
        executed,
      );
      return r;
    }
    const recover = cond.recover;
    if (!recover) return 'continue';
    if (recover.then !== 'continue') {
      const safe = retryAllowed(executed);
      if (!safe.ok) {
        return this.stuck(
          'RETRY_UNSAFE',
          step,
          prefix,
          `${cond.id} recovery (${recover.then}) is safe`,
          `steps ${safe.unsafe.join(', ')} are not retry safe; re-running could repeat a write. Screen: ${summarizeObservation(obs)}`,
          obs,
          executed,
        );
      }
    }

    this.logger.event({
      actor: 'automation',
      type: 'recover',
      stepId,
      detail: { condition: cond.id, attempt: n, then: recover.then },
    });
    for (const rs of recover.steps ?? []) {
      if (rs.action === 'wait') {
        await sleep(rs.ms ?? 500);
        continue;
      }
      if (rs.action === 'press') {
        await this.act({ type: 'press', key: rs.key ?? 'Enter' }, stepId, 'read');
        continue;
      }
      const now = await this.surface.observe();
      const res = rs.target ? resolveTarget(now.elements, rs.target) : undefined;
      if (!res?.ok) {
        return this.stuck(
          'RECOVERY_EXHAUSTED',
          step,
          prefix,
          `recovery target for ${cond.id}`,
          summarizeObservation(now),
          now,
          executed,
        );
      }
      await this.act({ type: 'click', ref: res.element.ref }, stepId, 'read');
    }
    if (recover.runCapability)
      await this.runFlow(this.sub(recover.runCapability), `${recover.runCapability}:`);

    const existing = this.meta.recoveries.find(
      (r) => r.conditionId === cond.id && r.atStep === stepId,
    );
    if (existing) existing.attempts = n;
    else this.meta.recoveries.push({ conditionId: cond.id, atStep: stepId, attempts: n });

    return recover.then === 'continue'
      ? 'continue'
      : recover.then === 'retry_step'
        ? 'retry'
        : 'restart';
  }

  /**
   * The run cannot safely proceed. With an escalation channel a human decides;
   * without one, the run fails with the code.
   */
  private async stuck(
    code: FailureCode,
    step: Step,
    prefix: string,
    expected: string,
    observed: string,
    obs: Observation,
    executed: Step[],
  ): Promise<Directive | 'continue'> {
    const stepId = prefix + step.id;
    if (!this.opts.escalation || !STUCK_ESCALATES.has(code))
      this.fail(code, stepId, expected, observed);
    // Retry re-runs the current step, so every step executed so far (this one included, once acted) must be retry safe.
    const canRetry = retryAllowed(executed).ok;
    const shot = await this.surface.observe({ screenshot: true });
    const screenshotPath = shot.screenshot
      ? this.logger.saveScreenshot(`escalation-${step.id}`, shot.screenshot, shot)
      : undefined;
    this.logger.event({
      actor: 'automation',
      type: 'escalate',
      stepId,
      intent: step.intent,
      detail: { code, expected, observed },
    });
    const resolution = await (this.opts.escalation as Escalation).request({
      runId: this.logger.runId,
      capabilityId: this.main.capability.id,
      stepId,
      stepIntent: step.intent,
      reasonCode: code,
      reason: reasonText(code),
      expected,
      observed,
      obs: shot.screenshot ? shot : obs,
      allowed: canRetry ? ['retry', 'continue', 'abort'] : ['continue', 'abort'],
      surface: this.surface,
      logger: this.logger,
      ...(screenshotPath ? { screenshotPath } : {}),
    });
    this.meta.humanInterventions.push({
      interventionId: resolution.interventionId,
      atStep: stepId,
      resolution: resolution.kind,
    });
    this.logger.event({ actor: 'human', type: 'control', stepId, detail: { resolution } });
    if (resolution.kind === 'timeout')
      this.fail(
        'ESCALATION_TIMEOUT',
        stepId,
        expected,
        'no operator resolved the intervention in time',
      );
    if (resolution.kind === 'abort' || resolution.kind === 'reject')
      this.fail(
        'ABORTED_BY_OPERATOR',
        stepId,
        expected,
        'note' in resolution && resolution.note ? resolution.note : 'operator aborted',
      );
    this.pendingResume = resolution.interventionId;
    if (resolution.kind === 'retry') return 'retry';
    return 'continue';
  }

  /** Reports the resume check to the escalation channel. */
  private confirmResume(ok: boolean): void {
    if (!this.pendingResume) return;
    this.opts.escalation?.resumed?.(this.pendingResume, ok);
    this.logger.event({
      actor: 'automation',
      type: 'control',
      detail: { resumeCheck: ok ? 'passed' : 'failed', interventionId: this.pendingResume },
    });
    this.pendingResume = undefined;
  }

  // --- Helpers ---------------------------------------------------------------

  private async act(action: Action, stepId: string, risk: Step['risk']) {
    const before = this.surface.lastObservation()?.hash;
    let result;
    try {
      result = await this.surface.act(action, 'automation', { declaredRisk: risk });
    } catch (err) {
      if (err instanceof PolicyBlockedError)
        this.fail('POLICY_BLOCKED', stepId, 'an action the policy allows', err.message);
      throw err;
    }
    if (before && NAVIGATING.has(action.type)) await this.awaitChange(before);
    return result;
  }

  /**
   * After an action that can navigate, wait until the screen differs from the
   * one acted on, so the next classification never sees the stale page (for
   * example the notice whose Continue was just clicked). Capped: a click that
   * legitimately changes nothing costs at most CHANGE_WAIT_MS.
   */
  private async awaitChange(before: string): Promise<void> {
    const deadline = Date.now() + CHANGE_WAIT_MS;
    while (Date.now() < deadline) {
      if ((await this.surface.observe()).hash !== before) return;
      await sleep(Math.min(this.poll, 100));
    }
  }

  private async waitFor(
    m: StateMatcher,
    stepId: string,
    timeoutMs: number,
    required = true,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const obs = await this.surface.observe();
      if (matches(obs, m)) return true;
      const cond = this.main.profile.conditions.find(
        (c) => c.class !== 'recoverable' && matches(obs, c.detect),
      );
      if (cond?.class === 'hard_failure')
        this.fail(asFailureCode(cond.code), stepId, describeMatcher(m), summarizeObservation(obs));
      if (cond?.class === 'business_outcome')
        this.outcome(cond.code ?? cond.id, cond.message, stepId);
      if (Date.now() > deadline) {
        if (required)
          this.fail('UNEXPECTED_STATE', stepId, describeMatcher(m), summarizeObservation(obs));
        return false;
      }
      await sleep(this.poll);
    }
  }

  private toAction(step: Step, element: ObservedElement | undefined): Action {
    const ref = element?.ref ?? '';
    switch (step.action) {
      case 'click':
        return { type: 'click', ref };
      case 'type':
        return { type: 'type', ref, text: this.bind(step.value as ValueBinding) };
      case 'select':
        return { type: 'select', ref, option: this.bind(step.value as ValueBinding) };
      case 'read':
        return { type: 'read', ref };
      case 'press':
        return { type: 'press', key: step.key ?? 'Enter' };
      case 'wait':
        return { type: 'wait', ms: step.ms ?? 500 };
      case 'goto':
        return {
          type: 'goto',
          url: new URL(step.path ?? '/', this.main.overlay.baseUrl).toString(),
        };
    }
  }

  private bind(binding: ValueBinding): string {
    if ('const' in binding) return binding.const;
    const [scope, name = ''] = binding.from.split('.');
    if (scope === 'secrets') {
      const v = this.secrets.get(name);
      if (v === undefined) this.fail('MISSING_SECRET', null, `secret ${name}`, 'not set');
      return v;
    }
    const v = this.inputs[name];
    if (v === undefined) this.fail('INVALID_INPUT', null, `input ${name}`, 'not supplied');
    return toUiText(v);
  }

  private fail(
    code: FailureCode,
    atStep: string | null,
    expected: string,
    observed: string,
  ): never {
    throw new StopRun({ status: 'failure', code, atStep, expected, observed });
  }

  private outcome(code: string, message: string | undefined, atStep: string): never {
    throw new StopRun({ status: 'business_outcome', code, message: message ?? code, atStep });
  }

  private finishMeta(): RunMeta {
    return { ...this.meta, durationMs: Date.now() - this.startedAt.getTime() };
  }

  private async toResult(err: unknown): Promise<RunResult> {
    const stop: StopFailure | StopOutcome =
      err instanceof StopRun
        ? err.stop
        : {
            status: 'failure',
            code: 'INTERNAL_ERROR',
            atStep: null,
            expected: 'no internal error',
            observed: err instanceof Error ? err.message : String(err),
          };
    if (stop.status === 'business_outcome') {
      this.logger.event({
        actor: 'automation',
        type: 'classify',
        stepId: stop.atStep,
        detail: { businessOutcome: stop.code },
      });
      return { ...stop, meta: this.finishMeta() };
    }
    this.confirmResume(false);
    const evidence: { screenshot?: string; observation?: string; log: string } = {
      log: this.logger.logPath,
    };
    if (this.surface) {
      try {
        const obs = await this.surface.observe({ screenshot: true });
        if (obs.screenshot)
          evidence.screenshot = this.logger.saveScreenshot('failure', obs.screenshot, obs);
        evidence.observation = this.logger.saveObservation('failure', obs);
      } catch {
        // The session may be gone; the log still explains the failure.
      }
    }
    return { ...stop, retryable: RETRYABLE.has(stop.code), evidence, meta: this.finishMeta() };
  }
}

function asFailureCode(code: string | undefined): FailureCode {
  const parsed = FailureCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : 'APP_ERROR';
}

function describeBinding(b: ValueBinding): string {
  return 'const' in b ? `const` : b.from;
}

export function describeTarget(t: TargetSpec): string {
  if ('kind' in t)
    return `table cell ${t.column} where ${t.rowWhere.column} = "${t.rowWhere.equals}"`;
  return t.locators
    .map((l) => {
      switch (l.kind) {
        case 'role_name':
          return `${l.role} named "${l.name}"`;
        case 'label_anchor':
          return `${l.role} labelled "${l.label}" (${l.relation})`;
        case 'text':
          return `${l.role ?? 'element'} with text "${l.text}"`;
        case 'structural':
          return `${l.role} #${l.ordinal} in ${l.framePath.join('/')}`;
        case 'visual':
          return `${l.role ?? 'element'} at ${l.bbox.x},${l.bbox.y}`;
      }
    })
    .join(' | ');
}

function reasonText(code: string): string {
  switch (code) {
    case 'UNEXPECTED_STATE':
      return 'The screen did not match the expected state or any known condition.';
    case 'TARGET_NOT_FOUND':
      return 'No locator matched the control this step acts on.';
    case 'TARGET_AMBIGUOUS':
      return 'Several controls matched and none of the locators narrowed it to one.';
    case 'RECOVERY_EXHAUSTED':
      return 'A known recoverable condition kept coming back.';
    case 'RETRY_UNSAFE':
      return 'Recovering would re-run a step that is not safe to repeat.';
    default:
      return code;
  }
}
