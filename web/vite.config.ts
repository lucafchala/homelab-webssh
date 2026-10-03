import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  publicDir: 'public',
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  resolve: {
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      output: {
        // Rolldown's replacement for Rollup's `manualChunks` (same function, same chunks).
        codeSplitting: {
          groups: [
            {
              debugName: 'vendor',
              name: (id) => {
                if (id.includes('@xterm')) return 'xterm';
                if (id.includes('@codemirror') || id.includes('@lezer') || id.includes('/codemirror/')) return 'codemirror';
                return null;
              },
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', ws: true, changeOrigin: false },
      '/healthz': 'http://localhost:8080',
    },
  },
});
