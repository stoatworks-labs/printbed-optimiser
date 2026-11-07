// The optimiser: from parts, a printer and its presets to a sliced plate for every sampled count.
//
//   1. Probe: slice each part alone at the printer's preferred position. That proves the part prints at all and
//      measures the brim OrcaSlicer gives it (auto brim decides per part), which the packer must leave room for.
//   2. Fullest plate: pack as many kits as fit, and slice that plate. If OrcaSlicer refuses it for placement
//      (outside the plate, too close to an exclusion zone, paths of two objects crossing), widen the margin or the
//      gap and pack again.
//   3. Sweep: lay out and slice the sampled counts from 1 to the fullest, on every host of the pool at once.
//
// Every number shown to the user comes from a slice. The layout rules only decide where parts go.
import type { BedSpec, Layout, LayoutSettings, Part, PlateResult } from '../../types.ts';
import { place, bounds } from '../mesh/geometry.ts';
import type { EnginePool, SliceObject, SliceOutcome } from '../engine/pool.ts';
import type { LayoutJob, LayoutService } from '../layout/service.ts';
import { sampleCounts } from './sweep.ts';
import type { Config, Toolpaths } from '@muon3d/slicer-engine-protocol';

export interface OptimiseRequest {
  parts: Part[];
  heights: Record<string, number>;
  minRectAngles: Record<string, number>;
  bed: BedSpec;
  configs: { machine: Config; process: Config; filaments: Config[] };
  settings: Omit<LayoutSettings, 'brimByPart'>;
  /** Stop adding counts to the sweep beyond this many triangles on one plate (the engine's heap is 4 GB). */
  maxTriangles?: number;
}

export interface Probe {
  partId: string;
  ok: boolean;
  seconds: number | null;
  brim: number;
  error?: string;
}

export interface OptimiseResult {
  probes: Probe[];
  fullest: Layout | null;
  plates: PlateResult[];
  settings: LayoutSettings;
  notes: string[];
}

export interface OptimiseEvents {
  progress?: (message: string, done: number, total: number) => void;
  plate?: (plate: PlateResult) => void;
  probe?: (probe: Probe) => void;
}

const PLACEMENT_ERRORS = new Set([-50, -52, -63, -64, -102]);

export function objectsFor(layout: Layout, parts: Part[]): SliceObject[] {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const used = new Map<string, number>();
  return layout.placements.map((pl) => {
    const part = byId.get(pl.partId)!;
    const base = part.name.replace(/[^\w.\- ]+/g, '_').replace(/\.(stl|3mf|obj)$/i, '') || 'part';
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return { name: `${base} ${n}`, positions: place(part.positions, pl.angle, pl.x, pl.y) };
  });
}

export function plateFrom(layout: Layout, outcome: SliceOutcome, objects: number): PlateResult {
  if (outcome.ok) {
    return {
      kits: layout.kits,
      objects,
      layout,
      ok: true,
      printSeconds: outcome.stats.printTimeSeconds,
      filamentG: outcome.stats.filamentG,
      filamentCost: outcome.stats.filamentCost,
      layers: outcome.stats.layers,
      warnings: outcome.warnings.map((w) => ({ kind: w.kind, message: w.message, objects: w.objects })),
      sliceMs: outcome.ms,
    };
  }
  return {
    kits: layout.kits,
    objects,
    layout,
    ok: false,
    printSeconds: null,
    filamentG: null,
    filamentCost: null,
    layers: null,
    warnings: [],
    error: { code: outcome.code, message: outcome.message, objects: outcome.objects },
    sliceMs: outcome.ms,
  };
}

