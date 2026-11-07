import { describe, expect, it } from 'vitest';
import { Packer, type PackPart } from './pack.ts';
import { staticGrid } from '../bed.ts';
import { place, bounds } from '../mesh/geometry.ts';
import type { BedSpec, Layout, LayoutSettings } from '../../types.ts';
import { box, lShape } from '../test-meshes.ts';
import { rasterise } from './mask.ts';

const x1c: BedSpec = {
  min: [0, 0],
  max: [256, 256],
  regions: [[[0, 0], [256, 0], [256, 256], [0, 256]]],
  exclusions: [[[0, 0], [18, 0], [18, 28], [0, 28]]],
  maxHeight: 250,
  bestPos: [0.5, 0.5],
};

const settings: LayoutSettings = { gap: 6, edgeMargin: 5, heightGapPerMm: 0, brimByPart: {}, allowRotation: true, resolution: 0.5 };

function part(id: string, positions: Float32Array, quantity = 1): PackPart {
  const b = bounds(positions);
  return { id, positions, quantity, height: b.max[2], minRectAngle: 0 };
}

/** Footprint rectangles of a layout's parts, in bed coordinates. */
function rects(layout: Layout, parts: PackPart[]) {
  return layout.placements.map((p) => {
    const src = parts.find((q) => q.id === p.partId)!;
    const b = bounds(place(src.positions, p.angle, p.x, p.y));
    return { x0: b.min[0], x1: b.max[0], y0: b.min[1], y1: b.max[1] };
  });
}

/** True when no two placed footprints share a 0.25 mm cell (shapes that interlock pass; boxes would not). */
function footprintsDisjoint(layout: Layout, parts: PackPart[]): boolean {
  const taken = new Set<number>();
  for (const p of layout.placements) {
    const src = parts.find((q) => q.id === p.partId)!;
    const m = rasterise(place(src.positions, p.angle, p.x, p.y), 0, 0.25);
    const mine = new Set<number>();
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        if (!m.cells[y * m.w + x]) continue;
        const key = (y - m.oy + 4000) * 10000 + (x - m.ox + 4000);
        if (taken.has(key)) return false;
        mine.add(key);
      }
    }
    for (const k of mine) taken.add(k);
  }
  return true;
}

function minGap(rs: ReturnType<typeof rects>): number {
  let g = Infinity;
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      const dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1));
      const dy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));
      g = Math.min(g, Math.hypot(dx, dy));
    }
  }
  return g;
}

