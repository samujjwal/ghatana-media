import { defineConfig } from 'vitest/config';

export default defineConfig({
  // UI components resolve from the source-linked Shared workspace. Dedupe its
  // peer React imports against this package so SSR tests and React DOM share
  // one dispatcher even when the sibling workspace has its own node_modules.
  resolve: { dedupe: ['react', 'react-dom'] },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
