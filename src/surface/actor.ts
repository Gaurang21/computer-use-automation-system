import { HUMAN_ONLY_ACTIONS, type Action, type Actor } from './types.js';

export class ActorNotPermittedError extends Error {
  constructor(
    readonly actor: Actor,
    readonly actionType: Action['type'],
  ) {
    super(`${actor} may not perform ${actionType}: raw pointer and key input is for humans only`);
    this.name = 'ActorNotPermittedError';
  }
}

/**
 * Automation must act on resolved elements, never raw coordinates or raw
 * keystrokes, so every automated action stays replayable and policy-checkable.
 */
export function assertActorMayUse(action: Action, actor: Actor): void {
  if (actor === 'automation' && HUMAN_ONLY_ACTIONS.includes(action.type)) {
    throw new ActorNotPermittedError(actor, action.type);
  }
}
