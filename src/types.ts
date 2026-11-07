// Domain types. Read this first: it is the spec the rest of the code follows.
//
// Units are millimetres and degrees throughout. Bed coordinates are OrcaSlicer's: origin at the front-left of
// the printable area's bounding box, +X right, +Y back, +Z up.

/** One distinct model the user loaded. Its mesh is normalised: resting on z = 0, its XY bounding-box centre at
 * the origin, so a placement is "rotate about Z, then translate". */
export interface Part {
  id: string;
  name: string;
  /** The file it came from (a 3MF can hold several parts). */
  source: string;
  /** Triangle soup: 9 floats per triangle. */
  positions: Float32Array;
  triangles: number;
  /** Bounding-box size as normalised. */
  size: [number, number, number];
  /** Copies of this part in one kit (one "set" of the job). */
  quantity: number;
}

/** What the geometry says about a part's printability, computed once (src/lib/mesh/analyse.ts). */
export interface PartAnalysis {
  partId: string;
  height: number;
  /** Area touching the bed (downward faces within 0.05 mm of z = 0), mm². */
  contactArea: number;
  /** Area of the footprint (XY projection), mm². */
  footprintArea: number;
  /** Downward faces flatter than the support threshold that are not on the bed, mm². */
  overhangArea: number;
  /** Height over the smallest footprint dimension. */
  slenderness: number;
  /** The rotation (degrees) of the footprint's minimum-area bounding rectangle. */
  minRectAngle: number;
}

/** The printable region and its no-go zones, read from a flattened machine preset (src/lib/bed.ts). */
export interface BedSpec {
  /** Bounding box of the printable area, bed coordinates. */
  min: [number, number];
  max: [number, number];
  /** Polygons a part must lie inside: printable_area and, on multi-nozzle printers, each extruder's area. */
  regions: [number, number][][];
  /** Polygons a part must stay out of: bed_exclude_area, wrapping_exclude_area. */
  exclusions: [number, number][][];
  maxHeight: number;
  /** Where the slicer prefers objects, as a fraction of the printable area (best_object_pos). */
  bestPos: [number, number];
}

export interface LayoutSettings {
  /** Smallest clear gap between two parts' footprints. */
  gap: number;
  /** Smallest clear gap between a part and the edge of the printable area or an exclusion zone. */
  edgeMargin: number;
  /** Extra clearance per mm of part height (each side), so tall parts get more room. */
  heightGapPerMm: number;
  /** Brim width each part is expected to get, by part id: the clearance grows by it. */
  brimByPart: Record<string, number>;
  /** Let the packer turn parts about Z. */
  allowRotation: boolean;
  /** Grid cell size. */
  resolution: number;
}

/** A part copy on the bed: rotate the normalised mesh by `angle` about Z, then move its origin to (x, y). */
export interface Placement {
  partId: string;
  /** Which kit this copy belongs to (0-based). */
  kit: number;
  angle: number;
  x: number;
  y: number;
}

/** 'grid' tiles whole kits at a fixed pitch; the others place parts one at a time (src/lib/layout/pack.ts). */
export type PackStrategy = 'grid' | 'centre' | 'rows' | 'columns';

export interface Layout {
  kits: number;
  placements: Placement[];
  strategy: PackStrategy;
  /** Multiplier the clearances were packed with (1 = the settings; more when the plate has room). */
  spacing: number;
  /** Mean distance of part centres from the preferred position, mm. */
  meanOffset: number;
  /** Area of the bounding box of all footprints, mm². */
  clusterArea: number;
}

/** One sliced plate. */
export interface PlateResult {
  kits: number;
  objects: number;
  layout: Layout;
  ok: boolean;
  /** Seconds, from OrcaSlicer's G-code statistics. */
  printSeconds: number | null;
  filamentG: number | null;
  filamentCost: number | null;
  layers: number | null;
  warnings: { kind: string; message: string; objects?: string[] }[];
  /** OrcaSlicer's refusal, when the slice failed. */
  error?: { code: number; message: string; objects?: string[] };
  /** Wall-clock slice time, ms. */
  sliceMs: number;
}

export interface Advice {
  level: 'error' | 'warning' | 'info';
  partId?: string;
  message: string;
}
