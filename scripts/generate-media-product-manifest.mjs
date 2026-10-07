#!/usr/bin/env node
/**
 * Purpose: generate the portable Media Product Definition artifact manifest
 * and Explorer source index from the canonical four-PDP tree.
 * Consumers: local authority checks and the Media Explorer adapter.
 * Non-goals: lifecycle-generated semantic fingerprints, currentness, acceptance,
 * qualification, release evidence, or manual readiness claims.
 * Change policy: update canonical source files first, then run this generator;
 * never hand-edit generated manifest/index output.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("..", import.meta.url).pathname);
const productRoot = join(root, ".product-experience");
const manifestPath = join(productRoot, "source-manifest.yaml");
const identityRegistryPath = join(productRoot, "artifact-identities.yaml");
const explorerIndexPath = join(root, "apps/media-experience-explorer/specification-artifacts.json");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = join(directory, entry.name);
      return entry.isDirectory() ? walk(absolute) : [absolute];
    });
}

function titleFor(path) {
  return path.split("/").at(-1)
    .replace(/\.[^.]+$/u, "")
    .replace(/[-_]+/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function phaseFor(path) {
  if (path.startsWith(".product-experience/pdp-0-product-truth/")) return "PDP-0";
  if (path.startsWith(".product-experience/pdp-1-domain-data/")) return "PDP-1";
  if (path.startsWith(".product-experience/pdp-2-design-interface-system/")) return "PDP-2";
  if (path.startsWith(".product-experience/pdp-3-product-experience/")) return "PDP-3";
  if (path.startsWith(".product-experience/explorer/")) return "EXPLORER";
  return "CROSS_PHASE";
}

function surfacesFor(path, phase) {
  if (phase === "EXPLORER") return ["media.surface.explorer"];
  if (path.startsWith(".product-experience/pdp-3-product-experience/api/")) return ["media.surface.public-http", "media.surface.service-grpc"];
  if (path.startsWith(".product-experience/pdp-3-product-experience/sdk/")) return ["media.surface.sdk"];
  if (path.startsWith(".product-experience/pdp-3-product-experience/cli/")) return ["media.surface.cli"];
  if (path.startsWith(".product-experience/pdp-3-product-experience/events/")) return ["media.surface.events"];
  if (path.startsWith(".product-experience/pdp-3-product-experience/agent-tools/")) return ["media.surface.agent-tools"];
  if (path.startsWith(".product-experience/pdp-3-product-experience/services/")) return ["media.surface.integrations"];
  if (phase === "PDP-3") return ["media.surface.web", "media.surface.embedded"];
  if (path.includes("pdp-2-design-interface-system/api/")) return ["media.surface.public-http", "media.surface.service-grpc"];
  if (path.includes("pdp-2-design-interface-system/cli/")) return ["media.surface.cli"];
  if (path.includes("pdp-2-design-interface-system/sdk/")) return ["media.surface.sdk"];
  if (path.includes("pdp-2-design-interface-system/events/")) return ["media.surface.events"];
  if (path.includes("pdp-2-design-interface-system/agent-tools/")) return ["media.surface.agent-tools"];
  if (path.includes("pdp-2-design-interface-system/gui/") || path.includes("pdp-2-design-interface-system/component-contracts.yaml")) return ["media.surface.web", "media.surface.embedded", "media.surface.ui-library"];
  if (phase === "PDP-2") return ["media.surface.web", "media.surface.embedded", "media.surface.ui-library"];
  if (phase === "PDP-0" || phase === "PDP-1") return [];
  return [];
}

const supportedAuthorityClasses = Object.freeze([
  "CROSS_PHASE_GOVERNANCE",
  "EXPLORER_PROJECTION",
  "PRODUCT_TRUTH_AUTHORITY",
  "DOMAIN_DATA_AUTHORITY",
  "DESIGN_INTERFACE_AUTHORITY",
  "PRODUCT_EXPERIENCE_AUTHORITY",
]);

/**
 * Parse the deliberately small YAML profile used by artifact-identities.yaml.
 * Supported syntax is block mappings/sequences with JSON-quoted identity
 * scalars; comments, aliases, tags, flow collections, and block scalars are
 * rejected. This avoids ambiguous YAML features while remaining dependency-free.
 */
