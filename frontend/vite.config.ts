import { defineConfig } from 'vitest/config';

// The config runs in Node; the project has no @types/node, so only what is used is declared.
declare const process: { env: Record<string, string | undefined> };

// The FastAPI backend (uvicorn on :8000, see the Makefile) serves /api; in dev and preview
// Vite proxies to it (FORMA_API_URL points at another one, e.g. the e2e backend on its own
// port), in production the backend serves the built files itself.
const api = { '/api': { target: process.env.FORMA_API_URL || 'http://127.0.0.1:8000', changeOrigin: true } };

export default defineConfig({
  server: { port: 5173, strictPort: true, proxy: api },
  preview: { port: 4173, strictPort: true, proxy: api },
  build: {
    target: 'es2022',
    sourcemap: false,
    // three.js is one large module; it is split into its own chunk below.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes('node_modules/three') ? 'three' : undefined),
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
