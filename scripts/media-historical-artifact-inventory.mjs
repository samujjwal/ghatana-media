#!/usr/bin/env node
/**
 * Historical-artifact inventory for media.dev.historical-artifact-inventory.
 *
 * Read-only classification of every Git-tracked byte under the historical
 * prefixes (docs/implementation/, archive/, docs/migration/). For each path
 * records: sha256, byte size, kind (source | derived | record), inbound
 * reference count from other tracked text files, retention owner, and a
 * disposition (KEEP | EXTERNAL_ARCHIVE | REVIEW_DELETE). Nothing is deleted;
 * every REVIEW_DELETE requires owner review before any removal.
 *
 * Output: docs/implementation/historical-artifact-inventory.v1.json
 * Usage: node scripts/media-historical-artifact-inventory.mjs [--check]
 *   --check  read-only; exit 1 when the report is stale or any byte is unclassified.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkMode = process.argv.includes("--check");
const HISTORICAL_PREFIXES = ["docs/implementation/", "archive/", "docs/migration/"];
const OUTPUT = "docs/implementation/historical-artifact-inventory.v1.json";
const PRESERVATION = "docs/development/historical-content-preservation.json";
const BINARY_EXT = /\.(mov|mp4|m4a|wav|mp3|png|jpe?g|gif|webm|zip|gz|tar|jar|class|so|dylib|bin|pdf|woff2?|ico)$/iu;
const GENERATED_HINT = /(?:generated|projection|crosswalk|manifest|index|matrix|inventory|bridge|packages|readiness|trace)\.v?\d*\.json$/iu;

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "buffer" })
  .toString("utf8").split("\0").filter(Boolean).sort();
const inventory = tracked.filter((p) => HISTORICAL_PREFIXES.some((x) => p.startsWith(x)) && p !== OUTPUT);
const inventorySet = new Set(inventory);
const preservation = JSON.parse(readFileSync(resolve(root, PRESERVATION), "utf8"));
if (preservation.deletionApproved !== false || preservation.externalArchiveVerified !== false
  || !Array.isArray(preservation.artifacts) || preservation.total !== preservation.artifacts.length) {
  throw new Error("historical preservation decision is malformed or no longer fail-closed");
}
const pinnedCandidates = new Set();
for (const item of preservation.artifacts) {
  if (item.deleteApproved !== false || item.preservation !== "KEEP_IN_MAIN_PENDING_VERIFIED_IMMUTABLE_OFF_MAIN_COPY"
    || typeof item.path !== "string" || !inventorySet.has(item.path)) {
    throw new Error("historical preservation pin is not a tracked, deletion-unapproved candidate");
  }
  pinnedCandidates.add(item.path);
}
if (pinnedCandidates.size !== preservation.total) {
  throw new Error("historical preservation pins contain duplicate paths");
}
const byBasename = new Map();
for (const p of inventory) {
  const base = p.split("/").pop();
  if (!byBasename.has(base)) byBasename.set(base, []);
  byBasename.get(base).push(p);
}

// Inbound refs: scan every other tracked text file for basename mentions.
const inbound = new Map(inventory.map((p) => [p, 0]));
const NAME_TOKEN = /[A-Za-z0-9_.-]{10,}/g;
for (const path of tracked) {
  if (path === PRESERVATION || path === OUTPUT) continue;
  // The preservation manifest pins candidate identities, and this generated
  // inventory lists every path; neither is a semantic product reference.
  let text;
  try { text = readFileSync(resolve(root, path), "utf8"); } catch { continue; }
  if (text.includes("\0")) continue;              // binary
  const seen = new Set();
  for (const m of text.matchAll(NAME_TOKEN)) {
    const cand = byBasename.get(m[0]);
    if (!cand) continue;
    for (const target of cand) {
      if (target === path) continue; // A file does not reference itself.
      const key = `${path}->${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      inbound.set(target, inbound.get(target) + 1);
    }
  }
}

const RETENTION_OWNERS = {
  "docs/implementation/observations/": "owner-review-provenance",
  "docs/implementation/evidence/": "owner-review-provenance",
  "docs/implementation/verification/": "owner-review-provenance",
  "docs/migration/": "migration-provenance",
  "archive/": "compatibility-archive",
  "docs/implementation/": "implementation-planning",
};
const retentionOwner = (p) =>
  Object.entries(RETENTION_OWNERS).find(([k]) => p.startsWith(k))?.[1] ?? "implementation-planning";

function classify(path, size, refs) {
  const name = path.split("/").pop();
  let kind;
  if (BINARY_EXT.test(path)) kind = "record";                       // evidence/preimage bytes
  else if (path.startsWith("docs/implementation/observations/")) kind = "derived";
  else if (GENERATED_HINT.test(name)) kind = "derived";
  else if (path.startsWith("docs/implementation/verification/")) kind = "record";
  else if (path.endsWith(".md") || path.endsWith(".json") || path.endsWith(".yaml")) kind = "source";
  else kind = "record";

  if (pinnedCandidates.has(path)) {
    return {
      kind, disposition: "EXTERNAL_ARCHIVE",
      reason: "exact preservation pin is an off-main archive candidate; independent immutable readback and reference migration remain required before deletion",
    };
  }

  let disposition, reason;
  if (path.startsWith("archive/")) {
    disposition = "KEEP"; reason = "compatibility archive preserved by design";
  } else if (kind === "record" && size > 5 * 1024 * 1024 && refs === 0) {
    disposition = "EXTERNAL_ARCHIVE";
    reason = `large evidence/preimage (${(size / 1048576).toFixed(1)} MiB) with no inbound references — external storage candidate`;
  } else if (kind === "derived" && size > 5 * 1024 * 1024 && refs === 0) {
    disposition = "EXTERNAL_ARCHIVE";
    reason = "large derived projection with no inbound references — regenerable or externally archivable";
  } else if (refs > 0) {
    disposition = "KEEP"; reason = `${refs} inbound reference(s)`;
  } else {
    disposition = "KEEP"; reason = "tracked source/record byte; removal requires owner review";
  }
  return { kind, disposition, reason };
}

const rows = [];
let totalBytes = 0;
for (const path of inventory) {
  const abs = resolve(root, path);
  const buf = readFileSync(abs);
  const size = statSync(abs).size;
  totalBytes += size;
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const refs = inbound.get(path) ?? 0;
  const c = classify(path, size, refs);
  rows.push({
    path, bytes: size, sha256, kind: c.kind,
    inboundReferences: refs,
    retentionOwner: retentionOwner(path),
    disposition: c.disposition, reason: c.reason,
  });
}
rows.sort((a, b) => a.path.localeCompare(b.path));

const summary = {
  generated: new Date().toISOString(),
  historicalPrefixes: HISTORICAL_PREFIXES,
  totalTrackedHistoricalFiles: rows.length,
  totalTrackedHistoricalBytes: totalBytes,
  byDisposition: rows.reduce((m, r) => ((m[r.disposition] = (m[r.disposition] ?? 0) + 1), m), {}),
  byKind: rows.reduce((m, r) => ((m[r.kind] = (m[r.kind] ?? 0) + 1), m), {}),
  unclassified: rows.filter((r) => !r.disposition).length,
  policy: "read-only report; REVIEW_DELETE and EXTERNAL_ARCHIVE are owner-review candidates only — no unreviewed deletions",
};
const doc = { schemaVersion: "media.historical-artifact-inventory/v1", summary, artifacts: rows };

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

function inventoryComparable(value) {
  if (value === null || typeof value !== "object" || value.summary === null || typeof value.summary !== "object") {
    return null;
  }
  const comparable = { ...value, summary: { ...value.summary } };
  // Generation time is provenance only; it must not make a semantically current report stale.
  delete comparable.summary.generated;
  return canonicalize(comparable);
}

if (checkMode) {
  const outputPath = resolve(root, OUTPUT);
  let existing;
  try {
    existing = JSON.parse(readFileSync(outputPath, "utf8"));
  } catch {
    console.error(`HISTORICAL_INVENTORY_STALE: ${OUTPUT} is missing or invalid`);
    process.exitCode = 1;
  }
  if (existing !== undefined
      && JSON.stringify(inventoryComparable(existing)) !== JSON.stringify(inventoryComparable(doc))) {
    console.error(`HISTORICAL_INVENTORY_STALE: ${OUTPUT} does not match current tracked historical files`);
    process.exitCode = 1;
  }
  if (summary.unclassified > 0) {
    console.error(`HISTORICAL_INVENTORY_UNCLASSIFIED: ${summary.unclassified} tracked historical file(s)`);
    process.exitCode = 1;
  }
} else {
  writeFileSync(resolve(root, OUTPUT), JSON.stringify(doc, null, 2) + "\n");
}
console.log(JSON.stringify(summary, null, 2));
