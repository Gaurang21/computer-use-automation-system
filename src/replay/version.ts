// Tiny version-range check for app versions like "7.4" against ">=7.2 <8".
// Space-separated comparators, all must hold.

export function versionInRange(version: string, range: string): boolean {
  return range
    .trim()
    .split(/\s+/)
    .every((cmp) => {
      const m = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)*)$/.exec(cmp);
      if (!m) throw new Error(`bad version comparator "${cmp}"`);
      const c = compareVersions(version, m[2] as string);
      switch (m[1] ?? '=') {
        case '>=':
          return c >= 0;
        case '<=':
          return c <= 0;
        case '>':
          return c > 0;
        case '<':
          return c < 0;
        default:
          return c === 0;
      }
    });
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
