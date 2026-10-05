import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@audio-video/types/contracts',
        replacement: resolve(import.meta.dirname, '../audio-video-types/src/contracts.ts'),
      },
      {
        find: '@audio-video/types',
        replacement: resolve(import.meta.dirname, '../audio-video-types/src/index.ts'),
      },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
