import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import {
  Redactor,
  findLeaks,
  maskPng,
  redactBySensitivity,
  scrubPatterns,
  sensitiveBoxes,
} from '../../src/policy/redact.js';
import type { Observation, ObservedElement } from '../../src/surface/types.js';

describe('redaction', () => {
  it('handles each sensitivity level as the policy table says', () => {
    expect(redactBySensitivity('teller', 'none')).toBe('teller');
    expect(redactBySensitivity('10001', 'identifier')).toBe('***01');
    expect(redactBySensitivity('Avery Lindqvist', 'pii')).toBe('[REDACTED:pii]');
    expect(redactBySensitivity('$12,540.32', 'financial')).toBe('[REDACTED:financial]');
    expect(redactBySensitivity('hunter2', 'secret')).toBe('[SECRET]');
  });

  it('scrubs SSNs, account and card numbers, emails and money by pattern', () => {
    const line =
      'ssn 123-45-6789 acct 7001000101 card 4111 1111 1111 1111 mail a.b@cvcu.example bal $12,540.32';
    const out = scrubPatterns(line);
    for (const leak of ['123-45-6789', '7001000101', '4111', 'a.b@cvcu.example', '12,540.32']) {
      expect(out).not.toContain(leak);
    }
  });

  it('replaces registered run values everywhere, including money in its display forms', () => {
    const r = new Redactor();
    r.addKnown('Avery Lindqvist', 'pii');
    r.addKnown('10001', 'identifier');
    r.addKnown('change-me-local-only', 'secret');
    r.addKnown({ amountMinor: 1254032, currency: 'USD' }, 'financial');
    const out = r.redactDeep({
      detail: 'typed change-me-local-only for member 10001, Avery Lindqvist has 12540.32',
      nested: ['Avery Lindqvist'],
      png: Buffer.from('x'),
    });
    expect(JSON.stringify(out)).not.toMatch(/Avery|change-me|10001|12540/);
    expect(out.detail).toContain('***01');
    expect(out).not.toHaveProperty('png');
  });

  it('masks labelled cells, labelled values and pattern matches in screenshots', () => {
    const el = (p: Partial<ObservedElement>): ObservedElement => ({
      ref: p.ref ?? 'x',
      role: 'text',
      name: '',
      framePath: ['main'],
      bbox: { x: 10, y: 10, w: 20, h: 10 },
      states: [],
      ...p,
    });
    const obs: Observation = {
      location: 'http://x/',
      frames: [],
      hash: 'h',
      takenAt: '',
      elements: [
        el({ ref: 't', role: 'table', nearText: { text: 'Accounts', relation: 'above' } }),
        el({ ref: 'h', role: 'cell', name: 'Balance', table: { tableRef: 't', row: 0, col: 1 } }),
        el({
          ref: 'c',
          role: 'cell',
          name: '$5.00',
          table: { tableRef: 't', row: 1, col: 1 },
          bbox: { x: 1, y: 1, w: 5, h: 5 },
        }),
        el({
          ref: 'n',
          name: 'Avery Lindqvist',
          nearText: { text: 'Name', relation: 'left_of' },
          bbox: { x: 2, y: 2, w: 5, h: 5 },
        }),
        el({ ref: 's', name: 'Search' }),
      ],
    };
    const boxes = sensitiveBoxes(obs, ['Balance', 'Name']);
    expect(boxes).toEqual([
      { x: 1, y: 1, w: 5, h: 5 },
      { x: 2, y: 2, w: 5, h: 5 },
    ]);
  });

  it('draws solid boxes on the PNG', () => {
    const img = new PNG({ width: 20, height: 20 });
    img.data.fill(255);
    const masked = PNG.sync.read(maskPng(PNG.sync.write(img), [{ x: 8, y: 8, w: 4, h: 4 }]));
    const px = (x: number, y: number) => masked.data[(y * 20 + x) * 4];
    expect(px(10, 10)).toBe(0);
    expect(px(1, 1)).toBe(255);
  });
});

describe('leak check: no input value or secret in any artifact', () => {
  const dirs = [
    'capabilities/memberdesk',
    'capabilities/memberdesk/overlays',
    'tests/fixtures/capabilities',
  ];
  const files = dirs.flatMap((d) =>
    readdirSync(d)
      .filter((f) => f.endsWith('.json'))
      .map((f) => join(d, f)),
  );
  // Every concrete value the demo and tests ever feed in, plus the synthetic credentials.
  const forbidden = [
    '10001',
    '10004',
    '10006',
    '10007',
    '99999',
    'teller01',
    'change-me-local-only',
    'Avery Lindqvist',
    '12,540.32',
    'Rainy day',
  ];

  it.each(files)('%s holds bindings only', (file) => {
    expect(findLeaks(readFileSync(file, 'utf8'), forbidden)).toEqual([]);
  });
});

describe('screenshot masking precision', () => {
  it('does not mask a label just because a sensitive label sits above it', () => {
    const obs: Observation = {
      location: 'http://x/',
      frames: [],
      hash: 'h',
      takenAt: '',
      elements: [
        {
          ref: 'l',
          role: 'text',
          name: 'Member ID',
          nearText: { text: 'Name', relation: 'above' },
          framePath: ['main'],
          bbox: { x: 1, y: 30, w: 5, h: 5 },
          states: [],
        },
      ],
    };
    expect(sensitiveBoxes(obs, ['Name'])).toEqual([]);
  });
});
