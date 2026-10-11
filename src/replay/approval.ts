// Approval binds a reviewer and a time to the capability's content hash. Any
// later edit changes the hash, so the artifact falls back to draft by itself.

import { readFileSync, writeFileSync } from 'node:fs';
import { Capability } from '../schema/capability.js';
import { contentHash } from './hash.js';

export function approveCapabilityFile(file: string, by: string, at = new Date()): Capability {
  const cap = Capability.parse(JSON.parse(readFileSync(file, 'utf8')));
  const approved: Capability = {
    ...cap,
    status: 'approved',
    approval: { by, at: at.toISOString(), contentHash: contentHash(cap) },
  };
  writeFileSync(file, JSON.stringify(approved, null, 2) + '\n');
  return approved;
}
