import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPolicy } from '../../src/policy/gate.js';
import { PolicyBlockedError, type GuardedSurface } from '../../src/policy/guarded-surface.js';
import { launchGuardedWeb } from '../../src/policy/launch.js';
import { startTenant, type RunningTenant } from '../support/memberdesk.js';
import { hasText, observeUntil } from '../support/poll.js';

describe('GuardedSurface with network routing', () => {
  let app: RunningTenant;
  let surface: GuardedSurface;
  const blockedRequests: string[] = [];
  const decisions: string[] = [];

  beforeAll(async () => {
    app = await startTenant('tenant-a');
    // The test server listens on a random port, so allow that origin explicitly.
    const policy = { ...loadPolicy(), allowedOrigins: [app.baseUrl] };
    ({ surface } = await launchGuardedWeb(
      policy,
      { mode: 'replay' },
      {
        onBlockedRequest: (url) => blockedRequests.push(new URL(url).pathname),
        onDecision: (_req, d) => decisions.push(d.verdict),
      },
    ));
    await surface.act({ type: 'goto', url: app.baseUrl + '/' }, 'automation');
    await observeUntil(surface, hasText('Operator ID'));
  }, 30_000);

  afterAll(async () => {
    await surface?.close();
    await app?.close();
  });

  it('refuses a goto to the admin route before it reaches the browser', async () => {
    await expect(
      surface.act({ type: 'goto', url: app.baseUrl + '/app/admin' }, 'automation'),
    ).rejects.toThrow(PolicyBlockedError);
    expect(decisions.at(-1)).toBe('block');
  });

  it('refuses an off-origin goto', async () => {
    await expect(
      surface.act({ type: 'goto', url: 'https://example.com/' }, 'automation'),
    ).rejects.toThrow(/origin https:\/\/example.com is not allowed/);
  });

  it('aborts at the network layer when a click leads to a blocked route', async () => {
    // A human may click anything, but the network allowlist still binds them.
    const obs = await surface.observe();
    const admin = obs.elements.find((e) => e.role === 'link' && e.name === 'Administration');
    expect(admin).toBeDefined();
    await surface.act({ type: 'click', ref: admin?.ref ?? '' }, 'human');
    await expect.poll(() => blockedRequests).toContain('/app/admin');
    const after = await surface.observe();
    expect(after.elements.some((e) => e.name.includes('Reset All Operator Passwords'))).toBe(false);
  });
});
