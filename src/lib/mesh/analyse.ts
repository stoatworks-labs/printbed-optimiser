// What the geometry alone says about printing a part: how much of it touches the bed, how much hangs over air,
// how tall and thin it is. These feed the advice list; the slicer has the last word on whether it prints.
import type { PartAnalysis } from '../../types.ts';
import { convexHull, footprintPoints, minAreaRectAngle, normalise, rotateNormalDown } from './geometry.ts';
import { maskArea, rasterise } from '../layout/mask.ts';

/** `supportAngle`: OrcaSlicer's support_threshold_angle, degrees from horizontal (0 = its default of 30). */
export function analysePart(partId: string, positions: Float32Array, supportAngle = 30): PartAnalysis {
  const threshold = Math.cos(((supportAngle > 0 ? supportAngle : 30) * Math.PI) / 180);
  let height = 0;
  for (let i = 2; i < positions.length; i += 3) if (positions[i] > height) height = positions[i];
  let contact = 0;
  let overhang = 0;
  for (let t = 0; t < positions.length; t += 9) {
    const ax = positions[t], ay = positions[t + 1], az = positions[t + 2];
    const bx = positions[t + 3], by = positions[t + 4], bz = positions[t + 5];
    const cx = positions[t + 6], cy = positions[t + 7], cz = positions[t + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) continue;
    const area = len / 2;
    const down = -nz / len; // 1 for a face looking straight down
    if (down <= threshold) continue;
    const zmax = Math.max(az, bz, cz);
    if (zmax < 0.05) contact += area;
    else if (Math.min(az, bz, cz) > 0.3) overhang += area;
  }
  const hull = convexHull(footprintPoints(positions));
  const minRect = minAreaRectAngle(hull);
  const mask = rasterise(positions, minRect, 0.5);
  // Smallest footprint dimension: the short side of the minimum-area rectangle.
  const side = Math.min(mask.w - 2 * (mask.w > 6 ? 3 : 0), mask.h - 2 * (mask.h > 6 ? 3 : 0)) * 0.5;
  return {
    partId,
    height,
    contactArea: contact,
    footprintArea: maskArea(rasterise(positions, 0, 0.5), 0.5),
    overhangArea: overhang,
    slenderness: height / Math.max(1, side),
    minRectAngle: minRect,
  };
}

/** The face that gives the most bed contact when laid down: its normal and that contact area. Faces are grouped
 * by normal; a group counts only where it lies on the part's outer surface in its direction (a supporting plane). */
export function bestFlatFace(positions: Float32Array): { normal: [number, number, number]; area: number } | null {
  const groups = new Map<string, { n: [number, number, number]; area: number }>();
  for (let t = 0; t < positions.length; t += 9) {
    const ux = positions[t + 3] - positions[t], uy = positions[t + 4] - positions[t + 1], uz = positions[t + 5] - positions[t + 2];
    const vx = positions[t + 6] - positions[t], vy = positions[t + 7] - positions[t + 1], vz = positions[t + 8] - positions[t + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) continue;
    const n: [number, number, number] = [nx / len, ny / len, nz / len];
    const key = n.map((c) => Math.round(c * 50)).join(',');
    const g = groups.get(key);
    if (g) g.area += len / 2;
    else groups.set(key, { n, area: len / 2 });
  }
  const candidates = [...groups.values()].sort((a, b) => b.area - a.area).slice(0, 24);
  let best: { normal: [number, number, number]; area: number } | null = null;
  for (const { n } of candidates) {
    let dmax = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const d = positions[i] * n[0] + positions[i + 1] * n[1] + positions[i + 2] * n[2];
      if (d > dmax) dmax = d;
    }
    let area = 0;
    for (let t = 0; t < positions.length; t += 9) {
      let onPlane = true;
      for (let k = 0; k < 9 && onPlane; k += 3) {
        const d = positions[t + k] * n[0] + positions[t + k + 1] * n[1] + positions[t + k + 2] * n[2];
        if (dmax - d > 0.05) onPlane = false;
      }
      if (!onPlane) continue;
      const ux = positions[t + 3] - positions[t], uy = positions[t + 4] - positions[t + 1], uz = positions[t + 5] - positions[t + 2];
      const vx = positions[t + 6] - positions[t], vy = positions[t + 7] - positions[t + 1], vz = positions[t + 8] - positions[t + 2];
      area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
    if (!best || area > best.area) best = { normal: n, area };
  }
  return best;
}

/** Turn a part so its best face is on the bed, then normalise it again. */
export function layFlat(positions: Float32Array): Float32Array {
  const face = bestFlatFace(positions);
  if (!face) return positions;
  return normalise(rotateNormalDown(positions, face.normal));
}