describe('Packer', () => {
  const bed = staticGrid(x1c, 0.5, settings.edgeMargin);

  it('keeps every copy inside the bed, out of the exclusion zone, and the gap apart', () => {
    const cube = part('cube', box(20, 20, 20));
    const packer = new Packer(bed, [cube], settings);
    const layout = packer.maxKits()!;
    expect(layout.kits).toBeGreaterThanOrEqual(64); // a 9 x 9 grid of 26 mm pitch is 81 in 246 mm; greedy gets most
    const rs = rects(layout, [cube]);
    for (const r of rs) {
      expect(r.x0).toBeGreaterThanOrEqual(5 - 1e-6);
      expect(r.y0).toBeGreaterThanOrEqual(5 - 1e-6);
      expect(r.x1).toBeLessThanOrEqual(251 + 1e-6);
      expect(r.y1).toBeLessThanOrEqual(251 + 1e-6);
      const inExclusion = r.x0 < 18 + 5 && r.y0 < 28 + 5;
      expect(inExclusion).toBe(false);
    }
    expect(minGap(rs)).toBeGreaterThanOrEqual(6 - 1e-6);
  });

  it('centres a small plate on the preferred position', () => {
    const cube = part('cube', box(20, 20, 20));
    const layout = new Packer(bed, [cube], settings).layoutFor(4)!;
    expect(layout.placements).toHaveLength(4);
    const cx = layout.placements.reduce((s, p) => s + p.x, 0) / 4;
    const cy = layout.placements.reduce((s, p) => s + p.y, 0) / 4;
    expect(Math.abs(cx - 128)).toBeLessThan(3);
    expect(Math.abs(cy - 128)).toBeLessThan(3);
    // Room to spare, so the roomier spacing is used.
    expect(layout.spacing).toBe(1.5);
    expect(minGap(rects(layout, [cube]))).toBeGreaterThanOrEqual(9 - 1e-6);
  });

  it('lays identical parts on a regular grid, the gap apart', () => {
    const cube = part('cube', box(20, 20, 20));
    const packer = new Packer(bed, [cube], settings);
    for (const kits of [6, 28]) {
      const layout = packer.layoutFor(kits)!;
      expect(layout.strategy).toBe('grid');
      // Rows: every one holds the same count but the last, which may be short.
      const rows = new Map<string, number[]>();
      for (const p of layout.placements) rows.set(p.y.toFixed(2), [...(rows.get(p.y.toFixed(2)) ?? []), p.x]);
      const counts = [...rows.values()].map((r) => r.length).sort((a, b) => b - a);
      expect(counts.slice(0, -1).every((n) => n === counts[0])).toBe(true);
      // One pitch along every row.
      const pitches = new Set([...rows.values()].flatMap((r) => r.sort((a, b) => a - b).slice(1).map((x, i) => (x - r[i]).toFixed(2))));
      expect(pitches.size).toBeLessThanOrEqual(1);
      expect(minGap(rects(layout, [cube]))).toBeGreaterThanOrEqual(6 - 1e-6);
      const cx = layout.placements.reduce((s, p) => s + p.x, 0) / kits;
      expect(Math.abs(cx - 128)).toBeLessThan(15);
    }
  });

  it('packs one kit of a thin part and two squares compactly, not as a stack', () => {
    // The bar goes first (largest halo); the squares must end up side by side, not one each side of the bar.
    const kit = [part('bar', box(60, 12, 8)), part('sq', box(30, 30, 4), 2)];
    const one = new Packer(bed, kit, settings).packKits(1, 'centre', 1.5)!;
    expect(Math.sqrt(one.clusterArea)).toBeLessThan(72);
  });

  it('centres a plate across the bed even when it fills the bed front to back', () => {
    const kit = [part('bar', box(60, 12, 8)), part('sq', box(30, 30, 4), 2)];
    const packer = new Packer(bed, kit, settings);
    for (const kits of [4, 9]) {
      const rs = rects(packer.layoutFor(kits)!, kit);
      const x0 = Math.min(...rs.map((r) => r.x0));
      const x1 = Math.max(...rs.map((r) => r.x1));
      expect(Math.abs((x0 + x1) / 2 - 128)).toBeLessThan(8);
      expect(footprintsDisjoint(packer.layoutFor(kits)!, kit)).toBe(true);
    }
  });

  it('gives tall parts more room', () => {
    const tall = part('tall', box(10, 10, 120));
    const short = part('short', box(10, 10, 5));
    const s = { ...settings, heightGapPerMm: 0.05 };
    const tallMax = new Packer(bed, [tall], s).maxKits()!.kits;
    const shortMax = new Packer(bed, [short], s).maxKits()!.kits;
    expect(tallMax).toBeLessThan(shortMax);
  });

  it('packs a kit of mixed parts, every part of every kit', () => {
    const kit = [part('big', box(60, 40, 10)), part('ell', lShape(40, 40, 10, 5), 2)];
    const layout = new Packer(bed, kit, settings).maxKits()!;
    expect(layout.kits).toBeGreaterThanOrEqual(3);
    for (let k = 0; k < layout.kits; k++) {
      expect(layout.placements.filter((p) => p.kit === k && p.partId === 'big')).toHaveLength(1);
      expect(layout.placements.filter((p) => p.kit === k && p.partId === 'ell')).toHaveLength(2);
    }
    expect(footprintsDisjoint(layout, kit)).toBe(true);
  });

  it('turns a long part to fit a bed it would not fit straight', () => {
    // 300 mm long: only fits on a 256 bed along the diagonal.
    const rod = part('rod', box(300, 8, 8));
    const layout = new Packer(staticGrid(x1c, 0.5, 2), [{ ...rod, minRectAngle: 0 }], { ...settings, edgeMargin: 2 }).layoutFor(1);
    expect(layout).toBeNull(); // no candidate angle is diagonal for a rectangle that is already square to the axes
    const angled = new Packer(staticGrid(x1c, 0.5, 2), [{ ...rod, positions: place(rod.positions, 45, 0, 0), minRectAngle: 45 }], {
      ...settings,
      edgeMargin: 2,
    }).layoutFor(1);
    expect(angled).not.toBeNull();
  });
});
