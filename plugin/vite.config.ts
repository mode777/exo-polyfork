import { defineConfig } from 'vitest/config'

// GitHub Pages serves a project site from a child path. Development keeps the
// root base so the localhost entry is simple.
export default defineConfig(({ command }) => ({
  base:
    process.env.EXO_PLUGIN_BASE_PATH ??
    (command === 'build' ? '/exo-polyfork/' : '/'),
  server: {
    port: 5176,
    strictPort: true,
    cors: true,
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: ['plugin.html', 'panel.html', 'preview.html'],
      // Resolved by the import map in panel.html and preview.html at runtime,
      // so both pages and the Polyfork asset modules share exactly one three.js
      // instance.
      external: ['three', /^three\/addons\//],
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}))
