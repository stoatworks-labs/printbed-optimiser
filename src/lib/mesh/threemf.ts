// 3MF reader: the core spec's objects, components and build items, plus the production extension's p:path,
// which Bambu Studio and OrcaSlicer use to keep each object's mesh in its own file under 3D/Objects/.
//
// Each build item becomes one mesh in world coordinates (its components' transforms and the item's transform
// applied). Items that share an object become one part with a quantity. The parser is regex-based on purpose:
// DOMParser is not available in workers and is slow on million-vertex meshes.
import { unzipSync, strFromU8 } from 'fflate';

export interface ThreeMfMesh {
  name: string;
  positions: Float32Array;
  /** How many build items used this object. */
  count: number;
}

type Matrix = number[]; // 12 values, 3MF order: m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32

const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

interface ObjectDef {
  id: string;
  name: string;
  vertices?: Float64Array;
  triangles?: Uint32Array;
  components: { objectId: string; path: string | null; transform: Matrix }[];
}

const attrRe = /([\w:]+)\s*=\s*"([^"]*)"/g;
function attrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  attrRe.lastIndex = 0;
  while ((m = attrRe.exec(text))) out[m[1].replace(/^\w+:(?=path$)/, 'p:')] = m[2];
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** An attribute value as text: XML's five named entities and numeric character references decoded. */
function unescapeXml(v: string): string {
  return v.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

function parseMatrix(text: string | undefined): Matrix {
  if (!text) return IDENTITY;
  const v = text.trim().split(/\s+/).map(Number);
  return v.length === 12 && v.every(Number.isFinite) ? v : IDENTITY;
}

/** a then b (row vectors): p * a * b. */
function compose(a: Matrix, b: Matrix): Matrix {
  const r: Matrix = new Array(12).fill(0);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      let s = row === 3 ? b[9 + col] : 0;
      for (let k = 0; k < 3; k++) s += a[row * 3 + k] * b[k * 3 + col];
      r[row * 3 + col] = s;
    }
  }
  return r;
}

function parseModel(text: string): Map<string, ObjectDef> {
  const objects = new Map<string, ObjectDef>();
  const objectRe = /<(?:\w+:)?object\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?object>/g;
  let m: RegExpExecArray | null;
  while ((m = objectRe.exec(text))) {
    const a = attrs(m[1]);
    const body = m[2];
    const def: ObjectDef = { id: a.id, name: unescapeXml(a.name ?? ''), components: [] };
    if (/<(?:\w+:)?mesh\b/.test(body)) {
      const vs: number[] = [];
      const vRe = /<(?:\w+:)?vertex\b([^>]*?)\/?>/g;
      let v: RegExpExecArray | null;
      while ((v = vRe.exec(body))) {
        const va = attrs(v[1]);
        vs.push(Number(va.x), Number(va.y), Number(va.z));
      }
      const ts: number[] = [];
      const tRe = /<(?:\w+:)?triangle\b([^>]*?)\/?>/g;
      let t: RegExpExecArray | null;
      while ((t = tRe.exec(body))) {
        const ta = attrs(t[1]);
        ts.push(Number(ta.v1), Number(ta.v2), Number(ta.v3));
      }
      def.vertices = Float64Array.from(vs);
      def.triangles = Uint32Array.from(ts);
    }
    const cRe = /<(?:\w+:)?component\b([^>]*?)\/?>/g;
    let c: RegExpExecArray | null;
    while ((c = cRe.exec(body))) {
      const ca = attrs(c[1]);
      def.components.push({ objectId: ca.objectid, path: ca['p:path'] ?? null, transform: parseMatrix(ca.transform) });
    }
    objects.set(def.id, def);
  }
  return objects;
}

function normalisePath(p: string): string {
  return p.replace(/^\/+/, '');
}

export function parse3mf(data: ArrayBuffer | Uint8Array): ThreeMfMesh[] {
  const files = unzipSync(data instanceof Uint8Array ? data : new Uint8Array(data));
  const lower = new Map(Object.keys(files).map((k) => [k.toLowerCase(), k]));
  const read = (p: string): string | null => {
    const key = lower.get(normalisePath(p).toLowerCase());
    return key ? strFromU8(files[key]) : null;
  };

  let rootPath = '3D/3dmodel.model';
  const rels = read('_rels/.rels');
  if (rels) {
    const target = /Target\s*=\s*"([^"]+\.model)"/i.exec(rels);
    if (target) rootPath = normalisePath(target[1]);
  }
  const rootText = read(rootPath);
  if (!rootText) throw new Error('No 3D model in this 3MF file.');

  const models = new Map<string, Map<string, ObjectDef>>();
  const modelAt = (p: string | null): Map<string, ObjectDef> => {
    const key = p ? normalisePath(p) : rootPath;
    let m = models.get(key);
    if (!m) {
      const text = read(key);
      if (!text) throw new Error(`The 3MF names a model file it does not contain: ${key}`);
      m = parseModel(text);
      models.set(key, m);
    }
    return m;
  };
  modelAt(null);

  // Flatten an object (with its components) into world-space triangles.
  const emit = (path: string | null, objectId: string, transform: Matrix, out: number[], depth: number): void => {
    if (depth > 16) throw new Error('3MF components nest too deeply.');
    const def = modelAt(path).get(objectId);
    if (!def) throw new Error(`The 3MF references a missing object ${objectId}.`);
    if (def.vertices && def.triangles) {
      const v = def.vertices;
      const t = def.triangles;
      const m = transform;
      for (let i = 0; i < t.length; i++) {
        const j = t[i] * 3;
        const x = v[j], y = v[j + 1], z = v[j + 2];
        out.push(
          x * m[0] + y * m[3] + z * m[6] + m[9],
          x * m[1] + y * m[4] + z * m[7] + m[10],
          x * m[2] + y * m[5] + z * m[8] + m[11],
        );
      }
    }
    for (const c of def.components) emit(c.path ?? path, c.objectId, compose(c.transform, transform), out, depth + 1);
  };

  const nameOf = (path: string | null, id: string): string => {
    const def = modelAt(path).get(id);
    if (def?.name) return def.name;
    for (const c of def?.components ?? []) {
      const n = modelAt(c.path ?? path).get(c.objectId)?.name;
      if (n) return n;
    }
    return '';
  };

  const itemRe = /<(?:\w+:)?item\b([^>]*?)\/?>/g;
  const build = /<(?:\w+:)?build\b[^>]*>([\s\S]*?)<\/(?:\w+:)?build>/.exec(rootText)?.[1] ?? '';
  const byObject = new Map<string, ThreeMfMesh>();
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = itemRe.exec(build))) {
    const a = attrs(m[1]);
    const path = a['p:path'] ?? null;
    const key = `${path ?? ''}#${a.objectid}`;
    const existing = byObject.get(key);
    if (existing) {
      existing.count++;
      continue;
    }
    const out: number[] = [];
    emit(path, a.objectid, parseMatrix(a.transform), out, 0);
    if (out.length === 0) continue;
    n++;
    byObject.set(key, { name: nameOf(path, a.objectid) || `Object ${n}`, positions: Float32Array.from(out), count: 1 });
  }
  if (byObject.size === 0) throw new Error('This 3MF file has no printable objects on its build plate.');
  return [...byObject.values()];
}
