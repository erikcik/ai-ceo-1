import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const API = process.env.LH_HARNESS_WEB_API ?? 'http://127.0.0.1:8799';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
    proxy: {
      '/api': { target: API, changeOrigin: true, ws: true },
      '/ws': { target: API, changeOrigin: true, ws: true },
    },
  },
  // The bundle is built next to this package so the Node web API can serve
  // `frontend/web/dist` directly; the directory is git-ignored build output.
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});
