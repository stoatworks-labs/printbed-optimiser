import { describe, expect, it } from 'vitest';
import { planQuantity, recommend, sampleCounts, timeline, formatDuration } from './sweep.ts';
import type { PlateResult } from '../../types.ts';

/** A plate whose time is start-up plus a fixed time per kit, like a real slice (roughly). */
function plate(kits: number, startup = 600, each = 400, warnings = 0): PlateResult {
  return {
    kits,
    objects: kits,
    layout: { kits, placements: [], strategy: 'centre', spacing: 1, meanOffset: 0, clusterArea: 0 },
    ok: true,
    printSeconds: startup + each * kits,
    filamentG: kits * 4,
    filamentCost: null,
    layers: 100,
    warnings: Array.from({ length: warnings }, () => ({ kind: 'validation', message: 'x' })),
    sliceMs: 300,
  };
}

describe('sampleCounts', () => {
  it('slices every count on a small plate', () => {
    expect(sampleCounts(5)).toEqual([1, 2, 3, 4, 5]);
  });
  it('samples a big plate densely low and sparsely high, ending at the maximum', () => {
    const s = sampleCounts(150);
    expect(s.slice(0, 12)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(s.at(-1)).toBe(150);
    expect(s.at(-2)).toBe(149);
    expect(s.length).toBeLessThan(32);
    expect([...s].sort((a, b) => a - b)).toEqual(s);
  });
});

describe('recommend', () => {
  const plates = [1, 2, 4, 8, 16, 24].map((k) => plate(k));

  it('finds the fastest per piece and the fewest within tolerance', () => {
    const r = recommend(plates, { overheadSeconds: 300, tolerance: 0.05 });
    expect(r.fastest?.kits).toBe(24);
    // per kit: (900 + 400k)/k. 24 -> 437.5; within 5% -> <= 459.4; 16 -> 456.25 qualifies, 8 -> 512.5 does not.
    expect(r.recommended?.kits).toBe(16);
  });

  it('respects a plate time limit', () => {
    const r = recommend(plates, { overheadSeconds: 300, tolerance: 0, maxPlateSeconds: 900 + 400 * 8 });
    expect(r.fastest?.kits).toBe(8);
  });

  it('leaves out plates the slicer warned about when clean ones exist', () => {
    const warned = [plate(1), plate(2), plate(4, 600, 400, 1)];
    const r = recommend(warned, { overheadSeconds: 0, tolerance: 0 });
    expect(r.fastest?.kits).toBe(2);
    expect(r.reason).toMatch(/warnings were left out/);
  });

  it('ignores failed slices', () => {
    const failed = { ...plate(30), ok: false, printSeconds: null };
    const r = recommend([...plates, failed], { overheadSeconds: 0, tolerance: 0 });
    expect(r.fastest?.kits).toBe(24);
  });
});

describe('planQuantity', () => {
  const plates = [1, 2, 3, 4, 5, 6, 8, 10].map((k) => plate(k));

  it('interpolates between sliced counts', () => {
    const t = timeline(plates, 0);
    expect(t(7)).toEqual({ seconds: 600 + 400 * 7, estimated: true });
    expect(t(8)).toEqual({ seconds: 600 + 400 * 8, estimated: false });
    expect(t(11)).toBeNull();
  });

  it('fills plates as full as they go when start-up dominates', () => {
    const plan = planQuantity(plates, 25, { overheadSeconds: 600 })!;
    expect(plan.plates.map((p) => p.kits)).toEqual([10, 10, 5]);
    expect(plan.totalSeconds).toBe(3 * 1200 + 400 * 25);
  });

  it('splits around a plate time limit', () => {
    const plan = planQuantity(plates, 12, { overheadSeconds: 0, maxPlateSeconds: 600 + 400 * 6 })!;
    expect(plan.plates.map((p) => p.kits)).toEqual([6, 6]);
  });

  it('says when nothing fits the limit', () => {
    expect(planQuantity(plates, 3, { overheadSeconds: 0, maxPlateSeconds: 100 })).toBeNull();
  });
});

describe('formatDuration', () => {
  it('reads like a slicer', () => {
    expect(formatDuration(973)).toBe('16m 13s');
    expect(formatDuration(3 * 3600 + 5 * 60)).toBe('3h 05m');
    expect(formatDuration(null)).toBe('—');
  });
});
