// Compact text renderings of an observation. Used for the model prompt, for
// "observed" in failure results, and for saved observation snapshots.

import type { Observation, ObservedElement } from './types.js';

export function renderElement(e: ObservedElement): string {
  const parts = [`[${e.ref}]`, e.role, JSON.stringify(e.name)];
  if (e.nearText)
    parts.push(
      `(label ${e.nearText.relation === 'left_of' ? 'left' : 'above'}: ${JSON.stringify(e.nearText.text)})`,
    );
  if (e.value) parts.push(`value=${JSON.stringify(e.value)}`);
  if (e.options) parts.push(`options=${JSON.stringify(e.options)}`);
  if (e.table) parts.push(`(row ${e.table.row}, col ${e.table.col})`);
  if (e.states.length) parts.push(`{${e.states.join(',')}}`);
  return parts.join(' ');
}

/** Elements grouped by frame, one per line. */
export function renderObservation(obs: Observation, maxElements = 200): string {
  const lines: string[] = [];
  for (const frame of obs.frames) {
    const inFrame = obs.elements.filter((e) => samePath(e.framePath, frame.path));
    if (inFrame.length === 0) continue;
    lines.push(`# frame ${frame.path.join('/') || '(top)'}: ${frame.title} <${frame.url}>`);
    for (const e of inFrame) {
      if (lines.length >= maxElements) {
        lines.push(`... ${obs.elements.length} elements in total`);
        return lines.join('\n');
      }
      lines.push(renderElement(e));
    }
  }
  return lines.join('\n');
}

/** A one-line summary of what is on screen, for failure messages. */
export function summarizeObservation(obs: Observation, maxChars = 400): string {
  const main = obs.frames.find((f) => f.path.at(-1) === 'main') ?? obs.frames.at(-1);
  const texts = obs.elements
    .filter((e) => !main || samePath(e.framePath, main.path))
    .filter((e) => ['text', 'heading', 'button', 'link'].includes(e.role) && e.name)
    .map((e) => (e.role === 'button' ? `[${e.name}]` : e.name));
  const s = `${main?.title ?? ''} <${main?.url ?? obs.location}>: ${texts.join(' | ')}`;
  return s.length > maxChars ? `${s.slice(0, maxChars - 3)}...` : s;
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
