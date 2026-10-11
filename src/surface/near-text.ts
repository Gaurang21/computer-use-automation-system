// The one geometric rule that makes unlabeled legacy forms targetable: for a
// control with no accessible name, its label is the closest text to the left
// on the same row, else the closest text above. This works on any surface that
// reports bounding boxes, desktop included.

import type { BBox } from '../schema/target.js';
import type { NearText, ObservedElement } from './types.js';

/** Roles that get a nearText. Controls, tables, and loose text (for reads like "Name: Avery"). */
export const NEAR_TEXT_ROLES = new Set([
  'textbox',
  'combobox',
  'checkbox',
  'radio',
  'spinbutton',
  'searchbox',
  'table',
  'text',
]);

const MAX_LEFT_GAP = 320;
const MAX_ABOVE_GAP = 120;

type Positioned = Pick<ObservedElement, 'ref' | 'role' | 'name' | 'framePath' | 'bbox'>;

export function computeNearText(
  element: Positioned,
  all: readonly Positioned[],
): NearText | undefined {
  const labels = all.filter(
    (c) =>
      c.ref !== element.ref &&
      c.role === 'text' &&
      c.name.trim() !== '' &&
      sameFrame(c.framePath, element.framePath) &&
      hasArea(c.bbox),
  );
  if (!hasArea(element.bbox)) return undefined;

  const left = closest(labels, (c) => leftGap(c.bbox, element.bbox), MAX_LEFT_GAP);
  if (left) return { text: normalize(left.name), relation: 'left_of' };

  const above = closest(labels, (c) => aboveGap(c.bbox, element.bbox), MAX_ABOVE_GAP);
  if (above) return { text: normalize(above.name), relation: 'above' };
  return undefined;
}

/** Horizontal gap when label sits left of el on the same row, else undefined. */
function leftGap(label: BBox, el: BBox): number | undefined {
  const labelRight = label.x + label.w;
  if (labelRight > el.x + 2) return undefined;
  const labelMid = label.y + label.h / 2;
  const elMid = el.y + el.h / 2;
  const sameRow =
    (labelMid >= el.y && labelMid <= el.y + el.h) ||
    (elMid >= label.y && elMid <= label.y + label.h);
  return sameRow ? el.x - labelRight : undefined;
}

/** Vertical gap when label sits above el and starts within its horizontal span. */
function aboveGap(label: BBox, el: BBox): number | undefined {
  const labelBottom = label.y + label.h;
  if (labelBottom > el.y + 2) return undefined;
  const aligned = label.x >= el.x - 24 && label.x <= el.x + Math.max(el.w, 24);
  return aligned ? el.y - labelBottom : undefined;
}

function closest<T>(
  items: readonly T[],
  gap: (t: T) => number | undefined,
  max: number,
): T | undefined {
  let best: T | undefined;
  let bestGap = Infinity;
  for (const item of items) {
    const g = gap(item);
    if (g !== undefined && g <= max && g < bestGap) {
      best = item;
      bestGap = g;
    }
  }
  return best;
}

function sameFrame(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function hasArea(b: BBox): boolean {
  return b.w > 0 && b.h > 0;
}

export function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
