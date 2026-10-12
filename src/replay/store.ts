// Loads app profiles, capabilities and tenant overlays from disk and merges
// them into the effective capability that actually runs.
//
// Layout: <root>/<appId>/app-profile.json
//         <root>/<appId>/overlays/<tenantId>.json
//         <root>/<appId>/<capability id>.json   (plus any extra capability dirs)

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppProfile } from '../schema/app-profile.js';
import { Capability } from '../schema/capability.js';
import { TenantOverlay, type JsonPatchOp } from '../schema/overlay.js';
import { sha256, stableStringify } from './hash.js';
import { versionInRange } from './version.js';

export interface EffectiveCapability {
  profile: AppProfile;
  capability: Capability;
  overlay: TenantOverlay;
  /** Hash of the merged documents. Logged on every run. */
  effectiveHash: string;
  /** Where the capability was loaded from. */
  file: string;
}

export class CapabilityDisabledError extends Error {}
export class CapabilityNotFoundError extends Error {}

export class CapabilityStore {
  private files = new Map<string, string>();

  /**
   * @param root directory holding one folder per app
   * @param appId the vendor product
   * @param extraDirs more capability folders, searched before the app folder; earlier folders win on id clashes
   */
  constructor(
    readonly root = 'capabilities',
    readonly appId = 'memberdesk',
    extraDirs: string[] = [],
  ) {
    // Extra folders first: a draft being probed or self-checked must win over a saved capability with the same id.
    for (const dir of [...extraDirs, join(root, appId)]) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json') || f === 'app-profile.json' || f.endsWith('.rejected.json'))
          continue;
        const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
          kind?: string;
          id?: string;
        };
        if (raw.kind === 'capability' && raw.id && !this.files.has(raw.id))
          this.files.set(raw.id, join(dir, f));
      }
    }
  }

  ids(): string[] {
    return [...this.files.keys()].sort();
  }

  fileOf(id: string): string | undefined {
    return this.files.get(id);
  }

  profile(): AppProfile {
    return AppProfile.parse(readJson(join(this.root, this.appId, 'app-profile.json')));
  }

  overlay(tenantId: string): TenantOverlay {
    const file = join(this.root, this.appId, 'overlays', `${tenantId}.json`);
    if (!existsSync(file)) throw new CapabilityNotFoundError(`no overlay for tenant ${tenantId}`);
    return TenantOverlay.parse(readJson(file));
  }

  capability(id: string): Capability {
    const file = this.files.get(id);
    if (!file)
      throw new CapabilityNotFoundError(`no capability ${id} (have: ${this.ids().join(', ')})`);
    return Capability.parse(readJson(file));
  }

  effective(id: string, tenantId: string, opts: { baseUrl?: string } = {}): EffectiveCapability {
    const overlay = this.overlay(tenantId);
    if (opts.baseUrl) overlay.baseUrl = opts.baseUrl;
    return mergeEffective(this.profile(), this.capability(id), overlay, this.files.get(id) ?? '');
  }
}

export function mergeEffective(
  profile: AppProfile,
  capability: Capability,
  overlay: TenantOverlay,
  file = '',
): EffectiveCapability {
  if (overlay.disabledCapabilities.includes(capability.id)) {
    throw new CapabilityDisabledError(`${capability.id} is disabled for ${overlay.tenantId}`);
  }
  let cap: Capability = structuredClone(capability);
  for (const patch of overlay.patches) {
    if (patch.capabilityId !== cap.id) continue;
    if (patch.appVersions && !versionInRange(overlay.appVersion, patch.appVersions)) continue;
    cap = Capability.parse(applyPatch(cap, patch.ops));
  }
  const mapped = {
    profile: applyTextMap(profile, overlay.textMap),
    capability: applyTextMap(cap, overlay.textMap),
  };
  return {
    ...mapped,
    overlay,
    file,
    effectiveHash: sha256(stableStringify({ ...mapped, overlay })).slice(0, 16),
  };
}

/** Keys whose string values are UI text and get tenant renames. Bindings, ids and codes do not. */
const TEXT_KEYS = new Set(['name', 'label', 'text', 'textPresent', 'equals', 'column']);

export function applyTextMap<T>(value: T, textMap: Record<string, string>): T {
  if (Object.keys(textMap).length === 0) return value;
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') return key && TEXT_KEYS.has(key) && v in textMap ? textMap[v] : v;
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value) as T;
}

/** The add/remove/replace subset of RFC 6902, enough for targeted fixes. */
export function applyPatch<T>(doc: T, ops: readonly JsonPatchOp[]): T {
  const out = structuredClone(doc) as unknown;
  for (const op of ops) {
    const parts = op.path
      .split('/')
      .slice(1)
      .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    const last = parts.pop();
    if (last === undefined) throw new Error('patch path must not be the root');
    let parent = out as Record<string, unknown> | unknown[];
    for (const p of parts) {
      const next = (parent as Record<string, unknown>)[p];
      if (next === undefined || next === null || typeof next !== 'object')
        throw new Error(`patch path ${op.path} not found`);
      parent = next as Record<string, unknown>;
    }
    if (Array.isArray(parent)) {
      const i = last === '-' ? parent.length : Number(last);
      if (op.op === 'add') parent.splice(i, 0, op.value);
      else if (op.op === 'remove') parent.splice(i, 1);
      else parent[i] = op.value;
    } else if (op.op === 'remove') {
      Reflect.deleteProperty(parent, last);
    } else {
      parent[last] = op.value;
    }
  }
  return out as T;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}
