// Compiles a discovery trace into a capability. The trace is what the model
// did; the capability is what replay will do. Keeping them apart is what
// decouples the artifact from the model transcript.
//
// 1. Keep only successful actions on the path to done.
// 2. Build each target from the recorded element, in locator order, keeping
//    only locators that pick out exactly that element on the recorded screen.
// 3. Values that came from inputs or secrets become bindings.
// 4. The model proposes a title, a description and an expected text per step.
// 5. Code verifies each proposal: it must hold after the step and not before.
//    A rejected proposal falls back to a text diff of the two screens.
// 6. Step risk is the higher of the policy hint and the model's proposal.
// 7. No input value, secret or read value may appear in the result.

import { effectiveRisk } from '../policy/gate.js';
import { findLeaks } from '../policy/redact.js';
import { matches } from '../replay/matcher.js';
import { Capability, type Step } from '../schema/capability.js';
import type { StateMatcher } from '../schema/matcher.js';
import type { Policy } from '../schema/policy.js';
import type { ElementTarget, Locator, TargetSpec } from '../schema/target.js';
import { maxRisk, SCHEMA_VERSION, type Risk } from '../schema/values.js';
import { summarizeObservation } from '../surface/describe.js';
import { matchLocator } from '../surface/resolve.js';
import type { Observation, ObservedElement } from '../surface/types.js';
import type { DiscoveryTrace, TraceStep } from './agent.js';
import type { Brain, StepSummary } from './brain.js';
import type { GoalSpec } from './goal.js';

export const COMPILER_VERSION = '0.1.0';

export interface CompileInput {
  trace: DiscoveryTrace;
  spec: GoalSpec;
  brain: Brain;
  policy: Policy;
  runId: string;
  /** Values that must never appear in the artifact (inputs, probes, secrets, read values). */
  forbidden: string[];
}

export interface CompileResult {
  capability?: Capability;
  /** The recorded screens around each compiled step, for verifying probe matchers. */
  screens: Record<string, { before: Observation; after?: Observation }>;
  rejected?: string;
  warnings: string[];
}

