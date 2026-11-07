# Printbed Optimiser

> **AI-assisted project.** This codebase was created with [Claude](https://claude.com/claude-code)
> (Anthropic), directed and reviewed by a human author. Tested in Chrome against OrcaSlicer's
> Bambu Lab X1 Carbon and H2D presets; no plate from it has been printed yet.

Drop STL or 3MF models, pick a printer, process and filament, and the page works out how many to print at once.
OrcaSlicer's own engine, compiled to WebAssembly, runs in the browser tab. It slices the plate at every count
from one kit up to a full bed, and the page recommends the count with the shortest print time per piece. It
prefers plates the slicer passes without a warning, and fewer parts per plate when that costs little time.

**Nothing leaves your device.** There is no server and no account. The page, the slicer and the printer profiles
are static files, and your models are read in the tab and never uploaded.

## What it does

1. **Reads the models.** STL (binary or ASCII) and 3MF, including Bambu Studio and OrcaSlicer project files
   (components, build transforms, several copies of an object). Each part is set down on the bed. A kit can hold
   several parts and several copies of each.
2. **Checks the geometry.** It flags a part taller than the printer, one that barely touches the bed, and one
   that is tall and thin without a brim. It also flags overhangs with supports off, and a better face to lay the
   part on ("Lay flat" turns it).
3. **Slices each part alone.** This proves the part prints, and measures the brim OrcaSlicer's auto brim gives
   it, so the layout leaves room for it.
4. **Packs the fullest plate.** A raster packer works on a 0.5 mm grid with conservative footprints. It respects
   the printable area, the printer's no-go zones (`bed_exclude_area` and `wrapping_exclude_area`), and on
   multi-nozzle printers like the H2D, where every nozzle reaches. It keeps a gap between parts that grows with
   the part's height. Identical kits go on a regular grid when that fits nearly as well. Otherwise the densest
   of three greedy strategies wins, centred on the printer's preferred spot. If OrcaSlicer refuses the plate
   (an object off the plate, or paths crossing), the margin or gap widens and it packs again.
5. **Slices every count.** It slices each count from 1 to 12, then about 14 more up to the fullest plate. Several
   slicer instances run at once (up to three, sized to the device's cores and memory).
6. **Recommends.** The answer is the fewest kits per plate within a tolerance of the fastest time per piece,
   counting the time you set between plates. Plates with slicer warnings are left out when clean ones exist, and
   you can cap plate length. "Make a number" splits an order across plates for the shortest total, and any plate
   size it uses is sliced too.
7. **Exports.** A 3MF of the plate opens in Bambu Studio or OrcaSlicer with every part where the optimiser put
   it. You can also download that plate's G-code from the same engine.

Every time shown comes from a slice. The layout rules only decide where the parts go.

## Limits

- Print times are OrcaSlicer's estimates. The time between plates (clearing, cooling, starting the next) is
  yours to set.
- One filament per plate. Multi-colour and per-object settings are not modelled.
- A plate is limited to about 4 million triangles, which is what a browser tab's slicer heap holds. Counts past
  that are not sliced, and the page says so.
- The 3MF carries geometry and positions only. Pick the printer and presets again in your slicer.
- Only OrcaSlicer's engine for now. The engine is reached through a message protocol, so another slicer
  compiled the same way could be added.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests
npm run test:engine  # end to end against the real engine (slow)
npm run build      # dist/: static files, ready to host
```

`npm install` fetches nothing large. The first `dev`, `build` or `test:engine` downloads the pinned engine
release and its profile set (about 40 MB of downloads, checked against SHA-256 hashes, cached in `.cache/`) and
unpacks the 13 MB the page serves into `public/slicer/`.

### Hosting

`dist/` is plain static files. The host **must** send these two headers, because the page has to be
cross-origin isolated (the engine needs `SharedArrayBuffer`):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`public/_headers` sets them, with a strict CSP, for Cloudflare and Netlify-style hosts. `npm run dev` and
`npm run preview` set them too. Without them the page says the slicer cannot start.

## Licences

The app is MIT (see [LICENSE](LICENSE)).

The slicer is the [Muon3D Slicer Engine](https://github.com/Muon-3D/muon3d-slicer-engine), which is OrcaSlicer's
libslic3r compiled to WebAssembly and licensed **AGPL-3.0-only**. It is served next to the page as its own files
(`slicer/engine/<version>/`), unmodified and with its LICENSE, NOTICE and source pointer. The app starts it by
URL as a Web Worker and talks to it only through its message protocol. The client package
`@muon3d/slicer-engine-protocol` is Apache-2.0. The page footer links the exact engine source it runs. The
build fails if any engine code is found in the app's own bundle (`scripts/check-bundle.mjs`).

The printer, process and filament presets come from OrcaSlicer's profile set (AGPL-3.0), shipped with the
engine release.
