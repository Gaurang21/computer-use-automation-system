// Web implementation of Surface on Playwright + Chromium.
//
// Perception comes from the Chromium accessibility tree of every frame (CDP
// Accessibility.getFullAXTree per frameId), not from the DOM. That handles the
// legacy frameset cleanly and yields the same vocabulary a desktop
// accessibility API exposes: role, name, value, states, bounds.
//
// Actions use real input: the element's on-screen box comes from
// DOM.getContentQuads and the click goes through the mouse; typing goes through
// the keyboard after focusing the node. No CSS selector is ever built.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Route,
} from 'playwright';
import type { BBox, TargetSpec } from '../schema/target.js';
import { computeNearText, NEAR_TEXT_ROLES } from './near-text.js';
import { resolveTarget } from './resolve.js';
import type {
  ActResult,
  Action,
  Actor,
  FrameInfo,
  Observation,
  ObserveOptions,
  ObservedElement,
  Resolution,
  ResolveOptions,
  Surface,
} from './types.js';
import { assertActorMayUse } from './actor.js';

// --- Minimal CDP shapes (only the fields we read) ---------------------------

interface AXValue {
  value?: unknown;
}
interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
}
interface FrameTree {
  frame: { id: string; name?: string; url: string };
  childFrames?: FrameTree[];
}

/** Chromium roles we drop: layout scaffolding and duplicates of other nodes. */
const SKIP_ROLES = new Set([
  'generic',
  'none',
  'presentation',
  'InlineTextBox',
  'LineBreak',
  'LayoutTable',
  'LayoutTableRow',
  'LayoutTableCell',
  'RootWebArea',
  'Iframe',
  'IframePresentational',
  'rowgroup',
  'row',
  'separator',
  'ListMarker',
  'MenuListPopup',
  'option',
  'MenuListOption',
  'paragraph',
  'Section',
  'form',
]);

/** Text inside these is already the element's name, so it is not listed twice. */
const TEXT_OWNERS = new Set([
  'link',
  'button',
  'cell',
  'columnheader',
  'rowheader',
  'gridcell',
  'heading',
  'combobox',
  'option',
  'MenuListOption',
]);

const CELL_ROLES = new Set(['cell', 'gridcell', 'columnheader', 'rowheader']);
const STATE_FLAGS = [
  'focused',
  'disabled',
  'readonly',
  'required',
  'checked',
  'selected',
  'expanded',
];

export interface PlaywrightSurfaceOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Called for every network request. Return false to abort it (network allowlist). */
  allowRequest?: (url: string) => boolean;
  /** Called with each aborted request, for the run log. */
  onBlockedRequest?: (url: string) => void;
}

