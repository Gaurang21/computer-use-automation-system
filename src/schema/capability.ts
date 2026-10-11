// A capability: one reusable flow on one vendor product, with a contract an
// agent can call. Typed inputs and outputs, ordered steps, known business
// outcomes, a success check, risk and approval. It never holds a literal input
// value, a secret, a CSS selector or the model transcript.

import { z } from 'zod';
import { StateMatcher } from './matcher.js';
import { TargetSpec } from './target.js';
import { ParamSpec, Risk, SCHEMA_VERSION } from './values.js';

const Id = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
    'dotted lower_snake id, e.g. member.lookup_savings_balance',
  );
const StepId = z.string().regex(/^[a-z][a-z0-9_-]*$/);
const SemVer = z.string().regex(/^\d+\.\d+\.\d+$/);

/** Where a step value comes from. inputs.* and secrets.* are resolved at run time. */
export const ValueBinding = z.union([
  z.strictObject({ from: z.string().regex(/^(inputs|secrets)\.[A-Za-z][A-Za-z0-9_]*$/) }),
  z.strictObject({
    const: z.string().describe('A fixed, non-sensitive value such as a menu option'),
  }),
]);
export type ValueBinding = z.infer<typeof ValueBinding>;

export const StepAction = z.enum(['click', 'type', 'select', 'press', 'read', 'goto', 'wait']);
export type StepAction = z.infer<typeof StepAction>;

export const Step = z
  .strictObject({
    id: StepId,
    intent: z.string().min(1).describe('What the step is for, in plain words'),
    action: StepAction,
    risk: Risk,
    retrySafe: z
      .boolean()
      .describe('Safe to run again after a recovery (no duplicate side effect)'),
    target: TargetSpec.optional(),
    value: ValueBinding.optional(),
    key: z.string().optional().describe('For press'),
    path: z
      .string()
      .startsWith('/')
      .optional()
      .describe('For goto, relative to the tenant baseUrl'),
    ms: z.int().min(0).max(10_000).optional().describe('For wait'),
    into: z
      .string()
      .regex(/^outputs\.[A-Za-z][A-Za-z0-9_]*$/)
      .optional()
      .describe('For read'),
    expect: StateMatcher.optional().describe('The state that proves the step worked'),
    timeoutMs: z.int().min(100).max(120_000).default(8000),
  })
  .superRefine((s, ctx) => {
    const need = (cond: boolean, msg: string) => {
      if (!cond) ctx.addIssue({ code: 'custom', message: `step ${s.id}: ${msg}` });
    };
    if (['click', 'type', 'select', 'read'].includes(s.action))
      need(!!s.target, `${s.action} needs a target`);
    if (['type', 'select'].includes(s.action)) need(!!s.value, `${s.action} needs a value binding`);
    if (s.action === 'press') need(!!s.key, 'press needs a key');
    if (s.action === 'goto') need(!!s.path, 'goto needs a path');
    if (s.action === 'read') need(!!s.into, 'read needs into');
  });
export type Step = z.infer<typeof Step>;

export const Outcome = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  message: z.string().optional().describe('Returned to the caller with the outcome'),
  afterSteps: z.array(StepId).min(1).describe('Only checked after these steps'),
  detect: StateMatcher,
  source: z.enum(['probe', 'reviewer', 'operator']).describe('Who added this detector'),
});
export type Outcome = z.infer<typeof Outcome>;

export const Precondition = z.strictObject({
  capability: Id.describe('Capability to run first, e.g. auth.login'),
  skipWhen: StateMatcher.optional().describe('Skip it when this already holds'),
});

export const Approval = z.strictObject({
  by: z.string().min(1),
  at: z.iso.datetime(),
  contentHash: z.string().min(16),
});
export type Approval = z.infer<typeof Approval>;

export const Capability = z
  .strictObject({
    kind: z.literal('capability'),
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: Id,
    version: SemVer,
    title: z.string().min(1),
    description: z.string().min(1),
    app: z.strictObject({
      appId: z.string().min(1),
      versions: z.string().min(1).describe('e.g. ">=7.2 <8"'),
    }),
    risk: Risk.describe('Highest risk of any step'),
    status: z.enum(['draft', 'approved', 'deprecated']),
    inputs: z.record(z.string(), ParamSpec),
    outputs: z.record(z.string(), ParamSpec),
    preconditions: z.array(Precondition).default([]),
    entry: z
      .strictObject({ path: z.string().startsWith('/').optional(), ready: StateMatcher.optional() })
      .optional()
      .describe('Where the flow starts and how to know the start screen is up'),
    steps: z.array(Step).min(1),
    outcomes: z.array(Outcome).default([]),
    success: StateMatcher.describe('Checked after the last step'),
    approval: Approval.nullable(),
    provenance: z.strictObject({
      source: z.enum(['discovery', 'hand_written']),
      discoveryRunId: z.string().optional(),
      probeRunIds: z.array(z.string()).default([]),
      model: z.string().optional(),
      recordedAt: z.iso.datetime(),
      compilerVersion: z.string().optional(),
    }),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    for (const s of c.steps) {
      if (ids.has(s.id)) ctx.addIssue({ code: 'custom', message: `duplicate step id ${s.id}` });
      ids.add(s.id);
      if (s.value && 'from' in s.value && s.value.from.startsWith('inputs.')) {
        const name = s.value.from.slice('inputs.'.length);
        if (!c.inputs[name])
          ctx.addIssue({ code: 'custom', message: `step ${s.id} binds undeclared input ${name}` });
      }
      if (s.into && !c.outputs[s.into.slice('outputs.'.length)]) {
        ctx.addIssue({ code: 'custom', message: `step ${s.id} reads into undeclared ${s.into}` });
      }
    }
    for (const o of c.outcomes) {
      for (const id of o.afterSteps) {
        if (!ids.has(id))
          ctx.addIssue({
            code: 'custom',
            message: `outcome ${o.code} refers to unknown step ${id}`,
          });
      }
    }
  });
export type Capability = z.infer<typeof Capability>;
export type CapabilityInput = z.input<typeof Capability>;
