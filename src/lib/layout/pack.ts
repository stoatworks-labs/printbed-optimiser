// The packer: greedy placement of footprint masks on the bed grid.
//
// Two grids decide where a part may go. The static grid (src/lib/bed.ts) blocks everything outside the printable
// region, inside exclusion zones, and within the edge margin of either; a part's *base* mask (its footprint grown
// by its expected brim) must not touch it. The dynamic grid holds the *halos* of parts already placed (footprint
// grown by brim + spacing * (gap/2 + height clearance)); a new part's halo must not touch it. Two halos that do not
// touch keep the parts at least the sum of their clearances apart.
//
// Strategies differ only in the order candidate positions are tried: nearest the printer's preferred position
// first ("centre"), front row first ("rows") or left column first ("columns"). Each candidate is tried at a coarse
// step for every rotation; the first that fits is then slid, a cell at a time, toward the strategy's corner or
// toward the centre, which packs parts against each other. At the end the whole cluster is moved as one, to sit on
// the preferred position as far as the bed allows.
//
// The fourth strategy, "grid", places no part on its own: it lays one kit out as a tile and repeats the tile at a
// fixed pitch (its halo's width and depth), in the rows and columns that fit, centred on the preferred position.
// Copies on a regular grid cool alike and are easy to check and clear, so a grid is preferred whenever it is nearly
// as good as the greedy layouts (GRID_BIAS).
import type { Layout, LayoutSettings, PackStrategy, Placement } from '../../types.ts';
import { BitGrid } from './grid.ts';
import { dilate, pack, rasterise, sameMask, type Mask, type PackedMask } from './mask.ts';
import type { StaticGrid } from '../bed.ts';

export interface PackPart {
  id: string;
  positions: Float32Array;
  quantity: number;
  height: number;
  /** Angle of the footprint's minimum-area rectangle, from the analysis. */
  minRectAngle: number;
}

/** A grid layout's score is multiplied by this when layouts are compared: neat wins unless it costs > 10%. */
const GRID_BIAS = 0.9;
const STRATEGIES: PackStrategy[] = ['grid', 'centre', 'rows', 'columns'];

interface TileItem {
  part: PackPart;
  pose: Pose;
  /** Cell offset of the part's origin from the tile's origin. */
  dx: number;
  dy: number;
}

/** One kit laid out, to be repeated: its items and the extents (cells, relative to the tile origin) of its bases and
 * halos. Repeating it every `px` cells across and `py` cells deep keeps neighbouring halos apart. */
interface Tile {
  items: TileItem[];
  bx0: number;
  bx1: number;
  by0: number;
  by1: number;
  px: number;
  py: number;
}

interface Pose {
  angle: number;
  base: PackedMask;
  halo: PackedMask;
  /** Bounds of the base mask's set cells, relative to the origin cell. */
  bx0: number;
  bx1: number;
  by0: number;
  by1: number;
  /** Bounds of the halo mask's set cells, relative to the origin cell. */
  hx0: number;
  hx1: number;
  hy0: number;
  hy1: number;
}

/** Bounds of a packed mask's set cells, relative to its origin cell. */
function setBounds(m: PackedMask): [number, number, number, number] {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (m.rows[y * m.words + (x >> 5)] & (1 << (x & 31))) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return [x0 - m.ox, x1 - m.ox, y0 - m.oy, y1 - m.oy];
}

export class Packer {
  private cores = new Map<string, { angle: number; mask: Mask }[]>();
  private poses = new Map<string, Pose[]>();
  private orders = new Map<string, Int32Array>();

  constructor(
    readonly bed: StaticGrid,
    readonly parts: PackPart[],
    readonly settings: LayoutSettings,
  ) {}

  /** The distinct footprints of a part over its candidate rotations (identical masks kept once). */
  private coreMasks(part: PackPart): { angle: number; mask: Mask }[] {
    let list = this.cores.get(part.id);
    if (list) return list;
    const angles = new Set<number>([0]);
    if (this.settings.allowRotation) {
      for (const base of [0, part.minRectAngle]) for (const q of [0, 90, 180, 270]) angles.add(Math.round(((base + q) % 360) * 10) / 10);
    }
    list = [];
    for (const angle of angles) {
      const mask = rasterise(part.positions, angle, this.settings.resolution);
      if (!list.some((m) => sameMask(m.mask, mask))) list.push({ angle, mask });
    }
    this.cores.set(part.id, list);
    return list;
  }

