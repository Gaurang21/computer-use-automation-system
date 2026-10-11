// The classification order after every action. Determinism comes from one
// rule: the engine recognises the state it is in before doing anything else,
// and never steps past a state it does not recognise.
//
// 1. The step's expect matches                   -> next step
// 2. A capability outcome scoped to this step     -> business_outcome
// 3. An app-profile condition                     -> recover / outcome / hard failure
// 4. Nothing (yet)                                -> keep polling until timeout, then UNEXPECTED_STATE

import type { Condition } from '../schema/app-profile.js';
import type { Outcome, Step } from '../schema/capability.js';
import type { StateMatcher } from '../schema/matcher.js';
import type { Observation, ResolveOptions } from '../surface/types.js';
import { matches } from './matcher.js';

export type Classification =
  | { kind: 'expected' }
  | { kind: 'outcome'; outcome: Outcome }
  | { kind: 'condition'; condition: Condition }
  | { kind: 'unrecognized' };

export interface ClassifyInput {
  obs: Observation;
  stepId: string;
  expect?: StateMatcher | undefined;
  outcomes: readonly Outcome[];
  conditions: readonly Condition[];
  resolveOptions?: ResolveOptions;
}

export function classify(input: ClassifyInput): Classification {
  const { obs, stepId, expect, resolveOptions } = input;
  if (expect && matches(obs, expect, resolveOptions)) return { kind: 'expected' };
  const outcome = input.outcomes.find(
    (o) => o.afterSteps.includes(stepId) && matches(obs, o.detect, resolveOptions),
  );
  if (outcome) return { kind: 'outcome', outcome };
  const condition = input.conditions.find((c) => matches(obs, c.detect, resolveOptions));
  if (condition) return { kind: 'condition', condition };
  return { kind: 'unrecognized' };
}

/**
 * Retry safety. A recovery that re-runs work (retry the step, or restart the
 * flow) is allowed only when every step executed so far is retry safe. Session
 * expiry halfway through a write must never silently resubmit.
 */
export function retryAllowed(
  executed: readonly Pick<Step, 'id' | 'retrySafe'>[],
): { ok: true } | { ok: false; unsafe: string[] } {
  const unsafe = executed.filter((s) => !s.retrySafe).map((s) => s.id);
  return unsafe.length === 0 ? { ok: true } : { ok: false, unsafe };
}
