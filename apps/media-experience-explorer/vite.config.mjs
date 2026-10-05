import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appRoot = new URL(".", import.meta.url).pathname;
const mediaRoot = resolve(appRoot, "../..");
const productExperienceRoot = resolve(mediaRoot, ".product-experience");
const artifactManifest = JSON.parse(readFileSync(resolve(appRoot, "specification-artifacts.json"), "utf8"));
const specificationFiles = artifactManifest.map((artifact) => artifact.path.replace(".product-experience/", ""));

function specificationSourcePlugin() {
  return {
    name: "media-specification-source",
    configureServer(server) {
      server.middlewares.use("/specification", (request, response, next) => {
        const relativePath = decodeURIComponent((request.url ?? "/").split("?")[0]).replace(/^\/+/, "");
        if (!specificationFiles.includes(relativePath)) return next();
        const sourcePath = resolve(productExperienceRoot, relativePath);
        if (!sourcePath.startsWith(`${productExperienceRoot}/`)) return next();
        try {
          response.setHeader("Content-Type", relativePath.endsWith(".md") ? "text/markdown; charset=utf-8" : "text/yaml; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(readFileSync(sourcePath));
        } catch {
          response.statusCode = 404;
          response.end("Specification file not found.");
        }
      });
    },
    generateBundle() {
      for (const relativePath of specificationFiles) {
        this.emitFile({
          type: "asset",
          fileName: `specification/${relativePath}`,
          source: readFileSync(resolve(productExperienceRoot, relativePath)),
        });
      }
    },
  };
}

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'none'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:4178",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const previewContentSecurityPolicy = contentSecurityPolicy.replace(
  "connect-src 'self' ws://127.0.0.1:4178",
  "connect-src 'self'",
);

export default {
  root: appRoot,
  base: "./",
  plugins: [specificationSourcePlugin()],
  resolve: {
    alias: {
      "@ghatana/media-experience-simulation": resolve(appRoot, "../../libs/media-experience-simulation/src/index.ts"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true,
    headers: { "Content-Security-Policy": contentSecurityPolicy },
    fs: { allow: [resolve(appRoot, "../.."), resolve(appRoot, "../../../ghatana-tools")] },
  },
  preview: {
    host: "127.0.0.1",
    headers: { "Content-Security-Policy": previewContentSecurityPolicy },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
};