  /** Clearance (mm, each side) a part keeps from its neighbours at a spacing multiplier. */
  clearance(part: PackPart, spacing: number): number {
    const brim = this.settings.brimByPart[part.id] ?? 0;
    return brim + spacing * (this.settings.gap / 2 + this.settings.heightGapPerMm * part.height);
  }

  private posesOf(part: PackPart, spacing: number): Pose[] {
    const res = this.settings.resolution;
    const brimCells = Math.ceil((this.settings.brimByPart[part.id] ?? 0) / res);
    const haloCells = Math.ceil(this.clearance(part, spacing) / res);
    const key = `${part.id}|${brimCells}|${haloCells}`;
    let poses = this.poses.get(key);
    if (poses) return poses;
    poses = this.coreMasks(part).map(({ angle, mask }) => {
      const base = pack(dilate(mask, brimCells));
      const halo = pack(dilate(mask, haloCells));
      const [bx0, bx1, by0, by1] = setBounds(base);
      const [hx0, hx1, hy0, hy1] = setBounds(halo);
      return { angle, base, halo, bx0, bx1, by0, by1, hx0, hx1, hy0, hy1 };
    });
    this.poses.set(key, poses);
    return poses;
  }

  /** Candidate origin cells in the strategy's order, on a coarse step. */
  private order(strategy: PackStrategy): Int32Array {
    let o = this.orders.get(strategy);
    if (o) return o;
    const { grid, attract } = this.bed;
    const step = Math.max(1, Math.round(2 / this.settings.resolution));
    const cells: [number, number, number][] = [];
    for (let y = 0; y < grid.h; y += step) {
      for (let x = 0; x < grid.w; x += step) {
        if (grid.get(x, y)) continue;
        const key =
          strategy === 'centre' ? (x - attract[0]) ** 2 + (y - attract[1]) ** 2 : strategy === 'rows' ? y * grid.w + x : x * grid.h + y;
        cells.push([key, x, y]);
      }
    }
    cells.sort((a, b) => a[0] - b[0]);
    o = new Int32Array(cells.length * 2);
    cells.forEach(([, x, y], i) => {
      o![i * 2] = x;
      o![i * 2 + 1] = y;
    });
    this.orders.set(strategy, o);
    return o;
  }

  /** Lay out `kits` copies of the kit. Null when they do not all fit. */
  packKits(kits: number, strategy: PackStrategy, spacing = 1): Layout | null {
    if (kits <= 0) return null;
    if (strategy === 'grid') return this.packGrid(kits, spacing);
    const { grid: fixed, attract, res } = this.bed;
    const dynamic = new BitGrid(fixed.w, fixed.h);
    const order = this.order(strategy);

    interface Item { part: PackPart; kit: number; poses: Pose[]; area: number }
    const items: Item[] = [];
    for (let k = 0; k < kits; k++) {
      for (const part of this.parts) {
        const poses = this.posesOf(part, spacing);
        for (let q = 0; q < part.quantity; q++) items.push({ part, kit: k, poses, area: poses[0].halo.count });
      }
    }
    // Largest first; copies of one part stay together, so each part's scan resumes where its last copy landed.
    items.sort((a, b) => b.area - a.area || (a.part.id < b.part.id ? -1 : a.part.id > b.part.id ? 1 : a.kit - b.kit));

    const valid = (pose: Pose, x: number, y: number) => fixed.fits(pose.base, x, y) && !dynamic.touches(pose.halo, x, y);
    const resume = new Map<string, number>();
    const placed: { item: Item; pose: Pose; x: number; y: number }[] = [];
    // The cluster's bounding box so far, in cells.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const boxWith = (pose: Pose, x: number, y: number) => {
      const a0 = Math.min(x0, x + pose.bx0), a1 = Math.max(x1, x + pose.bx1);
      const b0 = Math.min(y0, y + pose.by0), b1 = Math.max(y1, y + pose.by1);
      return { w: a1 - a0 + 1, h: b1 - b0 + 1 };
    };
    // Rows and columns take the first fit (ties between rotations go to the smaller cluster). The centre strategy
    // looks at every fit from the nearest one out to a part's width further (so each side of the cluster is in
    // play, not just the strip nearest the middle), and takes the one that keeps the cluster squarest and
    // smallest, so four parts make a square, not a cross.
    const CENTRE_CANDIDATES = 400;
    const centreScore = (pose: Pose, x: number, y: number) => {
      const { w, h } = boxWith(pose, x, y);
      return Math.max(w, h) ** 2 + w * h + 0.1 * ((x - attract[0]) ** 2 + (y - attract[1]) ** 2);
    };

