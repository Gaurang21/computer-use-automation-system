// How an artifact identifies a control. There are no CSS or XPath selectors
// here on purpose: a selector is a web-only idea. Every locator is answered
// from role, accessible name, nearby label text, structure or geometry, which a
// desktop accessibility API (Windows UI Automation, macOS AX) can answer too.

import { z } from 'zod';

const role = z
  .string()
  .min(1)
  .describe('Normalized accessibility role, e.g. button, textbox, link');
const framePath = z
  .array(z.string())
  .describe('Frame names from the top window down to the frame holding the element');

export const BBox = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type BBox = z.infer<typeof BBox>;

export const RoleNameLocator = z
  .object({
    kind: z.literal('role_name'),
    role,
    name: z.string().min(1),
    framePath: framePath.optional(),
  })
  .describe('Role plus exact accessible name. Strongest when the app labels its controls.');

export const LabelAnchorLocator = z
  .object({
    kind: z.literal('label_anchor'),
    role,
    label: z.string().min(1),
    relation: z.enum(['left_of', 'above']),
    framePath: framePath.optional(),
  })
  .describe(
    'Role plus the visible label text next to the control. Targets unlabeled legacy inputs.',
  );

export const TextLocator = z
  .object({
    kind: z.literal('text'),
    role: role.optional(),
    text: z.string().min(1),
    framePath: framePath.optional(),
  })
  .describe('Visible text, for buttons, links and static text.');

export const StructuralLocator = z
  .object({
    kind: z.literal('structural'),
    framePath,
    role,
    ordinal: z.int().min(0),
  })
  .describe('The Nth element of a role inside a frame. Survives label renames, not reordering.');

export const VisualLocator = z
  .object({
    kind: z.literal('visual'),
    role: role.optional(),
    bbox: BBox,
  })
  .describe(
    'Last known bounding box. Kept for evidence and drift checks. Only used to act when policy allows visual fallback.',
  );

export const Locator = z.discriminatedUnion('kind', [
  RoleNameLocator,
  LabelAnchorLocator,
  TextLocator,
  StructuralLocator,
  VisualLocator,
]);
export type Locator = z.infer<typeof Locator>;

export const ElementTarget = z
  .object({
    locators: z.array(Locator).min(1),
  })
  .describe('Ordered locators. The first one matching exactly one element wins.');
export type ElementTarget = z.infer<typeof ElementTarget>;

export const TableCellTarget = z
  .object({
    kind: z.literal('table_cell'),
    table: ElementTarget,
    rowWhere: z.object({ column: z.string().min(1), equals: z.string().min(1) }),
    column: z.string().min(1),
  })
  .describe('A cell in a data table, found by a row predicate and a column header.');
export type TableCellTarget = z.infer<typeof TableCellTarget>;

export const TargetSpec = z.union([TableCellTarget, ElementTarget]);
export type TargetSpec = z.infer<typeof TargetSpec>;

export function isTableCellTarget(t: TargetSpec): t is TableCellTarget {
  return 'kind' in t && t.kind === 'table_cell';
}
