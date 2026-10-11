import { describe, expect, it } from 'vitest';
import { DesktopSurface } from '../../src/surface/desktop.js';
import type { Surface } from '../../src/surface/types.js';

describe('DesktopSurface stub', () => {
  it('implements the Surface interface and fails loudly', async () => {
    const surface: Surface = new DesktopSurface();
    expect(surface.kind).toBe('desktop');
    await expect(surface.observe()).rejects.toThrow(/design stub/);
    await expect(surface.act({ type: 'click', ref: 'e1' }, 'automation')).rejects.toThrow(
      /design stub/,
    );
  });

  it('applies the same actor rule as the web surface', async () => {
    await expect(
      new DesktopSurface().act({ type: 'pointer', x: 1, y: 1 }, 'automation'),
    ).rejects.toThrow(/humans only/);
  });
});
