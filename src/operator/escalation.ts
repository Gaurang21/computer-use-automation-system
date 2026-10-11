// Adapters from the replay engine's and the discovery agent's escalation seams
// to the operator hub.

import type { DiscoveryEscalation, DiscoveryEscalationContext } from '../discovery/agent.js';
import type { Escalation, HumanResolution, StuckContext } from '../replay/engine.js';
import { summarizeObservation } from '../surface/describe.js';
import type { OperatorHub } from './hub.js';
import type { HandBackChoice } from './types.js';

export class OperatorReplayEscalation implements Escalation {
  constructor(private readonly hub: OperatorHub) {}

  request(ctx: StuckContext): Promise<HumanResolution> {
    const handBackChoices = ctx.allowed.filter(
      (a): a is HandBackChoice => a === 'retry' || a === 'continue' || a === 'abort',
    );
    return this.hub.open({
      runId: ctx.runId,
      mode: 'replay',
      kind: 'stuck',
      capabilityId: ctx.capabilityId,
      ...(ctx.stepId ? { stepId: ctx.stepId } : {}),
      ...(ctx.stepIntent ? { stepIntent: ctx.stepIntent } : {}),
      reasonCode: ctx.reasonCode,
      reason: ctx.reason,
      expected: ctx.expected,
      observed: ctx.observed,
      location: ctx.obs.frames.find((f) => f.path.at(-1) === 'main')?.url ?? ctx.obs.location,
      ...(ctx.screenshotPath ? { screenshot: ctx.screenshotPath } : {}),
      allowed: ['take_control', 'abort'],
      handBackChoices,
      surface: ctx.surface,
      logger: ctx.logger,
    });
  }

  resumed(interventionId: string, ok: boolean): void {
    this.hub.resumed(interventionId, ok);
  }
}

export class OperatorDiscoveryEscalation implements DiscoveryEscalation {
  constructor(
    private readonly hub: OperatorHub,
    private readonly goal: string,
    private readonly capabilityId: string,
  ) {}

  async stuck(ctx: DiscoveryEscalationContext): Promise<'resume' | 'abort'> {
    const r = await this.hub.open({
      ...this.base(ctx),
      kind: 'stuck',
      reasonCode: 'DISCOVERY_STUCK',
      reason: ctx.reason,
      allowed: ['take_control', 'abort'],
      handBackChoices: ['continue', 'abort'],
    });
    if (r.kind === 'continue' || r.kind === 'retry') {
      // The model looks at a fresh screen next turn; that is the resume check.
      this.hub.resumed(r.interventionId, true);
      return 'resume';
    }
    return 'abort';
  }

  async approve(
    ctx: DiscoveryEscalationContext & { action: string },
  ): Promise<'approve' | 'reject'> {
    const r = await this.hub.open({
      ...this.base(ctx),
      kind: 'approval',
      reasonCode: 'IRREVERSIBLE_STEP',
      reason: ctx.reason,
      expected: `approval to ${ctx.action}`,
      allowed: ['approve', 'reject'],
      handBackChoices: [],
    });
    if (r.kind === 'approve') {
      this.hub.resumed(r.interventionId, true);
      return 'approve';
    }
    return 'reject';
  }

  private base(ctx: DiscoveryEscalationContext) {
    const saved = ctx.observation.screenshot
      ? ctx.logger.saveScreenshot(
          `escalation-step-${ctx.step}`,
          ctx.observation.screenshot,
          ctx.observation,
        )
      : undefined;
    return {
      runId: ctx.logger.runId,
      mode: 'discovery' as const,
      goal: this.goal,
      capabilityId: this.capabilityId,
      stepId: `step-${ctx.step}`,
      observed: summarizeObservation(ctx.observation),
      location:
        ctx.observation.frames.find((f) => f.path.at(-1) === 'main')?.url ??
        ctx.observation.location,
      ...(saved ? { screenshot: saved } : {}),
      surface: ctx.surface,
      logger: ctx.logger,
    };
  }
}
