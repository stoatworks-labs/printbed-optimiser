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

Live at <https://printbed-optimiser.stoatworks-labs.com>: a static-assets-only Cloudflare Worker
(`wrangler.toml`) serving `dist/`, which applies `public/_headers` (COOP/COEP/CSP).

**A push to `main` deploys it.** `.github/workflows/deploy.yml` runs `npm test`, `npm run build`, the fleet
smoke-check and `wrangler deploy`, then checks that the live `<head>` matches the build. Pushes that change only
Markdown or `docs/` are skipped. It uses the repo secret `CLOUDFLARE_API_TOKEN` and the variable
`CLOUDFLARE_ACCOUNT_ID`. So don't deploy by hand after a push: a hand deploy from an older tree replaces the
workflow's. Only if the workflow is broken, deploy from a checkout of `main`, never a branch:

```
npm run build && cf-run npx --yes wrangler@4.116.0 deploy
```

Check what is live with `cf-run npx wrangler deployments list` and `gh run list --limit 3`.

The hostname is a zone **route**, not a custom domain (the zone is at Cloudflare's 100 custom-domain limit). It
depends on the proxied `AAAA 100::` DNS record `printbed-optimiser` existing; wrangler does not create it.
