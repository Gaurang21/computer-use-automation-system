// A scripted Brain. Each turn names its target by role and name or label, and
// is resolved against the live observation, exactly where a model would point.
// No API key, no spend: the whole discovery path runs on it.

import type { FakeTurn, GoalSpec } from './goal.js';
import type {
  Brain,
  DecideContext,
  OutcomeClassification,
  Proposal,
  StepSummary,
  ToolCall,
  TranscriptEntry,
} from './brain.js';
import { renderDecidePrompt } from './anthropic-brain.js';
import type { Observation } from '../surface/types.js';

export class FakeBrain implements Brain {
  readonly model = 'fake-llm';
  private turn = 0;
  private sink: ((e: TranscriptEntry) => void) | undefined;

  constructor(private readonly script: NonNullable<GoalSpec['fake']>) {}

  /** Records the same prompt text a real model would get, so fake runs exercise transcript redaction too. */
  setTranscript(sink: (e: TranscriptEntry) => void): void {
    this.sink = sink;
  }

  async decide(ctx: DecideContext): Promise<ToolCall> {
    const call = this.next(ctx);
    this.sink?.({
      purpose: 'decide',
      model: this.model,
      request: renderDecidePrompt(ctx),
      response: call,
    });
    return call;
  }

  private next(ctx: DecideContext): ToolCall {
    const t = this.script.turns[this.turn++];
    if (!t) return { tool: 'stuck', reason: 'fake script ran out of turns', intent: 'Give up' };
    const ref = t.target ? this.find(ctx.observation, t) : '';
    switch (t.tool) {
      case 'click':
        return { tool: 'click', ref, intent: t.intent };
      case 'type':
        return { tool: 'type', ref, value: t.value ?? '', intent: t.intent };
      case 'select':
        return { tool: 'select', ref, value: t.value ?? '', intent: t.intent };
      case 'read':
        return { tool: 'read', ref, output: t.output ?? '', intent: t.intent };
      case 'press':
        return { tool: 'press', key: t.key ?? 'Enter', intent: t.intent };
      case 'wait':
        return { tool: 'wait', intent: t.intent };
      case 'done':
        return { tool: 'done', summary: t.summary ?? 'done', intent: t.intent };
      case 'stuck':
        return { tool: 'stuck', reason: t.reason ?? 'scripted stuck', intent: t.intent };
    }
  }

  async propose(_goal: string, capabilityId: string, steps: StepSummary[]): Promise<Proposal> {
    const d = this.script.describe;
    return {
      title: d?.title ?? capabilityId,
      description: d?.description ?? `Scripted capability ${capabilityId}`,
      expects: d?.expects ?? {},
      risks: d?.risks ?? Object.fromEntries(steps.map((s) => [s.id, 'read'])),
    };
  }

  async classify(_goal: string, _intent: string, obs: Observation): Promise<OutcomeClassification> {
    const hit = this.script.classify.find((c) =>
      obs.elements.some((e) => e.name.includes(c.textPresent)),
    );
    return hit
      ? {
          kind: 'business_outcome',
          code: hit.code,
          message: hit.message,
          textPresent: hit.textPresent,
        }
      : { kind: 'unknown' };
  }

  private find(obs: Observation, t: FakeTurn): string {
    const target = t.target;
    if (!target) return '';
    const hit = obs.elements.find(
      (e) =>
        e.role === target.role &&
        (target.name === undefined || e.name === target.name) &&
        (target.label === undefined || e.nearText?.text === target.label) &&
        (target.framePath === undefined || e.framePath.join('/') === target.framePath.join('/')),
    );
    // A bad ref is fine: the agent loop reports it back as a tool error, like a model mistake.
    return hit?.ref ?? 'e0';
  }
}
