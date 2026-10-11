// Writes JSON Schema for every artifact document and the result contract to
// /schemas, so a calling agent (or a reviewer) can read the contract without
// reading TypeScript.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AppProfile } from './app-profile.js';
import { Capability } from './capability.js';
import { TenantOverlay } from './overlay.js';
import { RunResult } from './result.js';

export const EXPORTED = {
  'app-profile': AppProfile,
  capability: Capability,
  'tenant-overlay': TenantOverlay,
  'run-result': RunResult,
} as const;

export function toJsonSchema(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', reused: 'ref' });
}

export function exportSchemas(dir = 'schemas'): string[] {
  mkdirSync(dir, { recursive: true });
  return Object.entries(EXPORTED).map(([name, schema]) => {
    const file = join(dir, `${name}.schema.json`);
    writeFileSync(file, JSON.stringify(toJsonSchema(schema), null, 2) + '\n');
    return file;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const file of exportSchemas()) console.log(`wrote ${file}`);
}
