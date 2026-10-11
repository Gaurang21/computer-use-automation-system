import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/schema/result.js';
import { startTenant, type RunningTenant } from '../support/memberdesk.js';
import { approvedCopy, runReplay, testStore } from '../support/replay.js';

const LOOKUP = 'member.lookup_savings_balance';
const OPEN = 'member.open_sub_account';
const openInputs = {
  memberId: '10002',
  accountType: 'Money Market',
  nickname: 'Rainy day',
  openingDeposit: '150.00',
};

function events(r: RunResult & { status: 'failure' }) {
  return readFileSync(r.evidence.log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { type: string });
}

describe('replay engine against tenant A', () => {
  let app: RunningTenant;
  beforeAll(async () => {
    app = await startTenant('tenant-a');
  });
  afterAll(() => app.close());
  beforeEach(() => app.reset());

  describe('success', () => {
    it('returns typed outputs and verifies the checkpoint', async () => {
      const r = await runReplay(app, LOOKUP, { memberId: '10001' });
      expect(r.status).toBe('success');
      if (r.status !== 'success') return;
      expect(r.outputs).toEqual({
        memberName: 'Avery Lindqvist',
        savingsBalance: { amountMinor: 1254032, currency: 'USD' },
      });
      expect(r.meta.effectiveHash).toMatch(/^[0-9a-f]{16}$/);
      expect(r.meta.appVersion).toBe('7.4');
      expect(r.meta.recoveries).toEqual([]);
    });

    it('opens a sub-account when the artifact is approved and the caller confirms', async () => {
      const r = await runReplay(app, OPEN, openInputs, {
        store: testStore([approvedCopy(OPEN)]),
        allowDraft: false,
        confirmIrreversible: true,
      });
      expect(r.status).toBe('success');
      if (r.status === 'success') expect(r.outputs.newAccountNumber).toMatch(/^\d{10}$/);
    });
  });

  describe('business outcomes', () => {
    it.each([
      ['99999', 'MEMBER_NOT_FOUND', 's3'],
      ['10006', 'PERMISSION_DENIED', 's3'],
      ['10004', 'NO_SAVINGS_ACCOUNT', 's5'],
    ])('member %s -> %s', async (memberId, code, atStep) => {
      const r = await runReplay(app, LOOKUP, { memberId });
      expect(r).toMatchObject({ status: 'business_outcome', code, atStep });
    });

    it('a deposit under the minimum is a validation outcome, not a crash', async () => {
      const r = await runReplay(app, OPEN, { ...openInputs, openingDeposit: '5.00' });
      expect(r).toMatchObject({
        status: 'business_outcome',
        code: 'DEPOSIT_BELOW_MINIMUM',
        atStep: 's8',
      });
    });
  });

  describe('recoverable conditions are handled in line', () => {
    it('dismisses a maintenance interstitial', async () => {
      await app.arm({ switch: 'interstitial', path: '/app/search' });
      const r = await runReplay(app, LOOKUP, { memberId: '10001' });
      expect(r.status).toBe('success');
      expect(r.meta.recoveries).toEqual([
        { conditionId: 'maintenance_notice', atStep: 's1', attempts: 1 },
      ]);
    });

    it('signs on again after session expiry and restarts the flow', async () => {
      await app.arm({ switch: 'expireSession', path: '/app/search' });
      const r = await runReplay(app, LOOKUP, { memberId: '10001' });
      expect(r.status).toBe('success');
      expect(r.meta.recoveries.map((x) => x.conditionId)).toEqual(['session_expired']);
    });

    it('survives a slow load by waiting, with no fixed sleeps', async () => {
      await app.arm({ switch: 'slow', ms: 2500, path: '/app/search' });
      const r = await runReplay(app, LOOKUP, { memberId: '10001' });
      expect(r.status).toBe('success');
      expect(r.meta.durationMs).toBeGreaterThanOrEqual(2500);
    });
  });

  describe('failures', () => {
    it('rejects bad input before touching the UI', async () => {
      const r = await runReplay(app, LOOKUP, { memberId: '12' });
      expect(r).toMatchObject({
        status: 'failure',
        code: 'INVALID_INPUT',
        atStep: null,
        retryable: false,
      });
      if (r.status !== 'failure') return;
      expect(events(r).map((e) => e.type)).toEqual(['run', 'result']);
      expect(r.evidence.screenshot).toBeUndefined();
    });

    it('stops on the app error page with a screenshot and observation', async () => {
      await app.arm({ switch: 'error500', path: '/app/search' });
      const r = await runReplay(app, LOOKUP, { memberId: '10001' });
      expect(r).toMatchObject({ status: 'failure', code: 'APP_ERROR', atStep: 's1' });
      if (r.status !== 'failure') return;
      expect(existsSync(r.evidence.screenshot ?? '')).toBe(true);
      expect(readFileSync(r.evidence.observation ?? '', 'utf8')).toContain('Application Error');
      expect(r.observed).toContain('Application Error');
    });

    it('never steps past an unknown screen', async () => {
      await app.arm({ switch: 'unknownDialog', path: '/app/search' });
      const r = await runReplay(app, LOOKUP, { memberId: '10001' });
      expect(r).toMatchObject({
        status: 'failure',
        code: 'UNEXPECTED_STATE',
        atStep: 's1',
        retryable: true,
      });
      if (r.status === 'failure') expect(r.observed).toContain('Compliance Attestation');
    }, 20_000);

    it('gives up when a recoverable condition keeps coming back', async () => {
      await app.arm({ switch: 'interstitial', path: '/app/search', persist: true });
      const r = await runReplay(app, LOOKUP, { memberId: '10001' });
      expect(r).toMatchObject({ status: 'failure', code: 'RECOVERY_EXHAUSTED' });
    });

    it('refuses to guess between two matching rows', async () => {
      const r = await runReplay(app, LOOKUP, { memberId: '10007' });
      expect(r).toMatchObject({ status: 'failure', code: 'TARGET_AMBIGUOUS', atStep: 's5' });
    });

    it('will not resubmit a write after the session expires mid-submit', async () => {
      await app.arm({ switch: 'expireSession', path: '/app/subaccount/submit' });
      const r = await runReplay(app, OPEN, openInputs, {
        store: testStore([approvedCopy(OPEN)]),
        confirmIrreversible: true,
      });
      expect(r).toMatchObject({ status: 'failure', code: 'RETRY_UNSAFE', atStep: 's9' });
    });

    it('blocks the irreversible step of a draft capability', async () => {
      const r = await runReplay(app, OPEN, openInputs, { confirmIrreversible: true });
      expect(r).toMatchObject({ status: 'failure', code: 'POLICY_BLOCKED', atStep: 's9' });
    });

    it('blocks the irreversible step without caller confirmation', async () => {
      const r = await runReplay(app, OPEN, openInputs, { store: testStore([approvedCopy(OPEN)]) });
      expect(r).toMatchObject({ status: 'failure', code: 'POLICY_BLOCKED', atStep: 's9' });
    });

    it('refuses a draft without --allow-draft', async () => {
      const r = await runReplay(app, LOOKUP, { memberId: '10001' }, { allowDraft: false });
      expect(r).toMatchObject({ status: 'failure', code: 'NOT_APPROVED' });
    });

    it('fails clearly when a tenant secret is missing', async () => {
      const r = await runReplay(
        app,
        LOOKUP,
        { memberId: '10001' },
        { secrets: { get: () => undefined } },
      );
      expect(r).toMatchObject({ status: 'failure', code: 'MISSING_SECRET' });
    });
  });

  it('keeps sensitive values out of the saved result and log, but returns them to the caller', async () => {
    let dir = '';
    const r = await runReplay(
      app,
      LOOKUP,
      { memberId: '10001' },
      { onStart: (info) => (dir = info.dir) },
    );
    expect(r.status === 'success' && r.outputs.memberName).toBe('Avery Lindqvist');
    const saved =
      readFileSync(join(dir, 'result.json'), 'utf8') + readFileSync(join(dir, 'run.jsonl'), 'utf8');
    for (const leak of [
      'Avery Lindqvist',
      '10001',
      '12,540.32',
      '12540.32',
      'change-me-local-only',
      'teller01',
    ]) {
      expect(saved).not.toContain(leak);
    }
    expect(saved).toContain('[REDACTED:pii]');
    expect(existsSync(join(dir, 'screenshots', 'final.png'))).toBe(true);
  });
});

describe('replay engine against tenant B (same capability, overlay only)', () => {
  let app: RunningTenant;
  beforeAll(async () => {
    app = await startTenant('tenant-b');
  });
  afterAll(() => app.close());

  it('reads the "Share Savings" balance through the overlay renames', async () => {
    const r = await runReplay(app, LOOKUP, { memberId: '10001' }, { tenantId: 'tenant-b' });
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.outputs.savingsBalance).toEqual({ amountMinor: 1254032, currency: 'USD' });
    expect(r.meta.tenantId).toBe('tenant-b');
    expect(r.meta.appVersion).toBe('7.2');
  });
});
