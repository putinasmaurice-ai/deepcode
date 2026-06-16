import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // the React plugin lets vitest transform .tsx renderer components (automatic JSX runtime);
  // it no-ops its dev-only refresh in test mode, so the node-environment logic tests are unaffected.
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    // node is the DEFAULT env (all the pure-logic/main-process suites); a renderer test opts into
    // jsdom per-file with a `// @vitest-environment jsdom` docblock at the top of the file.
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    // patches jsdom-only gaps (e.g. scrollIntoView); a no-op under the node environment.
    setupFiles: ['./test/setup-jsdom.ts']
  }
})
