// End to end against the real engine: Bambu Lab presets from the profile set, the host in worker threads,
// the packer in this thread. Run with `npm run test:engine`.
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { nodeWorkerTransport } from '@muon3d/slicer-engine-protocol';
import { ProfileLibrary } from '../profiles/profiles.ts';
import { EnginePool } from '../engine/pool.ts';
import { LocalLayoutService } from '../layout/service.ts';
import { bedFromMachine } from '../bed.ts';
import { optimise } from './optimise.ts';
import { recommend, planQuantity, formatDuration } from './sweep.ts';
import { analysePart } from '../mesh/analyse.ts';
import { box, lShape } from '../test-meshes.ts';
import { choosePlate, printerPlates } from '../profiles/plates.ts';
import type { Part } from '../../types.ts';

const base = pathToFileURL(path.resolve('public/slicer') + path.sep);
const fetcher = async (url: URL) => new Uint8Array(await fs.readFile(url));
const log = (s: string) => process.stderr.write(s + '\n');

async function setup(vendor: string, printer: string) {
  const lib = await ProfileLibrary.open(base, fetcher);
  const choices = await lib.choicesFor(vendor, printer);
  const process_ = await lib.flatten('process', vendor, choices.defaultProcess!);
  const filament = await lib.flatten('filament', vendor, choices.defaultFilament!);
  const engineBase = new URL(lib.info.engine.base, base);
  const pool = new EnginePool(() => {
    const worker = new Worker(new URL(lib.info.engine.host, engineBase));
    // @types/node's overloaded `off` does not fit the protocol's endpoint type; the runtime shape does.
    const endpoint = worker as unknown as Parameters<typeof nodeWorkerTransport>[0];
    return { transport: nodeWorkerTransport(endpoint), terminate: () => void worker.terminate() };
  }, 3);
  const hello = await pool.start();
  return { lib, choices, process: process_, filament, pool, hello };
}

function makePart(id: string, name: string, positions: Float32Array, quantity = 1): Part {
  let h = 0;
  for (let i = 2; i < positions.length; i += 3) h = Math.max(h, positions[i]);
  return { id, name, source: 'test', positions, triangles: positions.length / 9, size: [0, 0, h], quantity };
}

const pools: EnginePool[] = [];
afterAll(() => pools.forEach((p) => p.close()));

