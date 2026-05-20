import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  base: './',
  build: {
    outDir: path.resolve(__dirname, '../pages/utilities/assets'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      input: path.resolve(__dirname, '../utilities-src/src/main.ts'),
      output: {
        format: 'es',
        entryFileNames: 'utilities-app.js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]'
      }
    }
  },
  resolve: {
    alias: {
      '@utilities': path.resolve(__dirname, '../utilities-src/src')
    }
  }
});
