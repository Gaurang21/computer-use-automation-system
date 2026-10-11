import { z } from 'zod';
import { Risk } from './values.js';

export const Policy = z.strictObject({
  allowedOrigins: z.array(z.string()).min(1),
  allowedRoutes: z
    .array(z.string())
    .min(1)
    .describe('Path globs. ** spans segments, * stays in one.'),
  blockedRoutes: z.array(z.string()).default([]),
  allowedActions: z.array(z.enum(['click', 'type', 'select', 'press', 'read', 'wait', 'goto'])),
  allowVisualFallback: z.boolean().default(false),
  irreversible: z.strictObject({
    discovery: z.enum(['require_human_approval', 'block']),
    replay: z.enum(['require_approved_artifact_and_caller_confirmation', 'block']),
  }),
  riskHints: z.array(z.strictObject({ textMatches: z.string(), risk: Risk })).default([]),
  sensitiveLabels: z
    .array(z.string())
    .default([])
    .describe('Labels or column headers whose values are masked in saved screenshots'),
});
export type Policy = z.infer<typeof Policy>;
