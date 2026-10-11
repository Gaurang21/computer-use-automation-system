// The discovery agent loop: observe -> decide -> (policy) -> act, until the
// goal is met or a stopping condition hits. The output is a trace of what was
// done, on which element, with which binding, and what the screen looked like
// before and after. A separate compiler turns the trace into a capability.

import { setTimeout as sleep } from 'node:timers/promises';
import type { RunLogger } from '../evidence/logger.js';
import {
  ApprovalRequiredError,
  PolicyBlockedError,
  type GuardedSurface,
} from '../policy/guarded-surface.js';
import type { ValueBinding } from '../schema/capability.js';
import type { ParamSpec } from '../schema/values.js';
import type { SecretProvider } from '../replay/secrets.js';
import { parseOutput, type TypedValue } from '../replay/values.js';
import type { Action, Observation, ObservedElement } from '../surface/types.js';
import type { Brain, HistoryEntry, ToolCall } from './brain.js';
import { BudgetExceededError } from './spend.js';

export interface TraceStep {
  call: ToolCall;
  ok: boolean;
  result: string;
  element?: ObservedElement;
  binding?: ValueBinding;
  readValue?: TypedValue;
  /** The screen the decision was made on. */
  before: Observation;
  /** The screen after the action settled. */
  after?: Observation;
  humanApproved?: boolean;
}

export type TraceStatus =
  'done' | 'stuck' | 'max_steps' | 'timeout' | 'budget' | 'rejected' | 'aborted';

export interface DiscoveryTrace {
  status: TraceStatus;
  reason?: string;
  steps: TraceStep[];
  outputs: Record<string, TypedValue>;
  final?: Observation;
}

/** How discovery asks a human: on a dead end, or before an irreversible step. */
export interface DiscoveryEscalation {
  stuck(ctx: {
    reason: string;
    observation: Observation;
    step: number;
  }): Promise<'resume' | 'abort'>;
  approve(ctx: {
    action: string;
    reason: string;
    observation: Observation;
    step: number;
  }): Promise<'approve' | 'reject'>;
}

export interface AgentOptions {
  goal: string;
  brain: Brain;
  surface: GuardedSurface;
  logger: RunLogger;
  inputs: Record<string, { spec: ParamSpec; value: string }>;
  outputs: Record<string, ParamSpec>;
  secrets: SecretProvider;
  secretNames: string[];
  maxSteps: number;
  maxMs: number;
  escalation?: DiscoveryEscalation;
  pollMs?: number;
}

const DEAD_END_REPEATS = 3;

