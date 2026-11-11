import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    dedupe: ["react", "react-dom"],
    preserveSymlinks: true,
  },
  ssr: {
    noExternal: ["@audio-video/ui", "@ghatana/design-system", "@ghatana/theme"],
  },
});
