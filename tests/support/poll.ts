import { setTimeout as sleep } from 'node:timers/promises';
import type { Observation, Surface } from '../../src/surface/types.js';

/** Polls observe() until the predicate holds. Test helper only. */
export async function observeUntil(
  surface: Surface,
  predicate: (obs: Observation) => boolean,
  timeoutMs = 8000,
): Promise<Observation> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const obs = await surface.observe();
    if (predicate(obs)) return obs;
    if (Date.now() > deadline) {
      throw new Error(
        `observeUntil timed out; last screen: ${obs.elements.map((e) => e.name).join(' | ')}`,
      );
    }
    await sleep(150);
  }
}

export const hasText = (text: string) => (obs: Observation) =>
  obs.elements.some((e) => e.name.includes(text));
