import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { containsValue } from '../../src/discovery/discover.js';
import { CapabilityStore } from '../../src/replay/store.js';

describe('regressions found in the first real evidence run', () => {
  it('a draft folder wins over a saved capability with the same id (probes and self-check test the draft)', () => {
    const root = mkdtempSync(join(tmpdir(), 'caps-'));
    cpSync('capabilities/memberdesk', join(root, 'memberdesk'), { recursive: true });
    const fixture = JSON.parse(
      readFileSync('tests/fixtures/capabilities/member.lookup_savings_balance.json', 'utf8'),
    );
    writeFileSync(
      join(root, 'memberdesk', 'member.lookup_savings_balance.json'),
      JSON.stringify({ ...fixture, title: 'stale saved copy' }),
    );
    const draftDir = join(root, 'draft');
    mkdirSync(draftDir);
    writeFileSync(
      join(draftDir, 'member.lookup_savings_balance.json'),
      JSON.stringify({ ...fixture, title: 'fresh draft' }),
    );

    const store = new CapabilityStore(root, 'memberdesk', [draftDir]);
    expect(store.capability('member.lookup_savings_balance').title).toBe('fresh draft');
    expect(store.fileOf('member.lookup_savings_balance')).toBe(
      join(draftDir, 'member.lookup_savings_balance.json'),
    );
  });

  it('an input value inside a longer number is not a leak ("5.00" in "$25.00")', () => {
    expect(containsValue('Opening deposit must be at least $25.00.', '5.00')).toBe(false);
    expect(containsValue('Deposit of 5.00 is too small', '5.00')).toBe(true);
    expect(containsValue('No member found for Member ID 99999.', '99999')).toBe(true);
    expect(containsValue('Account 7001000101', '10001')).toBe(false);
  });
});
