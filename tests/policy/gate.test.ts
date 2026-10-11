import { describe, expect, it } from 'vitest';
import {
  checkAction,
  globMatch,
  loadPolicy,
  urlBlockedReason,
  type GateRequest,
} from '../../src/policy/gate.js';
import type { ObservedElement } from '../../src/surface/types.js';

const policy = loadPolicy();
const button = (name: string): ObservedElement => ({
  ref: 'e1',
  role: 'button',
  name,
  framePath: ['main'],
  bbox: { x: 0, y: 0, w: 10, h: 10 },
  states: [],
});
const req = (over: Partial<GateRequest>): GateRequest => ({
  mode: 'replay',
  actor: 'automation',
  action: { type: 'click', ref: 'e1' },
  element: button('Search'),
  frameUrl: 'http://localhost:4000/app/search',
  ...over,
});

describe('policy gate', () => {
  it('blocks navigation to the admin route and the chaos endpoint', () => {
    for (const url of ['http://localhost:4000/app/admin', 'http://localhost:4000/__chaos']) {
      const d = checkAction(policy, req({ action: { type: 'goto', url } }));
      expect(d.verdict).toBe('block');
    }
  });

  it('blocks an off-origin request, for the human too', () => {
    for (const actor of ['automation', 'human'] as const) {
      const d = checkAction(
        policy,
        req({ actor, action: { type: 'goto', url: 'https://example.com/' } }),
      );
      expect(d).toMatchObject({ verdict: 'block', rule: 'allowlist' });
    }
  });

  it('blocks acting on a page that is outside the allowlist', () => {
    const d = checkAction(policy, req({ frameUrl: 'http://localhost:4000/app/admin' }));
    expect(d).toMatchObject({ verdict: 'block', rule: 'allowlist' });
  });

  it('allows ordinary reads and reversible writes unattended', () => {
    expect(checkAction(policy, req({})).verdict).toBe('allow');
    expect(
      checkAction(
        policy,
        req({ action: { type: 'type', ref: 'e1', text: 'x' }, declaredRisk: 'reversible_write' }),
      ),
    ).toEqual({ verdict: 'allow', risk: 'reversible_write' });
  });

  it('blocks action types outside the allowlist', () => {
    const narrow = { ...policy, allowedActions: ['click' as const] };
    const d = checkAction(narrow, req({ action: { type: 'type', ref: 'e1', text: 'x' } }));
    expect(d).toMatchObject({ verdict: 'block', rule: 'action_type' });
  });

  it('raises risk from text hints even when the artifact under-declares it', () => {
    const d = checkAction(policy, req({ element: button('Submit'), declaredRisk: 'read' }));
    expect(d).toMatchObject({ verdict: 'block', risk: 'irreversible' });
  });

  it('pauses for a human on an irreversible step in discovery', () => {
    const d = checkAction(policy, req({ mode: 'discovery', element: button('Submit') }));
    expect(d.verdict).toBe('needs_approval');
    expect(
      checkAction(
        policy,
        req({ mode: 'discovery', element: button('Submit'), humanApproved: true }),
      ).verdict,
    ).toBe('allow');
  });

  it('runs an irreversible replay step only for an approved artifact with caller confirmation', () => {
    const submit = { element: button('Submit'), declaredRisk: 'irreversible' as const };
    expect(checkAction(policy, req({ ...submit })).verdict).toBe('block');
    expect(checkAction(policy, req({ ...submit, artifactApproved: true })).verdict).toBe('block');
    expect(checkAction(policy, req({ ...submit, callerConfirmedIrreversible: true })).verdict).toBe(
      'block',
    );
    expect(
      checkAction(
        policy,
        req({ ...submit, artifactApproved: true, callerConfirmedIrreversible: true }),
      ).verdict,
    ).toBe('allow');
  });

  it('lets the human operator take an irreversible action (they are the authority being asked)', () => {
    expect(checkAction(policy, req({ actor: 'human', element: button('Submit') })).verdict).toBe(
      'allow',
    );
  });

  it('matches route globs', () => {
    expect(globMatch('/app/**', '/app/a/b')).toBe(true);
    expect(globMatch('/app/*', '/app/a/b')).toBe(false);
    expect(globMatch('/', '/')).toBe(true);
    expect(urlBlockedReason(policy, 'http://localhost:4000/app/admin/reset-passwords')).toMatch(
      /blocked/,
    );
    expect(urlBlockedReason(policy, 'http://localhost:4000/other')).toMatch(/not in the allowlist/);
    expect(urlBlockedReason(policy, 'about:blank')).toBeUndefined();
  });
});
