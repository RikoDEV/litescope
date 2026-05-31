import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react:   ['react', 'react-dom', 'react-router-dom'],
          mui:     ['@mui/material', '@mui/icons-material', '@emotion/react', '@emotion/styled'],
          charts:  ['recharts'],
          leaflet: ['leaflet'],
        },
      },
    },
  },
})
