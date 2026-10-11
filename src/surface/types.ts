// The seam between "how we perceive and act on a surface" and everything above
// it. Discovery, replay, policy and the operator console only ever talk to a
// Surface. None of them know about browsers, frames or the DOM.

import type { BBox, TargetSpec } from '../schema/target.js';

export type SurfaceKind = 'web' | 'desktop';

/** Who issued an action. Only the holder of the control lease may act. */
export type Actor = 'automation' | 'human';

export interface NearText {
  text: string;
  /** Where the label sits relative to the element. */
  relation: 'left_of' | 'above';
}

export interface TableCoordinates {
  /** ref of the table element this cell belongs to. */
  tableRef: string;
  row: number;
  col: number;
}

export interface ObservedElement {
  /** Handle valid until the next observe(). Never stored in an artifact. */
  ref: string;
  /** Normalized role: button, link, textbox, combobox, text, table, cell, ... */
  role: string;
  /** Accessible name. Empty for unlabeled legacy inputs. */
  name: string;
  value?: string;
  /** For unnamed controls and loose text: the closest label by geometry. */
  nearText?: NearText;
  framePath: string[];
  bbox: BBox;
  /** Only true flags: focused, disabled, readonly, required, checked, selected, expanded, protected. */
  states: string[];
  /** For combobox: the visible option labels. */
  options?: string[];
  /** For table cells: position inside their table. Row 0 is the header row. */
  table?: TableCoordinates;
}

export interface FrameInfo {
  path: string[];
  url: string;
  title: string;
}

export interface Observation {
  /** Top-level location. */
  location: string;
  frames: FrameInfo[];
  elements: ObservedElement[];
  /** Stable digest of what is on screen (ignores geometry). Used for dead-end detection. */
  hash: string;
  takenAt: string;
  screenshot?: Buffer;
}

export type Action =
  | { type: 'click'; ref: string }
  | { type: 'type'; ref: string; text: string }
  | { type: 'select'; ref: string; option: string }
  | { type: 'press'; key: string }
  | { type: 'read'; ref: string }
  | { type: 'wait'; ms: number }
  | { type: 'goto'; url: string }
  // Low-level, human-only: the operator console forwards raw pointer clicks
  // and keystrokes so a person can do anything a person could do.
  | { type: 'pointer'; x: number; y: number }
  | { type: 'key'; key?: string; text?: string };

export type ActionType = Action['type'];

export const HUMAN_ONLY_ACTIONS: readonly ActionType[] = ['pointer', 'key'];

export interface ActResult {
  /** For read: the element's text value. */
  value?: string;
  /** The element acted on, as it was observed just before the action. */
  element?: ObservedElement;
}

export interface LocatorAttempt {
  index: number;
  kind: string;
  matches: number;
}

export type Resolution =
  | { ok: true; element: ObservedElement; locatorIndex: number; attempts: LocatorAttempt[] }
  | {
      ok: false;
      code: 'TARGET_NOT_FOUND' | 'TARGET_AMBIGUOUS';
      attempts: LocatorAttempt[];
      /** For TARGET_AMBIGUOUS: every element the best locator matched. */
      candidates: ObservedElement[];
      detail: string;
    };

export interface ObserveOptions {
  screenshot?: boolean;
}

export interface ResolveOptions {
  allowVisualFallback?: boolean;
}

export interface Surface {
  readonly kind: SurfaceKind;
  observe(options?: ObserveOptions): Promise<Observation>;
  resolve(target: TargetSpec, options?: ResolveOptions): Promise<Resolution>;
  act(action: Action, actor: Actor): Promise<ActResult>;
  location(): Promise<string>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}
