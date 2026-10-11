import { createHash } from 'node:crypto';
import type { Capability } from '../schema/capability.js';

/** JSON with object keys sorted, so equal content always hashes the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The hash an approval is bound to: everything except the approval itself and
 * the status. Any edit to steps, locators, inputs or outcomes changes it, so
 * an edited artifact falls back to draft on its own.
 */
export function contentHash(cap: Capability): string {
  const { approval: _approval, status: _status, ...content } = cap;
  return sha256(stableStringify(content));
}

export function isApproved(cap: Capability): boolean {
  return (
    cap.status === 'approved' &&
    cap.approval !== null &&
    cap.approval.contentHash === contentHash(cap)
  );
}
