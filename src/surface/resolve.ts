// Target resolution. Pure: it works over an observation's element list, so the
// same rules apply to any surface (web today, desktop later).
//
// Rules:
// - Locators are tried in order. One counts only when it matches exactly one
//   element. Zero or several means try the next one.
// - When nothing resolves the result is TARGET_NOT_FOUND, or TARGET_AMBIGUOUS
//   when some locator matched several elements. No guessing.
// - The visual locator is skipped unless the caller allows visual fallback.

import {
  isTableCellTarget,
  type ElementTarget,
  type Locator,
  type TableCellTarget,
  type TargetSpec,
} from '../schema/target.js';
import { normalize } from './near-text.js';
import type { LocatorAttempt, ObservedElement, Resolution, ResolveOptions } from './types.js';

export function resolveTarget(
  elements: readonly ObservedElement[],
  target: TargetSpec,
  options: ResolveOptions = {},
): Resolution {
  return isTableCellTarget(target)
    ? resolveTableCell(elements, target, options)
    : resolveElement(elements, target, options);
}

function resolveElement(
  elements: readonly ObservedElement[],
  target: ElementTarget,
  options: ResolveOptions,
): Resolution {
  const attempts: LocatorAttempt[] = [];
  let ambiguous: ObservedElement[] = [];

  target.locators.forEach((locator, index) => {
    if (attempts.some((a) => a.matches === 1)) return;
    if (locator.kind === 'visual' && !options.allowVisualFallback) {
      attempts.push({ index, kind: locator.kind, matches: -1 }); // -1: skipped by policy
      return;
    }
    const matches = matchLocator(elements, locator);
    attempts.push({ index, kind: locator.kind, matches: matches.length });
    if (matches.length > 1 && ambiguous.length === 0) ambiguous = matches;
  });

  const hit = attempts.find((a) => a.matches === 1);
  if (hit) {
    const locator = target.locators[hit.index] as Locator;
    const element = matchLocator(elements, locator)[0] as ObservedElement;
    return { ok: true, element, locatorIndex: hit.index, attempts };
  }
  if (ambiguous.length > 0) {
    return {
      ok: false,
      code: 'TARGET_AMBIGUOUS',
      attempts,
      candidates: ambiguous,
      detail: `${ambiguous.length} elements matched and no locator narrowed it to one`,
    };
  }
  return {
    ok: false,
    code: 'TARGET_NOT_FOUND',
    attempts,
    candidates: [],
    detail: `no element matched any of ${target.locators.length} locator(s)`,
  };
}

export function matchLocator(
  elements: readonly ObservedElement[],
  locator: Locator,
): ObservedElement[] {
  switch (locator.kind) {
    case 'role_name':
      return elements.filter(
        (e) =>
          e.role === locator.role &&
          normalize(e.name) === normalize(locator.name) &&
          inFrame(e, locator.framePath),
      );
    case 'label_anchor':
      return elements.filter(
        (e) =>
          e.role === locator.role &&
          e.nearText?.relation === locator.relation &&
          e.nearText.text === normalize(locator.label) &&
          inFrame(e, locator.framePath),
      );
    case 'text':
      return elements.filter(
        (e) =>
          (locator.role === undefined || e.role === locator.role) &&
          normalize(e.name) === normalize(locator.text) &&
          inFrame(e, locator.framePath),
      );
    case 'structural': {
      const sameRole = elements.filter(
        (e) => e.role === locator.role && samePath(e.framePath, locator.framePath),
      );
      const el = sameRole[locator.ordinal];
      return el ? [el] : [];
    }
    case 'visual': {
      const cx = locator.bbox.x + locator.bbox.w / 2;
      const cy = locator.bbox.y + locator.bbox.h / 2;
      const containing = elements
        .filter(
          (e) =>
            (locator.role === undefined || e.role === locator.role) &&
            cx >= e.bbox.x &&
            cx <= e.bbox.x + e.bbox.w &&
            cy >= e.bbox.y &&
            cy <= e.bbox.y + e.bbox.h,
        )
        .sort((a, b) => a.bbox.w * a.bbox.h - b.bbox.w * b.bbox.h);
      return containing.slice(0, 1);
    }
  }
}

function resolveTableCell(
  elements: readonly ObservedElement[],
  target: TableCellTarget,
  options: ResolveOptions,
): Resolution {
  const table = resolveElement(elements, target.table, options);
  if (!table.ok) return { ...table, detail: `table: ${table.detail}` };

  const cells = elements.filter((e) => e.table?.tableRef === table.element.ref);
  const header = cells.filter((c) => c.table?.row === 0);
  const colOf = (name: string) =>
    header.find((h) => normalize(h.name) === normalize(name))?.table?.col;

  const whereCol = colOf(target.rowWhere.column);
  const valueCol = colOf(target.column);
  const notFound = (detail: string): Resolution => ({
    ok: false,
    code: 'TARGET_NOT_FOUND',
    attempts: table.attempts,
    candidates: [],
    detail,
  });
  if (whereCol === undefined) return notFound(`no column "${target.rowWhere.column}"`);
  if (valueCol === undefined) return notFound(`no column "${target.column}"`);

  const rows = cells
    .filter(
      (c) =>
        c.table &&
        c.table.row > 0 &&
        c.table.col === whereCol &&
        normalize(c.name) === normalize(target.rowWhere.equals),
    )
    .map((c) => c.table?.row);
  if (rows.length === 0)
    return notFound(`no row where ${target.rowWhere.column} = "${target.rowWhere.equals}"`);
  if (rows.length > 1) {
    return {
      ok: false,
      code: 'TARGET_AMBIGUOUS',
      attempts: table.attempts,
      candidates: cells.filter((c) => rows.includes(c.table?.row) && c.table?.col === valueCol),
      detail: `${rows.length} rows where ${target.rowWhere.column} = "${target.rowWhere.equals}"`,
    };
  }
  const cell = cells.find((c) => c.table?.row === rows[0] && c.table?.col === valueCol);
  if (!cell) return notFound(`row has no "${target.column}" cell`);
  return { ok: true, element: cell, locatorIndex: table.locatorIndex, attempts: table.attempts };
}

function inFrame(e: ObservedElement, framePath: readonly string[] | undefined): boolean {
  return framePath === undefined || samePath(e.framePath, framePath);
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
