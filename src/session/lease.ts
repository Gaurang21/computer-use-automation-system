// Control of a live session is a lease with exactly one holder. Surface
// actions are checked against it, so automation and a human can never act at
// once, and "who is in control" always has one answer.

import { randomBytes } from 'node:crypto';
import type { Actor } from '../surface/types.js';

export type LeaseOwner = Actor | 'none';

export interface LeaseState {
  owner: LeaseOwner;
  leaseId: string;
  since: string;
  reason?: string;
}

export class LeaseViolationError extends Error {
  constructor(
    readonly actor: Actor,
    readonly lease: LeaseState,
  ) {
    super(
      `${actor} does not hold the control lease (held by ${lease.owner} since ${lease.since}${lease.reason ? `: ${lease.reason}` : ''})`,
    );
    this.name = 'LeaseViolationError';
  }
}

export class ControlLease {
  private state: LeaseState;
  private readonly listeners: ((s: LeaseState) => void)[] = [];

  constructor(owner: LeaseOwner = 'automation') {
    this.state = { owner, leaseId: newId(), since: new Date().toISOString() };
  }

  get current(): LeaseState {
    return { ...this.state };
  }

  holds(actor: Actor): boolean {
    return this.state.owner === actor;
  }

  assertHeld(actor: Actor): void {
    if (!this.holds(actor)) throw new LeaseViolationError(actor, this.current);
  }

  /** Transfers control. Every transfer gets a new lease id. */
  transfer(owner: LeaseOwner, reason?: string): LeaseState {
    this.state = {
      owner,
      leaseId: newId(),
      since: new Date().toISOString(),
      ...(reason ? { reason } : {}),
    };
    for (const l of this.listeners) l(this.current);
    return this.current;
  }

  onChange(listener: (s: LeaseState) => void): void {
    this.listeners.push(listener);
  }
}

function newId(): string {
  return `lease_${randomBytes(4).toString('hex')}`;
}
