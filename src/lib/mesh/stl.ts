// STL reader: binary and ASCII, to a triangle soup (9 floats per triangle). Normals in the file are ignored;
// the slicer recomputes them from the winding.

export function parseStl(data: ArrayBuffer | Uint8Array): Float32Array {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (isBinaryStl(bytes)) return parseBinary(bytes);
  return parseAscii(new TextDecoder().decode(bytes));
}

/** A binary STL is exactly 84 + 50 n bytes for its declared n. Some binary files start with "solid", so the size
 * is the test, not the first word. */
function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < 84) return false;
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  if (84 + count * 50 === bytes.length) return true;
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart().toLowerCase();
  return !(head.startsWith('solid') && head.includes('facet'));
}

function parseBinary(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(80, true);
  const count = Math.min(declared, Math.floor((bytes.length - 84) / 50));
  const out = new Float32Array(count * 9);
  for (let i = 0; i < count; i++) {
    const base = 84 + i * 50 + 12; // skip the facet normal
    for (let k = 0; k < 9; k++) out[i * 9 + k] = view.getFloat32(base + k * 4, true);
  }
  return out;
}

function parseAscii(text: string): Float32Array {
  const values: number[] = [];
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) values.push(Number(m[1]), Number(m[2]), Number(m[3]));
  const usable = values.length - (values.length % 9);
  if (usable === 0) throw new Error('No triangles found: this does not look like an STL file.');
  return new Float32Array(values.slice(0, usable));
}

/** A binary STL of a soup, for tests and for handing a part back to the user. */
export function writeBinaryStl(positions: Float32Array, header = 'printbed-optimiser'): Uint8Array {
  const count = positions.length / 9;
  const out = new Uint8Array(84 + count * 50);
  const view = new DataView(out.buffer);
  new TextEncoder().encodeInto(header.slice(0, 80), out);
  view.setUint32(80, count, true);
  for (let i = 0; i < count; i++) {
    const base = 84 + i * 50 + 12;
    for (let k = 0; k < 9; k++) view.setFloat32(base + k * 4, positions[i * 9 + k], true);
  }
  return out;
}