    for (const item of items) {
      let found: { pose: Pose; x: number; y: number } | null = null;
      let bestScore = Infinity;
      let firstValid = -1;
      let seen = 0;
      let reach = Infinity; // centre: stop past this distance from the preferred position (cells)
      const span = Math.max(...item.poses.map((p) => Math.max(p.hx1 - p.hx0, p.hy1 - p.hy0))) + 1;
      for (let i = resume.get(item.part.id) ?? 0; i < order.length; i += 2) {
        const x = order[i];
        const y = order[i + 1];
        if (strategy === 'centre' && Math.hypot(x - attract[0], y - attract[1]) > reach) break;
        let any = false;
        for (const pose of item.poses) {
          if (!valid(pose, x, y)) continue;
          any = true;
          const { w, h } = boxWith(pose, x, y);
          const sc = strategy === 'centre' ? centreScore(pose, x, y) : w * h;
          if (sc < bestScore) {
            bestScore = sc;
            found = { pose, x, y };
          }
        }
        if (!any) continue;
        if (firstValid < 0) {
          firstValid = i;
          reach = Math.hypot(x - attract[0], y - attract[1]) + span * 0.6;
        }
        if (strategy !== 'centre' || ++seen >= CENTRE_CANDIDATES) break;
      }
      if (!found) return null;
      // Positions before the first fit failed for every rotation and will keep failing: the grid only fills.
      resume.set(item.part.id, firstValid);
      // Centre mode slides toward the middle of the cluster so far (toward the bed's preferred position would undo
      // the squareness the score chose); the cluster is centred as a whole at the end.
      const target: [number, number] = placed.length ? [Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2)] : attract;
      const p = slide(found, strategy, target, valid);
      dynamic.stamp(p.pose.halo, p.x, p.y);
      placed.push({ item, ...p });
      x0 = Math.min(x0, p.x + p.pose.bx0);
      x1 = Math.max(x1, p.x + p.pose.bx1);
      y0 = Math.min(y0, p.y + p.pose.by0);
      y1 = Math.max(y1, p.y + p.pose.by1);
    }

    // Move the cluster as one onto the preferred position, as far toward it as stays valid.
    const dx = Math.round(attract[0] - (x0 + x1) / 2);
    const dy = Math.round(attract[1] - (y0 + y1) / 2);
    // Each axis on its own: a cluster that already fills the bed's depth can still move across, and the other way.
    const fitsShifted = (sx: number, sy: number) => placed.every((p) => fixed.fits(p.pose.base, p.x + sx, p.y + sy));
    const furthest = (d: number, along: (v: number) => [number, number]) => {
      for (const t of [1, 0.75, 0.5, 0.25]) {
        const v = Math.round(d * t);
        if (fitsShifted(...along(v))) return v;
      }
      return 0;
    };
    const sx = furthest(dx, (v) => [v, 0]);
    const sy = furthest(dy, (v) => [sx, v]);
    const shift: [number, number] = [sx, sy];

    const placements: Placement[] = placed.map((p) => ({
      partId: p.item.part.id,
      kit: p.item.kit,
      angle: p.pose.angle,
      x: this.bed.minX + (p.x + shift[0]) * res,
      y: this.bed.minY + (p.y + shift[1]) * res,
    }));
    const ax = this.bed.minX + attract[0] * res;
    const ay = this.bed.minY + attract[1] * res;
    const meanOffset = placements.reduce((s, p) => s + Math.hypot(p.x - ax, p.y - ay), 0) / placements.length;
    return {
      kits,
      placements,
      strategy,
      spacing,
      meanOffset,
      clusterArea: (x1 - x0 + 1) * (y1 - y0 + 1) * res * res,
    };
  }

  /** The most kits that fit, over every strategy; the layout that holds them, most central on a tie. */
  maxKits(spacing = 1): Layout | null {
    let best: Layout | null = null;
    for (const strategy of STRATEGIES) {
      let lo = 0;
      let hi = this.upperBound(spacing);
      let found: Layout | null = null;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const layout = this.packKits(mid, strategy, spacing);
        if (layout) {
          lo = mid;
          found = layout;
        } else hi = mid - 1;
      }
      if (found && (!best || found.kits > best.kits || (found.kits === best.kits && score(found) < score(best)))) best = found;
    }
    return best;
  }

  /** The kit as a tile: each rotation of a lone part, or one kit as each greedy strategy packs it. */
  private tiles(spacing: number): Tile[] {
    const { res, minX, minY } = this.bed;
    const lists: TileItem[][] = [];
    if (this.parts.length === 1 && this.parts[0].quantity === 1) {
      for (const pose of this.posesOf(this.parts[0], spacing)) lists.push([{ part: this.parts[0], pose, dx: 0, dy: 0 }]);
    } else {
      // One kit packed by each strategy; the grid tries them all and keeps the best block.
      for (const strategy of ['centre', 'rows', 'columns'] as PackStrategy[]) {
        const one = this.packKits(1, strategy, spacing);
        if (!one) continue;
        lists.push(
          one.placements.map((p) => {
            const part = this.parts.find((q) => q.id === p.partId)!;
            const pose = this.posesOf(part, spacing).find((q) => q.angle === p.angle)!;
            return { part, pose, dx: Math.round((p.x - minX) / res), dy: Math.round((p.y - minY) / res) };
          }),
        );
      }
    }
    return lists.map((items) => {
      let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
      let hx0 = Infinity, hx1 = -Infinity, hy0 = Infinity, hy1 = -Infinity;
      for (const { pose, dx, dy } of items) {
        bx0 = Math.min(bx0, dx + pose.bx0);
        bx1 = Math.max(bx1, dx + pose.bx1);
        by0 = Math.min(by0, dy + pose.by0);
        by1 = Math.max(by1, dy + pose.by1);
        hx0 = Math.min(hx0, dx + pose.hx0);
        hx1 = Math.max(hx1, dx + pose.hx1);
        hy0 = Math.min(hy0, dy + pose.hy0);
        hy1 = Math.max(hy1, dy + pose.hy1);
      }
      // Origin at the base box's lower-left corner, so tiles compare alike.
      const shifted = items.map((it) => ({ ...it, dx: it.dx - bx0, dy: it.dy - by0 }));
      return { items: shifted, bx0: 0, bx1: bx1 - bx0, by0: 0, by1: by1 - by0, px: hx1 - hx0 + 1, py: hy1 - hy0 + 1 };
    });
  }

  /** `kits` tiles in the most central, compact block of rows that fits; a short last row is centred. */
  private packGrid(kits: number, spacing: number): Layout | null {
    const { grid: fixed, attract } = this.bed;
    let best: Layout | null = null;
    for (const tile of this.tiles(spacing)) {
      for (let cols = 1; cols <= kits; cols++) {
        const rows = Math.ceil(kits / cols);
        const bw = (cols - 1) * tile.px + tile.bx1 + 1;
        const bh = (rows - 1) * tile.py + tile.by1 + 1;
        if (bw > fixed.w || bh > fixed.h) continue;
        // Tile origins, front row first; the last (short) row is at the back, centred.
        const cells: { x: number; y: number; kit: number }[] = [];
        for (let j = 0; j < rows; j++) {
          const n = j === rows - 1 ? kits - (rows - 1) * cols : cols;
          const off = Math.round(((cols - n) * tile.px) / 2);
          for (let i = 0; i < n; i++) cells.push({ x: off + i * tile.px, y: j * tile.py, kit: j * cols + i });
        }
        const fitsAt = (ox: number, oy: number) =>
          cells.every((c) => tile.items.every((it) => fixed.fits(it.pose.base, ox + c.x + it.dx, oy + c.y + it.dy)));
        // Centred on the preferred position; failing that, the nearest offset that fits, on a 2 mm step.
        const cx = attract[0] - Math.round((bw - 1) / 2);
        const cy = attract[1] - Math.round((bh - 1) / 2);
        let at: [number, number] | null = fitsAt(cx, cy) ? [cx, cy] : null;
        if (!at) {
          const step = Math.max(1, Math.round(2 / this.settings.resolution));
          const offsets: [number, number][] = [];
          for (let x = 0; x + bw <= fixed.w; x += step) for (let y = 0; y + bh <= fixed.h; y += step) offsets.push([x, y]);
          offsets.sort((a, b) => (a[0] - cx) ** 2 + (a[1] - cy) ** 2 - ((b[0] - cx) ** 2 + (b[1] - cy) ** 2));
          at = offsets.find(([x, y]) => fitsAt(x, y)) ?? null;
        }
        if (!at) continue;
        const placed = cells.flatMap((c) => tile.items.map((it) => ({ part: it.part, kit: c.kit, pose: it.pose, x: at![0] + c.x + it.dx, y: at![1] + c.y + it.dy })));
        const layout = this.toLayout(placed, kits, 'grid', spacing, [at[0], at[0] + bw - 1, at[1], at[1] + bh - 1]);
        if (!best || score(layout) < score(best)) best = layout;
      }
    }
    return best;
  }

  private toLayout(
    placed: { part: PackPart; kit: number; pose: Pose; x: number; y: number }[],
    kits: number,
    strategy: PackStrategy,
    spacing: number,
    box: [number, number, number, number],
  ): Layout {
    const { attract, res, minX, minY } = this.bed;
    const placements: Placement[] = placed.map((p) => ({ partId: p.part.id, kit: p.kit, angle: p.pose.angle, x: minX + p.x * res, y: minY + p.y * res }));
    const ax = minX + attract[0] * res;
    const ay = minY + attract[1] * res;
    const meanOffset = placements.reduce((s, p) => s + Math.hypot(p.x - ax, p.y - ay), 0) / placements.length;
    return { kits, placements, strategy, spacing, meanOffset, clusterArea: (box[1] - box[0] + 1) * (box[3] - box[2] + 1) * res * res };
  }

  /** Kits whose halos would cover the free area: no more can ever fit. */
  private upperBound(spacing: number): number {
    const { grid } = this.bed;
    let free = 0;
    for (let y = 0; y < grid.h; y++) for (let x = 0; x < grid.w; x++) if (!grid.get(x, y)) free++;
    let kitCells = 0;
    for (const part of this.parts) {
      const poses = this.posesOf(part, spacing);
      // Halos of neighbours may overlap each other's clearance by half, so count the halo at its inner area.
      const core = poses[0].base.count;
      kitCells += part.quantity * Math.max(1, (core + poses[0].halo.count) / 2);
    }
    return Math.max(1, Math.floor((free * 1.15) / Math.max(1, kitCells)) + 1);
  }

  /** The best layout for exactly `kits`: roomier spacing when it still fits, every strategy, most central. */
  layoutFor(kits: number, spacings = [1.5, 1.25, 1]): Layout | null {
    for (const spacing of spacings) {
      let best: Layout | null = null;
      for (const strategy of STRATEGIES) {
        const layout = this.packKits(kits, strategy, spacing);
        if (layout && (!best || score(layout) < score(best))) best = layout;
      }
      if (best) return best;
    }
    return null;
  }
}

