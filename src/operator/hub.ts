// The operator hub: open intervention requests, and control transfer for each
// live session. It runs in the same process that owns the session, so a human
// operates the very same browser the automation was using, through the very
// same Surface (actor 'human'), and the same logger records what they do.

import { randomBytes } from 'node:crypto';
import type { RunLogger } from '../evidence/logger.js';
import type { GuardedSurface } from '../policy/guarded-surface.js';
import type { HumanResolution } from '../replay/engine.js';
import { ControlStateMachine, type ControlState } from '../session/state.js';
import type { Action, ObservedElement } from '../surface/types.js';
import type { HandBackChoice, InterventionRequest, Notifier } from './types.js';

export interface HumanActionRecord {
  at: string;
  action: string;
  element?: string;
  detail: Record<string, unknown>;
}

interface Session {
  runId: string;
  surface: GuardedSurface;
  logger: RunLogger;
  sm: ControlStateMachine;
}

interface Pending {
  request: InterventionRequest;
  session: Session;
  status: 'open' | 'resolved';
  resolution?: HumanResolution;
  humanActions: HumanActionRecord[];
  resolve: (r: HumanResolution) => void;
  timer: NodeJS.Timeout;
}

export type OpenParams = Omit<InterventionRequest, 'id' | 'createdAt'> & {
  surface: GuardedSurface;
  logger: RunLogger;
};

export class OperatorError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export class OperatorHub {
  private readonly sessions = new Map<string, Session>();
  private readonly interventions = new Map<string, Pending>();
  consoleUrl = 'http://localhost:4100';

  constructor(
    private readonly notifiers: Notifier[] = [],
    readonly timeoutMs = Number(process.env.CUA_ESCALATION_TIMEOUT_MS ?? 10 * 60_000),
  ) {}

