import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      '@audio-video/ui': resolve(__dirname, '../../libs/audio-video-ui/src/index.tsx'),
      '@ghatana/design-system': resolve(__dirname, '../../../../../ghatana-shared/platform/typescript/design-system/src/index.ts'),
      '@ghatana/platform-utils': resolve(__dirname, '../../../../../ghatana-shared/platform/typescript/platform-utils/src/index.ts'),
      '@ghatana/tokens': resolve(__dirname, '../../../../../ghatana-shared/platform/typescript/tokens/src/index.ts'),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: process.env.TAURI_PLATFORM == 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['dist/**', 'node_modules/**', 'e2e/**'],
    coverage: {
      reporter: ['text', 'lcov', 'html'],
      exclude: ['src/test-setup.ts', 'src/**/*.d.ts'],
    },
  },
})
