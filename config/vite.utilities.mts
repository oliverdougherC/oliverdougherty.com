import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  base: './',
  plugins: [{
    name: 'source-preview-entry',
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find((item) => item.type === 'chunk' && item.isEntry);
      if (!entry) throw new Error('Utilities entry missing');
      // Source previews keep a compatibility loader. Deployment HTML points
      // directly at the immutable entry and does not ship this loader.
      this.emitFile({ type: 'asset', fileName: 'utilities-app.js', source: `import './${entry.fileName}';\n` });
    }
  }],
  worker: {
    format: 'es'
  },
  build: {
    outDir: path.resolve(__dirname, '../pages/utilities/assets'),
    emptyOutDir: true,
    sourcemap: false,
    manifest: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        'utilities-app': path.resolve(__dirname, '../utilities-src/src/main.ts')
      },
      output: {
        format: 'es',
        entryFileNames: '[name]-[hash].js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: (asset) => asset.names.some(name => /^v86(?:-fallback)?\.wasm$/.test(name))
          ? '[name][extname]'
          : '[name]-[hash][extname]'
      }
    }
  },
  resolve: {
    alias: {
      '@utilities': path.resolve(__dirname, '../utilities-src/src')
    }
  }
});
