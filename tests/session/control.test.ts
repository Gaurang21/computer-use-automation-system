import { describe, expect, it } from 'vitest';
import { ControlLease, LeaseViolationError } from '../../src/session/lease.js';
import { ControlStateMachine, InvalidTransitionError } from '../../src/session/state.js';

describe('control lease', () => {
  it('has exactly one holder and rejects the other actor', () => {
    const lease = new ControlLease();
    expect(lease.holds('automation')).toBe(true);
    expect(() => lease.assertHeld('human')).toThrow(LeaseViolationError);
    const before = lease.current.leaseId;
    lease.transfer('human', 'operator took control');
    expect(lease.holds('human')).toBe(true);
    expect(lease.holds('automation')).toBe(false);
    expect(lease.current.leaseId).not.toBe(before);
  });
});

describe('control state machine', () => {
  it('walks escalate -> take control -> hand back -> resume, moving the lease each time', () => {
    const lease = new ControlLease();
    const sm = new ControlStateMachine(lease);
    expect(sm.fire('escalate')).toBe('PAUSED_AWAITING_HUMAN');
    expect(lease.current.owner).toBe('none');
    expect(sm.fire('take_control')).toBe('HUMAN_CONTROL');
    expect(lease.current.owner).toBe('human');
    expect(sm.fire('hand_back')).toBe('RESUMING');
    expect(lease.current.owner).toBe('automation');
    expect(sm.fire('resume_ok')).toBe('RUNNING');
    expect(sm.history.map((h) => h.event)).toEqual([
      'escalate',
      'take_control',
      'hand_back',
      'resume_ok',
    ]);
  });

  it('approves or rejects without taking control, and times out', () => {
    const a = new ControlStateMachine(new ControlLease());
    a.fire('escalate');
    expect(a.fire('approve')).toBe('RESUMING');
    const r = new ControlStateMachine(new ControlLease());
    r.fire('escalate');
    expect(r.fire('reject')).toBe('ABORTED');
    const t = new ControlStateMachine(new ControlLease());
    t.fire('escalate');
    expect(t.fire('timeout')).toBe('FAILED');
  });

  it('re-escalates after one failed resume check and fails after the second', () => {
    const sm = new ControlStateMachine(new ControlLease());
    sm.fire('escalate');
    sm.fire('take_control');
    sm.fire('hand_back');
    expect(sm.fire('resume_failed')).toBe('PAUSED_AWAITING_HUMAN');
    sm.fire('take_control');
    sm.fire('hand_back');
    expect(sm.fire('resume_failed')).toBe('FAILED');
  });

  it('rejects transitions the table does not allow', () => {
    const sm = new ControlStateMachine(new ControlLease());
    expect(() => sm.fire('take_control')).toThrow(InvalidTransitionError);
    sm.fire('escalate');
    expect(() => sm.fire('hand_back')).toThrow(/cannot hand_back while PAUSED_AWAITING_HUMAN/);
  });
});
