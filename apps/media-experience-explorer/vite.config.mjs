import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactProxyGuard } from "./artifact-proxy-guard.mjs";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const mediaRoot = resolve(appRoot, "../..");
const sharedRoot = resolve(mediaRoot, "../ghatana-shared/platform/typescript");
const productExperienceRoot = resolve(mediaRoot, ".product-experience");
const devProjectTimelineProxyPort = Number(process.env.MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT ?? "8093");
if (!Number.isInteger(devProjectTimelineProxyPort) || devProjectTimelineProxyPort < 1 || devProjectTimelineProxyPort > 65535) {
  throw new Error("MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT must be a valid TCP port.");
}
const artifactManifest = JSON.parse(readFileSync(resolve(appRoot, "specification-artifacts.json"), "utf8"));
const specificationFiles = artifactManifest.map((artifact) => artifact.path.replace(".product-experience/", ""));

export function decodeSpecificationRequestPath(requestUrl) {
  try {
    return decodeURIComponent((requestUrl ?? "/").split("?")[0]).replace(/^\/+/, "");
  } catch {
    return null;
  }
}

function specificationSourcePlugin() {
  return {
    name: "media-specification-source",
    configureServer(server) {
      server.middlewares.use("/specification", (request, response, next) => {
        const relativePath = decodeSpecificationRequestPath(request.url);
        if (relativePath === null) {
          response.statusCode = 400;
          response.end("Malformed specification path.");
          return;
        }
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

function artifactProxyGuardPlugin() {
  return {
    name: "media-artifact-proxy-guard",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url ?? "/";
        if (!url.startsWith("/api/v1/jobs")) return next();
        if (request.method !== "GET" || !isSafeCanonicalJobReadPath(url)) {
          response.statusCode = 404;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Only owner-scoped job reads are forwarded by this local page." } }));
          return;
        }
        next();
      });
      server.middlewares.use(artifactProxyGuard);
    },
  };
}

function isSafeCanonicalJobReadPath(url) {
  const match = /^\/api\/v1\/jobs\/([^/?#]+)$/u.exec(url);
  if (!match) return false;
  try {
    const decoded = decodeURIComponent(match[1]);
    return decoded !== "." && decoded !== ".."
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(decoded)
      && encodeURIComponent(decoded) === match[1];
  } catch {
    return false;
  }
}

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
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
  plugins: [artifactProxyGuardPlugin(), specificationSourcePlugin()],
  resolve: {
    alias: {
      "@ghatana/media-experience-simulation": resolve(appRoot, "../../libs/media-experience-simulation/src/index.ts"),
      // Resolve the public DEV_ONLY package subpath from source for this local
      // review host; production package exports and canonical SDK remain separate.
      "@audio-video/client/dev-project-timeline": resolve(mediaRoot, "libs/audio-video-client/src/dev-project-timeline.ts"),
      "@audio-video/client/operations": resolve(mediaRoot, "libs/audio-video-client/src/operations.ts"),
      "@audio-video/client/canonical-operations": resolve(mediaRoot, "libs/audio-video-client/src/canonical-operations.ts"),
      // Local review-host aliases consume source/public exports; they do not qualify a published artifact.
      "@audio-video/ui/screens": resolve(appRoot, "../../libs/audio-video-ui/src/screens/index.ts"),
      "@audio-video/ui/components": resolve(appRoot, "../../libs/audio-video-ui/src/components/index.ts"),
      "@audio-video/ui/styles.css": resolve(appRoot, "../../libs/audio-video-ui/src/styles.css"),
      // The review host consumes the workspace package's public root from
      // source, matching its existing source aliases for public subpaths.
      "@audio-video/ui": resolve(mediaRoot, "libs/audio-video-ui/src/index.ts"),
      "@ghatana/design-system/strict-csp-controls.css": resolve(sharedRoot, "design-system/dist/strict-csp-controls.css"),
      "@ghatana/design-system": resolve(sharedRoot, "design-system/dist/index.js"),
      "react/jsx-dev-runtime": resolve(appRoot, "node_modules/react/jsx-dev-runtime.js"),
      "react/jsx-runtime": resolve(appRoot, "node_modules/react/jsx-runtime.js"),
      "react-dom/client": resolve(appRoot, "node_modules/react-dom/client.js"),
      "react-dom": resolve(appRoot, "node_modules/react-dom/index.js"),
      // Shared's design-system package is outside this workspace's resolver
      // tree; route its declared icon dependency through the app installation.
      "lucide-react": resolve(appRoot, "node_modules/lucide-react"),
      react: resolve(appRoot, "node_modules/react/index.js"),
    },
  },
  // Artifact intake hashes selected files with the Noble SHA-256 implementation.
  // Prebundle it with the initial dependency graph so Vite does not discover it
  // after serving modules and invalidate URLs the browser has already requested.
  optimizeDeps: { include: ["@noble/hashes/sha2.js"] },
  server: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true,
    headers: { "Content-Security-Policy": contentSecurityPolicy },
    // Browser credentials stay same-origin; Vite forwards only this DEV_ONLY
    // lane to the loopback Media host. The Explorer never accepts a host URL.
    proxy: {
      "/dev/v1": {
        target: `http://127.0.0.1:${devProjectTimelineProxyPort}`,
        changeOrigin: false,
        secure: false,
        configure(proxy) {
          proxy.on("error", (_error, request, response) => {
            if (request.method !== "POST" || response.destroyed || response.headersSent) return;
            response.writeHead(502, {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
            });
            response.end(JSON.stringify({
              error: {
                code: "OUTCOME_UNKNOWN",
                message: "The local host did not confirm the mutation outcome. Reopen the exact project before retrying.",
              },
            }));
          });
        },
      },
      // The artifact intake host forwards only canonical artifact routes to a
      // configured loopback Media host. The browser always addresses itself.
      "/api/v1/artifacts": {
        target: `http://127.0.0.1:${devProjectTimelineProxyPort}`,
        changeOrigin: false,
        secure: false,
        configure(proxy) {
          proxy.on("error", (_error, request, response) => {
            if ((request.method !== "POST" && request.method !== "PUT") || response.destroyed || response.headersSent) return;
            response.writeHead(502, {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
            });
            response.end(JSON.stringify({
              error: {
                code: "OUTCOME_UNKNOWN",
                message: "The local host did not confirm the artifact mutation outcome. Inspect the same upload identity before proceeding.",
              },
            }));
          });
        },
      },
      "/api/v1/jobs": {
        target: `http://127.0.0.1:${devProjectTimelineProxyPort}`,
        changeOrigin: false,
        secure: false,
      },
    },
    fs: { allow: [resolve(appRoot, "../.."), resolve(appRoot, "../../../ghatana-tools"), resolve(appRoot, "../../../ghatana-shared")] },
  },
  preview: {
    host: "127.0.0.1",
    headers: { "Content-Security-Policy": previewContentSecurityPolicy },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    ...(process.env.MEDIA_STRICT_CSP_FIXTURE === "1"
      ? { rollupOptions: { input: { strictCspControls: resolve(appRoot, "strict-csp-controls.html") } } }
      : {}),
  },
};
