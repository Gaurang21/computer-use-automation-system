// The replay result contract. Three statuses, kept strictly apart:
// - success: the flow finished and the success check held. Outputs are typed.
// - business_outcome: a legitimate answer the caller needs ("no such member").
// - failure: the run could not complete. Says where, what was expected, what
//   was seen, and points at evidence.
// Recoverable conditions never surface as a status. They are handled in line
// and listed in meta.recoveries.

import { z } from 'zod';

export const FailureCode = z.enum([
  'INVALID_INPUT',
  'NOT_APPROVED',
  'CAPABILITY_DISABLED',
  'POLICY_BLOCKED',
  'APP_VERSION_UNSUPPORTED',
  'MISSING_SECRET',
  'TARGET_NOT_FOUND',
  'TARGET_AMBIGUOUS',
  'UNEXPECTED_STATE',
  'RECOVERY_EXHAUSTED',
  'RETRY_UNSAFE',
  'APP_ERROR',
  'OUTPUT_PARSE_ERROR',
  'CHECKPOINT_FAILED',
  'ESCALATION_TIMEOUT',
  'ABORTED_BY_OPERATOR',
  'INTERNAL_ERROR',
]);
export type FailureCode = z.infer<typeof FailureCode>;

export const RunMeta = z.object({
  runId: z.string(),
  capabilityId: z.string(),
  version: z.string(),
  effectiveHash: z.string().describe('Hash of the merged profile + capability + overlay that ran'),
  tenantId: z.string(),
  appVersion: z.string().optional(),
  startedAt: z.iso.datetime(),
  durationMs: z.number(),
  warnings: z.array(z.string()),
  recoveries: z.array(
    z.object({ conditionId: z.string(), atStep: z.string(), attempts: z.number() }),
  ),
  locatorDrift: z.array(
    z.object({ stepId: z.string(), usedLocator: z.number(), kind: z.string() }),
  ),
  humanInterventions: z.array(
    z.object({ interventionId: z.string(), atStep: z.string().nullable(), resolution: z.string() }),
  ),
});
export type RunMeta = z.infer<typeof RunMeta>;

export const RunResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    outputs: z.record(z.string(), z.unknown()),
    meta: RunMeta,
  }),
  z.object({
    status: z.literal('business_outcome'),
    code: z.string(),
    message: z.string(),
    atStep: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    meta: RunMeta,
  }),
  z.object({
    status: z.literal('failure'),
    code: FailureCode,
    atStep: z.string().nullable(),
    expected: z.string(),
    observed: z.string(),
    retryable: z.boolean(),
    evidence: z.object({
      screenshot: z.string().optional(),
      observation: z.string().optional(),
      log: z.string(),
    }),
    meta: RunMeta,
  }),
]);
export type RunResult = z.infer<typeof RunResult>;

/** CLI exit codes: 0 success, 10 business outcome, 20 failure. */
export function exitCodeFor(result: RunResult): number {
  return result.status === 'success' ? 0 : result.status === 'business_outcome' ? 10 : 20;
}
