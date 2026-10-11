// Typed parameters: what a calling agent supplies and what it gets back.

import { z } from 'zod';

export const SCHEMA_VERSION = '1.0';

export const ValueType = z.enum(['string', 'integer', 'boolean', 'date', 'enum', 'money']);
export type ValueType = z.infer<typeof ValueType>;

/**
 * How a value is handled outside the caller's own result:
 * none (plain), identifier (last two characters in logs), pii and financial
 * (redacted in logs), secret (never logged, never returned).
 */
export const Sensitivity = z.enum(['none', 'identifier', 'pii', 'financial', 'secret']);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const ParamSpec = z
  .object({
    type: ValueType,
    sensitivity: Sensitivity,
    description: z.string().optional(),
    pattern: z.string().optional().describe('Regex the string form must match'),
    enum: z.array(z.string()).min(1).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    currency: z.string().length(3).optional().describe('For money. Defaults to USD.'),
    required: z.boolean().default(true),
  })
  .superRefine((p, ctx) => {
    if (p.type === 'enum' && !p.enum)
      ctx.addIssue({ code: 'custom', message: 'enum params need enum values' });
    if (p.pattern) {
      try {
        new RegExp(p.pattern);
      } catch {
        ctx.addIssue({ code: 'custom', message: `invalid pattern ${p.pattern}` });
      }
    }
  });
export type ParamSpec = z.infer<typeof ParamSpec>;

/** Money is integer minor units plus a currency. Never a float. */
export const Money = z.object({ amountMinor: z.int(), currency: z.string().length(3) });
export type Money = z.infer<typeof Money>;

export const Risk = z.enum(['read', 'reversible_write', 'irreversible']);
export type Risk = z.infer<typeof Risk>;

const RISK_ORDER: Record<Risk, number> = { read: 0, reversible_write: 1, irreversible: 2 };

export function maxRisk(...risks: Risk[]): Risk {
  return risks.reduce<Risk>((a, b) => (RISK_ORDER[b] > RISK_ORDER[a] ? b : a), 'read');
}

export function riskAtLeast(risk: Risk, floor: Risk): boolean {
  return RISK_ORDER[risk] >= RISK_ORDER[floor];
}
