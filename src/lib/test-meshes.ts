// Meshes for tests and for the demo: closed, outward-facing triangle soups, normalised (on z = 0, XY centred).
import { normalise } from './mesh/geometry.ts';

function soup(vertices: [number, number, number][], faces: [number, number, number][]): Float32Array {
  return new Float32Array(faces.flatMap((f) => f.flatMap((i) => vertices[i])));
}

/** An axis-aligned box. */
export function box(sx: number, sy: number, sz: number): Float32Array {
  const v: [number, number, number][] = [
    [0, 0, 0], [sx, 0, 0], [sx, sy, 0], [0, sy, 0],
    [0, 0, sz], [sx, 0, sz], [sx, sy, sz], [0, sy, sz],
  ];
  const f: [number, number, number][] = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  return normalise(soup(v, f));
}

/** An L-shaped prism: legs `a` and `b` long, `t` thick, `h` tall. */
export function lShape(a: number, b: number, h: number, t: number): Float32Array {
  // Outline counter-clockwise, extruded.
  const outline: [number, number][] = [[0, 0], [a, 0], [a, t], [t, t], [t, b], [0, b]];
  return normalise(extrude(outline, h));
}

/** Extrude a simple counter-clockwise polygon (convex or an L/U made of convex fan-safe pieces) by ear clipping. */
export function extrude(outline: [number, number][], h: number): Float32Array {
  const n = outline.length;
  const v: [number, number, number][] = [...outline.map(([x, y]) => [x, y, 0] as [number, number, number]), ...outline.map(([x, y]) => [x, y, h] as [number, number, number])];
  const f: [number, number, number][] = [];
  for (const [a, b, c] of earClip(outline)) {
    f.push([a, c, b]); // bottom faces down
    f.push([a + n, b + n, c + n]);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    f.push([i, j, j + n], [i, j + n, i + n]);
  }
  return soup(v, f);
}

function earClip(poly: [number, number][]): [number, number, number][] {
  const idx = poly.map((_, i) => i);
  const tris: [number, number, number][] = [];
  const cross = (a: number, b: number, c: number) =>
    (poly[b][0] - poly[a][0]) * (poly[c][1] - poly[a][1]) - (poly[b][1] - poly[a][1]) * (poly[c][0] - poly[a][0]);
  const inside = (p: number, a: number, b: number, c: number) => cross(a, b, p) > 0 && cross(b, c, p) > 0 && cross(c, a, p) > 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 1000) {
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      if (cross(a, b, c) <= 0) continue;
      if (idx.some((p) => p !== a && p !== b && p !== c && inside(p, a, b, c))) continue;
      tris.push([a, b, c]);
      idx.splice(i, 1);
      break;
    }
  }
  tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}