export class PlaywrightSurface implements Surface {
  readonly kind = 'web' as const;
  private refs = new Map<string, { backendNodeId: number }>();
  private lastElements = new Map<string, ObservedElement>();

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly cdp: CDPSession,
  ) {}

  static async launch(options: PlaywrightSurfaceOptions = {}): Promise<PlaywrightSurface> {
    const executablePath = chromiumExecutable();
    const browser = await chromium.launch({
      headless: options.headless ?? true,
      ...(executablePath ? { executablePath } : {}),
    });
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 800 },
    });
    if (options.allowRequest) {
      const allow = options.allowRequest;
      await context.route('**/*', (route: Route) => {
        const url = route.request().url();
        if (url.startsWith('data:') || allow(url)) return route.continue();
        options.onBlockedRequest?.(url);
        return route.abort('blockedbyclient');
      });
    }
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('Accessibility.enable');
    return new PlaywrightSurface(browser, context, page, cdp);
  }

  async location(): Promise<string> {
    return this.page.url();
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ type: 'png' });
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }

  async resolve(target: TargetSpec, options?: ResolveOptions): Promise<Resolution> {
    const obs = await this.observe();
    return resolveTarget(obs.elements, target, options);
  }

  async observe(options: ObserveOptions = {}): Promise<Observation> {
    const { frameTree } = (await this.cdp.send('Page.getFrameTree')) as { frameTree: FrameTree };
    const frames = flattenFrames(frameTree);
    const refs = new Map<string, { backendNodeId: number }>();
    const elements: ObservedElement[] = [];
    const frameInfos: FrameInfo[] = [];

    for (const frame of frames) {
      let nodes: AXNode[];
      try {
        ({ nodes } = (await this.cdp.send('Accessibility.getFullAXTree', {
          frameId: frame.id,
        })) as { nodes: AXNode[] });
      } catch {
        // A frame navigating mid-observe. The next poll sees it settled.
        continue;
      }
      const byId = new Map(nodes.map((n) => [n.nodeId, n]));
      const root = nodes.find((n) => n.role?.value === 'RootWebArea');
      frameInfos.push({ path: frame.path, url: frame.url, title: str(root?.name) });

      const refOf = new Map<string, string>();
      for (const node of nodes) {
        const rawRole = str(node.role);
        if (node.ignored || !rawRole || SKIP_ROLES.has(rawRole)) continue;
        if (node.backendDOMNodeId === undefined) continue;
        const role = normalizeRole(rawRole);
        const name = str(node.name).replace(/\s+/g, ' ').trim();
        if (role === 'text' && (name === '' || hasTextOwner(node, byId))) continue;

        const ref = `e${refs.size + 1}`;
        refs.set(ref, { backendNodeId: node.backendDOMNodeId });
        refOf.set(node.nodeId, ref);
        const value = str(node.value);
        const element: ObservedElement = {
          ref,
          role,
          name,
          framePath: frame.path,
          bbox: { x: 0, y: 0, w: 0, h: 0 },
          states: states(node),
          ...(value ? { value } : {}),
        };
        if (role === 'combobox') element.options = optionNames(node, byId);
        elements.push(element);
      }
      assignTableCoordinates(nodes, byId, refOf, elements);
    }

    await Promise.all(
      elements.map(async (e) => {
        const target = refs.get(e.ref);
        if (target) e.bbox = await this.boxOf(target.backendNodeId);
      }),
    );
    for (const e of elements) {
      if (NEAR_TEXT_ROLES.has(e.role) && (e.name === '' || e.role === 'text')) {
        const near = computeNearText(e, elements);
        if (near) e.nearText = near;
      }
    }

    this.refs = refs;
    this.lastElements = new Map(elements.map((e) => [e.ref, e]));
    const obs: Observation = {
      location: this.page.url(),
      frames: frameInfos,
      elements,
      hash: hashObservation(frameInfos, elements),
      takenAt: new Date().toISOString(),
    };
    if (options.screenshot) obs.screenshot = await this.screenshot();
    return obs;
  }

  async act(action: Action, actor: Actor): Promise<ActResult> {
    assertActorMayUse(action, actor);
    switch (action.type) {
      case 'click': {
        const { element, backendNodeId } = this.lookup(action.ref);
        await this.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined);
        const box = await this.boxOf(backendNodeId);
        await this.page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
        return { element };
      }
      case 'type': {
        const { element, backendNodeId } = this.lookup(action.ref);
        await this.cdp.send('DOM.focus', { backendNodeId });
        // Clear first, so a retried step can never double-type.
        await this.page.keyboard.press('ControlOrMeta+A');
        await this.page.keyboard.press('Backspace');
        await this.page.keyboard.type(action.text);
        return { element };
      }
      case 'select': {
        const { element, backendNodeId } = this.lookup(action.ref);
        const { object } = (await this.cdp.send('DOM.resolveNode', { backendNodeId })) as {
          object: { objectId?: string };
        };
        const result = (await this.cdp.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: SELECT_OPTION_JS,
          arguments: [{ value: action.option }],
          returnByValue: true,
        })) as { result: { value?: unknown } };
        if (result.result.value !== true) {
          throw new Error(`option "${action.option}" not found in ${action.ref}`);
        }
        return { element };
      }
      case 'read': {
        const { element } = this.lookup(action.ref);
        return { element, value: element.value ?? element.name };
      }
      case 'press':
        await this.page.keyboard.press(action.key);
        return {};
      case 'wait':
        await sleep(Math.min(Math.max(action.ms, 0), 10_000));
        return {};
      case 'goto':
        await this.page.goto(action.url, { waitUntil: 'domcontentloaded' });
        return {};
      case 'pointer':
        await this.page.mouse.click(action.x, action.y);
        return {};
      case 'key':
        if (action.key) await this.page.keyboard.press(action.key);
        if (action.text) await this.page.keyboard.type(action.text);
        return {};
    }
  }

  /** The element under a point, from the last observation. Used to log human clicks. */
  elementAt(x: number, y: number): ObservedElement | undefined {
    return [...this.lastElements.values()]
      .filter(
        (e) =>
          x >= e.bbox.x && x <= e.bbox.x + e.bbox.w && y >= e.bbox.y && y <= e.bbox.y + e.bbox.h,
      )
      .sort((a, b) => a.bbox.w * a.bbox.h - b.bbox.w * b.bbox.h)[0];
  }

  private lookup(ref: string): { element: ObservedElement; backendNodeId: number } {
    const target = this.refs.get(ref);
    const element = this.lastElements.get(ref);
    if (!target || !element)
      throw new Error(`stale or unknown element ref ${ref}; observe() again`);
    return { element, backendNodeId: target.backendNodeId };
  }

  private async boxOf(backendNodeId: number): Promise<BBox> {
    try {
      const { quads } = (await this.cdp.send('DOM.getContentQuads', { backendNodeId })) as {
        quads: number[][];
      };
      const q = quads[0];
      if (!q) return { x: 0, y: 0, w: 0, h: 0 };
      const xs = [q[0], q[2], q[4], q[6]] as number[];
      const ys = [q[1], q[3], q[5], q[7]] as number[];
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return {
        x: round(x),
        y: round(y),
        w: round(Math.max(...xs) - x),
        h: round(Math.max(...ys) - y),
      };
    } catch {
      return { x: 0, y: 0, w: 0, h: 0 };
    }
  }
}

