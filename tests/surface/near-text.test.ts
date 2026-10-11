import { describe, expect, it } from 'vitest';
import { computeNearText } from '../../src/surface/near-text.js';

const el = (ref: string, role: string, name: string, x: number, y: number, w = 100, h = 20) => ({
  ref,
  role,
  name,
  framePath: ['main'],
  bbox: { x, y, w, h },
});

describe('computeNearText', () => {
  it('picks the closest text to the left on the same row', () => {
    const input = el('i', 'textbox', '', 200, 100);
    const all = [
      input,
      el('far', 'text', 'Far label', 10, 102, 60, 16),
      el('near', 'text', 'Member ID', 120, 102, 70, 16),
      el('other-row', 'text', 'Password', 120, 140, 70, 16),
    ];
    expect(computeNearText(input, all)).toEqual({ text: 'Member ID', relation: 'left_of' });
  });

  it('falls back to the closest text above when nothing is to the left', () => {
    const table = el('t', 'table', '', 20, 200, 400, 120);
    const all = [
      table,
      el('h', 'text', 'Accounts', 20, 176, 70, 16),
      el('x', 'text', 'Older', 20, 40, 70, 16),
    ];
    expect(computeNearText(table, all)).toEqual({ text: 'Accounts', relation: 'above' });
  });

  it('ignores text in other frames, non-text roles and labels too far away', () => {
    const input = el('i', 'textbox', '', 600, 100);
    const all = [
      input,
      { ...el('nav', 'text', 'Home', 560, 102, 30, 16), framePath: ['nav'] },
      el('btn', 'button', 'Search', 500, 100, 80, 20),
      el('far', 'text', 'Too far', 10, 102, 40, 16),
    ];
    expect(computeNearText(input, all)).toBeUndefined();
  });

  it('collapses whitespace in the label', () => {
    const input = el('i', 'textbox', '', 200, 100);
    expect(
      computeNearText(input, [input, el('l', 'text', '  Opening\n  Deposit ', 100, 102, 90, 16)]),
    ).toEqual({
      text: 'Opening Deposit',
      relation: 'left_of',
    });
  });
});