export function parseArtifactIdentityRegistry(source) {
  const root = new Map();
  const policy = new Map();
  const projection = new Map();
  const records = [];
  const authorityClasses = [];
  let section = "";
  let currentRecord = undefined;
  let recordFields = new Set();

  const addUnique = (map, key, value, location) => {
    if (map.has(key)) throw new Error(`Duplicate YAML key '${key}' in ${location}.`);
    map.set(key, value);
  };
  const parseScalar = (raw, location, requireQuoted = false) => {
    const value = raw.trim();
    if (!value || value.includes("\t") || value.startsWith("#") || /\s+#/u.test(value)) {
      throw new Error(`Malformed scalar in ${location}.`);
    }
    if (value.startsWith('"')) {
      let parsed;
      try { parsed = JSON.parse(value); } catch { throw new Error(`Malformed JSON-quoted YAML scalar in ${location}.`); }
      if (typeof parsed !== "string" || !parsed) throw new Error(`Expected a non-empty string in ${location}.`);
      return parsed;
    }
    if (requireQuoted || /^[\[\]{}&*!|>%@`]/u.test(value) || /:\s/u.test(value)) {
      throw new Error(`Unsupported YAML scalar syntax in ${location}; quote strings with JSON double quotes.`);
    }
    return value;
  };

  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const lineNumber = index + 1;
    if (!line.trim()) continue;
    if (line.includes("\t") || line.startsWith("#") || /\s+#/u.test(line)) {
      throw new Error(`Unsupported tab/comment syntax at artifact-identities.yaml:${lineNumber}.`);
    }

    const top = line.match(/^([A-Za-z][A-Za-z0-9]*):(?:\s+(.*))?$/u);
    if (top) {
      const [, key, raw = ""] = top;
      addUnique(root, key, raw, "top level");
      section = key;
      currentRecord = undefined;
      if (["schemaVersion", "status", "purpose"].includes(key)) {
        root.set(key, parseScalar(raw, `line ${lineNumber}`));
      } else if (["inventoryPolicy", "manifestProjection", "allowedAuthorityClasses", "records"].includes(key)) {
        if (raw) throw new Error(`Section '${key}' must not have an inline value at line ${lineNumber}.`);
      } else {
        throw new Error(`Unknown top-level field '${key}' at line ${lineNumber}.`);
      }
      continue;
    }

    if (section === "inventoryPolicy" || section === "manifestProjection") {
      const entry = line.match(/^  ([A-Za-z][A-Za-z0-9]*): (.+)$/u);
      if (!entry) throw new Error(`Malformed ${section} entry at line ${lineNumber}.`);
      const [, key, raw] = entry;
      const target = section === "inventoryPolicy" ? policy : projection;
      addUnique(target, key, parseScalar(raw, `line ${lineNumber}`), section);
      continue;
    }

    if (section === "allowedAuthorityClasses") {
      const item = line.match(/^  - (.+)$/u);
      if (!item) throw new Error(`Malformed authorityClass vocabulary entry at line ${lineNumber}.`);
      const value = parseScalar(item[1], `line ${lineNumber}`, true);
      if (authorityClasses.includes(value)) throw new Error(`Duplicate allowedAuthorityClasses value '${value}'.`);
      authorityClasses.push(value);
      continue;
    }

    if (section === "records") {
      const first = line.match(/^  - path: (.+)$/u);
      if (first) {
        currentRecord = { path: parseScalar(first[1], `line ${lineNumber}`, true) };
        records.push(currentRecord);
        recordFields = new Set(["path"]);
        continue;
      }
      const field = line.match(/^    ([A-Za-z][A-Za-z0-9]*): (.+)$/u);
      if (!field || !currentRecord) throw new Error(`Malformed artifact identity record at line ${lineNumber}.`);
      const [, key, raw] = field;
      if (!["artifactId", "authorityClass"].includes(key)) throw new Error(`Unknown artifact identity field '${key}' at line ${lineNumber}.`);
      if (recordFields.has(key)) throw new Error(`Duplicate YAML key '${key}' in artifact record at line ${lineNumber}.`);
      recordFields.add(key);
      currentRecord[key] = parseScalar(raw, `line ${lineNumber}`, true);
      continue;
    }

    throw new Error(`Unexpected or malformed YAML at artifact-identities.yaml:${lineNumber}.`);
  }

  const exactKeys = (map, expected, label) => {
    const actual = [...map.keys()].sort();
    const wanted = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      throw new Error(`${label} fields must be exactly: ${wanted.join(", ")}.`);
    }
  };
  exactKeys(root, ["schemaVersion", "status", "purpose", "inventoryPolicy", "allowedAuthorityClasses", "manifestProjection", "records"], "Registry");
  exactKeys(policy, ["locationMetadata", "identityPolicy", "classificationPolicy", "selfExclusion"], "inventoryPolicy");
  exactKeys(projection, ["path", "artifactId", "authorityClass"], "manifestProjection");
  if (root.get("schemaVersion") !== "media.artifact-identities.v1") throw new Error("Unsupported artifact identity registry schemaVersion.");
  if (!records.length || !authorityClasses.length) throw new Error("Artifact identity records and allowedAuthorityClasses must be non-empty.");
  for (const [index, record] of records.entries()) {
    if (!record.artifactId || !record.authorityClass || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["artifactId", "authorityClass", "path"])) {
      throw new Error(`Artifact identity record ${index + 1} must contain exactly path, artifactId, and authorityClass.`);
    }
  }
  return { records, authorityClasses, manifestProjection: Object.fromEntries(projection), inventoryPolicy: Object.fromEntries(policy) };
}

export function validateArtifactIdentities(records, sourcePaths, authorityClasses = supportedAuthorityClasses, manifestProjection = undefined) {
  const byPath = new Map();
  const ids = new Set();
  const allowed = new Set(authorityClasses);
  if (!allowed.size || allowed.size !== authorityClasses.length) throw new Error("Allowed authorityClass vocabulary must be non-empty and unique.");
  for (const record of records) {
    if (!record.path || !record.artifactId || !record.authorityClass) {
      throw new Error("Every artifact identity requires path, artifactId, and authorityClass.");
    }
    if (byPath.has(record.path)) throw new Error(`Duplicate artifact identity path: ${record.path}`);
    if (ids.has(record.artifactId)) throw new Error(`Duplicate artifactId: ${record.artifactId}`);
    if (!allowed.has(record.authorityClass)) throw new Error(`Unknown authorityClass '${record.authorityClass}' for ${record.path}.`);
    byPath.set(record.path, record);
    ids.add(record.artifactId);
  }
  const missing = sourcePaths.filter((path) => !byPath.has(path));
  const stale = [...byPath.keys()].filter((path) => !sourcePaths.includes(path));
  if (missing.length || stale.length) {
    throw new Error(`Artifact identity coverage mismatch; missing: ${missing.join(", ") || "none"}; stale: ${stale.join(", ") || "none"}`);
  }
  if (manifestProjection) {
    if (!manifestProjection.path || !manifestProjection.artifactId || !manifestProjection.authorityClass) {
      throw new Error("Manifest projection identity requires path, artifactId, and authorityClass.");
    }
    if (ids.has(manifestProjection.artifactId)) throw new Error(`Manifest projection artifactId collides with a source artifactId: ${manifestProjection.artifactId}`);
    if (!allowed.has(manifestProjection.authorityClass)) throw new Error(`Unknown authorityClass '${manifestProjection.authorityClass}' for manifest projection.`);
  }
  return byPath;
}

function yamlScalar(value) {
  return JSON.stringify(value);
}

function repositoryObservation(repositoryId, relativeRoot, files) {
  const repositoryRoot = resolve(root, relativeRoot);
  if (!existsSync(join(repositoryRoot, ".git"))) {
    return { repositoryId, available: false, revision: null, workingTree: "UNAVAILABLE", files: [] };
  }
  const runGit = (args) => execFileSync("git", ["-C", repositoryRoot, ...args], { encoding: "utf8" }).trim();
  const revision = runGit(["rev-parse", "HEAD"]);
  const workingTree = runGit(["status", "--porcelain", "--untracked-files=no"]).length ? "MODIFIED" : "CLEAN";
  const observedFiles = files.flatMap(({ path, packageName }) => {
    const absolutePath = join(repositoryRoot, path);
    if (!existsSync(absolutePath)) return [{ path, package: packageName, state: "UNAVAILABLE" }];
    const bytes = readFileSync(absolutePath);
    const record = { path, sha256: sha256(bytes) };
    if (packageName && path.endsWith("package.json")) {
      try { record.version = JSON.parse(bytes.toString("utf8")).version ?? null; }
      catch { record.version = "INVALID_PACKAGE_JSON"; }
      record.package = packageName;
    }
    return [record];
  });
  return { repositoryId, available: true, revision, workingTree, files: observedFiles };
}

const externalOwnerObservations = [
  repositoryObservation("ghatana", "../ghatana", [
    { path: "config/repo-boundary.json" },
    { path: "config/service-contract-source.json" },
    { path: "services/media/service-contract.yaml" },
    { path: "services/media/service-contract-supplements/source-overlay.json" },
  ]),
  repositoryObservation("ghatana-tools", "../ghatana-tools", [
    { packageName: "@ghatana/product-definition", path: "libs/product-development/product-definition/package.json" },
    { path: "libs/product-development/product-definition/schemas/product-definition.v1.schema.json" },
    { packageName: "@ghatana/experience-language", path: "libs/product-development/experience-language/package.json" },
    { path: "libs/product-development/experience-language/schemas/experience-language.v1.schema.json" },
    { packageName: "@ghatana/experience-specification", path: "libs/product-development/experience-specification/package.json" },
    { path: "libs/product-development/experience-specification/schemas/experience-specification.v1.schema.json" },
    { packageName: "@ghatana/experience-package", path: "libs/product-development/experience-package/package.json" },
    { packageName: "@ghatana/product-dev-explorer", path: "tools/product-development/explorer/package.json" },
  ]),
  repositoryObservation("ghatana-lifecycle", "../ghatana-lifecycle", [
    { packageName: "@ghatana/lifecycle", path: "package.json" },
    { path: "scripts/checks/check-pdp-acceptance.mjs" },
  ]),
  repositoryObservation("ghatana-shared", "../ghatana-shared", [
    { packageName: "@ghatana/tokens", path: "platform/typescript/tokens/package.json" },
    { path: "platform/typescript/tokens/src/semantic-roles.ts" },
    { packageName: "@ghatana/theme", path: "platform/typescript/theme/package.json" },
    { packageName: "@ghatana/design-system", path: "platform/typescript/design-system/package.json" },
  ]),
];

function generate() {
const identitySource = readFileSync(identityRegistryPath, "utf8");
const registry = parseArtifactIdentityRegistry(identitySource);
const relativeFiles = walk(productRoot)
  .map((path) => relative(root, path).replaceAll("\\", "/"))
  .filter((path) => path !== ".product-experience/source-manifest.yaml" && path !== ".product-experience/artifact-identities.yaml")
  .sort();
const identities = validateArtifactIdentities(registry.records, relativeFiles, registry.authorityClasses, registry.manifestProjection);
const manifestProjectionRecord = registry.manifestProjection;
const artifactIdByPath = new Map([...identities].map(([path, identity]) => [path, identity.artifactId]));
const sourceByPath = new Map(relativeFiles.map((path) => [path, readFileSync(join(root, path), "utf8")]));
const dependenciesByPath = new Map(relativeFiles.map((sourcePath) => {
  const source = sourceByPath.get(sourcePath);
  const dependencies = relativeFiles
    .filter((targetPath) => targetPath !== sourcePath && source.includes(targetPath))
    .map((targetPath) => artifactIdByPath.get(targetPath))
    .filter(Boolean)
    .sort();
  return [sourcePath, dependencies];
}));
const dependentsByPath = new Map(relativeFiles.map((path) => [path, []]));
for (const [sourcePath, dependencies] of dependenciesByPath) {
  for (const targetId of dependencies) {
    const targetPath = relativeFiles.find((path) => artifactIdByPath.get(path) === targetId);
    if (targetPath) dependentsByPath.get(targetPath).push(artifactIdByPath.get(sourcePath));
  }
}
const records = relativeFiles.map((path) => {
  const phase = phaseFor(path);
  const source = readFileSync(join(root, path), "utf8");
  const identity = identities.get(path);
  return {
    artifactId: identity.artifactId,
    title: titleFor(path),
    owner: phase === "EXPLORER" ? "ghatana-media-explorer-owners" : "ghatana-media-product-owners",
    authorityClass: identity.authorityClass,
    owningPhase: phase,
    path,
    surfaceIds: surfacesFor(path, phase),
    semanticStatus: "PROPOSAL_PENDING_OWNER_REVIEW",
    generatedOrAuthored: "AUTHORED",
    generatedFrom: ["canonical-source-file"],
    schema: `${phase.toLowerCase().replaceAll("-", ".")}.artifact.v1`,
    verification: "LOCAL_STRUCTURE_ONLY_NATIVE_CURRENTNESS_PENDING",
    acceptanceState: "PENDING_OWNER_REVIEW",
    explorerProjection: phase === "EXPLORER" ? "DIRECT_EXPLORER_ARTIFACT" : "SPECIFICATION_SOURCE_RECORD",
    semanticFingerprint: {
      status: "PENDING_OWNER_APPROVED_TOOLS_GENERATION",
      value: null,
      contentSha256: sha256(source),
      contentFingerprintSemantics: "Exact file bytes for provenance only; not semantic currentness or acceptance.",
    },
    dependencies: dependenciesByPath.get(path),
    dependents: dependentsByPath.get(path).sort(),
    legacyPlanTaskRefs: [],
  };
});
const lines = [
  "schemaVersion: media.source-manifest.v2",
  "productId: media",
  "authorityModel:",
  "  canonicalPdpPhases: [PDP-0, PDP-1, PDP-2, PDP-3]",
  "  explorerOutsidePdpPhases: true",
  "  canonicalLocationPolicy: repository-relative-only",
  "  semanticFingerprintAuthority: ghatana-lifecycle-owner-generated",
  "  currentnessAuthority: ghatana-lifecycle-owner-generated",
  "migrationReference:",
  "  title: Ghatana Media — Expert-Reviewed Master Plan",
  "  path: docs/migration/expert-reviewed-master-plan.md",
  "  classification: REFERENCE",
  "  executionRole: MIGRATION_EXECUTION_PLAN",
  "  semanticAuthority: false",
  "externalOwnerObservations:",
  "  status: SOURCE_OBSERVATION_ONLY; not-schema-validation-or-semantic-currentness",
  "  repositories:",
];

for (const observation of externalOwnerObservations) {
  lines.push(`  - repositoryId: ${observation.repositoryId}`);
  lines.push(`    available: ${observation.available}`);
  lines.push(`    revision: ${observation.revision ?? "UNAVAILABLE"}`);
  lines.push(`    workingTree: ${observation.workingTree}`);
  lines.push("    files:");
  if (!observation.files.length) lines.push("      []");
  for (const file of observation.files) {
    lines.push("      - path: " + yamlScalar(file.path));
    if (file.package) lines.push("        package: " + yamlScalar(file.package));
    if (file.version) lines.push("        version: " + yamlScalar(file.version));
    if (file.sha256) lines.push(`        sha256: ${file.sha256}`);
    if (file.state) lines.push(`        state: ${file.state}`);
  }
}

lines.push(
  "supplementalDecisionReference:",
  "  title: Document Intelligence ownership instruction",
  "  path: docs/migration/decisions/MDI-001-document-intelligence-ownership.md",
  "  classification: ACCEPTED_USER_SCOPE_OVERLAY",
  "productArtifactIndex:",
  "  status: generated-portable-index; semantic-fingerprints-and-generated-currentness-pending",
  "  authoritySource: .product-experience/authority-map.yaml",
  "  taskDependencySource: .product-experience/traceability.yaml",
  "  generator: scripts/generate-media-product-manifest.mjs",
  "  records:",
);

for (const record of records) {
  lines.push(`  - artifactId: ${record.artifactId}`);
  lines.push(`    title: ${yamlScalar(record.title)}`);
  lines.push(`    owner: ${record.owner}`);
  lines.push(`    authorityClass: ${record.authorityClass}`);
  lines.push(`    owningPhase: ${record.owningPhase}`);
  lines.push(`    path: ${record.path}`);
  lines.push(`    surfaceIds: [${record.surfaceIds.join(", ")}]`);
  lines.push(`    semanticStatus: ${record.semanticStatus}`);
  lines.push(`    generatedOrAuthored: ${record.generatedOrAuthored}`);
  lines.push("    generatedFrom:");
  for (const value of record.generatedFrom) lines.push(`    - ${value}`);
  const dependencies = record.dependencies;
  const dependents = record.dependents;
  lines.push("    dependencyBasis: explicit-repository-relative-source-path-mentions; provenance-only");
  lines.push(`    dependencies: [${dependencies.join(", ")}]`);
  lines.push(`    dependents: [${dependents.join(", ")}]`);
  lines.push(`    schema: ${record.schema}`);
  lines.push(`    verification: ${record.verification}`);
  lines.push(`    acceptanceState: ${record.acceptanceState}`);
  lines.push(`    explorerProjection: ${record.explorerProjection}`);
  lines.push("    semanticFingerprint:");
  lines.push(`      status: ${record.semanticFingerprint.status}`);
  lines.push(`      contentSha256: ${record.semanticFingerprint.contentSha256}`);
  lines.push(`      contentFingerprintSemantics: ${yamlScalar(record.semanticFingerprint.contentFingerprintSemantics)}`);
  lines.push("    legacyPlanTaskRefs: []");
}

writeFileSync(manifestPath, `${lines.join("\n")}\n`);
writeFileSync(explorerIndexPath, `${JSON.stringify([...records.map(({ artifactId, authorityClass, owningPhase: phase, path, title }) => ({ artifactId, authorityClass, phase, path, title })), { ...manifestProjectionRecord, phase: "CROSS_PHASE", title: "Source Manifest" }], null, 2)}\n`);
console.log(`Generated ${records.length} manifest records and ${records.length + 1} Explorer records.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) generate();
