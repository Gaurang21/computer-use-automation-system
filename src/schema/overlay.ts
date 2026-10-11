// A tenant overlay: what differs for one institution running the shared
// vendor product. Most differences are label renames (textMap), so most
// tenants need no patches. Patches are the escape hatch.

import { z } from 'zod';
import { SCHEMA_VERSION } from './values.js';

export const JsonPatchOp = z.strictObject({
  op: z.enum(['add', 'remove', 'replace']),
  path: z.string().startsWith('/'),
  value: z.unknown().optional(),
});
export type JsonPatchOp = z.infer<typeof JsonPatchOp>;

export const TenantOverlay = z.strictObject({
  kind: z.literal('tenant_overlay'),
  schemaVersion: z.literal(SCHEMA_VERSION),
  tenantId: z.string().min(1),
  appId: z.string().min(1),
  appVersion: z.string().min(1),
  baseUrl: z.url(),
  textMap: z
    .record(z.string(), z.string())
    .default({})
    .describe('Base label -> tenant label, applied to every locator and matcher string at load'),
  patches: z
    .array(
      z.strictObject({
        capabilityId: z.string(),
        appVersions: z.string().optional(),
        ops: z.array(JsonPatchOp).min(1),
        reason: z.string().min(1),
      }),
    )
    .default([]),
  disabledCapabilities: z.array(z.string()).default([]),
  secrets: z
    .record(z.string(), z.strictObject({ env: z.string().min(1) }))
    .default({})
    .describe('secrets.<name> -> environment variable. Credentials are per institution.'),
});
export type TenantOverlay = z.infer<typeof TenantOverlay>;