/** How far the brim reaches past the part, from the probe's toolpaths. */
export function brimWidth(toolpaths: Toolpaths | null, part: { min: number[]; max: number[] }): number {
  if (!toolpaths) return 0;
  const brimRoles = new Set<number>();
  toolpaths.roles.forEach((r, i) => {
    if (/brim/i.test(r.name)) brimRoles.add(i);
  });
  if (!brimRoles.size) return 0;
  const { positions, roleIndex } = toolpaths.extrusions;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let s = 0; s < roleIndex.length; s++) {
    if (!brimRoles.has(roleIndex[s])) continue;
    for (const k of [0, 3]) {
      const x = positions[s * 6 + k];
      const y = positions[s * 6 + k + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!Number.isFinite(x0)) return 0;
  const reach = Math.max(part.min[0] - x0, x1 - part.max[0], part.min[1] - y0, y1 - part.max[1], 0);
  // Half a line width either side of the outermost loop's centreline.
  return Math.ceil((reach + (toolpaths.lineWidth ?? 0.45) / 2) * 2) / 2;
}

export async function optimise(
  req: OptimiseRequest,
  pool: EnginePool,
  layouts: LayoutService,
  events: OptimiseEvents = {},
  signal?: AbortSignal,
): Promise<OptimiseResult> {
  const notes: string[] = [];
  const check = () => {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  };
  const { bed } = req;
  const ax = bed.min[0] + bed.bestPos[0] * (bed.max[0] - bed.min[0]);
  const ay = bed.min[1] + bed.bestPos[1] * (bed.max[1] - bed.min[1]);

  // ---- 1. Probe each part alone ------------------------------------------------------------------------------
  events.progress?.('Slicing each part alone', 0, req.parts.length);
  let probed = 0;
  const probes = await Promise.all(
    req.parts.map(async (part): Promise<Probe> => {
      const positions = place(part.positions, 0, ax, ay);
      const b = bounds(positions); // before the slice: the pool moves the buffer to the engine
      const outcome = await pool.slice({ configs: req.configs, objects: [{ name: part.name, positions }], toolpaths: true });
      check();
      const probe: Probe = outcome.ok
        ? { partId: part.id, ok: true, seconds: outcome.stats.printTimeSeconds, brim: brimWidth(outcome.toolpaths, b) }
        : { partId: part.id, ok: false, seconds: null, brim: 0, error: `${outcome.message} (OrcaSlicer ${outcome.code})` };
      events.probe?.(probe);
      events.progress?.('Slicing each part alone', ++probed, req.parts.length);
      return probe;
    }),
  );
  const brimByPart = Object.fromEntries(probes.map((p) => [p.partId, p.brim]));
  let settings: LayoutSettings = { ...req.settings, brimByPart };
  if (probes.some((p) => !p.ok)) {
    notes.push('A part would not slice on its own, so no plate was laid out. Fix it first (see its message).');
    return { probes, fullest: null, plates: [], settings, notes };
  }

  await layouts.addParts(req.parts.map((p) => ({ id: p.id, positions: p.positions })));
  const job = (): LayoutJob => ({
    bed,
    parts: req.parts.map((p) => ({ id: p.id, quantity: p.quantity, height: req.heights[p.id] ?? 0, minRectAngle: req.minRectAngles[p.id] ?? 0 })),
    settings,
  });
  const triangles = (kits: number) => kits * req.parts.reduce((s, p) => s + p.triangles * p.quantity, 0);
  const maxTriangles = req.maxTriangles ?? 4_000_000;

  // ---- 2. The fullest plate, checked by the slicer -----------------------------------------------------------
  let fullest: Layout | null = null;
  let fullestPlate: PlateResult | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    check();
    events.progress?.(attempt ? 'Packing again with more room' : 'Packing the fullest plate', 0, 1);
    fullest = await layouts.max(job());
    if (!fullest) {
      notes.push('One kit does not fit on this printer\'s bed with these clearances. Reduce the kit, the gap or the edge margin.');
      return { probes, fullest: null, plates: [], settings, notes };
    }
    if (triangles(fullest.kits) > maxTriangles) break; // too heavy to check here; the sweep stops before it
    const objects = objectsFor(fullest, req.parts);
    events.progress?.(`Slicing the fullest plate (${objects.length} objects)`, 0, 1);
    const outcome = await pool.slice({ configs: req.configs, objects });
    fullestPlate = plateFrom(fullest, outcome, objects.length);
    if (outcome.ok || !(PLACEMENT_ERRORS.has(outcome.code) || outcome.code === -101)) break;
    if (outcome.code === -101) {
      settings = { ...settings, gap: settings.gap * 1.5 };
      notes.push(`OrcaSlicer found two objects' paths crossing (${outcome.message}); the gap was widened to ${settings.gap.toFixed(1)} mm.`);
    } else {
      settings = { ...settings, edgeMargin: settings.edgeMargin + 4 };
      notes.push(`OrcaSlicer refused a part's position (${outcome.message}); the edge margin was widened to ${settings.edgeMargin} mm.`);
    }
    fullestPlate = null;
  }
  check();

  // ---- 3. The sweep -------------------------------------------------------------------------------------------
  let counts = sampleCounts(fullest!.kits);
  const heavy = counts.filter((k) => triangles(k) > maxTriangles);
  if (heavy.length) {
    counts = counts.filter((k) => triangles(k) <= maxTriangles);
    notes.push(
      `Plates of more than ${counts.at(-1) ?? 0} were not sliced: ${heavy[0]} copies carry ${(triangles(heavy[0]) / 1e6).toFixed(1)} M triangles, more than a browser tab's slicer can hold. A lighter mesh would let the sweep go further.`,
    );
  }
  const plates: PlateResult[] = [];
  if (fullestPlate && counts.includes(fullestPlate.kits)) {
    plates.push(fullestPlate);
    events.plate?.(fullestPlate);
    counts = counts.filter((k) => k !== fullestPlate!.kits);
  }
  events.progress?.('Laying out each count', 0, counts.length);
  const laid = await layouts.layouts(job(), counts);
  check();
  let done = 0;
  const total = counts.length;
  events.progress?.('Slicing each count', done, total);
  await Promise.all(
    counts.map(async (_, i) => {
      const layout = laid[i];
      if (!layout) return;
      const objects = objectsFor(layout, req.parts);
      const outcome = await pool.slice({ configs: req.configs, objects });
      check();
      const plate = plateFrom(layout, outcome, objects.length);
      plates.push(plate);
      events.plate?.(plate);
      events.progress?.('Slicing each count', ++done, total);
    }),
  );
  plates.sort((a, b) => a.kits - b.kits);
  return { probes, fullest, plates, settings, notes };
}
