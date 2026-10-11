// One small declarative language for screen states, used everywhere a state is
// described: step expectations, business outcomes, app-wide conditions and the
// success check. Matchers are data, so a reviewer can read them and the
// compiler can verify them against recorded observations.

import { z } from 'zod';
import { TargetSpec } from './target.js';

export type StateMatcher =
  | { all: StateMatcher[] }
  | { any: StateMatcher[] }
  | { not: StateMatcher }
  | { visible: TargetSpec }
  | { textPresent: string; inFrame?: string[] }
  | { locationMatches: string };

export const StateMatcher: z.ZodType<StateMatcher> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(StateMatcher).min(1) }),
    z.strictObject({ any: z.array(StateMatcher).min(1) }),
    z.strictObject({ not: StateMatcher }),
    z.strictObject({ visible: TargetSpec }),
    z.strictObject({ textPresent: z.string().min(1), inFrame: z.array(z.string()).optional() }),
    z.strictObject({
      locationMatches: z.string().min(1).describe('Regex tested against every frame URL'),
    }),
  ]),
);

/** A short human-readable rendering, for logs and failure messages. */
export function describeMatcher(m: StateMatcher): string {
  if ('all' in m) return m.all.map(describeMatcher).join(' AND ');
  if ('any' in m) return `(${m.any.map(describeMatcher).join(' OR ')})`;
  if ('not' in m) return `NOT ${describeMatcher(m.not)}`;
  if ('visible' in m) return `visible ${JSON.stringify(m.visible)}`;
  if ('textPresent' in m)
    return `text "${m.textPresent}"${m.inFrame ? ` in ${m.inFrame.join('/')}` : ''}`;
  return `location ~ /${m.locationMatches}/`;
}
