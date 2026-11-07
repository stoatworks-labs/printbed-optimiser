# AGENTS.md — bringing an LLM up to speed on Printbed Optimiser

Orientation for an AI assistant (or a new human) picking this project up cold. `CLAUDE.md` holds the short
command reference; this file explains the model, the invariants and the traps.

## 1. What this is

A browser-only tool that lays out multi-object 3D prints and finds how many to print per plate for the shortest
time per piece. OrcaSlicer's libslic3r runs in the tab as WebAssembly (the Muon3D Slicer Engine, AGPL-3.0), in
Web Workers started by URL. React 19 + TypeScript + Vite, static `dist/`. **No backend, no cloud, nothing
uploaded.** That is a hard requirement from the owner, not a default: do not add a server, an API call or a
hosted service.

## 2. Layout

```
src/
  types.ts                  domain types and units. Read this first: it is the spec.
  lib/mesh/                 stl.ts, threemf.ts (reader), geometry.ts, analyse.ts (contact, overhang, lay flat)
  lib/layout/mask.ts        footprint rasterising (conservative, holes filled), dilation, bit-packing
  lib/layout/grid.ts        BitGrid: fits / touches / stamp
  lib/layout/pack.ts        THE PACKER: grid, centre, rows, columns; maxKits, layoutFor
  lib/layout/service.ts     layout requests in this thread or a worker (workers/layout.worker.ts)
  lib/bed.ts                BedSpec from a flattened machine preset; the static grid
  lib/profiles/             OrcaSlicer presets: library, compatibility conditions; plates.ts (build plate types)
  lib/engine/pool.ts        EnginePool: N single-threaded engine hosts, protocol v2 only
  lib/plan/optimise.ts      probe -> fullest plate -> sweep, all sliced
  lib/plan/sweep.ts         sampleCounts, recommend, timeline, planQuantity (pure, tested)
  lib/plan/advice.ts        geometry advice that needs no slice
  lib/export/threemf-writer.ts  plate -> core-spec 3MF
  lib/app/                  models.ts (files -> parts), useProfiles.ts (preset pickers)
  components/               BedView (three.js), SweepChart (SVG), PlateTable, panels
  App.tsx                   state, run/cancel, exports, the engine notice
scripts/fetch-engine.mjs    downloads + verifies the pinned engine and profile set into public/slicer/
scripts/check-bundle.mjs    fails the build if engine code is in dist/assets (the engine's canary)
```

## 3. Invariants

- **The engine is never imported.** It is served from `public/slicer/engine/<version>/` and started with
  `new Worker(url)`; the app sends it protocol messages only. That keeps the AGPL engine a separate program from
  the MIT app. `scripts/check-bundle.mjs` greps the bundle for the engine's canary on every build. Do not
  `import` anything from `public/slicer/`, and do not copy engine code into `src/`.
- **Every number shown comes from a slice.** The packer decides where parts go; times, filament, warnings and
  refusals are OrcaSlicer's. A quantity plan that needs a count the sweep skipped gets that count sliced
  (`slicePlate` in App.tsx) rather than interpolated for display.
- **Units:** millimetres, degrees, seconds. Bed coordinates are OrcaSlicer's: origin front-left of the printable
  area's bounding box, +Y away from you. A `Placement` is "rotate the normalised mesh about Z by `angle`, then
  move its origin to (x, y)". `place()` in geometry.ts, the 3D view's instance matrices and the 3MF writer's
  build transforms must all agree. The 3MF round-trip test pins that.
- **Two masks per part pose.** The *base* (footprint + brim) must lie in free cells of the static grid (bed,
  edge margin, exclusions). The *halo* (footprint + brim + spacing x (gap/2 + height x heightGapPerMm)) must not
  touch another part's halo. A grid tile's pitch is its halo's *set-cell* extent, not the mask's padded size.
- **Mesh buffers are transferred to the engine.** `pool.slice` moves `positions` buffers, so every job gets fresh
  arrays (`place()` makes them). Read a mesh's bounds before slicing it, never after.
- **The pool retires a host** on engine codes 1/2 (dead engine) or when its heap passes half its limit (wasm
  memory only grows). Negative codes are OrcaSlicer refusing the job, and the host stays.
- **Profiles match the engine.** `fetch-engine.mjs` refuses a profile set built from a different OrcaSlicer commit
  than the engine.

## 4. Traps

- **The page must be cross-origin isolated** (COOP `same-origin` + COEP `require-corp`). Engine 0.6.1's host
  runs `memory.buffer instanceof SharedArrayBuffer` unguarded. Browsers define `SharedArrayBuffer` only on an
  isolated page, so without the headers the engine dies at load with "SharedArrayBuffer is not defined". Node
  always has it, so `test:engine` never sees this. Headers live in `vite.config.ts` (dev and preview) and
  `public/_headers` (production). Remove the requirement only once the engine guards the check upstream.
- **The Claude desktop app's built-in browser pane ignores COOP/COEP** (it is an embedded webview and
  `crossOriginIsolated` stays false). Verify in real Chrome, Firefox or Safari.
- A running slice cannot be stopped. Stop clears the queue, and the UI says "Stopping when the slices running now
  finish…".
- **Every job names a build plate** (`curr_bed_type`, put in the process config). Without it OrcaSlicer slices on a
  Smooth Cool Plate, and ABS, ASA, PA, PC and most filled filaments refuse that plate (code -61, "Plate 1: Cool Plate
  does not support filament 1"). A filament supports a plate when both its bed temperatures for it are above 0.
  OrcaSlicer offers the choice only on Bambu Lab printers and those with `support_multi_bed_types`; every other
  printer is fixed to the Smooth High Temp Plate (`src/lib/profiles/plates.ts`).
- Vitest 5 hides `console.log` from passing tests. Use `process.stderr.write` in a debug test.
- Never run `vitest --root /` (it scans the disk). Run it from the repo.
- The engine tests (`npm run test:engine`) take about a minute and need `public/slicer/` (the pretest hook
  fetches it).
- `three` is in the main chunk (about 890 kB minified). Code-split BedView if load time starts to matter.
- Timings vary a lot with machine load: the same 27-plate sweep has taken 20 s and 90 s in one session.
- Cloudflare injects an inline bot-detection script into the live page. The CSP (`script-src 'self'`) blocks it,
  so DevTools shows one CSP violation on load. That is expected: the script is Cloudflare's, not ours, and the
  page needs nothing from it. Do not loosen the CSP to silence it.

## 5. Status

MVP. Verified end to end in Chrome on 2026-11-07: X1 Carbon cubes (64 per plate full, 28 recommended), a mixed
kit, quantity mode (100 → 50 + 50), and the 3MF and G-code exports. The H2D two-nozzle bed is covered by an
engine test. Hosted at <https://printbed-optimiser.stoatworks-labs.com> since 2026-11-07, where a cube sweep
ran in Chrome with the page cross-origin isolated. Every push to `main` deploys it (`deploy.yml`, see
CLAUDE.md). Not yet done: opening the
exported 3MF in Bambu Studio, a real print, and other vendors' printers beyond the profile pickers loading.
