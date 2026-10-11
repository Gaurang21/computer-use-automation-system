import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaywrightSurface } from '../../src/surface/playwright.js';
import type { Surface } from '../../src/surface/types.js';
import { startTenant, type RunningTenant } from '../support/memberdesk.js';
import { hasText, observeUntil } from '../support/poll.js';

async function clickTarget(surface: Surface, text: string, role: string) {
  const r = await surface.resolve({ locators: [{ kind: 'text', role, text }] });
  if (!r.ok) throw new Error(`${text}: ${r.code} ${r.detail}`);
  await surface.act({ type: 'click', ref: r.element.ref }, 'automation');
}

async function typeInto(surface: Surface, label: string, text: string) {
  const r = await surface.resolve({
    locators: [{ kind: 'label_anchor', role: 'textbox', label, relation: 'left_of' }],
  });
  if (!r.ok) throw new Error(`${label}: ${r.code} ${r.detail}`);
  await surface.act({ type: 'type', ref: r.element.ref, text }, 'automation');
}

describe('PlaywrightSurface on the MemberDesk frameset', () => {
  let app: RunningTenant;
  let surface: PlaywrightSurface;

  beforeAll(async () => {
    app = await startTenant('tenant-a');
    surface = await PlaywrightSurface.launch();
    await surface.act({ type: 'goto', url: app.baseUrl + '/' }, 'automation');
    await observeUntil(surface, hasText('Operator ID'));
    await typeInto(surface, 'Operator ID', app.operator.id);
    await typeInto(surface, 'Password', app.operator.password);
    await clickTarget(surface, 'Sign On', 'button');
    await observeUntil(surface, hasText('Welcome'));
  }, 30_000);

  afterAll(async () => {
    await surface?.close();
    await app?.close();
  });

  it('sees every frame of the frameset and reports frame paths', async () => {
    const obs = await surface.observe();
    expect(obs.frames.map((f) => f.path.join('/'))).toEqual(['', 'banner', 'nav', 'main']);
    const link = obs.elements.find((e) => e.role === 'link' && e.name === 'Member Search');
    expect(link?.framePath).toEqual(['nav']);
    expect(link?.bbox.w).toBeGreaterThan(0);
  });

  it('resolves an unlabeled input inside a nested frame by its label anchor', async () => {
    await clickTarget(surface, 'Member Search', 'link');
    const obs = await observeUntil(surface, hasText('Find a member'));
    const input = obs.elements.find((e) => e.role === 'textbox');
    expect(input?.name).toBe('');
    expect(input?.framePath).toEqual(['main']);
    expect(input?.nearText).toEqual({ text: 'Member ID', relation: 'left_of' });

    await typeInto(surface, 'Member ID', '10001');
    const typed = await surface.observe();
    expect(typed.elements.find((e) => e.role === 'textbox')?.value).toBe('10001');
  });

  it('clears the field before typing, so a retry cannot double-type', async () => {
    await typeInto(surface, 'Member ID', '10001');
    const obs = await surface.observe();
    expect(obs.elements.find((e) => e.role === 'textbox')?.value).toBe('10001');
  });

  it('reads a table cell and a labelled value on the member detail page', async () => {
    await clickTarget(surface, 'Search', 'button');
    await observeUntil(surface, hasText('Member Detail'));
    const balance = await surface.resolve({
      kind: 'table_cell',
      table: {
        locators: [{ kind: 'label_anchor', role: 'table', label: 'Accounts', relation: 'above' }],
      },
      rowWhere: { column: 'Type', equals: 'Savings' },
      column: 'Balance',
    });
    expect(balance.ok && balance.element.name).toBe('$12,540.32');

    const name = await surface.resolve({
      locators: [{ kind: 'label_anchor', role: 'text', label: 'Name', relation: 'left_of' }],
    });
    expect(name.ok && name.element.name).toBe('Avery Lindqvist');
  });

  it('returns several candidates for an ambiguous target', async () => {
    await clickTarget(surface, 'Member Search', 'link');
    await observeUntil(surface, hasText('Find a member'));
    await typeInto(surface, 'Member ID', '10007');
    await clickTarget(surface, 'Search', 'button');
    await observeUntil(surface, hasText('Taylor Brennan'));
    const r = await surface.resolve({
      kind: 'table_cell',
      table: {
        locators: [{ kind: 'label_anchor', role: 'table', label: 'Accounts', relation: 'above' }],
      },
      rowWhere: { column: 'Type', equals: 'Savings' },
      column: 'Balance',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('TARGET_AMBIGUOUS');
    expect(r.candidates.map((c) => c.name)).toEqual(['$6,400.00', '$180.00']);
  });

  it('selects an option on a legacy select by its visible label', async () => {
    await clickTarget(surface, 'Open Sub-Account', 'button');
    const obs = await observeUntil(surface, hasText('Opening Deposit'));
    const combo = obs.elements.find((e) => e.role === 'combobox');
    expect(combo?.nearText?.text).toBe('Account Type');
    expect(combo?.options).toEqual(['-- select --', 'Savings', 'Money Market', 'Certificate']);
    await surface.act(
      { type: 'select', ref: combo?.ref ?? '', option: 'Money Market' },
      'automation',
    );
    const after = await surface.observe();
    expect(after.elements.find((e) => e.role === 'combobox')?.value).toBe('Money Market');
  });

  it('refuses raw pointer input from automation', async () => {
    await expect(surface.act({ type: 'pointer', x: 10, y: 10 }, 'automation')).rejects.toThrow(
      /humans only/,
    );
  });

  it('gives the same hash for the same screen and a different one after navigation', async () => {
    const a = await surface.observe();
    const b = await surface.observe();
    expect(a.hash).toBe(b.hash);
    await clickTarget(surface, 'Home', 'link');
    const c = await observeUntil(surface, hasText('Welcome'));
    expect(c.hash).not.toBe(a.hash);
  });
});
