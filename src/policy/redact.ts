// Redaction. Three mechanisms, applied to everything written to disk:
// 1. Known values: every input, output and secret of a run is registered with
//    its sensitivity and replaced wherever it appears.
// 2. Patterns: SSNs, card numbers, long account numbers, emails and money
//    amounts are scrubbed even when nobody registered them.
// 3. Screenshots: solid boxes over elements whose label marks them sensitive.
// None of this applies to what the caller gets back in its own result.

import { PNG } from 'pngjs';
import type { BBox } from '../schema/target.js';
import type { Sensitivity } from '../schema/values.js';
import type { Observation } from '../surface/types.js';

export function redactBySensitivity(value: string, sensitivity: Sensitivity): string {
  switch (sensitivity) {
    case 'none':
      return value;
    case 'identifier':
      return value.length <= 2
        ? '**'
        : `${'*'.repeat(Math.min(value.length - 2, 6))}${value.slice(-2)}`;
    case 'pii':
    case 'financial':
      return `[REDACTED:${sensitivity}]`;
    case 'secret':
      return '[SECRET]';
  }
}

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: 'card', re: /\b(?:\d{4}[ -]){3}\d{1,7}\b/g },
  { name: 'account', re: /\b\d{8,19}\b/g },
  { name: 'money', re: /\$\s?\d[\d,]*(?:\.\d{2})?/g },
];

export function scrubPatterns(text: string): string {
  return PATTERNS.reduce((t, { name, re }) => t.replace(re, `[REDACTED:${name}]`), text);
}

export class Redactor {
  private known: { value: string; replacement: string }[] = [];

  /** Registers a run value (input, output, secret) so it never reaches disk in clear. */
  addKnown(value: unknown, sensitivity: Sensitivity): void {
    if (sensitivity === 'none' || value === undefined || value === null) return;
    for (const form of stringForms(value)) {
      if (form.length < 3) continue;
      this.known.push({ value: form, replacement: redactBySensitivity(form, sensitivity) });
    }
    this.known.sort((a, b) => b.value.length - a.value.length);
  }

  scrub(text: string): string {
    let out = text;
    for (const k of this.known) out = out.split(k.value).join(k.replacement);
    return scrubPatterns(out);
  }

  /** Deep copy with every string scrubbed. Buffers are dropped (they go through masking instead). */
  redactDeep<T>(value: T): T {
    return walk(value, (s) => this.scrub(s)) as T;
  }

  knownValues(): string[] {
    return this.known.map((k) => k.value);
  }
}

function stringForms(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (typeof value === 'object' && value && 'amountMinor' in value) {
    const minor = Number((value as { amountMinor: number }).amountMinor);
    const fixed = (minor / 100).toFixed(2);
    return [
      fixed,
      Number(fixed).toLocaleString('en-US', { minimumFractionDigits: 2 }),
      String(minor),
    ];
  }
  return [JSON.stringify(value)];
}

function walk(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Buffer.isBuffer(value)) return undefined;
  if (Array.isArray(value)) return value.map((v) => walk(v, fn));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .map(([k, v]) => [k, walk(v, fn)] as const)
        .filter(([, v]) => v !== undefined),
    );
  }
  return value;
}

/** Every value that must never appear in a serialized artifact. Returns the ones that do. */
export function findLeaks(serialized: string, forbidden: readonly string[]): string[] {
  return forbidden.filter((v) => v.length >= 3 && serialized.includes(v));
}

/**
 * Boxes to black out in a saved screenshot: elements labelled sensitive (by
 * their near label or their table column header), plus anything whose text
 * matches a scrub pattern or a known value.
 */
export function sensitiveBoxes(
  obs: Observation,
  labels: readonly string[],
  redactor?: Redactor,
): BBox[] {
  const isSensitiveLabel = (t: string | undefined) =>
    !!t && labels.some((l) => t.toLowerCase() === l.toLowerCase());
  const headers = new Map<string, string>();
  for (const e of obs.elements) {
    if (e.table && e.table.row === 0) headers.set(`${e.table.tableRef}:${e.table.col}`, e.name);
  }
  return obs.elements
    .filter((e) => {
      if (e.bbox.w <= 0 || e.bbox.h <= 0) return false;
      if (
        e.table &&
        e.table.row > 0 &&
        isSensitiveLabel(headers.get(`${e.table.tableRef}:${e.table.col}`))
      )
        return true;
      // Loose text takes its label from the left only ("Name: Avery"); text above it is usually another row's label.
      const labelled = e.role === 'text' ? e.nearText?.relation === 'left_of' : e.role !== 'table';
      if (labelled && isSensitiveLabel(e.nearText?.text)) return true;
      if (e.states.includes('protected')) return true;
      const text = `${e.name} ${e.value ?? ''}`;
      if (scrubPatterns(text) !== text) return true;
      return !!redactor && redactor.scrub(text) !== text;
    })
    .map((e) => e.bbox);
}

export function maskPng(png: Buffer, boxes: readonly BBox[]): Buffer {
  const img = PNG.sync.read(png);
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x) - 2);
    const y0 = Math.max(0, Math.floor(b.y) - 2);
    const x1 = Math.min(img.width, Math.ceil(b.x + b.w) + 2);
    const y1 = Math.min(img.height, Math.ceil(b.y + b.h) + 2);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * img.width + x) * 4;
        img.data[i] = 0;
        img.data[i + 1] = 0;
        img.data[i + 2] = 0;
        img.data[i + 3] = 255;
      }
    }
  }
  return PNG.sync.write(img);
}