export async function compileTrace(c: CompileInput): Promise<CompileResult> {
  const warnings: string[] = [];
  const screens: CompileResult['screens'] = {};
  if (c.trace.status !== 'done')
    return { rejected: `discovery did not finish (${c.trace.status})`, warnings, screens };

  const kept = keepPath(c.trace.steps);
  if (kept.length === 0)
    return { rejected: 'the trace has no successful actions', warnings, screens };

  const drafts: { trace: TraceStep; id: string }[] = kept.map((t, i) => ({
    trace: t,
    id: `s${i + 1}`,
  }));
  const summaries: StepSummary[] = drafts.map(({ trace, id }) => ({
    id,
    intent: trace.call.intent,
    action: trace.call.tool,
    target: trace.element
      ? `${trace.element.role} ${JSON.stringify(trace.element.nearText?.text ?? trace.element.name)}`
      : '',
    screenBefore: summarizeObservation(trace.before, 300),
    screenAfter: trace.after ? summarizeObservation(trace.after, 300) : '',
  }));
  const proposal = await c.brain.propose(c.spec.goal, c.spec.capabilityId, summaries);

  const steps: Step[] = [];
  for (const { trace, id } of drafts) {
    const action = trace.call.tool as Step['action'];
    const target = trace.element ? buildTarget(trace, warnings, id) : undefined;
    if (trace.element && !target)
      return {
        rejected: `step ${id}: no locator identifies the element uniquely`,
        warnings,
        screens,
      };

    const policyRisk = trace.element
      ? effectiveRisk(c.policy, {
          action: { type: 'click', ref: trace.element.ref },
          element: trace.element,
        })
      : 'read';
    const hinted: Risk = action === 'click' ? policyRisk : 'read';
    const risk = maxRisk(
      hinted,
      proposal.risks[id] ?? 'read',
      trace.humanApproved ? 'irreversible' : 'read',
    );

    const step: Step = {
      id,
      intent: trace.call.intent || `${action} step`,
      action,
      risk,
      retrySafe: risk !== 'irreversible',
      timeoutMs: 8000,
      ...(target ? { target } : {}),
      ...(trace.binding ? { value: trace.binding } : {}),
      ...(trace.call.tool === 'press' ? { key: trace.call.key } : {}),
      ...(trace.call.tool === 'read' ? { into: `outputs.${trace.call.output}` } : {}),
    };
    if (action === 'click' || action === 'press') {
      const expect = verifiedExpect(proposal.expects[id], trace, c.forbidden, warnings, id);
      if (expect) step.expect = expect;
      else
        warnings.push(
          `step ${id}: no expectation could be verified; replay will only check app conditions after it`,
        );
    }
    steps.push(step);
  }

  const success = successMatcher(steps, c.trace.final, warnings);
  const capability = Capability.safeParse({
    kind: 'capability',
    schemaVersion: SCHEMA_VERSION,
    id: c.spec.capabilityId,
    version: '1.0.0',
    title: proposal.title,
    description: proposal.description,
    app: { appId: c.spec.appId, versions: '>=7.2 <8' },
    risk: maxRisk(...steps.map((s) => s.risk)),
    status: 'draft',
    inputs: Object.fromEntries(Object.entries(c.spec.inputs).map(([k, v]) => [k, v.spec])),
    outputs: c.spec.outputs,
    preconditions: c.spec.preconditions.map((p) => ({ capability: p })),
    ...(c.spec.startPath !== '/' ? { entry: { path: c.spec.startPath } } : {}),
    steps,
    outcomes: [],
    success,
    approval: null,
    provenance: {
      source: 'discovery',
      discoveryRunId: c.runId,
      probeRunIds: [],
      model: c.brain.model,
      recordedAt: new Date().toISOString(),
      compilerVersion: COMPILER_VERSION,
    },
  });
  if (!capability.success)
    return { rejected: `schema: ${capability.error.message}`, warnings, screens };

  const leaks = findLeaks(JSON.stringify(capability.data), c.forbidden);
  if (leaks.length)
    return {
      rejected: `the artifact would contain literal values: ${leaks.length} found`,
      warnings,
      screens,
    };
  return { capability: capability.data, warnings, screens };
}

/** Successful actions on the path to done. Waits are dropped; a re-typed field keeps only its last value. */
function keepPath(steps: TraceStep[]): TraceStep[] {
  const ok = steps.filter(
    (s) => s.ok && s.call.tool !== 'wait' && s.call.tool !== 'done' && s.call.tool !== 'stuck',
  );
  return ok.filter((s, i) => {
    const next = ok[i + 1];
    const sameField =
      next &&
      (s.call.tool === 'type' || s.call.tool === 'select') &&
      next.call.tool === s.call.tool &&
      sameElement(s.element, next.element);
    return !sameField;
  });
}

function sameElement(a?: ObservedElement, b?: ObservedElement): boolean {
  return (
    !!a &&
    !!b &&
    a.role === b.role &&
    a.framePath.join('/') === b.framePath.join('/') &&
    a.nearText?.text === b.nearText?.text &&
    a.name === b.name
  );
}

export function buildTarget(
  trace: TraceStep,
  warnings: string[],
  id: string,
): TargetSpec | undefined {
  const el = trace.element as ObservedElement;
  const obs = trace.before;
  if (el.table && el.role !== 'table') {
    const table = obs.elements.find((e) => e.ref === el.table?.tableRef);
    if (!table) return undefined;
    const cells = obs.elements.filter((e) => e.table?.tableRef === table.ref);
    const header = (col: number) =>
      cells.find((c) => c.table?.row === 0 && c.table.col === col)?.name;
    const keyCol = el.table.col === 0 ? 1 : 0;
    const column = header(el.table.col);
    const keyHeader = header(keyCol);
    const keyValue = cells.find(
      (c) => c.table?.row === el.table?.row && c.table?.col === keyCol,
    )?.name;
    const tableTarget = elementTarget(table, obs, false);
    if (!column || !keyHeader || !keyValue || !tableTarget) return undefined;
    return {
      kind: 'table_cell',
      table: tableTarget,
      rowWhere: { column: keyHeader, equals: keyValue },
      column,
    };
  }
  const isRead = trace.call.tool === 'read';
  const target = elementTarget(el, obs, isRead);
  if (target && target.locators[0]?.kind === 'structural')
    warnings.push(
      `step ${id}: only a structural locator fits; it survives renames but not layout changes`,
    );
  return target;
}

