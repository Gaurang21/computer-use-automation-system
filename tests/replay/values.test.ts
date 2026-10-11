import { describe, expect, it } from 'vitest';
import { parseMoneyText, parseOutput, toUiText, validateInputs } from '../../src/replay/values.js';
import type { ParamSpec } from '../../src/schema/values.js';

const spec = (p: Partial<ParamSpec> & Pick<ParamSpec, 'type'>): ParamSpec => ({
  sensitivity: 'none',
  required: true,
  ...p,
});

describe('inputs', () => {
  const specs = {
    memberId: spec({ type: 'string', pattern: '^\\d{5}$', sensitivity: 'identifier' }),
    accountType: spec({ type: 'enum', enum: ['Savings', 'Certificate'] }),
    openingDeposit: spec({ type: 'money', sensitivity: 'financial' }),
  };

  it('coerces CLI strings into typed values', () => {
    const r = validateInputs(specs, {
      memberId: '10001',
      accountType: 'Savings',
      openingDeposit: '150.5',
    });
    expect(r).toEqual({
      ok: true,
      values: {
        memberId: '10001',
        accountType: 'Savings',
        openingDeposit: { amountMinor: 15050, currency: 'USD' },
      },
    });
  });

  it('reports every problem at once', () => {
    const r = validateInputs(specs, { memberId: '12', accountType: 'Checking', extra: 'x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.name).sort()).toEqual([
      'accountType',
      'extra',
      'memberId',
      'openingDeposit',
    ]);
  });
});

describe('money and outputs', () => {
  it('parses money text into minor units, never floats', () => {
    expect(parseMoneyText('$12,540.32')).toBe(1254032);
    expect(parseMoneyText('$1.25')).toBe(125);
    expect(parseMoneyText('-$5')).toBe(-500);
    expect(parseMoneyText('12.5')).toBe(1250);
    expect(parseMoneyText('n/a')).toBeNull();
    expect(toUiText({ amountMinor: 15050, currency: 'USD' })).toBe('150.50');
  });

  it('parses outputs by declared type and fails clearly when it cannot', () => {
    expect(parseOutput('$889.15', spec({ type: 'money' }))).toEqual({
      ok: true,
      value: { amountMinor: 88915, currency: 'USD' },
    });
    expect(parseOutput('Avery Lindqvist', spec({ type: 'string' }))).toEqual({
      ok: true,
      value: 'Avery Lindqvist',
    });
    const bad = parseOutput('Pending', spec({ type: 'money' }));
    expect(bad.ok).toBe(false);
  });
});
