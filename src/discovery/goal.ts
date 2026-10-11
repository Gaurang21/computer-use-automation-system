// A discovery goal spec: everything a discovery run needs, declared up front.
// Declaring inputs and outputs (with types and sensitivity) tells the compiler
// which values are parameters; inferring that from a transcript is guesswork.

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ParamSpec, Risk } from '../schema/values.js';

const FakeTarget = z.strictObject({
  role: z.string(),
  name: z.string().optional(),
  label: z.string().optional(),
  framePath: z.array(z.string()).optional(),
});

/** A scripted model turn for the fake LLM. Targets are resolved against the live screen. */
export const FakeTurn = z.strictObject({
  tool: z.enum(['click', 'type', 'select', 'press', 'read', 'wait', 'done', 'stuck']),
  intent: z.string(),
  target: FakeTarget.optional(),
  value: z.string().optional(),
  key: z.string().optional(),
  output: z.string().optional(),
  summary: z.string().optional(),
  reason: z.string().optional(),
});
export type FakeTurn = z.infer<typeof FakeTurn>;

export const GoalSpec = z.strictObject({
  capabilityId: z.string(),
  appId: z.string().default('memberdesk'),
  goal: z.string().min(1),
  /** Path on the tenant base URL where discovery starts (after preconditions). */
  startPath: z.string().default('/'),
  preconditions: z.array(z.string()).default([]),
  inputs: z.record(z.string(), z.strictObject({ spec: ParamSpec, value: z.string() })),
  outputs: z.record(z.string(), ParamSpec).default({}),
  /** Extra input sets replayed at authoring time to discover business outcomes. */
  probes: z.array(z.record(z.string(), z.string())).default([]),
  maxSteps: z.int().min(1).max(60).default(25),
  maxMinutes: z.number().min(0.5).max(30).default(5),
  fake: z
    .strictObject({
      turns: z.array(FakeTurn),
      describe: z
        .strictObject({
          title: z.string(),
          description: z.string(),
          expects: z.record(z.string(), z.string()).default({}),
          risks: z.record(z.string(), Risk).default({}),
        })
        .optional(),
      classify: z
        .array(z.strictObject({ textPresent: z.string(), code: z.string(), message: z.string() }))
        .default([]),
    })
    .optional()
    .describe('Scripted model behaviour for --llm fake. Lets the whole path run with no API key.'),
});
export type GoalSpec = z.infer<typeof GoalSpec>;

export function loadGoal(file: string): GoalSpec {
  return GoalSpec.parse(JSON.parse(readFileSync(file, 'utf8')));
}