/**
 * Candidate locators, strongest first, kept only when they match exactly this
 * element on the recorded screen. For reads, the element's own text is the
 * value being read, so it is never used to find it.
 */
function elementTarget(
  el: ObservedElement,
  obs: Observation,
  valueBearing: boolean,
): ElementTarget | undefined {
  const candidates: Locator[] = [];
  const named = el.name !== '' && !valueBearing && !['cell', 'table'].includes(el.role);
  if (named && el.role !== 'text')
    candidates.push({ kind: 'role_name', role: el.role, name: el.name, framePath: el.framePath });
  if (el.nearText)
    candidates.push({
      kind: 'label_anchor',
      role: el.role,
      label: el.nearText.text,
      relation: el.nearText.relation,
    });
  if (named && ['button', 'link', 'text'].includes(el.role))
    candidates.push({ kind: 'text', role: el.role, text: el.name });
  const sameRole = obs.elements.filter(
    (e) => e.role === el.role && e.framePath.join('/') === el.framePath.join('/'),
  );
  const ordinal = sameRole.findIndex((e) => e.ref === el.ref);
  if (ordinal >= 0)
    candidates.push({ kind: 'structural', framePath: el.framePath, role: el.role, ordinal });

  const unique = candidates.filter((l) => {
    const m = matchLocator(obs.elements, l);
    return m.length === 1 && m[0]?.ref === el.ref;
  });
  if (unique.length === 0) return undefined;
  // Visual stays last: evidence and drift checks only, never used to act by default.
  unique.push({ kind: 'visual', role: el.role, bbox: el.bbox });
  return { locators: unique };
}

/** The model's expected text if it verifies, else a text diff of the two screens. */
function verifiedExpect(
  proposed: string | undefined,
  trace: TraceStep,
  forbidden: string[],
  warnings: string[],
  id: string,
): StateMatcher | undefined {
  const after = trace.after;
  if (!after) return undefined;
  const ok = (m: StateMatcher) =>
    matches(after, m) &&
    !matches(trace.before, m) &&
    findLeaks(JSON.stringify(m), forbidden).length === 0;
  if (proposed) {
    const m: StateMatcher = { textPresent: proposed };
    if (ok(m)) return m;
    warnings.push(
      `step ${id}: model proposed "${proposed}", which did not verify; using a text diff`,
    );
  }
  for (const text of diffTexts(trace.before, after)) {
    const m: StateMatcher = { textPresent: text };
    if (ok(m)) return m;
  }
  return undefined;
}

/** Stable-looking text that appears after but not before: main-frame title first, then headings and labels. */
function diffTexts(before: Observation, after: Observation): string[] {
  const has = (obs: Observation, t: string) =>
    obs.elements.some((e) => e.name.includes(t)) || obs.frames.some((f) => f.title.includes(t));
  const titles = after.frames.filter((f) => f.path.at(-1) === 'main').map((f) => f.title);
  const texts = after.elements
    .filter((e) => e.role === 'text' && e.framePath.at(-1) === 'main')
    .map((e) => e.name);
  return [...titles, ...texts].filter(
    (t) => t.length >= 4 && t.length <= 40 && !/\d/.test(t) && !has(before, t),
  );
}

function successMatcher(
  steps: Step[],
  final: Observation | undefined,
  warnings: string[],
): StateMatcher {
  const lastExpect = [...steps].reverse().find((s) => s.expect)?.expect;
  if (lastExpect && (!final || matches(final, lastExpect))) return lastExpect;
  const title = final?.frames.find((f) => f.path.at(-1) === 'main')?.title;
  if (title) return { textPresent: title };
  warnings.push('no success checkpoint could be derived; using the app fingerprint');
  return { textPresent: 'MemberDesk' };
}
