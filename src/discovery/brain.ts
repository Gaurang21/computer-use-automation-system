// The model seam. Discovery talks to a Brain, never to a provider SDK. Two
// implementations: the Anthropic API, and a scripted fake used in tests and
// for running the whole path with no API key.

import type { Risk } from '../schema/values.js';
import type { Observation } from '../surface/types.js';

export type ToolCall =
  | { tool: 'click'; ref: string; intent: string }
  | { tool: 'type'; ref: string; value: string; intent: string }
  | { tool: 'select'; ref: string; value: string; intent: string }
  | { tool: 'press'; key: string; intent: string }
  | { tool: 'read'; ref: string; output: string; intent: string }
  | { tool: 'wait'; intent: string }
  | { tool: 'done'; summary: string; intent: string }
  | { tool: 'stuck'; reason: string; intent: string };

export interface HistoryEntry {
  call: ToolCall;
  result: string;
}

export interface DecideContext {
  goal: string;
  /** name -> binding and (for non-secrets) the value, as shown to the model. */
  inputs: { name: string; binding: string; value?: string; description?: string }[];
  outputs: { name: string; type: string; description?: string }[];
  secrets: string[];
  history: HistoryEntry[];
  observation: Observation;
  step: number;
  maxSteps: number;
}

export interface StepSummary {
  id: string;
  intent: string;
  action: string;
  target: string;
  screenBefore: string;
  screenAfter: string;
}

export interface Proposal {
  title: string;
  description: string;
  /** stepId -> text expected on screen after the step. */
  expects: Record<string, string>;
  /** stepId -> risk the model would assign. */
  risks: Record<string, Risk>;
}

export interface OutcomeClassification {
  kind: 'business_outcome' | 'unknown';
  code?: string;
  message?: string;
  textPresent?: string;
}

export interface Brain {
  readonly model: string;
  decide(ctx: DecideContext): Promise<ToolCall>;
  /** Once per compile: title, description, an expect text and a risk per step. */
  propose(goal: string, capabilityId: string, steps: StepSummary[]): Promise<Proposal>;
  /** Probe runs: what is this screen the replay did not recognise? */
  classify(
    goal: string,
    stepIntent: string,
    observation: Observation,
  ): Promise<OutcomeClassification>;
}
