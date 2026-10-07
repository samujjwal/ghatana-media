#!/usr/bin/env node
/**
 * Refresh executable UI provenance from the public package manifest and the
 * current repository tree. This records source identity and byte fingerprints
 * only; it does not compute semantic currentness or grant admission.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiPackagePath = "libs/audio-video-ui/package.json";
const exportMapPath = ".product-experience/executable-representation/export-map.yaml";
const inventoryPath = ".product-experience/pdp-2-design-interface-system/executable-ui-inventory.json";
const inventoryDocPath = ".product-experience/pdp-2-design-interface-system/executable-ui-inventory.md";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const bytesAt = (path) => readFileSync(join(root, path));
const textAt = (path) => bytesAt(path).toString("utf8");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const uiPackage = JSON.parse(textAt(uiPackagePath));

function packageSource(target) {
  const normalized = target.replace(/^\.\//u, "");
  if (normalized.startsWith("src/")) return `libs/audio-video-ui/${normalized}`;
  if (!normalized.startsWith("dist/")) throw new Error(`Unsupported package export target: ${target}`);
  const stem = normalized.slice("dist/".length).replace(/\.d\.ts$|\.js$/u, "");
  for (const extension of [".ts", ".tsx", ".js", ".jsx", ".css"]) {
    const candidate = `libs/audio-video-ui/src/${stem}${extension}`;
    try { bytesAt(candidate); return candidate; } catch { /* try next source extension */ }
  }
  throw new Error(`No source file found for package export target ${target}`);
}

const observedExports = Object.entries(uiPackage.exports).map(([subpath, targets]) => {
  const importTarget = typeof targets === "string" ? targets : targets.import ?? targets.default ?? targets.types;
  const source = packageSource(importTarget);
  return { subpath, importTarget, source, sourceSha256: hash(bytesAt(source)) };
});

const exportMapFile = textAt(exportMapPath);
const exportHeader = exportMapFile.split(/^exports:\s*$/mu)[0];
const authoredExportSection = exportMapFile.match(/^exports:\s*\n([\s\S]*?)(?=^notImplementedLayers:)/mu)?.[1];
if (authoredExportSection === undefined) throw new Error("Could not locate authored export records in export-map.yaml");
const authoredSubpaths = [...authoredExportSection.matchAll(/^  - subpath: (.+)$/gmu)].map((match) => match[1].trim().replace(/^['"]|['"]$/gu, ""));
if (!authoredSubpaths.length) throw new Error("No authored export records found in export-map.yaml");

const packageSubpaths = new Set(observedExports.map(({ subpath }) => subpath === "." ? "." : subpath));
for (const subpath of authoredSubpaths) {
  if (subpath !== "package-root-token-exports" && !packageSubpaths.has(subpath)) {
    throw new Error(`Authored package export ${subpath} is absent from ${uiPackagePath}`);
  }
}

let generatedExportSection = authoredExportSection
  .replace(/^    sourceSha256: [^\n]*\n/gmu, "")
  .replace(/^    source: ([^\n]+)$/gmu, (line, source) => {
  const path = source.trim().replace(/^['"]|['"]$/gu, "");
  return `${line}\n    sourceSha256: ${hash(bytesAt(path))}`;
});

const observationBlock = [
  "generatedPackageExports:",
  `  packageName: ${JSON.stringify(uiPackage.name)}`,
  `  packageVersion: ${JSON.stringify(uiPackage.version)}`,
  `  packageManifestSha256: ${hash(bytesAt(uiPackagePath))}`,
  `  sourceRevision: ${revision}`,
  "  exports:",
  ...observedExports.flatMap(({ subpath, importTarget, source, sourceSha256 }) => [
    `    - subpath: ${JSON.stringify(subpath)}`,
    `      importTarget: ${JSON.stringify(importTarget)}`,
    `      source: ${source}`,
    `      sourceSha256: ${sourceSha256}`,
  ]),
].join("\n");
let nextExportMap = exportHeader
  .replace(/^generatedPackageExports:\n[\s\S]*$/mu, "")
  .replace(/^observationRevision: .*$/mu, `observationRevision: ${revision}`)
  .replace(/^package: .*$/mu, `package: ${JSON.stringify(uiPackage.name)}`);
nextExportMap = `${nextExportMap.trimEnd()}\n${observationBlock}\nexports:\n${generatedExportSection}notImplementedLayers:${exportMapFile.split(/^notImplementedLayers:/mu)[1]}`;

const inventory = JSON.parse(textAt(inventoryPath));
const statusOutput = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
const statusByPath = new Map(statusOutput.split(/\r?\n/u).filter(Boolean).map((line) => [line.slice(3), line.slice(0, 2)]));
for (const entry of inventory.entries) {
  const fileBytes = bytesAt(entry.sourcePath);
  const state = statusByPath.get(entry.sourcePath);
  entry.sourceSha256 = hash(fileBytes);
  entry.sourceRevision = revision;
  entry.sourceState = state?.includes("?") ? "working-tree-untracked" : state ? "working-tree-modified" : "matches-observed-revision";
}
inventory.sourceRevision = revision;
inventory.observationFingerprint = hash(inventory.entries
  .map(({ sourcePath, sourceSha256 }) => `${sourcePath}\0${sourceSha256}`)
  .sort()
  .join("\n"));

const markdown = textAt(inventoryDocPath).replace(
  /current workspace observation at Git baseline `[^`]+`/u,
  `current workspace observation at Git baseline \`${revision}\``,
);
writeFileSync(join(root, exportMapPath), nextExportMap);
writeFileSync(join(root, inventoryPath), `${JSON.stringify(inventory, null, 2)}\n`);
writeFileSync(join(root, inventoryDocPath), markdown);
console.log(`Refreshed ${observedExports.length} package exports and ${inventory.entries.length} source observations at ${revision}.`);
