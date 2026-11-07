// The bed as a bit grid: one bit per `res` mm cell, rows of 32-bit words. Cell (x, y) covers bed
// [minX + x*res, minX + (x+1)*res) by [minY + y*res, ...). Masks are tested and stamped at a cell position: the
// mask's origin cell lands on (cx, cy). Cells outside the grid count as blocked for `fits` and are ignored by
// `stamp` and `touches`.
import type { PackedMask } from './mask.ts';

export class BitGrid {
  readonly words: number;
  readonly bits: Uint32Array;

  constructor(readonly w: number, readonly h: number) {
    this.words = (w + 31) >> 5;
    this.bits = new Uint32Array(this.words * h);
  }

  clone(): BitGrid {
    const g = new BitGrid(this.w, this.h);
    g.bits.set(this.bits);
    return g;
  }

  get(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return true;
    return (this.bits[y * this.words + (x >> 5)] & (1 << (x & 31))) !== 0;
  }

  set(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.bits[y * this.words + (x >> 5)] |= 1 << (x & 31);
  }

  /** Does the mask, placed at (cx, cy), lie inside the grid without touching a set cell? */
  fits(m: PackedMask, cx: number, cy: number): boolean {
    const c0 = cx - m.ox;
    const r0 = cy - m.oy;
    if (c0 < 0 || r0 < 0 || c0 + m.w > this.w || r0 + m.h > this.h) return false;
    for (let i = 0; i < m.probes.length; i += 2) if (this.get(cx + m.probes[i], cy + m.probes[i + 1])) return false;
    return !this.overlaps(m, c0, r0);
  }

  /** Does the mask touch a set cell? Parts of it outside the grid are ignored. */
  touches(m: PackedMask, cx: number, cy: number): boolean {
    for (let i = 0; i < m.probes.length; i += 2) {
      const x = cx + m.probes[i];
      const y = cy + m.probes[i + 1];
      if (x >= 0 && y >= 0 && x < this.w && y < this.h && this.get(x, y)) return true;
    }
    return this.overlaps(m, cx - m.ox, cy - m.oy);
  }

  private overlaps(m: PackedMask, c0: number, r0: number): boolean {
    const w0 = c0 >> 5;
    const s = c0 & 31;
    const { words, bits } = this;
    for (let r = 0; r < m.h; r++) {
      const gy = r0 + r;
      if (gy < 0 || gy >= this.h) continue;
      const base = gy * words;
      const mrow = r * m.words;
      let prev = 0;
      for (let k = 0; k <= m.words; k++) {
        const cur = k < m.words ? m.rows[mrow + k] : 0;
        const v = s === 0 ? cur : ((cur << s) | (prev >>> (32 - s))) >>> 0;
        prev = cur;
        if (v === 0) continue;
        const gx = w0 + k;
        if (gx < 0 || gx >= words) continue;
        if (bits[base + gx] & v) return true;
      }
    }
    return false;
  }

  stamp(m: PackedMask, cx: number, cy: number): void {
    const c0 = cx - m.ox;
    const r0 = cy - m.oy;
    const w0 = c0 >> 5;
    const s = c0 & 31;
    const { words, bits } = this;
    for (let r = 0; r < m.h; r++) {
      const gy = r0 + r;
      if (gy < 0 || gy >= this.h) continue;
      const base = gy * words;
      const mrow = r * m.words;
      let prev = 0;
      for (let k = 0; k <= m.words; k++) {
        const cur = k < m.words ? m.rows[mrow + k] : 0;
        const v = s === 0 ? cur : ((cur << s) | (prev >>> (32 - s))) >>> 0;
        prev = cur;
        const gx = w0 + k;
        if (v === 0 || gx < 0 || gx >= words) continue;
        bits[base + gx] |= v;
      }
    }
    // Bits past the last column of the final word must stay clear, or `fits` near the right edge lies.
    const tail = this.w & 31;
    if (tail) {
      const keep = (1 << tail) - 1;
      for (let y = 0; y < this.h; y++) bits[y * words + words - 1] &= keep;
    }
  }
}
