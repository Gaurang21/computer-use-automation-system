// Input validation and output parsing by declared type. Inputs are checked
// before the UI is touched. Outputs are parsed from screen text into typed
// values (money becomes integer minor units).

import type { Money, ParamSpec } from '../schema/values.js';

export type TypedValue = string | number | boolean | Money;

export interface InputError {
  name: string;
  problem: string;
}

/** Validates raw inputs (strings from a CLI, or typed values from an agent). */
export function validateInputs(
  specs: Record<string, ParamSpec>,
  raw: Record<string, unknown>,
): { ok: true; values: Record<string, TypedValue> } | { ok: false; errors: InputError[] } {
  const errors: InputError[] = [];
  const values: Record<string, TypedValue> = {};
  for (const name of Object.keys(raw)) {
    if (!specs[name]) errors.push({ name, problem: 'not a declared input' });
  }
  for (const [name, spec] of Object.entries(specs)) {
    const v = raw[name];
    if (v === undefined || v === '') {
      if (spec.required) errors.push({ name, problem: 'required' });
      continue;
    }
    const parsed = coerce(v, spec);
    if ('problem' in parsed) errors.push({ name, problem: parsed.problem });
    else values[name] = parsed.value;
  }
  return errors.length ? { ok: false, errors } : { ok: true, values };
}

function coerce(v: unknown, spec: ParamSpec): { value: TypedValue } | { problem: string } {
  const s = typeof v === 'string' ? v.trim() : v;
  switch (spec.type) {
    case 'string': {
      if (typeof s !== 'string') return { problem: 'expected a string' };
      if (spec.pattern && !new RegExp(spec.pattern).test(s))
        return { problem: `does not match ${spec.pattern}` };
      return { value: s };
    }
    case 'enum':
      return typeof s === 'string' && spec.enum?.includes(s)
        ? { value: s }
        : { problem: `expected one of ${spec.enum?.join(', ')}` };
    case 'integer': {
      const n = typeof s === 'number' ? s : Number(s);
      if (!Number.isInteger(n)) return { problem: 'expected an integer' };
      if (spec.min !== undefined && n < spec.min) return { problem: `below ${spec.min}` };
      if (spec.max !== undefined && n > spec.max) return { problem: `above ${spec.max}` };
      return { value: n };
    }
    case 'boolean':
      if (s === true || s === 'true') return { value: true };
      if (s === false || s === 'false') return { value: false };
      return { problem: 'expected true or false' };
    case 'date':
      return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
        ? { value: s }
        : { problem: 'expected YYYY-MM-DD' };
    case 'money': {
      const currency = spec.currency ?? 'USD';
      if (s && typeof s === 'object' && 'amountMinor' in s) {
        const m = s as Money;
        return Number.isInteger(m.amountMinor)
          ? { value: { amountMinor: m.amountMinor, currency: m.currency ?? currency } }
          : { problem: 'amountMinor must be an integer' };
      }
      const minor = typeof s === 'string' ? parseMoneyText(s) : null;
      if (minor === null) return { problem: 'expected a dollar amount like 150.00' };
      if (spec.min !== undefined && minor < spec.min)
        return { problem: `below ${spec.min} minor units` };
      return { value: { amountMinor: minor, currency } };
    }
  }
}

/** "$12,540.32", "12540.32", "-$5" -> minor units. Null when not money. */
export function parseMoneyText(text: string): number | null {
  const t = text.replace(/[\s,]/g, '').replace(/^\((.*)\)$/, '-$1');
  const m = /^(-)?\$?(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const minor = Number(m[3]) * 100 + Number((m[4] ?? '').padEnd(2, '0'));
  return m[1] || m[2] ? -minor : minor;
}

/** The text typed into the UI for a typed value. */
export function toUiText(value: TypedValue): string {
  if (typeof value === 'object') {
    const sign = value.amountMinor < 0 ? '-' : '';
    const abs = Math.abs(value.amountMinor);
    return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  }
  return String(value);
}

/** Parses screen text into the declared output type. */
export function parseOutput(
  text: string,
  spec: ParamSpec,
): { ok: true; value: TypedValue } | { ok: false; problem: string } {
  const t = text.trim();
  switch (spec.type) {
    case 'money': {
      const minor = parseMoneyText(t);
      return minor === null
        ? { ok: false, problem: `"${t}" is not a money amount` }
        : { ok: true, value: { amountMinor: minor, currency: spec.currency ?? 'USD' } };
    }
    case 'integer': {
      const n = Number(t.replace(/,/g, ''));
      return Number.isInteger(n)
        ? { ok: true, value: n }
        : { ok: false, problem: `"${t}" is not an integer` };
    }
    case 'boolean':
      return /^(yes|true|y)$/i.test(t)
        ? { ok: true, value: true }
        : /^(no|false|n)$/i.test(t)
          ? { ok: true, value: false }
          : { ok: false, problem: `"${t}" is not a boolean` };
    default: {
      if (t === '') return { ok: false, problem: 'empty value' };
      if (spec.type === 'enum' && !spec.enum?.includes(t))
        return { ok: false, problem: `"${t}" is not one of ${spec.enum?.join(', ')}` };
      if (spec.pattern && !new RegExp(spec.pattern).test(t))
        return { ok: false, problem: `"${t}" does not match ${spec.pattern}` };
      return { ok: true, value: t };
    }
  }
}
