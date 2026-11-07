// A plain 3MF (core spec) of one plate: one object per part, one build item per copy, each item's transform the
// copy's turn about Z and its position on the bed. Bambu Studio and OrcaSlicer open it with the parts where the
// optimiser put them; the printer, process and filament are chosen there.
import { zipSync, strToU8 } from 'fflate';
import type { Layout, Part } from '../../types.ts';

const fmt = (v: number) => {
  const s = v.toFixed(5).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

const escape = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/** Index a soup's vertices (exact duplicates shared), for a much smaller file. */
function indexed(positions: Float32Array): { vertices: Float32Array; triangles: Uint32Array } {
  const map = new Map<string, number>();
  const verts: number[] = [];
  const tris = new Uint32Array(positions.length / 3);
  for (let i = 0; i < positions.length; i += 3) {
    const key = `${positions[i]},${positions[i + 1]},${positions[i + 2]}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = verts.length / 3;
      map.set(key, idx);
      verts.push(positions[i], positions[i + 1], positions[i + 2]);
    }
    tris[i / 3] = idx;
  }
  return { vertices: Float32Array.from(verts), triangles: tris };
}

export function plateTo3mf(layout: Layout, parts: Part[], title: string): Uint8Array {
  const used = new Set(layout.placements.map((p) => p.partId));
  const objects = parts.filter((p) => used.has(p.id));
  const ids = new Map(objects.map((p, i) => [p.id, i + 1]));
  const chunks: string[] = [];
  chunks.push(
    '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-GB" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n',
    `<metadata name="Title">${escape(title)}</metadata>\n<metadata name="Application">Printbed Optimiser</metadata>\n<resources>\n`,
  );
  for (const part of objects) {
    const { vertices, triangles } = indexed(part.positions);
    chunks.push(`<object id="${ids.get(part.id)}" name="${escape(part.name)}" type="model"><mesh><vertices>\n`);
    const vs: string[] = [];
    for (let i = 0; i < vertices.length; i += 3) vs.push(`<vertex x="${fmt(vertices[i])}" y="${fmt(vertices[i + 1])}" z="${fmt(vertices[i + 2])}"/>`);
    chunks.push(vs.join('\n'), '\n</vertices><triangles>\n');
    const ts: string[] = [];
    for (let i = 0; i < triangles.length; i += 3) ts.push(`<triangle v1="${triangles[i]}" v2="${triangles[i + 1]}" v3="${triangles[i + 2]}"/>`);
    chunks.push(ts.join('\n'), '\n</triangles></mesh></object>\n');
  }
  chunks.push('</resources>\n<build>\n');
  for (const p of layout.placements) {
    const r = (p.angle * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    // Row-vector convention: [x y z 1] * M, translation in the last row.
    const m = [c, s, 0, -s, c, 0, 0, 0, 1, p.x, p.y, 0].map(fmt).join(' ');
    chunks.push(`<item objectid="${ids.get(p.partId)}" transform="${m}" printable="1"/>\n`);
  }
  chunks.push('</build>\n</model>\n');

  return zipSync(
    {
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>\n',
      ),
      '_rels/.rels': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n',
      ),
      '3D/3dmodel.model': strToU8(chunks.join('')),
    },
    { level: 6 },
  );
}

export function download(bytes: Uint8Array, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