export async function runAgent(o: AgentOptions): Promise<DiscoveryTrace> {
  const steps: TraceStep[] = [];
  const history: HistoryEntry[] = [];
  const outputs: Record<string, TypedValue> = {};
  const seen = new Map<string, number>();
  const deadline = Date.now() + o.maxMs;
  const poll = o.pollMs ?? 150;
  let obs = await o.surface.observe({ screenshot: true });
  let stepNo = 0;

  const finish = (status: TraceStatus, reason?: string): DiscoveryTrace => {
    o.logger.event({
      actor: 'system',
      type: 'result',
      detail: { status, reason, steps: steps.length },
    });
    return { status, ...(reason ? { reason } : {}), steps, outputs, final: obs };
  };

  while (stepNo < o.maxSteps) {
    if (Date.now() > deadline)
      return finish('timeout', `no result within ${Math.round(o.maxMs / 1000)} s`);
    stepNo++;
    o.logger.event({
      actor: 'automation',
      type: 'observe',
      detail: { step: stepNo, hash: obs.hash, location: mainUrl(obs) },
    });
    if (obs.screenshot)
      o.logger.saveScreenshot(`step-${String(stepNo).padStart(2, '0')}`, obs.screenshot, obs);

    let call: ToolCall;
    try {
      call = await o.brain.decide({
        goal: o.goal,
        inputs: Object.entries(o.inputs).map(([name, i]) => ({
          name,
          binding: `inputs.${name}`,
          value: i.value,
          ...(i.spec.description ? { description: i.spec.description } : {}),
        })),
        outputs: Object.entries(o.outputs).map(([name, s]) => ({
          name,
          type: s.type,
          ...(s.description ? { description: s.description } : {}),
        })),
        secrets: o.secretNames,
        history,
        observation: obs,
        step: stepNo,
        maxSteps: o.maxSteps,
      });
    } catch (err) {
      if (err instanceof BudgetExceededError) return finish('budget', err.message);
      throw err;
    }
    o.logger.event({
      actor: 'model',
      type: 'decide',
      intent: call.intent,
      detail: { step: stepNo, call: loggable(call) },
    });

    if (call.tool === 'done') {
      const missing = Object.keys(o.outputs).filter((k) => outputs[k] === undefined);
      if (missing.length === 0) return finish('done', call.summary);
      history.push({ call, result: `error: outputs not read yet: ${missing.join(', ')}` });
      continue;
    }

    // Dead end: the same action on the same screen, again and again.
    const key = `${obs.hash}|${signature(call)}`;
    const repeats = (seen.get(key) ?? 0) + 1;
    seen.set(key, repeats);
    if (call.tool === 'stuck' || repeats >= DEAD_END_REPEATS) {
      const reason =
        call.tool === 'stuck'
          ? call.reason
          : `dead end: "${signature(call)}" repeated ${repeats} times on the same screen`;
      o.logger.event({ actor: 'automation', type: 'escalate', detail: { step: stepNo, reason } });
      if (!o.escalation) return finish('stuck', reason);
      const decision = await o.escalation.stuck({ reason, observation: obs, step: stepNo });
      if (decision === 'abort') return finish('aborted', reason);
      seen.clear();
      history.push({
        call,
        result: 'a human operator took over and handed back; look at the screen again',
      });
      obs = await o.surface.observe({ screenshot: true });
      continue;
    }

    const step: TraceStep = { call, ok: false, result: '', before: obs };
    steps.push(step);
    try {
      await execute(o, step, outputs);
    } catch (err) {
      if (err instanceof ApprovalRequiredError) {
        o.logger.event({
          actor: 'automation',
          type: 'escalate',
          detail: { step: stepNo, approval: err.message },
        });
        if (!o.escalation) return finish('rejected', `needs human approval: ${err.message}`);
        const verdict = await o.escalation.approve({
          action: signature(call),
          reason: err.message,
          observation: obs,
          step: stepNo,
        });
        if (verdict === 'reject') {
          step.result = 'a human rejected this irreversible action';
          return finish('rejected', step.result);
        }
        step.humanApproved = true;
        await execute(o, step, outputs);
      } else if (err instanceof PolicyBlockedError) {
        step.result = `blocked by policy: ${err.decision.reason}`;
      } else {
        step.result = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    history.push({ call, result: step.result });

    // Let the screen settle into its next state before the next decision.
    const prev = obs.hash;
    if (step.ok && ['click', 'press'].includes(call.tool)) {
      const until = Date.now() + 1500;
      while (Date.now() < until && (await o.surface.observe()).hash === prev) await sleep(poll);
    }
    obs = await o.surface.observe({ screenshot: true });
    step.after = obs;
  }
  return finish('max_steps', `no result within ${o.maxSteps} steps`);
}

async function execute(
  o: AgentOptions,
  step: TraceStep,
  outputs: Record<string, TypedValue>,
): Promise<void> {
  const { call, before } = step;
  const element = 'ref' in call ? before.elements.find((e) => e.ref === call.ref) : undefined;
  if ('ref' in call && !element) {
    step.result = `error: no element ${call.ref} on this screen`;
    return;
  }
  if (element) step.element = element;
  const risk = {
    declaredRisk: 'read' as const,
    ...(step.humanApproved ? { humanApproved: true } : {}),
  };

  let action: Action;
  switch (call.tool) {
    case 'click':
      action = { type: 'click', ref: call.ref };
      break;
    case 'type':
    case 'select': {
      const { binding, text } = bind(o, call.value);
      step.binding = binding;
      action =
        call.tool === 'type'
          ? { type: 'type', ref: call.ref, text }
          : { type: 'select', ref: call.ref, option: text };
      break;
    }
    case 'read': {
      const spec = o.outputs[call.output];
      if (!spec) {
        step.result = `error: ${call.output} is not a declared output (${Object.keys(o.outputs).join(', ')})`;
        return;
      }
      action = { type: 'read', ref: call.ref };
      break;
    }
    case 'press':
      action = { type: 'press', key: call.key };
      break;
    case 'wait':
      action = { type: 'wait', ms: 1000 };
      break;
    default:
      return;
  }

  o.logger.event({
    actor: 'automation',
    type: 'act',
    intent: call.intent,
    detail: {
      action: action.type,
      ...(element ? { element: `${element.role}`, framePath: element.framePath } : {}),
      ...(step.binding ? { value: 'from' in step.binding ? step.binding.from : 'const' } : {}),
    },
  });
  const result = await o.surface.act(action, 'automation', risk);
  step.ok = true;
  step.result = 'ok';

  if (call.tool === 'read') {
    const spec = o.outputs[call.output] as ParamSpec;
    const text = result.value ?? '';
    o.logger.redactor.addKnown(text, spec.sensitivity);
    const parsed = parseOutput(text, spec);
    if (!parsed.ok) {
      step.ok = false;
      step.result = `error: could not read ${call.output} as ${spec.type}: ${parsed.problem}`;
      return;
    }
    outputs[call.output] = parsed.value;
    step.readValue = parsed.value;
    o.logger.redactor.addKnown(parsed.value, spec.sensitivity);
    step.result = `ok, read ${call.output}`;
  }
}

/** Turns what the model typed into a binding, substituting the real value. */
function bind(o: AgentOptions, value: string): { binding: ValueBinding; text: string } {
  const m = /^(inputs|secrets)\.([A-Za-z][A-Za-z0-9_]*)$/.exec(value.trim());
  if (m?.[1] === 'inputs') {
    const input = o.inputs[m[2] as string];
    if (!input) throw new Error(`${value} is not a declared input`);
    return { binding: { from: value.trim() }, text: input.value };
  }
  if (m?.[1] === 'secrets') {
    const secret = o.secrets.get(m[2] as string);
    if (secret === undefined) throw new Error(`${value} is not an available secret`);
    return { binding: { from: value.trim() }, text: secret };
  }
  // A model that typed a declared input's raw value still gets a binding, never a literal.
  const asInput = Object.entries(o.inputs).find(([, i]) => i.value === value);
  if (asInput) return { binding: { from: `inputs.${asInput[0]}` }, text: value };
  return { binding: { const: value }, text: value };
}

function signature(c: ToolCall): string {
  switch (c.tool) {
    case 'click':
      return `click ${c.ref}`;
    case 'type':
    case 'select':
      return `${c.tool} ${c.ref} ${c.value}`;
    case 'read':
      return `read ${c.ref} ${c.output}`;
    case 'press':
      return `press ${c.key}`;
    default:
      return c.tool;
  }
}

/** The decide event never carries literal typed text, only bindings. */
function loggable(c: ToolCall): Record<string, string> {
  const out: Record<string, string> = { tool: c.tool };
  if ('ref' in c) out.ref = c.ref;
  if ('value' in c) out.value = /^(inputs|secrets)\./.test(c.value) ? c.value : '[literal]';
  if ('output' in c) out.output = c.output;
  if ('key' in c) out.key = c.key;
  if ('reason' in c) out.reason = c.reason;
  if ('summary' in c) out.summary = c.summary;
  return out;
}

function mainUrl(obs: Observation): string {
  return obs.frames.find((f) => f.path.at(-1) === 'main')?.url ?? obs.location;
}
