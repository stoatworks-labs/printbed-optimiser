// Small geometry kit on triangle soups (9 floats per triangle) and 2D point sets.

export type Vec2 = [number, number];

export interface Box3 {
  min: [number, number, number];
  max: [number, number, number];
}

export function bounds(positions: Float32Array): Box3 {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/** Rest on z = 0 with the XY bounding-box centre at the origin. Returns a new array. */
export function normalise(positions: Float32Array): Float32Array {
  const { min, max } = bounds(positions);
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = positions[i] - cx;
    out[i + 1] = positions[i + 1] - cy;
    out[i + 2] = positions[i + 2] - min[2];
  }
  return out;
}

/** Rotate about Z by `angle` degrees, then translate. Writes into `out` (which may be a fresh array). */
export function place(positions: Float32Array, angle: number, x: number, y: number, out = new Float32Array(positions.length)): Float32Array {
  const r = (angle * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  for (let i = 0; i < positions.length; i += 3) {
    const px = positions[i];
    const py = positions[i + 1];
    out[i] = px * c - py * s + x;
    out[i + 1] = px * s + py * c + y;
    out[i + 2] = positions[i + 2];
  }
  return out;
}

/** Rotate a soup so the given unit normal points straight down (lay a face flat on the bed). */
export function rotateNormalDown(positions: Float32Array, n: [number, number, number]): Float32Array {
  // Rotation taking n to (0, 0, -1): axis n x (0,0,-1), angle acos(-nz).
  const [nx, ny, nz] = n;
  let ax = -ny, ay = nx, az = 0; // n x (0,0,-1) = (ny*-1 - nz*0, nz*0 - nx*-1, 0) = (-ny, nx, 0)
  const len = Math.hypot(ax, ay, az);
  const out = new Float32Array(positions.length);
  if (len < 1e-9) {
    if (nz < 0) out.set(positions);
    else for (let i = 0; i < positions.length; i += 3) { out[i] = positions[i]; out[i + 1] = -positions[i + 1]; out[i + 2] = -positions[i + 2]; }
    return out;
  }
  ax /= len; ay /= len; az /= len;
  const angle = Math.acos(Math.max(-1, Math.min(1, -nz)));
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  const m = [
    t * ax * ax + c, t * ax * ay - s * az, t * ax * az + s * ay,
    t * ax * ay + s * az, t * ay * ay + c, t * ay * az - s * ax,
    t * ax * az - s * ay, t * ay * az + s * ax, t * az * az + c,
  ];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    out[i] = m[0] * x + m[1] * y + m[2] * z;
    out[i + 1] = m[3] * x + m[4] * y + m[5] * z;
    out[i + 2] = m[6] * x + m[7] * y + m[8] * z;
  }
  return out;
}

/** Andrew's monotone chain. Points need not be unique. Returns the hull counter-clockwise. */
export function convexHull(points: Vec2[]): Vec2[] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** XY points of a soup, deduplicated on a 0.05 mm grid (enough for hulls, much smaller than the mesh). */
export function footprintPoints(positions: Float32Array): Vec2[] {
  const seen = new Set<string>();
  const out: Vec2[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    const x = Math.round(positions[i] * 20) / 20;
    const y = Math.round(positions[i + 1] * 20) / 20;
    const key = `${x},${y}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push([x, y]);
    }
  }
  return out;
}

/** Angle (degrees, in [0, 90)) that turns the hull's minimum-area bounding rectangle square to the axes. */
export function minAreaRectAngle(hull: Vec2[]): number {
  if (hull.length < 3) return 0;
  let best = Infinity;
  let bestAngle = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const theta = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(-theta), s = Math.sin(-theta);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of hull) {
      const x = p[0] * c - p[1] * s;
      const y = p[0] * s + p[1] * c;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const area = (maxX - minX) * (maxY - minY);
    if (area < best - 1e-6) {
      best = area;
      bestAngle = (-theta * 180) / Math.PI;
    }
  }
  const norm = ((bestAngle % 90) + 90) % 90;
  return norm > 89.9 ? 0 : Math.round(norm * 10) / 10;
}

export function pointInPolygon(x: number, y: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return Math.abs(a) / 2;
}
