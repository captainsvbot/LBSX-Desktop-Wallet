import { defineConfig } from 'vite';

export default defineConfig({
  // Electron loads the production renderer from file://, so packaged assets
  // must resolve relative to index.html instead of the filesystem root.
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
