// From dropped files to the parts the optimiser works on, each with what its geometry says about printing it.
import type { Part, PartAnalysis } from '../../types.ts';
import { parseStl } from '../mesh/stl.ts';
import { parse3mf } from '../mesh/threemf.ts';
import { bounds, normalise } from '../mesh/geometry.ts';
import { analysePart, bestFlatFace, layFlat } from '../mesh/analyse.ts';

export interface Model {
  part: Part;
  /** The mesh as loaded (normalised), so "Lay flat" can be undone. */
  original: Float32Array;
  flat: boolean;
  analysis: PartAnalysis;
  /** Area of the largest face it could lie on, mm². */
  bestFace: number | null;
}

let next = 0;
const newId = () => `p${++next}`;

function build(id: string, name: string, source: string, original: Float32Array, quantity: number, flat: boolean): Model {
  const positions = flat ? normalise(layFlat(original)) : original;
  const b = bounds(positions);
  const part: Part = {
    id,
    name,
    source,
    positions,
    triangles: positions.length / 9,
    size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]],
    quantity,
  };
  return { part, original, flat, analysis: analysePart(id, positions), bestFace: bestFlatFace(positions)?.area ?? null };
}

export function setFlat(model: Model, flat: boolean): Model {
  return build(model.part.id, model.part.name, model.part.source, model.original, model.part.quantity, flat);
}

export function setQuantity(model: Model, quantity: number): Model {
  return { ...model, part: { ...model.part, quantity } };
}

const stem = (filename: string) => filename.replace(/\.(stl|3mf)$/i, '');

export async function loadFiles(files: File[]): Promise<{ models: Model[]; errors: string[] }> {
  const models: Model[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (/\.stl$/i.test(file.name)) {
        const positions = parseStl(bytes);
        if (!positions.length) throw new Error('no triangles in it');
        models.push(build(newId(), stem(file.name), file.name, normalise(positions), 1, false));
      } else if (/\.3mf$/i.test(file.name)) {
        const meshes = parse3mf(bytes);
        if (!meshes.length) throw new Error('no printable objects in it');
        meshes.forEach((m, i) => {
          const name = m.name || (meshes.length > 1 ? `${stem(file.name)} ${i + 1}` : stem(file.name));
          models.push(build(newId(), name, file.name, normalise(m.positions), Math.max(1, m.count), false));
        });
      } else {
        throw new Error('not an STL or 3MF file');
      }
    } catch (err) {
      errors.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { models, errors };
}
