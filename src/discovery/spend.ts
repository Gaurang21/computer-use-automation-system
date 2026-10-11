// Model spend, enforced in code. Usage is read from every API response and
// priced; the running total is written to usage.json, and the run aborts as
// soon as it passes the cap.

import { writeFileSync } from 'node:fs';

/** USD per million tokens. Unknown models are priced at the most expensive row. */
export const PRICING: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};
const MOST_EXPENSIVE = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function costUsd(model: string, u: TokenUsage): number {
  const p = PRICING[model] ?? MOST_EXPENSIVE;
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
    1_000_000
  );
}

export class BudgetExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly capUsd: number,
  ) {
    super(`model spend $${spentUsd.toFixed(4)} passed the cap of $${capUsd.toFixed(2)}`);
    this.name = 'BudgetExceededError';
  }
}

export interface UsageRecord {
  purpose: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  costUsd: number;
}

export class SpendTracker {
  readonly calls: UsageRecord[] = [];

  constructor(
    readonly capUsd: number,
    private file?: string,
  ) {}

  setFile(file: string): void {
    this.file = file;
    this.flush();
  }

  get totalUsd(): number {
    return this.calls.reduce((s, c) => s + c.costUsd, 0);
  }

  /** Throws before a call when the cap is already spent. */
  assertBudget(): void {
    if (this.totalUsd >= this.capUsd) throw new BudgetExceededError(this.totalUsd, this.capUsd);
  }

  record(purpose: string, model: string, usage: TokenUsage): UsageRecord {
    const rec: UsageRecord = {
      purpose,
      model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      costUsd: costUsd(model, usage),
    };
    this.calls.push(rec);
    this.flush();
    if (this.totalUsd > this.capUsd) throw new BudgetExceededError(this.totalUsd, this.capUsd);
    return rec;
  }

  summary() {
    return {
      capUsd: this.capUsd,
      totalUsd: Number(this.totalUsd.toFixed(6)),
      calls: this.calls.length,
      inputTokens: this.calls.reduce(
        (s, c) => s + c.input_tokens + c.cache_read_input_tokens + c.cache_creation_input_tokens,
        0,
      ),
      outputTokens: this.calls.reduce((s, c) => s + c.output_tokens, 0),
      byCall: this.calls,
    };
  }

  flush(): void {
    if (this.file) writeFileSync(this.file, JSON.stringify(this.summary(), null, 2) + '\n');
  }
}

export function capFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.MAX_SPEND_USD ?? '1.00');
  return Number.isFinite(v) && v > 0 ? v : 1;
}
