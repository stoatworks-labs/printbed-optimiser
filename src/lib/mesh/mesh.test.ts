import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseStl, writeBinaryStl } from './stl.ts';
import { parse3mf } from './threemf.ts';
import { bounds } from './geometry.ts';
import { analysePart, layFlat } from './analyse.ts';
import { box, lShape } from '../test-meshes.ts';
import { rasterise, maskArea, fillHoles, dilate } from '../layout/mask.ts';
import { plateTo3mf } from '../export/threemf-writer.ts';

describe('STL', () => {
  it('round-trips binary', () => {
    const cube = box(10, 20, 30);
    const back = parseStl(writeBinaryStl(cube));
    expect(back).toEqual(cube);
  });

  it('reads ASCII, including a binary-looking header word', () => {
    const text = `solid test
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 0 1 0
 endloop
endfacet
endsolid test`;
    const tri = parseStl(new TextEncoder().encode(text));
    expect(Array.from(tri)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });
});

describe('3MF', () => {
  const model = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">${body}</model>`;
  const tetra = `<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices>
<triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/></triangles></mesh>`;

  it('applies item transforms and merges items of one object', () => {
    const files = {
      '_rels/.rels': strToU8('<Relationships><Relationship Target="/3D/3dmodel.model" Id="r" Type="x"/></Relationships>'),
      '3D/3dmodel.model': strToU8(
        model(`<resources><object id="1" name="Tetra" type="model">${tetra}</object></resources>
<build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 50 0"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 20 20 0"/></build>`),
      ),
    };
    const meshes = parse3mf(zipSync(files));
    expect(meshes).toHaveLength(1);
    expect(meshes[0].name).toBe('Tetra');
    expect(meshes[0].count).toBe(2);
    const b = bounds(meshes[0].positions);
    expect(b.min).toEqual([100, 50, 0]);
  });

  it('follows components into production-extension model files (Bambu Studio layout)', () => {
    const files = {
      '3D/3dmodel.model': strToU8(
        model(`<resources><object id="2" p:UUID="u" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="2 0 0 0 2 0 0 0 2 0 0 0"/></components></object></resources>
<build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 128 128 0" printable="1"/></build>`),
      ),
      '3D/Objects/object_1.model': strToU8(model(`<resources><object id="1" name="Part A" type="model">${tetra}</object></resources>`)),
    };
    const [mesh] = parse3mf(zipSync(files));
    expect(mesh.name).toBe('Part A');
    const b = bounds(mesh.positions);
    expect(b.min).toEqual([128, 128, 0]);
    expect(b.max).toEqual([148, 148, 20]); // scaled by the component's transform
  });
});

describe('3MF writer', () => {
  it('round-trips a plate through the reader with every copy where it was placed', () => {
    const cube = box(10, 10, 10);
    const part = { id: 'c', name: 'Cube & co', source: 't', positions: cube, triangles: 12, size: [10, 10, 10] as [number, number, number], quantity: 1 };
    const layout = {
      kits: 2,
      placements: [
        { partId: 'c', kit: 0, angle: 0, x: 50, y: 60 },
        { partId: 'c', kit: 1, angle: 90, x: 120, y: 60 },
      ],
      strategy: 'centre' as const,
      spacing: 1,
      meanOffset: 0,
      clusterArea: 0,
    };
    const meshes = parse3mf(plateTo3mf(layout, [part], 'test'));
    // Two build items of one object come back as one mesh with a count of two (the first item's placement).
    expect(meshes).toHaveLength(1);
    expect(meshes[0].count).toBe(2);
    expect(meshes[0].name).toBe('Cube & co');
    const b = bounds(meshes[0].positions);
    expect(b.min[0]).toBeCloseTo(45, 4);
    expect(b.max[1]).toBeCloseTo(65, 4);
  });
});

describe('analysis', () => {
  it('measures contact, footprint and slenderness of a box', () => {
    const a = analysePart('b', box(20, 10, 40));
    expect(a.contactArea).toBeCloseTo(200, 3);
    expect(a.overhangArea).toBe(0);
    expect(a.height).toBe(40);
    expect(a.footprintArea).toBeGreaterThanOrEqual(200);
    expect(a.footprintArea).toBeLessThan(280); // conservative raster: about a cell and a half of growth around
  });

  it('lays a box down on its largest face', () => {
    const flat = layFlat(box(60, 5, 40));
    const b = bounds(flat);
    expect(b.max[2]).toBeCloseTo(5, 3);
  });

  it('finds an L-shape overhang when it is stood up wrongly', () => {
    // Lay the L so one leg hangs: rotate 90 degrees about X by swapping y/z of a flat L.
    const l = lShape(40, 40, 6, 6);
    const stood = new Float32Array(l.length);
    for (let i = 0; i < l.length; i += 3) {
      stood[i] = l[i];
      stood[i + 1] = l[i + 2];
      stood[i + 2] = l[i + 1] + 20;
    }
    let minZ = Infinity;
    for (let i = 2; i < stood.length; i += 3) minZ = Math.min(minZ, stood[i]);
    for (let i = 2; i < stood.length; i += 3) stood[i] -= minZ;
    const a = analysePart('l', stood);
    expect(a.overhangArea).toBeGreaterThan(100);
  });
});

describe('masks', () => {
  it('fills a ring so nothing is nested inside it', () => {
    const ring = { w: 7, h: 7, ox: 0, oy: 0, cells: new Uint8Array(49) };
    for (let i = 0; i < 7; i++) {
      ring.cells[i] = ring.cells[42 + i] = ring.cells[i * 7] = ring.cells[i * 7 + 6] = 1;
    }
    const filled = fillHoles(ring);
    expect(filled.cells.every((c) => c === 1)).toBe(true);
  });

  it('dilates by a disc', () => {
    const dot = { w: 1, h: 1, ox: 0, oy: 0, cells: new Uint8Array([1]) };
    const d = dilate(dot, 3);
    expect(d.w).toBe(7);
    expect(maskArea(d, 1)).toBeGreaterThan(25);
    expect(maskArea(d, 1)).toBeLessThan(49);
  });

  it('rasterises a cube conservatively', () => {
    const m = rasterise(box(10, 10, 10), 0, 0.5);
    expect(maskArea(m, 0.5)).toBeGreaterThanOrEqual(100);
  });
});
