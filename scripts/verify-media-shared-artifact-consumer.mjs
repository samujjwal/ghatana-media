#!/usr/bin/env node
/**
 * Build Media UI in a temporary consumer context against locally packed Shared
 * artifacts, then install and exercise the resulting public artifacts in a
 * second isolated consumer. This is source-snapshot consumer evidence only.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sharedRoot = resolve(root, "../ghatana-shared/platform/typescript");
const mediaRoot = join(root, "libs/audio-video-ui");
const mediaManifest = JSON.parse(readFileSync(join(mediaRoot, "package.json"), "utf8"));
const { parse: parseYaml } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const tokenAliases = parseYaml(readFileSync(join(root, ".product-experience/pdp-2-design-interface-system/media-token-aliases.yaml"), "utf8")).aliases;
const mediaStyleSource = readFileSync(join(root, "libs/audio-video-ui/src/styles.css"), "utf8");
assert.match(mediaStyleSource, /@import\s+["']@ghatana\/design-system\/strict-csp-controls\.css["']/u,
  "Media's public stylesheet must consume the Shared CSP-safe control asset");
assert.match(mediaStyleSource, /@import\s+["']@ghatana\/tokens\/tokens\.css["']/u,
  "Media's public stylesheet must consume the public token CSS used by Shared controls");
const tempRoot = mkdtempSync(join(tmpdir(), "media-shared-artifact-consumer-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, args, cwd, timeout = 180_000) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout });
}
function packedArchives(dir) { return readdirSync(dir).filter((name) => name.endsWith(".tgz")).map((name) => join(dir, name)); }
function packageManifest(path) { return JSON.parse(readFileSync(join(path, "package.json"), "utf8")); }
function publicTargets(manifest) {
  return Object.values(manifest.exports ?? {}).flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (!entry || typeof entry !== "object") return [];
    return [entry.import, entry.require, entry.default, entry.types].filter(Boolean);
  });
}
function digest(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  return value;
}
function publishedContentDigest(packageRoot) {
  const hash = createHash("sha256");
  const visit = (directory, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (statSync(path).isDirectory()) visit(path, relative);
      else {
        const bytes = name.endsWith(".json")
          ? Buffer.from(`${JSON.stringify(canonicalJson(JSON.parse(readFileSync(path, "utf8"))))}\n`)
          : readFileSync(path);
        hash.update(relative).update("\0").update(bytes).update("\0");
      }
    }
  };
  visit(packageRoot);
  return hash.digest("hex");
}

try {
  assert.ok(existsSync(sharedRoot), `Shared TypeScript package source is unavailable: ${sharedRoot}`);
  const manifests = new Map();
  for (const entry of readdirSync(sharedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packagePath = join(sharedRoot, entry.name);
    const manifestPath = join(packagePath, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.name) manifests.set(manifest.name, { path: packagePath, manifest });
  }

  const closure = new Map();
  const pending = Object.keys(mediaManifest.dependencies ?? {}).filter((name) => name.startsWith("@ghatana/"));
  while (pending.length) {
    const name = pending.pop();
    if (closure.has(name)) continue;
    const found = manifests.get(name);
    assert.ok(found, `Shared dependency is not present in the local package inventory: ${name}`);
    assert.equal(found.manifest.version, mediaManifest.dependencies[name] ?? found.manifest.version,
      `${name} version differs from Media's declared dependency`);
    assert.ok(existsSync(join(found.path, "dist")), `${name} has no built dist artifact; build the Shared package before running this check`);
    closure.set(name, found);
    for (const dependency of Object.keys(found.manifest.dependencies ?? {})) {
      if (dependency.startsWith("@ghatana/") && manifests.has(dependency)) pending.push(dependency);
    }
  }

  const sharedPackDir = join(tempRoot, "shared-tarballs");
  const sharedExtractDir = join(tempRoot, "shared-extracted");
  const mediaBuildDir = join(tempRoot, "media-build");
  const mediaPackageDir = join(tempRoot, "media-packed-package");
  const mediaPackDir = join(tempRoot, "media-tarball");
  const consumerDir = join(tempRoot, "consumer");
  for (const directory of [sharedPackDir, sharedExtractDir, mediaBuildDir, mediaPackageDir, join(mediaPackageDir, "src"), mediaPackDir, consumerDir])
    await import("node:fs/promises").then(({ mkdir }) => mkdir(directory, { recursive: true }));

  for (const { path } of closure.values()) run(pnpm, ["pack", "--pack-destination", sharedPackDir], path);
  const sharedArchives = packedArchives(sharedPackDir);
  assert.equal(sharedArchives.length, closure.size, "pnpm pack must produce one archive for each Shared dependency");
  const sharedByName = new Map();
  for (const archive of sharedArchives) {
    const unpackDir = join(sharedExtractDir, String(sharedByName.size));
    await import("node:fs/promises").then(({ mkdir }) => mkdir(unpackDir, { recursive: true }));
    run("tar", ["-xzf", archive, "-C", unpackDir], root);
    const packedRoot = join(unpackDir, "package");
    const manifest = packageManifest(packedRoot);
    assert.equal(manifest.version, "0.1.0-SNAPSHOT", `${manifest.name} packed snapshot version changed`);
    for (const dependency of Object.values(manifest.dependencies ?? {})) {
      assert.ok(!String(dependency).startsWith("workspace:") && !String(dependency).startsWith("catalog:"),
        `${manifest.name} packed dependency was not normalized: ${dependency}`);
    }
    for (const target of publicTargets(manifest)) assert.ok(existsSync(join(packedRoot, target)), `${manifest.name} is missing packed public export ${target}`);
    sharedByName.set(manifest.name, {
      archive,
      packedRoot,
      manifest,
      archiveSha256: digest(archive),
      publishedContentSha256: publishedContentDigest(packedRoot),
    });
  }
  assert.deepEqual([...sharedByName.keys()].sort(), [...closure.keys()].sort(), "packed Shared identities must match Media's transitive dependency closure");

  const designSystemSource = readFileSync(join(sharedRoot, "design-system/src/styles/strict-csp-controls.css"), "utf8");
  const tokensCssPath = join(sharedRoot, "tokens/dist/tokens.css");
  assert.ok(existsSync(tokensCssPath), "public token CSS must be built before validating Shared control token bindings");
  const tokensCss = readFileSync(tokensCssPath, "utf8");
  const exportedTokenVars = new Set([...tokensCss.matchAll(/(--gh-[\w-]+)\s*:/gu)].map((match) => match[1]));
  const usedVars = new Set([...designSystemSource.matchAll(/var\(\s*(--gh-[\w-]+)/gu)].map((match) => match[1]));
  const localControlVars = new Set(["--gh-button-tone", "--gh-badge-tone"]);
  const unresolvedTokenVars = [...usedVars].filter((name) => !localControlVars.has(name) && !exportedTokenVars.has(name));
  assert.deepEqual(unresolvedTokenVars, [], "Shared controls may reference only local presentation vars or actual public token CSS exports");

  // Compile Media sources from a temporary copy whose node_modules contain
  // only tarball-installed packages. No workspace aliases or repository lockfile participate.
  cpSync(join(mediaRoot, "src"), join(mediaBuildDir, "src"), { recursive: true });
  cpSync(join(mediaRoot, "tsconfig.build.json"), join(mediaBuildDir, "tsconfig.build.json"));
  const buildTsconfig = JSON.parse(readFileSync(join(mediaRoot, "tsconfig.json"), "utf8"));
  buildTsconfig.compilerOptions.types = ["node"];
  writeFileSync(join(mediaBuildDir, "tsconfig.json"), JSON.stringify(buildTsconfig, null, 2));
  writeFileSync(join(mediaBuildDir, "package.json"), JSON.stringify({ name: "media-ui-temporary-build", private: true, type: "module" }, null, 2));

  const sharedTarballs = [...sharedByName.values()].map(({ archive }) => archive);
  const buildTools = ["typescript@^6.0.3", "@types/node@^26.1.2", "@types/react@^19.2.18", "@types/react-dom@^19.2.4", "react@^19.2.8", "react-dom@^19.2.8", "react-router@^8.3.0", "recharts@^3.10.1", "vite@^8.2.0"];
  run(npm, ["install", "--no-save", "--package-lock=false", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", mediaBuildDir, ...sharedTarballs, ...buildTools], root, 300_000);
  run(join(mediaBuildDir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc"), ["-p", "tsconfig.build.json"], mediaBuildDir);
  assert.ok(existsSync(join(mediaBuildDir, "dist", "screens", "index.js")), "Media build must emit its screens public entry point");

  const packedMediaManifest = structuredClone(mediaManifest);
  packedMediaManifest.peerDependencies = { react: "^19.2.8", "react-dom": "^19.2.8" };
  cpSync(join(mediaBuildDir, "dist"), join(mediaPackageDir, "dist"), { recursive: true });
  cpSync(join(mediaRoot, "src", "styles.css"), join(mediaPackageDir, "src", "styles.css"), { recursive: true });
  writeFileSync(join(mediaPackageDir, "package.json"), JSON.stringify(packedMediaManifest, null, 2));
  run(npm, ["pack", "--silent", "--pack-destination", mediaPackDir], mediaPackageDir);
  const mediaArchives = packedArchives(mediaPackDir);
  assert.equal(mediaArchives.length, 1, "Media pack must produce one artifact");
  const mediaArchive = mediaArchives[0];

  const publicTokenAliases = tokenAliases.map(({ id, sharedTokenRef, darkModeEquivalent }) => {
    const parseRole = (reference) => {
      const match = /^@ghatana\/tokens\/semantic-roles#semanticColorRoles\.(light|dark)\.([A-Za-z][A-Za-z0-9]*)$/u.exec(reference ?? "");
      assert.ok(match, `${id} must reference an exact role from the public @ghatana/tokens/semantic-roles export`);
      return { mode: match[1], role: match[2] };
    };
    const light = parseRole(sharedTokenRef);
    const dark = parseRole(darkModeEquivalent);
    assert.equal(light.mode, "light", `${id} light alias must resolve through semanticColorRoles.light`);
    assert.equal(dark.mode, "dark", `${id} dark alias must resolve through semanticColorRoles.dark`);
    return { id, light: light.role, dark: dark.role };
  });

  writeFileSync(join(consumerDir, "package.json"), JSON.stringify({ name: "media-public-artifact-consumer", private: true, type: "module" }, null, 2));
  const publicConsumerPackages = [mediaArchive, ...sharedTarballs, ...buildTools];
  run(npm, ["install", "--no-save", "--package-lock=false", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", consumerDir, ...publicConsumerPackages], root, 300_000);

  const consumerTs = `import { MediaTaskScreen } from "@audio-video/ui/screens";\n` +
    `import type { MediaActionPort, MediaActionDispatchResult, MediaDataPort } from "@audio-video/ui/ports";\n` +
    `import { EmptyState as MediaEmptyState } from "@audio-video/ui/foundations";\n` +
    `import { EmptyState as SharedEmptyState } from "@ghatana/design-system";\n` +
    `import { Badge, Button } from "@ghatana/design-system";\n` +
    `import * as Theme from "@ghatana/theme";\n` +
    `import { semanticColorRoles } from "@ghatana/tokens/semantic-roles";\n` +
    `const result: MediaActionDispatchResult = { status: "request-started", requestId: "consumer-request" };\n` +
    `const actionPort: MediaActionPort = { invoke: async () => result };\n` +
    `declare const data: MediaDataPort;\n` +
    publicTokenAliases.map(({ light, dark }, index) => `const tokenAlias_${index}: string = semanticColorRoles.light.${light};\nconst darkTokenAlias_${index}: string = semanticColorRoles.dark.${dark};`).join("\n") + "\n" +
    `void [MediaTaskScreen, actionPort, data, MediaEmptyState, SharedEmptyState, Badge, Button, Theme, semanticColorRoles];\n`;
  writeFileSync(join(consumerDir, "consumer.ts"), consumerTs);
  writeFileSync(join(consumerDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { noEmit: true, strict: true, skipLibCheck: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", jsx: "react-jsx", types: ["node"] },
    files: ["consumer.ts"],
  }, null, 2));
  run(join(consumerDir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc"), ["-p", "tsconfig.json"], consumerDir);

  const runtimeSpecifiers = ["@audio-video/ui", "@audio-video/ui/screens", "@audio-video/ui/components", "@audio-video/ui/foundations", "@audio-video/ui/hooks", "@ghatana/design-system", "@ghatana/theme", "@ghatana/tokens", "@ghatana/tokens/semantic-roles"];
  const runtimeConsumer = `import assert from "node:assert/strict";\n` +
    `import React from "react";\n` +
    `import { renderToStaticMarkup } from "react-dom/server";\n` +
    `import { EmptyState as MediaEmptyState } from "@audio-video/ui/foundations";\n` +
    `import { EmptyState as SharedEmptyState } from "@ghatana/design-system";\n` +
    `import { semanticColorRoles } from "@ghatana/tokens/semantic-roles";\n` +
    runtimeSpecifiers.map((specifier, index) => `import * as entry${index} from ${JSON.stringify(specifier)};`).join("\n") + "\n" +
    runtimeSpecifiers.map((specifier, index) => `assert.ok(Object.keys(entry${index}).length, ${JSON.stringify(specifier)} + " must expose public runtime exports");`).join("\n") + "\n" +
    publicTokenAliases.map(({ id, light, dark }) => `assert.equal(typeof semanticColorRoles.light.${light}, "string", ${JSON.stringify(`${id} light role must resolve from the installed public package`)});\nassert.equal(typeof semanticColorRoles.dark.${dark}, "string", ${JSON.stringify(`${id} dark role must resolve from the installed public package`)});`).join("\n") + "\n" +
    `assert.equal(MediaEmptyState, SharedEmptyState, "Media foundation facade must re-export the public Shared EmptyState without wrapping it");\n` +
    `const emptyStateMarkup = renderToStaticMarkup(React.createElement(MediaEmptyState, { title: "No authorized projects are available." }));\n` +
    `assert.match(emptyStateMarkup, /role="status" aria-label="No authorized projects are available\\."/);\n` +
    `assert.doesNotMatch(emptyStateMarkup, /\\sstyle=/, "Shared EmptyState must remain compatible with style-src-attr 'none'");\n`;
  writeFileSync(join(consumerDir, "consumer.mjs"), runtimeConsumer);
  writeFileSync(join(consumerDir, "vite.config.mjs"), `export default { ssr: { noExternal: true } };\n`);
  run(join(consumerDir, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite"), ["build", "--config", "vite.config.mjs", "--ssr", "consumer.mjs", "--outDir", "bundle", "--emptyOutDir"], consumerDir);
  const bundledFiles = readdirSync(join(consumerDir, "bundle")).filter((name) => /\.[cm]?js$/u.test(name));
  assert.ok(bundledFiles.length > 0, "Vite consumer bundle must be emitted");
  const bundledRuntime = join(consumerDir, "bundle", bundledFiles[0]);
  run(process.execPath, [bundledRuntime], consumerDir);

  console.log(`Media isolated public-artifact consumer passed: Media UI ${mediaManifest.version} compiled and packed; ${sharedByName.size} Shared source-snapshot artifacts at 0.1.0-SNAPSHOT installed from tarballs; consumer type and runtime entrypoints resolved. SHA-256 (raw archive, package JSON key order may vary): ${JSON.stringify(Object.fromEntries([...sharedByName].map(([name, value]) => [name, value.archiveSha256])))}. SHA-256 (canonical published files): ${JSON.stringify(Object.fromEntries([...sharedByName].map(([name, value]) => [name, value.publishedContentSha256])))}.`);
  console.log("Scope: this proves consumption of locally packed source snapshots only; canonical file digests normalize JSON object key order and do not prove registry publication, immutable release binding, or semantic acceptance.");
} catch (error) {
  if (error?.stdout || error?.stderr) {
    process.stderr.write(String(error.stdout ?? ""));
    process.stderr.write(String(error.stderr ?? ""));
  }
  throw error;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
