// The control-transfer state machine for one escalation. Each state fixes who
// holds the lease, so the state and the lease can never disagree.

import type { ControlLease, LeaseOwner } from './lease.js';

export type ControlState =
  'RUNNING' | 'PAUSED_AWAITING_HUMAN' | 'HUMAN_CONTROL' | 'RESUMING' | 'ABORTED' | 'FAILED';

export type ControlEvent =
  | 'escalate'
  | 'take_control'
  | 'approve'
  | 'reject'
  | 'timeout'
  | 'hand_back'
  | 'abort'
  | 'resume_ok'
  | 'resume_failed';

const TRANSITIONS: Record<ControlState, Partial<Record<ControlEvent, ControlState>>> = {
  RUNNING: { escalate: 'PAUSED_AWAITING_HUMAN' },
  PAUSED_AWAITING_HUMAN: {
    take_control: 'HUMAN_CONTROL',
    approve: 'RESUMING',
    reject: 'ABORTED',
    abort: 'ABORTED',
    timeout: 'FAILED',
  },
  HUMAN_CONTROL: { hand_back: 'RESUMING', abort: 'ABORTED' },
  RESUMING: {
    resume_ok: 'RUNNING',
    resume_failed: 'PAUSED_AWAITING_HUMAN',
    escalate: 'PAUSED_AWAITING_HUMAN',
  },
  ABORTED: {},
  FAILED: {},
};

const LEASE_FOR: Record<ControlState, LeaseOwner> = {
  RUNNING: 'automation',
  PAUSED_AWAITING_HUMAN: 'none',
  HUMAN_CONTROL: 'human',
  RESUMING: 'automation',
  ABORTED: 'none',
  FAILED: 'none',
};

export class InvalidTransitionError extends Error {}

export class ControlStateMachine {
  private _state: ControlState = 'RUNNING';
  private resumeFailures = 0;
  readonly history: { from: ControlState; event: ControlEvent; to: ControlState; at: string }[] =
    [];

  constructor(private readonly lease: ControlLease) {}

  get state(): ControlState {
    return this._state;
  }

  can(event: ControlEvent): boolean {
    return TRANSITIONS[this._state][event] !== undefined;
  }

  fire(event: ControlEvent, reason?: string): ControlState {
    let to = TRANSITIONS[this._state][event];
    if (!to) throw new InvalidTransitionError(`cannot ${event} while ${this._state}`);
    // Resume is never blind: a failed resume check goes back to a human once, then the run fails.
    if (event === 'resume_failed' && ++this.resumeFailures >= 2) to = 'FAILED';
    if (event === 'resume_ok') this.resumeFailures = 0;
    this.history.push({ from: this._state, event, to, at: new Date().toISOString() });
    this._state = to;
    this.lease.transfer(LEASE_FOR[to], reason ?? event);
    return to;
  }
}
