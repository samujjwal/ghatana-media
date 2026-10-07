#!/usr/bin/env node
/**
 * Build Media UI in a temporary consumer context against locally packed Shared
 * artifacts, then install and exercise the resulting public artifacts in a
 * second isolated consumer. This is source-snapshot consumer evidence only.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sharedRoot = resolve(root, "../ghatana-shared/platform/typescript");
const mediaRoot = join(root, "libs/audio-video-ui");
const mediaManifest = JSON.parse(readFileSync(join(mediaRoot, "package.json"), "utf8"));
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
    sharedByName.set(manifest.name, { archive, packedRoot, manifest, sha256: digest(archive) });
  }
  assert.deepEqual([...sharedByName.keys()].sort(), [...closure.keys()].sort(), "packed Shared identities must match Media's transitive dependency closure");

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

  writeFileSync(join(consumerDir, "package.json"), JSON.stringify({ name: "media-public-artifact-consumer", private: true, type: "module" }, null, 2));
  const publicConsumerPackages = [mediaArchive, ...sharedTarballs, ...buildTools];
  run(npm, ["install", "--no-save", "--package-lock=false", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", consumerDir, ...publicConsumerPackages], root, 300_000);

  const consumerTs = `import { MediaTaskScreen } from "@audio-video/ui/screens";\n` +
    `import type { MediaActionPort, MediaActionDispatchResult, MediaDataPort } from "@audio-video/ui/ports";\n` +
    `import { Badge, Button } from "@ghatana/design-system";\n` +
    `import * as Theme from "@ghatana/theme";\n` +
    `import { semanticColorRoles } from "@ghatana/tokens/semantic-roles";\n` +
    `const result: MediaActionDispatchResult = { status: "request-started", requestId: "consumer-request" };\n` +
    `const actionPort: MediaActionPort = { invoke: async () => result };\n` +
    `declare const data: MediaDataPort;\n` +
    `void [MediaTaskScreen, actionPort, data, Badge, Button, Theme, semanticColorRoles];\n`;
  writeFileSync(join(consumerDir, "consumer.ts"), consumerTs);
  writeFileSync(join(consumerDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { noEmit: true, strict: true, skipLibCheck: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", jsx: "react-jsx", types: ["node"] },
    files: ["consumer.ts"],
  }, null, 2));
  run(join(consumerDir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc"), ["-p", "tsconfig.json"], consumerDir);

  const runtimeSpecifiers = ["@audio-video/ui", "@audio-video/ui/screens", "@audio-video/ui/components", "@audio-video/ui/foundations", "@audio-video/ui/hooks", "@ghatana/design-system", "@ghatana/theme", "@ghatana/tokens", "@ghatana/tokens/semantic-roles"];
  const runtimeConsumer = `import assert from "node:assert/strict";\n` +
    runtimeSpecifiers.map((specifier, index) => `import * as entry${index} from ${JSON.stringify(specifier)};`).join("\n") + "\n" +
    runtimeSpecifiers.map((specifier, index) => `assert.ok(Object.keys(entry${index}).length, ${JSON.stringify(specifier)} + " must expose public runtime exports");`).join("\n") + "\n";
  writeFileSync(join(consumerDir, "consumer.mjs"), runtimeConsumer);
  writeFileSync(join(consumerDir, "vite.config.mjs"), `export default { ssr: { noExternal: true } };\n`);
  run(join(consumerDir, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite"), ["build", "--config", "vite.config.mjs", "--ssr", "consumer.mjs", "--outDir", "bundle", "--emptyOutDir"], consumerDir);
  const bundledFiles = readdirSync(join(consumerDir, "bundle")).filter((name) => /\.[cm]?js$/u.test(name));
  assert.ok(bundledFiles.length > 0, "Vite consumer bundle must be emitted");
  const bundledRuntime = join(consumerDir, "bundle", bundledFiles[0]);
  run(process.execPath, [bundledRuntime], consumerDir);

  console.log(`Media isolated public-artifact consumer passed: Media UI ${mediaManifest.version} compiled and packed; ${sharedByName.size} Shared source-snapshot artifacts at 0.1.0-SNAPSHOT installed from tarballs; consumer type and runtime entrypoints resolved. SHA-256: ${JSON.stringify(Object.fromEntries([...sharedByName].map(([name, value]) => [name, value.sha256])))}.`);
  console.log("Scope: this proves consumption of locally packed source snapshots only; it does not prove registry publication, immutable release binding, or semantic acceptance.");
} catch (error) {
  if (error?.stdout || error?.stderr) {
    process.stderr.write(String(error.stdout ?? ""));
    process.stderr.write(String(error.stderr ?? ""));
  }
  throw error;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