  /** Raises an intervention and resolves when a human (or the timeout) decides. */
  open(p: OpenParams): Promise<HumanResolution> {
    const session = this.session(p.runId, p.surface, p.logger);
    // A failed resume check already moved the session back to PAUSED.
    if (session.sm.state === 'FAILED')
      return Promise.resolve({
        kind: 'abort',
        interventionId: 'none',
        note: 'resume failed twice',
      });
    if (session.sm.state !== 'PAUSED_AWAITING_HUMAN') session.sm.fire('escalate', p.reasonCode);

    const { surface: _s, logger, ...fields } = p;
    const request: InterventionRequest = {
      ...fields,
      id: `int_${randomBytes(4).toString('hex')}`,
      createdAt: new Date().toISOString(),
    };
    logger.writeJson(`intervention-${request.id}.json`, request);
    logger.event({
      actor: 'system',
      type: 'escalate',
      ...(request.stepId ? { stepId: request.stepId } : {}),
      detail: {
        interventionId: request.id,
        kind: request.kind,
        reasonCode: request.reasonCode,
        lease: session.surface.lease.current,
      },
    });

    return new Promise<HumanResolution>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(request.id, { kind: 'timeout', interventionId: request.id }, 'timeout');
      }, this.timeoutMs);
      timer.unref();
      this.interventions.set(request.id, {
        request,
        session,
        status: 'open',
        humanActions: [],
        resolve,
        timer,
      });
      for (const n of this.notifiers) void n.notify(request, `${this.consoleUrl}/#${request.id}`);
    });
  }

  list(): (InterventionRequest & { status: string; state: ControlState; lease: string })[] {
    return [...this.interventions.values()].map((p) => ({
      ...p.request,
      status: p.status,
      state: p.session.sm.state,
      lease: p.session.surface.lease.current.owner,
    }));
  }

  get(id: string): Pending {
    const p = this.interventions.get(id);
    if (!p) throw new OperatorError(`no intervention ${id}`, 404);
    return p;
  }

  takeControl(id: string, operator = 'operator'): void {
    const p = this.openOnly(id);
    if (!p.request.allowed.includes('take_control'))
      throw new OperatorError('take_control is not offered for this request');
    p.session.sm.fire('take_control', `${operator} took control`);
    p.session.logger.event({
      actor: 'human',
      type: 'control',
      detail: {
        interventionId: id,
        event: 'take_control',
        operator,
        lease: p.session.surface.lease.current,
      },
    });
  }

  /** A human action on the live session. Only pointer, key and goto are offered to people. */
  async humanAct(id: string, action: Action): Promise<HumanActionRecord> {
    const p = this.openOnly(id);
    if (p.session.sm.state !== 'HUMAN_CONTROL') throw new OperatorError('take control first');
    const before = await p.session.surface.observe();
    const element =
      action.type === 'pointer' ? elementAt(before.elements, action.x, action.y) : undefined;
    await p.session.surface.act(action, 'human');
    const detail: Record<string, unknown> =
      action.type === 'pointer'
        ? { x: action.x, y: action.y }
        : action.type === 'key'
          ? // Typed text may be a secret: log its length only.
            {
              ...(action.key ? { key: action.key } : {}),
              ...(action.text ? { textLength: action.text.length } : {}),
            }
          : { type: action.type };
    const record: HumanActionRecord = {
      at: new Date().toISOString(),
      action: action.type,
      ...(element
        ? { element: `${element.role} "${element.name || element.nearText?.text || ''}"` }
        : {}),
      detail,
    };
    p.humanActions.push(record);
    p.session.logger.event({
      actor: 'human',
      type: 'act',
      detail: { interventionId: id, ...record },
    });
    return record;
  }

  async liveScreenshot(id: string): Promise<Buffer> {
    return this.get(id).session.surface.screenshot();
  }

  async elements(id: string): Promise<ObservedElement[]> {
    return (await this.get(id).session.surface.observe()).elements;
  }

  handBack(id: string, choice: HandBackChoice, note?: string): void {
    const p = this.openOnly(id);
    if (p.session.sm.state !== 'HUMAN_CONTROL')
      throw new OperatorError('only the operator in control can hand back');
    if (!p.request.handBackChoices.includes(choice))
      throw new OperatorError(
        `"${choice}" is not offered here (${p.request.handBackChoices.join(', ')})`,
      );
    if (choice === 'abort')
      return this.finish(
        id,
        { kind: 'abort', interventionId: id, ...(note ? { note } : {}) },
        'abort',
      );
    this.finish(id, { kind: choice, interventionId: id, ...(note ? { note } : {}) }, 'hand_back');
  }

  approve(id: string, note?: string): void {
    const p = this.openOnly(id);
    if (!p.request.allowed.includes('approve')) throw new OperatorError('nothing to approve here');
    this.finish(id, { kind: 'approve', interventionId: id, ...(note ? { note } : {}) }, 'approve');
  }

  reject(id: string, note?: string): void {
    const p = this.openOnly(id);
    if (!p.request.allowed.includes('reject')) throw new OperatorError('nothing to reject here');
    this.finish(id, { kind: 'reject', interventionId: id, ...(note ? { note } : {}) }, 'reject');
  }

  abort(id: string, note?: string): void {
    this.openOnly(id);
    this.finish(id, { kind: 'abort', interventionId: id, ...(note ? { note } : {}) }, 'abort');
  }

  /** The automation reports whether its resume check passed after a handback. */
  resumed(interventionId: string, ok: boolean): void {
    const p = this.interventions.get(interventionId);
    if (!p || p.session.sm.state !== 'RESUMING') return;
    p.session.sm.fire(ok ? 'resume_ok' : 'resume_failed');
    p.session.logger.event({
      actor: 'automation',
      type: 'control',
      detail: {
        interventionId,
        event: ok ? 'resume_ok' : 'resume_failed',
        state: p.session.sm.state,
        lease: p.session.surface.lease.current,
      },
    });
  }

  humanActions(id: string): HumanActionRecord[] {
    return this.get(id).humanActions;
  }

  private finish(
    id: string,
    resolution: HumanResolution,
    event: 'hand_back' | 'approve' | 'reject' | 'abort' | 'timeout',
  ): void {
    const p = this.get(id);
    if (p.status !== 'open') return;
    clearTimeout(p.timer);
    p.session.sm.fire(event);
    p.status = 'resolved';
    p.resolution = resolution;
    p.session.logger.event({
      actor: event === 'timeout' ? 'system' : 'human',
      type: 'control',
      detail: {
        interventionId: id,
        event,
        resolution,
        state: p.session.sm.state,
        lease: p.session.surface.lease.current,
        humanActions: p.humanActions.length,
      },
    });
    p.session.logger.writeJson(`intervention-${id}.resolution.json`, {
      resolution,
      humanActions: p.humanActions,
      transitions: p.session.sm.history,
    });
    p.resolve(resolution);
  }

  private openOnly(id: string): Pending {
    const p = this.get(id);
    if (p.status !== 'open') throw new OperatorError(`intervention ${id} is already resolved`);
    return p;
  }

  private session(runId: string, surface: GuardedSurface, logger: RunLogger): Session {
    let s = this.sessions.get(runId);
    if (!s || s.surface !== surface) {
      s = { runId, surface, logger, sm: new ControlStateMachine(surface.lease) };
      this.sessions.set(runId, s);
    }
    return s;
  }
}

function elementAt(elements: ObservedElement[], x: number, y: number): ObservedElement | undefined {
  return elements
    .filter(
      (e) => x >= e.bbox.x && x <= e.bbox.x + e.bbox.w && y >= e.bbox.y && y <= e.bbox.y + e.bbox.h,
    )
    .sort((a, b) => a.bbox.w * a.bbox.h - b.bbox.w * b.bbox.h)[0];
}
