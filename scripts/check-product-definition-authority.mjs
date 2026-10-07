#!/usr/bin/env node
/**
 * Purpose: enforce the four-PDP source layout, manifest portability, registry
 * presence, and scope-status rules locally.
 * Consumers: focused local verification and pre-review checks.
 * Non-goals: Lifecycle-owned Evidence Generator receipts, semantic acceptance,
 * qualification, release state, or currentness generation.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const productRoot = join(root, ".product-experience");
const failures = [];
const notes = [];
const fail = (message) => failures.push(message);
const note = (message) => notes.push(message);
const read = (relativePath) => {
  const path = join(root, relativePath);
  if (!existsSync(path)) { fail(`missing ${relativePath}`); return ""; }
  return readFileSync(path, "utf8");
};
const exists = (relativePath) => existsSync(join(root, relativePath));
const required = (paths) => paths.forEach((path) => { if (!exists(path)) fail(`missing required authority ${path}`); });

required([
  ".product-experience/pdp-0-product-truth",
  ".product-experience/pdp-1-domain-data",
  ".product-experience/pdp-2-design-interface-system",
  ".product-experience/pdp-3-product-experience",
  ".product-experience/explorer",
  ".product-experience/source-manifest.yaml",
  ".product-experience/surface-registry.yaml",
  ".product-experience/pdp-0-product-truth/ocr-ownership.yaml",
  ".product-experience/explorer/tools-binding.yaml",
  "libs/audio-video-client/src/canonical-routes.ts",
]);
const registryCounts = [
  [".product-experience/pdp-3-product-experience/api/api-registry.yaml", /^  - id: media\.http\./gmu, 27],
  [".product-experience/pdp-3-product-experience/grpc/service-registry.yaml", /^  - id: media\.grpc\./gmu, 43],
  [".product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml", /^  - id: /gmu, 4],
  [".product-experience/pdp-3-product-experience/cli/command-registry.yaml", /^  - id: /gmu, 11],
];
for (const [relativePath, expression, expected] of registryCounts) {
  const count = (read(relativePath).match(expression) ?? []).length;
  if (count !== expected) fail(`${relativePath} contains ${count} records; expected ${expected}`);
}
for (const oldPath of [".product-experience/phase-0-product-truth", ".product-experience/phase-1-design-language", ".product-experience/phase-2-product-experience", ".product-experience/phase-3-experience-explorer"]) {
  if (exists(oldPath)) fail(`obsolete active phase directory remains: ${oldPath}`);
}

const allowedPhases = new Set(["PDP-0", "PDP-1", "PDP-2", "PDP-3", "EXPLORER", "CROSS_PHASE", "IMPLEMENTATION", "EVIDENCE", "REFERENCE", "OBSOLETE"]);
const manifest = read(".product-experience/source-manifest.yaml");
if (!manifest.includes("schemaVersion: media.source-manifest.v2")) fail("source manifest schema is not media.source-manifest.v2");
if (!manifest.includes("canonicalLocationPolicy: repository-relative-only")) fail("source manifest does not declare repository-relative canonical locations");
if (!manifest.includes("explorerOutsidePdpPhases: true")) fail("source manifest does not keep Explorer outside PDP phases");
if (!manifest.includes("semanticAuthority: false")) fail("migration reference is not explicitly non-semantic");
if (/(?:^|[\s:])\/(?:Users|home|tmp|workspace)\//mu.test(manifest)) fail("source manifest contains an absolute workstation path");
const manifestRecords = [...manifest.matchAll(/^  - artifactId: ([^\s]+)\n(?:.*\n){0,20}?    owningPhase: ([^\n]+)\n    path: ([^\n]+)$/gmu)];
const artifactIds = new Set();
const artifactPaths = new Set();
for (const [, artifactId, phase, path] of manifestRecords) {
  if (artifactIds.has(artifactId)) fail(`duplicate manifest artifactId ${artifactId}`);
  if (artifactPaths.has(path)) fail(`duplicate manifest path ${path}`);
  artifactIds.add(artifactId); artifactPaths.add(path);
  if (!allowedPhases.has(phase.trim())) fail(`unknown manifest phase ${phase} for ${path}`);
  if (path.startsWith("/")) fail(`manifest path is absolute: ${path}`);
  if (!exists(path)) fail(`manifest record points to missing source: ${path}`);
}
if (manifestRecords.length < 100) fail(`manifest contains only ${manifestRecords.length} parsed records`);
note(`${manifestRecords.length} portable manifest records parsed`);

const indexSource = read("apps/media-experience-explorer/specification-artifacts.json");
let index = [];
try { index = JSON.parse(indexSource); } catch (error) { fail(`Explorer index is not valid JSON: ${error.message}`); }
if (!Array.isArray(index) || index.length === 0) fail("Explorer index is empty");
const indexPaths = new Set();
for (const artifact of index) {
  if (indexPaths.has(artifact.path)) fail(`duplicate Explorer index path ${artifact.path}`);
  indexPaths.add(artifact.path);
  if (!allowedPhases.has(artifact.phase)) fail(`unknown Explorer phase ${artifact.phase} for ${artifact.path}`);
  if (artifact.path.startsWith("/") || !exists(artifact.path)) fail(`invalid Explorer source path ${artifact.path}`);
}
if (!index.some((artifact) => artifact.path === ".product-experience/source-manifest.yaml")) fail("Explorer index does not expose the generated source manifest");
if (index.some((artifact) => /stablePathId|path-derived/iu.test(JSON.stringify(artifact)))) fail("Explorer index contains path-derived semantic identity metadata");

required([
  ".product-experience/pdp-1-domain-data/DOMAIN-MODEL.md",
  ".product-experience/pdp-1-domain-data/domain-objects.yaml",
  ".product-experience/pdp-1-domain-data/value-objects.yaml",
  ".product-experience/pdp-1-domain-data/relationships.yaml",
  ".product-experience/pdp-1-domain-data/operations.yaml",
  ".product-experience/pdp-1-domain-data/events.yaml",
  ".product-experience/pdp-1-domain-data/evidence.yaml",
  ".product-experience/pdp-1-domain-data/provenance.yaml",
  ".product-experience/pdp-1-domain-data/privacy.yaml",
  ".product-experience/pdp-1-domain-data/versioning.yaml",
  ".product-experience/pdp-1-domain-data/offline-sync.yaml",
  ".product-experience/pdp-1-domain-data/interoperability.yaml",
  ".product-experience/pdp-1-domain-data/authority.yaml",
  ".product-experience/pdp-1-domain-data/decisions.yaml",
  ".product-experience/pdp-2-design-interface-system/gui/primitives.yaml",
  ".product-experience/pdp-2-design-interface-system/gui/layout.yaml",
  ".product-experience/pdp-2-design-interface-system/gui/screen-composition-schema.yaml",
  ".product-experience/pdp-2-design-interface-system/gui/style-authority.yaml",
  ".product-experience/pdp-2-design-interface-system/api/conventions.yaml",
  ".product-experience/pdp-2-design-interface-system/cli/conventions.yaml",
  ".product-experience/pdp-2-design-interface-system/sdk/conventions.yaml",
  ".product-experience/pdp-2-design-interface-system/events/conventions.yaml",
  ".product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml",
  ".product-experience/pdp-3-product-experience/api/api-registry.yaml",
  ".product-experience/pdp-3-product-experience/api/operations/README.md",
  ".product-experience/pdp-3-product-experience/grpc/service-registry.yaml",
  ".product-experience/pdp-3-product-experience/grpc/operations/README.md",
  ".product-experience/pdp-3-product-experience/cli/command-registry.yaml",
  ".product-experience/pdp-3-product-experience/sdk/operation-registry.yaml",
  ".product-experience/pdp-3-product-experience/events/event-registry.yaml",
  ".product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml",
  ".product-experience/pdp-3-product-experience/services/service-registry.yaml",
]);

const surfaceRegistry = read(".product-experience/surface-registry.yaml");
for (const [field, expected] of [["guiScreens", 47], ["httpOperations", 27], ["grpcRpcs", 43], ["agentToolHandlers", 4], ["planCliCommands", 11], ["fixtureCliCommandsObserved", 12], ["explorerRecordsHistorical", 147]]) {
  if (!new RegExp(`^  ${field}: ${expected}$`, "mu").test(surfaceRegistry)) fail(`surface registry denominator ${field} is not ${expected}`);
}
for (const field of ["surfaceId:", "surfaceType:", "purpose:", "consumers:", "owners:", "upstreamProductTruth:", "canonicalDomainConcepts:", "interactionModel:", "contractAuthority:", "securityAuthorityModel:", "availabilityExpectations:", "versioningExpectations:", "compatibilityExpectations:", "applicablePdpArtifacts:", "explorerProjection:", "semanticStatus:", "implementationStatus:", "qualificationStatus:"]) {
  if (!surfaceRegistry.includes(field)) fail(`surface registry lacks field ${field}`);
}
const surfaceIds = [...surfaceRegistry.matchAll(/^  - surfaceId: ([^\s]+)$/gmu)].map((match) => match[1]);
if (new Set(surfaceIds).size !== surfaceIds.length) fail("surface registry contains duplicate surface IDs");
if (surfaceIds.length < 10) fail(`surface registry has only ${surfaceIds.length} surfaces`);

const scopeValues = new Set(["CURRENT", "TARGET", "DEFERRED", "RESEARCH", "COMPATIBILITY_ONLY", "NOT_APPLICABLE", "OBSOLETE"]);
function checkScope(relativePath, idPattern, { indent = 0, expectedCount } = {}) {
  const source = read(relativePath);
  const records = [...source.matchAll(/^( *)(- id: ([^\s]+))\r?\n/gmu)]
    .filter((record) => record[1].length === indent && idPattern.test(record[0]));
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const id = record[3];
    const start = record.index + record[0].length;
    let end = source.length;
    for (let next = index + 1; next < records.length; next += 1) {
      if (records[next].index > start) {
        end = records[next].index;
        break;
      }
    }
    const block = source.slice(start, end);
    const statuses = [...block.matchAll(/^( +)scopeStatus: ([^\s#]+)\s*$/gmu)]
      .filter((match) => match[1].length > indent);
    if (statuses.length !== 1) fail(`${relativePath} ${id} has ${statuses.length} scopeStatus values; expected exactly one`);
    else if (!scopeValues.has(statuses[0][2])) fail(`${relativePath} ${id} has invalid scopeStatus ${statuses[0][2]}`);
  }
  if (expectedCount !== undefined && records.length !== expectedCount) fail(`${relativePath} has ${records.length} records; expected ${expectedCount}`);
  note(`${relativePath}: ${records.length} scoped records checked`);
}
checkScope(".product-experience/pdp-0-product-truth/requirements.yaml", /^- id: MEDIA-REQ-/mu);
checkScope(".product-experience/pdp-0-product-truth/capabilities.yaml", /^- id: media\./mu);
checkScope(".product-experience/pdp-0-product-truth/journey-catalog.yaml", /^- id: J-/mu, { expectedCount: 30 });

const ocr = read(".product-experience/pdp-0-product-truth/ocr-ownership.yaml");
if (!ocr.includes("classification: INCORRECT_IMPLEMENTATION") || !ocr.includes("publicDependency:") || !ocr.includes("EXTERNAL_BLOCKER")) fail("OCR ownership does not record the generic-service boundary and external DI blocker");
if (/generic OcrService.*Product Truth/iu.test(ocr)) fail("OCR ownership incorrectly promotes generic OcrService to Product Truth");

const screenDir = join(productRoot, "pdp-3-product-experience/screen-contracts");
const screenFiles = exists(".product-experience/pdp-3-product-experience/screen-contracts") ? readdirSync(screenDir).filter((file) => file.endsWith(".yaml")) : [];
if (screenFiles.length !== 48) fail(`screen contract file count is ${screenFiles.length}; expected 48 including the job-family specialization`);
const screenRegistry = read(".product-experience/pdp-3-product-experience/screen-registry.yaml");
const screenIds = new Set([...screenRegistry.matchAll(/^\s*- id: (media\.view\.[^\s]+)$/gmu)].map((match) => match[1]));
if (screenIds.size !== 47) fail(`screen registry ID count is ${screenIds.size}; expected 47`);
const journeyRegistry = read(".product-experience/pdp-3-product-experience/journey-registry.yaml");
if (!journeyRegistry.includes("id: J-29") || !journeyRegistry.includes("id: J-30")) fail("journey registry does not include J-29 and J-30");

if (failures.length) {
  console.error(`Media Product Definition authority check failed (${failures.length} failures)`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Media Product Definition authority check passed");
}
for (const message of notes) console.log(`  ${message}`);
