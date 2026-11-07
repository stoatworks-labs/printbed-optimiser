// Footprint masks: a part's XY projection on a grid of `res` mm cells, one byte per cell while it is built
// (rasterise, fill holes, dilate), then packed into bit rows for the packer's overlap tests.
//
// Frame: mask cell i spans part-local x in [(i - ox) * res, (i - ox + 1) * res), and likewise j and y. So the part's
// origin sits on the lower-left corner of cell (ox, oy), and placing the mask with that cell on grid cell (cx, cy)
// puts the part's origin at bed x = grid.minX + cx * res.

export interface Mask {
  w: number;
  h: number;
  ox: number;
  oy: number;
  cells: Uint8Array; // row-major, h rows of w
}

export interface PackedMask {
  w: number;
  h: number;
  ox: number;
  oy: number;
  words: number; // 32-bit words per row
  rows: Uint32Array; // h * words, bit (x & 31) of word (x >> 5) is cell x
  /** A few set cells (relative to the origin cell) tested first: most failing positions fail on one of them. */
  probes: Int32Array; // pairs dx, dy
  count: number; // set cells
}

/** Rasterise a soup's projection, turned by `angle` degrees, conservatively (every touched cell is set). */
export function rasterise(positions: Float32Array, angle: number, res: number): Mask {
  const r = (angle * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const n = positions.length / 3;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const x = px * c - py * s;
    const y = px * s + py * c;
    xs[i] = x;
    ys[i] = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const pad = 2;
  const ox = -Math.floor(minX / res) + pad;
  const oy = -Math.floor(minY / res) + pad;
  const w = Math.floor(maxX / res) + ox + 1 + pad;
  const h = Math.floor(maxY / res) + oy + 1 + pad;
  const cells = new Uint8Array(w * h);
  const cellX = (x: number) => Math.floor(x / res) + ox;
  const cellY = (y: number) => Math.floor(y / res) + oy;

  for (let t = 0; t < n; t += 3) {
    const ax = xs[t], ay = ys[t], bx = xs[t + 1], by = ys[t + 1], cx = xs[t + 2], cy = ys[t + 2];
    // Every vertex's cell: covers slivers and triangles smaller than a cell.
    cells[cellY(ay) * w + cellX(ax)] = 1;
    cells[cellY(by) * w + cellX(bx)] = 1;
    cells[cellY(cy) * w + cellX(cx)] = 1;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) continue; // a wall seen edge-on; its neighbours cover it
    const i0 = cellX(Math.min(ax, bx, cx));
    const i1 = cellX(Math.max(ax, bx, cx));
    const j0 = cellY(Math.min(ay, by, cy));
    const j1 = cellY(Math.max(ay, by, cy));
    if (i0 === i1 && j0 === j1) continue;
    const sign = area > 0 ? 1 : -1;
    for (let j = j0; j <= j1; j++) {
      const py = (j - oy + 0.5) * res;
      for (let i = i0; i <= i1; i++) {
        const px = (i - ox + 0.5) * res;
        const e0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * sign;
        const e1 = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) * sign;
        const e2 = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) * sign;
        if (e0 >= 0 && e1 >= 0 && e2 >= 0) cells[j * w + i] = 1;
      }
    }
  }
  // Cell centres can miss thin features between them: one cell of dilation makes the mask conservative.
  return fillHoles(dilate({ w, h, ox, oy, cells }, 1));
}

/** Fill every region the outside cannot reach: a ring's middle counts as taken, so nothing is nested in it. */
export function fillHoles(mask: Mask): Mask {
  const { w, h, cells } = mask;
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!cells[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = outside[i] ? 0 : 1;
  return { ...mask, cells: out };
}

/** Dilate by a disc of `r` cells. The mask grows by r on every side. */
export function dilate(mask: Mask, r: number): Mask {
  if (r <= 0) return mask;
  const { w, h, cells } = mask;
  const W = w + 2 * r;
  const H = h + 2 * r;
  // Row prefix sums of the input, for O(1) "any set cell in [x0, x1]" per row.
  const prefix = new Int32Array(h * (w + 1));
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x < w; x++) {
      sum += cells[y * w + x];
      prefix[y * (w + 1) + x + 1] = sum;
    }
  }
  const half = new Int32Array(2 * r + 1);
  for (let d = -r; d <= r; d++) half[d + r] = Math.floor(Math.sqrt(r * r - d * d));
  const out = new Uint8Array(W * H);
  for (let Y = 0; Y < H; Y++) {
    for (let d = -r; d <= r; d++) {
      const y = Y - r + d; // input row
      if (y < 0 || y >= h) continue;
      const k = half[d + r];
      const row = y * (w + 1);
      for (let X = 0; X < W; X++) {
        if (out[Y * W + X]) continue;
        const x0 = Math.max(0, X - r - k);
        const x1 = Math.min(w - 1, X - r + k);
        if (x0 > x1) continue;
        if (prefix[row + x1 + 1] - prefix[row + x0] > 0) out[Y * W + X] = 1;
      }
    }
  }
  return { w: W, h: H, ox: mask.ox + r, oy: mask.oy + r, cells: out };
}

export function maskArea(mask: Mask, res: number): number {
  let n = 0;
  for (let i = 0; i < mask.cells.length; i++) n += mask.cells[i];
  return n * res * res;
}

export function pack(mask: Mask): PackedMask {
  const { w, h, ox, oy, cells } = mask;
  const words = (w + 31) >> 5;
  const rows = new Uint32Array(h * words);
  let count = 0;
  const set: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (cells[y * w + x]) {
        rows[y * words + (x >> 5)] |= 1 << (x & 31);
        count++;
        set.push(x, y);
      }
    }
  }
  // Probes: the set cells nearest the mask's centre and its four extremes, then an even sample.
  const probes: number[] = [];
  if (count) {
    const pick = (score: (x: number, y: number) => number) => {
      let best = 0, bestScore = Infinity;
      for (let i = 0; i < set.length; i += 2) {
        const sc = score(set[i], set[i + 1]);
        if (sc < bestScore) { bestScore = sc; best = i; }
      }
      probes.push(set[best] - ox, set[best + 1] - oy);
    };
    pick((x, y) => (x - w / 2) ** 2 + (y - h / 2) ** 2);
    pick((x) => x);
    pick((x) => -x);
    pick((_, y) => y);
    pick((_, y) => -y);
    const step = Math.max(2, Math.floor(set.length / 2 / 10)) * 2;
    for (let i = 0; i < set.length; i += step) probes.push(set[i] - ox, set[i + 1] - oy);
  }
  return { w, h, ox, oy, words, rows, probes: Int32Array.from(probes), count };
}

export function sameMask(a: Mask, b: Mask): boolean {
  if (a.w !== b.w || a.h !== b.h || a.ox !== b.ox || a.oy !== b.oy) return false;
  for (let i = 0; i < a.cells.length; i++) if (a.cells[i] !== b.cells[i]) return false;
  return true;
}
