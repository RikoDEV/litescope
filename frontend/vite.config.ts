import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync, constants as zlib } from 'node:zlib'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Writes a max-level `.gz` next to every compressible hashed asset so nginx's
// `gzip_static` serves it as-is: smaller than nginx's on-the-fly level-6 gzip
// and no compression CPU per request. Only dist/assets/ is precompressed — its
// files are immutable, whereas docker-entrypoint.sh rewrites root files
// (env-config.js, robots.txt, sitemap.xml) at container start, and a stale
// precompressed copy of those would be served instead of the fresh file.
function precompressAssets(): Plugin {
  let outDir = 'dist'
  return {
    name: 'precompress-assets',
    apply: 'build',
    configResolved(c) { outDir = c.build.outDir },
    closeBundle() {
      const dir = join(outDir, 'assets')
      for (const name of readdirSync(dir)) {
        if (!/\.(js|mjs|css|svg|json|wasm)$/.test(name)) continue
        const path = join(dir, name)
        if (statSync(path).size < 1024) continue
        writeFileSync(`${path}.gz`, gzipSync(readFileSync(path), { level: zlib.Z_BEST_COMPRESSION }))
      }
    },
  }
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))
const version = process.env.APP_VERSION || pkg.version

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [
    react(),
    precompressAssets(),
    {
      // Inject the version into index.html's JSON-LD (%APP_VERSION% placeholder).
      name: 'inject-app-version',
      transformIndexHtml: (html) => html.replace(/%APP_VERSION%/g, version),
    },
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  // maplibre-gl loads its parser as a worker via a `new URL(..., import.meta.url)`
  // Worker() call; Vite's dep pre-bundling rewrites that URL and breaks it in dev
  // (worker request 404s, leaving the map showing only its background paint).
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
