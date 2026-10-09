import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: '.',
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  server: {
    host: '127.0.0.1',
    port: 4328,
    strictPort: true,
    // Packaging creates nested index.html/tsconfig files. Watching evidence
    // caused unrelated full reloads in the middle of a player's choice.
    watch: { ignored: ['**/verification/**','**/test-results/**','**/dist/**','**/assets/**'] },
    proxy: { '/api': 'http://127.0.0.1:4329' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
