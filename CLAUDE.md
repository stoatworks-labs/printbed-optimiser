# CLAUDE.md — Printbed Optimiser

Command reference. For the model, the invariants and the traps, read [AGENTS.md](AGENTS.md) first.

## Commands

```bash
npm install
npm run dev            # vite dev server, cross-origin isolated (fetches the engine first)
npm test               # vitest: unit tests (30)
npm run test:engine    # vitest against the real engine in Node workers (2 tests, ~1 min)
npm run build          # tsc -b && vite build && check-bundle -> dist/
npm run preview        # serve dist/ with the isolation headers
npx tsc -b             # typecheck only
npm run fetch-engine   # re-fetch public/slicer/ (idempotent; pinned + hash-checked)
```

## Upgrading the engine

Change the version, URLs and SHA-256 values at the top of `scripts/fetch-engine.mjs`, and the protocol tarball
URL in `package.json`, then `npm install`, `npm run fetch-engine`, `npm run test:engine` and a browser run. If
the new host guards its `SharedArrayBuffer` check, the isolation headers can be relaxed (AGENTS.md §4).

## Deploy

Not hosted yet. `dist/` is static. The host must send COOP/COEP (see `public/_headers`). Check the repo's
visibility before adding any GitHub workflow: private repos get none.
