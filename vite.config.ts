import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// The page must be cross-origin isolated: the slicer engine's host (v0.6.1) tests
// `memory.buffer instanceof SharedArrayBuffer`, and browsers only define SharedArrayBuffer on an isolated page,
// so without these headers the engine throws on load. public/_headers sends the same two in production.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// Static SPA. Output goes to dist/. public/slicer/ (the engine and the profile set, fetched by
// scripts/fetch-engine.mjs) is copied as it is and served next to the page.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(`v${pkg.version}`) },
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1200 },
  worker: { format: 'es' },
  server: { headers: isolation },
  preview: { headers: isolation },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