/** Lower is better: central and compact, and a grid when it is nearly as good. */
function score(l: Layout): number {
  return (l.meanOffset + Math.sqrt(l.clusterArea) * 0.25) * (l.strategy === 'grid' ? GRID_BIAS : 1);
}

function slide(
  start: { pose: Pose; x: number; y: number },
  strategy: PackStrategy,
  attract: [number, number],
  valid: (pose: Pose, x: number, y: number) => boolean,
): { pose: Pose; x: number; y: number } {
  let { x, y } = start;
  const { pose } = start;
  const moves: [number, number][] =
    strategy === 'rows'
      ? [[0, -1], [-1, 0]]
      : strategy === 'columns'
        ? [[-1, 0], [0, -1]]
        : [];
  for (let round = 0; round < 64; round++) {
    let moved = false;
    const steps: [number, number][] =
      strategy === 'centre' ? [[Math.sign(attract[0] - x), 0], [0, Math.sign(attract[1] - y)]] : moves;
    for (const [sx, sy] of steps) {
      if (!sx && !sy) continue;
      while (valid(pose, x + sx, y + sy)) {
        if (strategy === 'centre' && ((sx && x === attract[0]) || (sy && y === attract[1]))) break;
        x += sx;
        y += sy;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { pose, x, y };
}