const SELECT_OPTION_JS = `function (label) {
  const opt = Array.from(this.options || []).find((o) => o.text.trim() === label);
  if (!opt) return false;
  this.value = opt.value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`;

/**
 * Playwright's bundled Chromium when present, else the CHROMIUM_PATH override,
 * else the pre-installed browser some sandboxes ship at /opt/pw-browsers.
 */
export function chromiumExecutable(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (existsSync(chromium.executablePath())) return undefined;
  const preinstalled = '/opt/pw-browsers/chromium';
  return existsSync(preinstalled) ? preinstalled : undefined;
}

function flattenFrames(
  tree: FrameTree,
  path: string[] = [],
): { id: string; url: string; path: string[] }[] {
  const out = [{ id: tree.frame.id, url: tree.frame.url, path }];
  (tree.childFrames ?? []).forEach((child, i) => {
    const name = child.frame.name || `frame${i}`;
    out.push(...flattenFrames(child, [...path, name]));
  });
  return out;
}

function normalizeRole(raw: string): string {
  if (raw === 'StaticText') return 'text';
  if (raw === 'ListBox') return 'listbox';
  return raw;
}

function str(v: AXValue | undefined): string {
  return v?.value === undefined || v.value === null ? '' : String(v.value);
}

function states(node: AXNode): string[] {
  const out: string[] = [];
  for (const p of node.properties ?? []) {
    if (STATE_FLAGS.includes(p.name) && (p.value.value === true || p.value.value === 'true'))
      out.push(p.name);
  }
  return out;
}

function hasTextOwner(node: AXNode, byId: Map<string, AXNode>): boolean {
  let parent = node.parentId ? byId.get(node.parentId) : undefined;
  while (parent) {
    const role = str(parent.role);
    if (!parent.ignored && TEXT_OWNERS.has(role)) return true;
    if (!parent.ignored && !SKIP_ROLES.has(role)) return false;
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  return false;
}

function optionNames(node: AXNode, byId: Map<string, AXNode>): string[] {
  const names: string[] = [];
  const walk = (n: AXNode) => {
    for (const id of n.childIds ?? []) {
      const child = byId.get(id);
      if (!child) continue;
      const role = str(child.role);
      if (role === 'option' || role === 'MenuListOption') names.push(str(child.name).trim());
      else walk(child);
    }
  };
  walk(node);
  return names.filter((n) => n !== '');
}

/** Gives every cell of a data table its (row, col). Row 0 is the header row. */
function assignTableCoordinates(
  nodes: AXNode[],
  byId: Map<string, AXNode>,
  refOf: Map<string, string>,
  elements: ObservedElement[],
): void {
  const byRef = new Map(elements.map((e) => [e.ref, e]));
  for (const table of nodes.filter((n) => str(n.role) === 'table' && !n.ignored)) {
    const tableRef = refOf.get(table.nodeId);
    if (!tableRef) continue;
    const rows: AXNode[] = [];
    const findRows = (n: AXNode) => {
      for (const id of n.childIds ?? []) {
        const child = byId.get(id);
        if (!child) continue;
        const role = str(child.role);
        if (role === 'row') rows.push(child);
        else if (role !== 'table') findRows(child);
      }
    };
    findRows(table);
    rows.forEach((row, r) => {
      let col = 0;
      for (const id of row.childIds ?? []) {
        const cell = byId.get(id);
        if (!cell || !CELL_ROLES.has(str(cell.role))) continue;
        const ref = refOf.get(cell.nodeId);
        const element = ref ? byRef.get(ref) : undefined;
        if (element) element.table = { tableRef, row: r, col };
        col++;
      }
    });
  }
}

function hashObservation(frames: FrameInfo[], elements: ObservedElement[]): string {
  const h = createHash('sha256');
  for (const f of frames) h.update(`F|${f.path.join('/')}|${f.url}\n`);
  for (const e of elements)
    h.update(`E|${e.framePath.join('/')}|${e.role}|${e.name}|${e.value ?? ''}\n`);
  return h.digest('hex').slice(0, 16);
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
