// An app profile: what is true of a vendor product on every screen and for
// every tenant. How to recognise it, which versions were tested, and the
// runtime conditions that can appear anywhere (session expiry, maintenance
// notices, permission denials, error pages) with how to handle each.

import { z } from 'zod';
import { StateMatcher } from './matcher.js';
import { TargetSpec } from './target.js';
import { SCHEMA_VERSION } from './values.js';

export const RecoveryStep = z.strictObject({
  action: z.enum(['click', 'press', 'wait']),
  target: TargetSpec.optional(),
  key: z.string().optional(),
  ms: z.int().min(0).max(10_000).optional(),
});
export type RecoveryStep = z.infer<typeof RecoveryStep>;

export const Condition = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    class: z.enum(['recoverable', 'business_outcome', 'hard_failure']),
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    message: z.string().optional(),
    detect: StateMatcher,
    recover: z
      .strictObject({
        steps: z.array(RecoveryStep).optional(),
        runCapability: z.string().optional(),
        then: z
          .enum(['continue', 'retry_step', 'restart'])
          .describe(
            'continue: re-check the current step; retry_step: run it again; restart: run the flow from step one',
          ),
      })
      .optional(),
    maxAttempts: z.int().min(1).max(5).default(1),
  })
  .superRefine((c, ctx) => {
    if (c.class === 'recoverable' && !c.recover)
      ctx.addIssue({ code: 'custom', message: `${c.id}: recoverable conditions need recover` });
    if (c.class !== 'recoverable' && !c.code)
      ctx.addIssue({ code: 'custom', message: `${c.id}: ${c.class} conditions need a code` });
  });
export type Condition = z.infer<typeof Condition>;

export const AppProfile = z.strictObject({
  kind: z.literal('app_profile'),
  schemaVersion: z.literal(SCHEMA_VERSION),
  appId: z.string().min(1),
  surface: z.enum(['web', 'desktop']),
  identity: z.strictObject({
    fingerprint: StateMatcher,
    versionPattern: z
      .string()
      .describe('Regex with one group capturing major.minor from screen text'),
    testedVersions: z.array(z.string()).min(1),
  }),
  conditions: z.array(Condition),
});
export type AppProfile = z.infer<typeof AppProfile>;
