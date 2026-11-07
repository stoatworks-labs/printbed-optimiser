import { defineConfig } from 'vitest/config'

// Tests that drive the real slicer engine (public/slicer/, fetched by scripts/fetch-engine.mjs) in Node worker
// threads: the same host file and protocol a browser uses. Slow, so not part of `npm test`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.engine.ts'],
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
})
