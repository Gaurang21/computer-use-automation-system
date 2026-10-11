// Evaluates StateMatchers against an observation. Pure.

import type { StateMatcher } from '../schema/matcher.js';
import { normalize } from '../surface/near-text.js';
import { resolveTarget } from '../surface/resolve.js';
import type { Observation, ResolveOptions } from '../surface/types.js';

export function matches(obs: Observation, m: StateMatcher, options: ResolveOptions = {}): boolean {
  if ('all' in m) return m.all.every((x) => matches(obs, x, options));
  if ('any' in m) return m.any.some((x) => matches(obs, x, options));
  if ('not' in m) return !matches(obs, m.not, options);
  if ('visible' in m) return resolveTarget(obs.elements, m.visible, options).ok;
  if ('textPresent' in m) {
    const needle = normalize(m.textPresent);
    const inFrame = m.inFrame;
    const frames = inFrame ? obs.frames.filter((f) => samePath(f.path, inFrame)) : obs.frames;
    if (frames.some((f) => f.title.includes(needle))) return true;
    return obs.elements.some(
      (e) =>
        (!inFrame || samePath(e.framePath, inFrame)) &&
        (e.name.includes(needle) || (e.value ?? '').includes(needle)),
    );
  }
  const re = new RegExp(m.locationMatches);
  return re.test(obs.location) || obs.frames.some((f) => re.test(f.url));
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
