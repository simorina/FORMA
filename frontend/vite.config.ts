import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// The config runs in Node; the project has no @types/node, so only what is used is declared.
declare const process: { env: Record<string, string | undefined> };

// The FastAPI backend (uvicorn on :8000, see the Makefile) serves /api; in dev and preview
// Vite proxies to it (FORMA_API_URL points at another one, e.g. the e2e backend on its own
// port), in production the backend serves the built files itself.
const api = { '/api': { target: process.env.FORMA_API_URL || 'http://127.0.0.1:8000', changeOrigin: true } };

/**
 * Preload the web fonts the first screen is set in (Bodoni Moda upright and italic, Jost: their
 * latin subsets). The page is built by the script, so without this the browser finds them only
 * after the script has run, and the titles and the wordmark swap from a fallback face late.
 * The other subsets (latin-ext, math, symbols, cyrillic) stay on demand: the interface never
 * draws their characters in these faces. Build only: the hashed file names exist only in the bundle.
 */
function preloadFonts(files: RegExp): Plugin {
  let base = '/';
  return {
    name: 'forma:preload-fonts',
    apply: 'build',
    configResolved(config) { base = config.base; },
    transformIndexHtml: {
      order: 'post',
      handler: (_html, { bundle }) => Object.keys(bundle ?? {}).filter((f) => files.test(f)).sort().map((f) => ({
        tag: 'link',
        attrs: { rel: 'preload', href: base + f, as: 'font', type: 'font/woff2', crossorigin: '' },
        injectTo: 'head' as const,
      })),
    },
  };
}

export default defineConfig({
  plugins: [preloadFonts(/\/(bodoni-moda-latin-standard-(normal|italic)|jost-latin-wght-normal)-[\w-]+\.woff2$/)],
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
