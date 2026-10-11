import { describe, expect, it } from 'vitest';
import { contentHash, isApproved } from '../../src/replay/hash.js';
import {
  CapabilityDisabledError,
  CapabilityStore,
  applyPatch,
  mergeEffective,
} from '../../src/replay/store.js';
import { versionInRange } from '../../src/replay/version.js';

const store = new CapabilityStore('capabilities', 'memberdesk', ['tests/fixtures/capabilities']);

describe('capability store and overlay merging', () => {
  it('finds capabilities in the app folder and extra folders', () => {
    expect(store.ids()).toEqual([
      'auth.login',
      'member.lookup_savings_balance',
      'member.open_sub_account',
    ]);
  });

  it('applies tenant B renames to locators and matchers, but not to bindings or codes', () => {
    const eff = store.effective('member.lookup_savings_balance', 'tenant-b');
    const json = JSON.stringify(eff.capability);
    expect(json).toContain('"label":"Account Holder No."');
    expect(json).toContain('"text":"Find"');
    expect(json).toContain('"equals":"Share Savings"');
    // Whole-string only: "Member Search" must not become "Member Find".
    expect(json).toContain('"text":"Member Search"');
    expect(json).toContain('"from":"inputs.memberId"');
    expect(eff.overlay.baseUrl).toBe('http://localhost:4001');
  });

  it('leaves tenant A untouched and gives each tenant its own effective hash', () => {
    const a = store.effective('member.lookup_savings_balance', 'tenant-a');
    const b = store.effective('member.lookup_savings_balance', 'tenant-b');
    expect(a.capability).toEqual(store.capability('member.lookup_savings_balance'));
    expect(a.effectiveHash).not.toBe(b.effectiveHash);
    expect(store.effective('member.lookup_savings_balance', 'tenant-a').effectiveHash).toBe(
      a.effectiveHash,
    );
  });

  it('applies version-scoped JSON patches and honours disabled capabilities', () => {
    const overlay = store.overlay('tenant-b');
    overlay.patches = [
      {
        capabilityId: 'member.lookup_savings_balance',
        appVersions: '>=7.2 <7.3',
        ops: [{ op: 'replace', path: '/steps/0/timeoutMs', value: 15000 }],
        reason: 'v7.2 search page loads slowly',
      },
    ];
    const eff = mergeEffective(
      store.profile(),
      store.capability('member.lookup_savings_balance'),
      overlay,
    );
    expect(eff.capability.steps[0]?.timeoutMs).toBe(15000);

    overlay.disabledCapabilities = ['member.lookup_savings_balance'];
    expect(() =>
      mergeEffective(store.profile(), store.capability('member.lookup_savings_balance'), overlay),
    ).toThrow(CapabilityDisabledError);
  });

  it('patches arrays and objects', () => {
    expect(applyPatch({ a: [1, 2] }, [{ op: 'add', path: '/a/-', value: 3 }])).toEqual({
      a: [1, 2, 3],
    });
    expect(applyPatch({ a: { b: 1 } }, [{ op: 'remove', path: '/a/b' }])).toEqual({ a: {} });
  });

  it('checks app version ranges', () => {
    expect(versionInRange('7.4', '>=7.2 <8')).toBe(true);
    expect(versionInRange('8.0', '>=7.2 <8')).toBe(false);
    expect(versionInRange('7.10', '>7.9')).toBe(true);
  });

  it('binds approval to the content hash, so any edit falls back to draft', () => {
    const cap = store.capability('member.lookup_savings_balance');
    expect(isApproved(cap)).toBe(false);
    const approved = {
      ...cap,
      status: 'approved' as const,
      approval: { by: 'reviewer', at: new Date().toISOString(), contentHash: contentHash(cap) },
    };
    expect(isApproved(approved)).toBe(true);
    const edited = { ...approved, title: 'changed' };
    expect(isApproved(edited)).toBe(false);
  });
});
