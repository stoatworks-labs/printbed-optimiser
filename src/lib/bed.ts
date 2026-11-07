// The printable region of a flattened OrcaSlicer machine preset, and the static grid the packer tests against.
import type { BedSpec } from '../types.ts';
import { pointInPolygon, type Vec2 } from './mesh/geometry.ts';
import { BitGrid } from './layout/grid.ts';
import { dilate, type Mask } from './layout/mask.ts';

type Config = Record<string, string | string[]>;

/** "0x0,256x0,256x256,0x256" or ["0x0", "256x0", ...] -> points. */
export function parsePoints(value: string | string[] | undefined): Vec2[] {
  if (value === undefined) return [];
  const text = Array.isArray(value) ? value.join(',') : value;
  return text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.split('x').map(Number) as Vec2)
    .filter((p) => p.length === 2 && p.every(Number.isFinite));
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function bedFromMachine(machine: Config): BedSpec {
  const area = parsePoints(machine.printable_area);
  if (area.length < 3) throw new Error('The printer preset has no printable_area.');
  const regions: Vec2[][] = [area];
  // Multi-nozzle printers (H2D, H2C): each extruder reaches its own strip. A one-filament plate may be given to
  // either nozzle, so parts stay where both reach.
  const extruderAreas = machine.extruder_printable_area;
  if (Array.isArray(extruderAreas)) for (const a of extruderAreas) {
    const poly = parsePoints(a);
    if (poly.length >= 3) regions.push(poly);
  }
  const exclusions: Vec2[][] = [];
  for (const key of ['bed_exclude_area', 'wrapping_exclude_area']) {
    const poly = parsePoints(machine[key]);
    if (poly.length >= 3) exclusions.push(poly);
  }
  const xs = area.map((p) => p[0]);
  const ys = area.map((p) => p[1]);
  const best = (first(machine.best_object_pos) ?? '0.5,0.5').split(',').map(Number);
  const heights = [Number(first(machine.printable_height))];
  if (Array.isArray(machine.extruder_printable_height)) for (const h of machine.extruder_printable_height) if (Number(h) > 0) heights.push(Number(h));
  return {
    min: [Math.min(...xs), Math.min(...ys)],
    max: [Math.max(...xs), Math.max(...ys)],
    regions,
    exclusions,
    maxHeight: Math.min(...heights.filter((h) => h > 0)),
    bestPos: best.length === 2 && best.every((v) => v >= 0 && v <= 1) ? (best as [number, number]) : [0.5, 0.5],
  };
}

export interface StaticGrid {
  grid: BitGrid;
  res: number;
  minX: number;
  minY: number;
  /** Where parts are drawn to, in grid cells. */
  attract: [number, number];
}

/** Blocked cells: outside any region, inside an exclusion, or within `edgeMargin` of either. */
export function staticGrid(bed: BedSpec, res: number, edgeMargin: number): StaticGrid {
  const w = Math.ceil((bed.max[0] - bed.min[0]) / res);
  const h = Math.ceil((bed.max[1] - bed.min[1]) / res);
  const blocked: Mask = { w, h, ox: 0, oy: 0, cells: new Uint8Array(w * h) };
  for (let y = 0; y < h; y++) {
    const py = bed.min[1] + (y + 0.5) * res;
    for (let x = 0; x < w; x++) {
      const px = bed.min[0] + (x + 0.5) * res;
      const usable = bed.regions.every((r) => pointInPolygon(px, py, r)) && !bed.exclusions.some((e) => pointInPolygon(px, py, e));
      if (!usable) blocked.cells[y * w + x] = 1;
    }
  }
  const r = Math.ceil(edgeMargin / res);
  const grown = dilate(blocked, r);
  const grid = new BitGrid(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // The margin also applies at the grid's own edge, which the mask cannot see past.
      const nearEdge = x < r || y < r || x >= w - r || y >= h - r;
      if (nearEdge || grown.cells[(y + r) * grown.w + x + r]) grid.set(x, y);
    }
  }
  // The preferred position is a fraction of the printable area's bounding box.
  return {
    grid,
    res,
    minX: bed.min[0],
    minY: bed.min[1],
    attract: [Math.round(bed.bestPos[0] * w), Math.round(bed.bestPos[1] * h)],
  };
}
