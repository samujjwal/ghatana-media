import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // UI components resolve from the source-linked Shared workspace. Dedupe its
  // peer React imports against this package so SSR tests and React DOM share
  // one dispatcher even when the sibling workspace has its own node_modules.
  resolve: {
    dedupe: ['react', 'react-dom'],
    // The isolated Media test toolchain cannot install the sibling Shared
    // workspace's locked lucide-react runtime (registry is offline). These
    // icons are decorative in the UI flows under test; keep all Shared UI and
    // behavior real while replacing only the icon leaf module for Vitest.
    alias: [{
      find: 'lucide-react',
      replacement: fileURLToPath(new URL('./vitest.lucide-react.ts', import.meta.url)),
    }],
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // Resolve this path from the config URL as a decoded filesystem path;
    // URL.pathname leaves spaces encoded (for example, as `%20`).
    setupFiles: [fileURLToPath(new URL('./vitest.setup.ts', import.meta.url))],
  },
});
