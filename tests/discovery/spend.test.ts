import { describe, expect, it } from 'vitest';
import { BudgetExceededError, SpendTracker, costUsd } from '../../src/discovery/spend.js';

describe('spend tracking', () => {
  it('prices usage per model, including cache reads and writes', () => {
    expect(
      costUsd('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 100_000 }),
    ).toBeCloseTo(3);
    expect(
      costUsd('claude-sonnet-5-5', {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
      }),
    ).toBeCloseTo(2.7);
    // Unknown models are priced conservatively.
    expect(costUsd('mystery-model', { input_tokens: 1_000_000, output_tokens: 0 })).toBe(10);
  });

  it('aborts as soon as the running total passes the cap', () => {
    const t = new SpendTracker(0.05);
    t.record('decide', 'claude-sonnet-5-5', { input_tokens: 10_000, output_tokens: 1_000 });
    expect(t.totalUsd).toBeCloseTo(0.03);
    expect(() =>
      t.record('decide', 'claude-sonnet-5-5', { input_tokens: 10_000, output_tokens: 1_000 }),
    ).toThrow(BudgetExceededError);
    expect(() => t.assertBudget()).toThrow(/passed the cap/);
  });
});
