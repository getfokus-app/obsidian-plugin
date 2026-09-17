import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Everything under test is pure by design; the stub exists so a module
      // that merely imports a type from 'obsidian' still resolves in Node.
      obsidian: fileURLToPath(new URL('./tests/stubs/obsidian.ts', import.meta.url)),
    },
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 15000 },
});
