import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { approveCapabilityFile } from '../../src/replay/approval.js';
import { isApproved } from '../../src/replay/hash.js';
import { Capability } from '../../src/schema/capability.js';

describe('approval', () => {
  it('approves a capability file and drops back to draft when a step is edited', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cap-')), 'c.json');
    copyFileSync('tests/fixtures/capabilities/member.open_sub_account.json', file);
    const approved = approveCapabilityFile(file, 'gaurang');
    expect(isApproved(approved)).toBe(true);
    expect(approved.approval?.by).toBe('gaurang');

    // A reviewer lowering the risk of the Submit step changes the content hash.
    const edited = JSON.parse(readFileSync(file, 'utf8'));
    edited.steps[8].risk = 'read';
    writeFileSync(file, JSON.stringify(edited));
    expect(isApproved(Capability.parse(edited))).toBe(false);
  });
});
