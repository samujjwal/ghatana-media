#!/usr/bin/env node
/**
 * Purpose: generate the portable Media Product Definition artifact manifest
 * and Explorer source index from the canonical four-PDP tree.
 * Consumers: local authority checks and the Media Explorer adapter.
 * Non-goals: Tools-native semantic fingerprints, currentness, acceptance,
 * qualification, release evidence, or manual readiness claims.
 * Change policy: update canonical source files first, then run this generator;
 * never hand-edit generated manifest/index output.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const productRoot = join(root, ".product-experience");
const manifestPath = join(productRoot, "source-manifest.yaml");
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

function authorityClassFor(phase) {
  return {
    "PDP-0": "PRODUCT_TRUTH_AUTHORITY",
    "PDP-1": "DOMAIN_DATA_AUTHORITY",
    "PDP-2": "DESIGN_INTERFACE_AUTHORITY",
    "PDP-3": "PRODUCT_EXPERIENCE_AUTHORITY",
    EXPLORER: "EXPLORER_PROJECTION",
    CROSS_PHASE: "CROSS_PHASE_GOVERNANCE",
  }[phase];
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

function stableArtifactId(path, priorIds) {
  if (priorIds.has(path)) return priorIds.get(path);
  const digest = sha256(path).slice(0, 12).toUpperCase();
  return `ART-MEDIA-${digest}`;
}

function readPriorIds() {
  if (!existsSync(manifestPath)) return new Map();
  const source = readFileSync(manifestPath, "utf8");
  const ids = new Map();
  for (const record of source.split(/\n  - artifactId:\s*/u).slice(1)) {
    const [id, ...rest] = record.split("\n");
    const path = rest.join("\n").match(/^    path:\s*(.+)$/mu)?.[1]?.trim();
    if (id && path) ids.set(path, id.trim());
  }
  return ids;
}

function yamlScalar(value) {
  return JSON.stringify(value);
}

const relativeFiles = walk(productRoot)
  .map((path) => relative(root, path).replaceAll("\\", "/"))
  .filter((path) => path !== ".product-experience/source-manifest.yaml")
  .sort();
const priorIds = readPriorIds();
const records = relativeFiles.map((path) => {
  const phase = phaseFor(path);
  const source = readFileSync(join(root, path), "utf8");
  const artifactId = stableArtifactId(path, priorIds);
  return {
    artifactId,
    title: titleFor(path),
    owner: phase === "EXPLORER" ? "ghatana-media-explorer-owners" : "ghatana-media-product-owners",
    authorityClass: authorityClassFor(phase),
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
    dependencies: [],
    dependents: [],
    legacyPlanTaskRefs: [],
  };
});
const manifestProjectionRecord = {
  phase: "CROSS_PHASE",
  path: ".product-experience/source-manifest.yaml",
  title: "Source Manifest",
  artifactId: "ART-MEDIA-SOURCE-MANIFEST",
};

const lines = [
  "schemaVersion: media.source-manifest.v2",
  "productId: media",
  "authorityModel:",
  "  canonicalPdpPhases: [PDP-0, PDP-1, PDP-2, PDP-3]",
  "  explorerOutsidePdpPhases: true",
  "  canonicalLocationPolicy: repository-relative-only",
  "  semanticFingerprintAuthority: ghatana-tools-owner-generated",
  "  currentnessAuthority: ghatana-tools-owner-generated",
  "migrationReference:",
  "  title: Ghatana Media — Expert-Reviewed Master Plan",
  "  path: docs/migration/expert-reviewed-master-plan.md",
  "  classification: REFERENCE",
  "  executionRole: MIGRATION_EXECUTION_PLAN",
  "  semanticAuthority: false",
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
];

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
  lines.push("    dependencies: []");
  lines.push("    dependents: []");
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
writeFileSync(explorerIndexPath, `${JSON.stringify([...records.map(({ owningPhase: phase, path, title }) => ({ phase, path, title })), manifestProjectionRecord], null, 2)}\n`);
console.log(`Generated ${records.length} manifest records and ${records.length + 1} Explorer records.`);
