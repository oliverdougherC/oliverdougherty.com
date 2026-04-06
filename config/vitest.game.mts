import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  test: {
    include: ['game-src/tests/**/*.test.ts'],
    environment: 'node',
    globals: true,
    coverage: {
      reporter: ['text']
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../game-src/src')
    }
  }
});
