import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import million from 'million/compiler'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))
const version = process.env.APP_VERSION || pkg.version

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [
    million.vite({ auto: true, telemetry: false }),
    react(),
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
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
