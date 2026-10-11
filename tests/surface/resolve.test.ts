import { describe, expect, it } from 'vitest';
import { resolveTarget } from '../../src/surface/resolve.js';
import type { ObservedElement } from '../../src/surface/types.js';

let n = 0;
const el = (
  partial: Partial<ObservedElement> & Pick<ObservedElement, 'role' | 'name'>,
): ObservedElement => ({
  ref: `e${++n}`,
  framePath: ['main'],
  bbox: { x: 0, y: n * 30, w: 100, h: 20 },
  states: [],
  ...partial,
});

const memberIdInput = el({
  role: 'textbox',
  name: '',
  nearText: { text: 'Member ID', relation: 'left_of' },
});
const passwordInput = el({
  role: 'textbox',
  name: '',
  nearText: { text: 'Password', relation: 'left_of' },
});
const searchButton = el({ role: 'button', name: 'Search' });
const navLink = el({ role: 'link', name: 'Member Search', framePath: ['nav'] });
const dupA = el({ role: 'button', name: 'Continue' });
const dupB = el({ role: 'button', name: 'Continue' });
const elements = [memberIdInput, passwordInput, searchButton, navLink, dupA, dupB];

describe('resolveTarget', () => {
  it('resolves an unlabeled input by its label anchor', () => {
    const r = resolveTarget(elements, {
      locators: [
        { kind: 'label_anchor', role: 'textbox', label: 'Member ID', relation: 'left_of' },
      ],
    });
    expect(r.ok && r.element).toBe(memberIdInput);
  });

  it('falls through to the next locator and reports which one hit (drift signal)', () => {
    const r = resolveTarget(elements, {
      locators: [
        { kind: 'label_anchor', role: 'textbox', label: 'Account Holder No.', relation: 'left_of' },
        { kind: 'structural', framePath: ['main'], role: 'textbox', ordinal: 0 },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.element).toBe(memberIdInput);
    expect(r.locatorIndex).toBe(1);
    expect(r.attempts.map((a) => a.matches)).toEqual([0, 1]);
  });

  it('returns TARGET_AMBIGUOUS with every candidate when no locator narrows to one', () => {
    const r = resolveTarget(elements, {
      locators: [{ kind: 'text', role: 'button', text: 'Continue' }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('TARGET_AMBIGUOUS');
    expect(r.candidates).toEqual([dupA, dupB]);
  });

  it('returns TARGET_NOT_FOUND when nothing matches', () => {
    const r = resolveTarget(elements, {
      locators: [{ kind: 'role_name', role: 'button', name: 'Find' }],
    });
    expect(r.ok === false && r.code).toBe('TARGET_NOT_FOUND');
  });

  it('honours framePath', () => {
    const inMain = resolveTarget(elements, {
      locators: [{ kind: 'text', role: 'link', text: 'Member Search', framePath: ['main'] }],
    });
    expect(inMain.ok).toBe(false);
    const inNav = resolveTarget(elements, {
      locators: [{ kind: 'text', role: 'link', text: 'Member Search', framePath: ['nav'] }],
    });
    expect(inNav.ok && inNav.element).toBe(navLink);
  });

  it('never acts on a visual locator unless policy allows it', () => {
    const target = {
      locators: [{ kind: 'visual' as const, role: 'button', bbox: { ...searchButton.bbox } }],
    };
    const blocked = resolveTarget(elements, target);
    expect(blocked.ok).toBe(false);
    expect(blocked.attempts[0]?.matches).toBe(-1);
    const allowed = resolveTarget(elements, target, { allowVisualFallback: true });
    expect(allowed.ok && allowed.element).toBe(searchButton);
  });

  describe('table_cell', () => {
    const table = el({
      role: 'table',
      name: '',
      nearText: { text: 'Accounts', relation: 'above' },
    });
    const cell = (name: string, row: number, col: number) =>
      el({ role: 'cell', name, table: { tableRef: table.ref, row, col } });
    const grid = [
      table,
      cell('Type', 0, 0),
      cell('Balance', 0, 1),
      cell('Checking', 1, 0),
      cell('$889.15', 1, 1),
      cell('Savings', 2, 0),
      cell('$12,540.32', 2, 1),
    ];
    const accounts = {
      locators: [
        {
          kind: 'label_anchor' as const,
          role: 'table',
          label: 'Accounts',
          relation: 'above' as const,
        },
      ],
    };

    it('reads the cell in the matching row and column', () => {
      const r = resolveTarget(grid, {
        kind: 'table_cell',
        table: accounts,
        rowWhere: { column: 'Type', equals: 'Savings' },
        column: 'Balance',
      });
      expect(r.ok && r.element.name).toBe('$12,540.32');
    });

    it('reports a missing row as TARGET_NOT_FOUND with a reason', () => {
      const r = resolveTarget(grid, {
        kind: 'table_cell',
        table: accounts,
        rowWhere: { column: 'Type', equals: 'Money Market' },
        column: 'Balance',
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe('TARGET_NOT_FOUND');
      expect(r.detail).toContain('Money Market');
    });
  });
});