describe('optimise against OrcaSlicer', () => {
  it('sweeps 20 mm cubes on an X1 Carbon', async () => {
    const s = await setup('BBL', 'Bambu Lab X1 Carbon 0.4 nozzle');
    pools.push(s.pool);
    log(`engine ${s.hello.engine.version}, OrcaSlicer ${s.hello.engine.orca.version}; ${s.choices.defaultProcess} / ${s.choices.defaultFilament}`);
    const cube = makePart('cube', 'Cube', box(20, 20, 20));
    const a = analysePart(cube.id, cube.positions);
    const t0 = performance.now();
    const result = await optimise(
      {
        parts: [cube],
        heights: { cube: a.height },
        minRectAngles: { cube: a.minRectAngle },
        bed: bedFromMachine(s.choices.machine),
        configs: { machine: s.choices.machine, process: s.process, filaments: [s.filament] },
        settings: { gap: 6, edgeMargin: 5, heightGapPerMm: 0.05, allowRotation: true, resolution: 0.5 },
      },
      s.pool,
      new LocalLayoutService(),
    );
    log(`optimised in ${((performance.now() - t0) / 1000).toFixed(1)} s; notes: ${result.notes.join(' | ') || 'none'}; brim ${result.probes[0].brim} mm`);
    for (const p of result.plates) {
      log(`  ${String(p.kits).padStart(3)}  ${p.ok ? formatDuration(p.printSeconds).padStart(9) : 'FAILED'.padStart(9)}  ${p.ok ? formatDuration(p.printSeconds! / p.kits) + ' each' : p.error?.message}  ${p.warnings.map((w) => w.kind).join(',')}  [${p.layout.strategy} x${p.layout.spacing}] ${Math.round(p.sliceMs)} ms`);
    }
    expect(result.probes[0].ok).toBe(true);
    expect(result.fullest!.kits).toBeGreaterThanOrEqual(36);
    const ok = result.plates.filter((p) => p.ok);
    expect(ok.length).toBe(result.plates.length);
    const per = (k: number) => ok.find((p) => p.kits === k)!.printSeconds! / k;
    expect(per(4)).toBeLessThan(per(1));
    const rec = recommend(result.plates, { overheadSeconds: 300, tolerance: 0.05 });
    log(`recommend: ${rec.reason}`);
    expect(rec.recommended).not.toBeNull();
    const plan = planQuantity(result.plates, 100, { overheadSeconds: 300 })!;
    log(`100 cubes: ${plan.plates.map((p) => p.kits).join(' + ')} in ${formatDuration(plan.totalSeconds)}`);
    expect(plan.plates.reduce((s, p) => s + p.kits, 0)).toBe(100);
  });

  it('slices ABS-GF only once the job names a plate it supports', async () => {
    const s = await setup('BBL', 'Bambu Lab X1 Carbon 0.4 nozzle');
    pools.push(s.pool);
    const name = s.choices.filaments.find((f) => f.startsWith('Bambu ABS-GF'))!;
    const filament = await s.lib.flatten('filament', 'BBL', name);
    const cube = () => box(20, 20, 20).map((v, i) => (i % 3 === 2 ? v : v + 118)); // centre of the 256 mm bed
    const job = (process: typeof s.process) => ({ configs: { machine: s.choices.machine, process, filaments: [filament] }, objects: [{ name: 'Cube', positions: cube() }] });
    // No curr_bed_type: OrcaSlicer slices on a Smooth Cool Plate, which ABS-GF does not support.
    const bare = await s.pool.slice(job(s.process));
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.message).toMatch(/does not support filament/);
    const plate = choosePlate('Cool Plate', printerPlates(s.choices.machine, 'BBL'), filament);
    log(`${name}: Cool Plate -> ${plate.value}`);
    expect(plate).toEqual({ value: 'Textured PEI Plate', replaced: 'Cool Plate', unsupported: false });
    const fixed = await s.pool.slice({ ...job({ ...s.process, curr_bed_type: plate.value }), keepGcode: true });
    expect(fixed.ok).toBe(true);
  });

  it('keeps a kit of mixed parts inside both nozzles\' reach on an H2D', async () => {
    const s = await setup('BBL', 'Bambu Lab H2D 0.4 nozzle');
    pools.push(s.pool);
    const parts = [makePart('bar', 'Bar', box(60, 12, 8)), makePart('ell', 'Bracket', lShape(35, 35, 10, 6), 2)];
    const bed = bedFromMachine(s.choices.machine);
    log(`H2D usable regions: ${bed.regions.map((r) => r.map((p) => p.join('x')).join(',')).join(' | ')}; best ${bed.bestPos}`);
    const result = await optimise(
      {
        parts,
        heights: { bar: 8, ell: 10 },
        minRectAngles: { bar: 0, ell: 0 },
        bed,
        configs: { machine: s.choices.machine, process: s.process, filaments: [s.filament] },
        settings: { gap: 6, edgeMargin: 5, heightGapPerMm: 0.05, allowRotation: true, resolution: 0.5 },
      },
      s.pool,
      new LocalLayoutService(),
    );
    log(`H2D: fullest ${result.fullest?.kits} kits; ${result.plates.filter((p) => p.ok).length}/${result.plates.length} sliced; notes ${result.notes.join(' | ') || 'none'}`);
    for (const p of result.plates.filter((q) => !q.ok)) log(`  ${p.kits} failed: ${p.error?.code} ${p.error?.message}`);
    expect(result.fullest!.kits).toBeGreaterThanOrEqual(6);
    for (const pl of result.fullest!.placements) {
      expect(pl.x).toBeGreaterThan(25);
      expect(pl.x).toBeLessThan(325);
    }
    expect(result.plates.every((p) => p.ok)).toBe(true);
  });
});
