import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicy } from '../../src/policy/gate.js';
import { replay, type ReplayOptions } from '../../src/replay/engine.js';
import { contentHash } from '../../src/replay/hash.js';
import { CapabilityStore } from '../../src/replay/store.js';
import type { Capability } from '../../src/schema/capability.js';
import type { RunningTenant } from './memberdesk.js';

export const FIXTURES = 'tests/fixtures/capabilities';

export function testStore(extraDirs: string[] = []): CapabilityStore {
  return new CapabilityStore('capabilities', 'memberdesk', [...extraDirs, FIXTURES]);
}

/** Writes an approved copy of a fixture capability into a temp dir and returns the dir. */
export function approvedCopy(id: string, by = 'test-reviewer'): string {
  const cap = testStore().capability(id);
  const approved: Capability = {
    ...cap,
    status: 'approved',
    approval: { by, at: new Date().toISOString(), contentHash: contentHash(cap) },
  };
  const dir = mkdtempSync(join(tmpdir(), 'approved-'));
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(approved, null, 2));
  return dir;
}

export function runReplay(
  app: RunningTenant,
  capabilityId: string,
  inputs: Record<string, unknown>,
  over: Partial<ReplayOptions> = {},
) {
  const policy = { ...loadPolicy(), allowedOrigins: [app.baseUrl] };
  return replay({
    store: testStore(),
    capabilityId,
    tenantId: 'tenant-a',
    inputs,
    policy,
    baseUrl: app.baseUrl,
    evidenceDir: mkdtempSync(join(tmpdir(), 'runs-')),
    allowDraft: true,
    pollMs: 100,
    ...over,
  });
}
