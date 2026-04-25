import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  root: path.resolve(__dirname, '../game-src'),
  base: './',
  build: {
    outDir: path.resolve(__dirname, '../pages/game'),
    emptyOutDir: true,
    target: 'es2022'
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../game-src/src')
    }
  },
  server: {
    port: 5174,
    strictPort: true
  }
});
