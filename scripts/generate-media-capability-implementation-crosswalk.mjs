#!/usr/bin/env node
/**
 * Generates docs/development/capability-implementation-crosswalk.v1.json —
 * the per-leaf implementation inventory for every PDP-0 capability intent.
 *
 * Classification rules (deliberately fail-closed; no fake success):
 *   OPTIONAL_DEFERRED — the leaf's authored scopeStatus is DEFERRED.
 *   IMPLEMENTED       — at least one linked register task is VERIFIED *and*
 *                       the task names the leaf's capability family (none
 *                       currently; durable-fence verifications are engineering
 *                       tasks, not capability completion).
 *   NOT_IMPLEMENTED   — default; carries exact blocking task references and
 *                       partial-code evidence paths so nothing is hidden.
 *   DELEGATED         — reserved for leaves whose intent executes wholly
 *                       outside Media by owner decision; Media-owned leaves
 *                       that consume platform dependencies record them under
 *                       delegatedDependencies instead.
 *
 * `--check` verifies the checked-in artifact is current; unknown or stale
 * classification fails the development audit.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const requireTools = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse: parseYaml } = requireTools("yaml");

const CAPABILITIES_PATH = ".product-experience/pdp-0-product-truth/capabilities.yaml";
const FAMILY_MAP_PATH = "docs/development/capability-family-implementation-map.yaml";
const REGISTER_PATH = "docs/development/remaining-work.json";
const ARTIFACT_PATH = "docs/development/capability-implementation-crosswalk.v1.json";
const LOCAL_EVIDENCE_PATH = "docs/development/capability-local-evidence.v1.json";

/**
 * Validates the optional per-leaf local-evidence overlay. Evidence is attached
 * beside the conservative classification and never changes it.
 */
export function loadLocalEvidence(repositoryRoot, leafIds) {
  const path = join(repositoryRoot, LOCAL_EVIDENCE_PATH);
  if (!existsSync(path)) return new Map();
  const overlay = JSON.parse(readFileSync(path, "utf8"));
  const statuses = new Set(Object.keys(overlay.statusVocabulary ?? {}));
  const known = new Set(leafIds);
  const byLeaf = new Map();
  for (const entry of overlay.entries ?? []) {
    const id = entry.capabilityId;
    if (!known.has(id)) throw new Error(`local evidence names unknown capability leaf: ${id}`);
    if (byLeaf.has(id)) throw new Error(`duplicate local evidence entry: ${id}`);
    if (!statuses.has(entry.status)) throw new Error(`local evidence ${id} has unknown status ${entry.status}`);
    if (!Array.isArray(entry.tests) || entry.tests.length === 0) throw new Error(`local evidence ${id} cites no tests`);
    for (const test of entry.tests) {
      if (!existsSync(join(repositoryRoot, test))) throw new Error(`local evidence ${id} cites missing test ${test}`);
    }
    if (!Array.isArray(entry.operations) || entry.operations.length === 0) throw new Error(`local evidence ${id} names no operation`);
    if (!Array.isArray(entry.gaps)) throw new Error(`local evidence ${id} must list gaps (possibly empty)`);
    if (entry.status === "LOCAL_DEV_ONLY_PARTIAL" && entry.gaps.length === 0) {
      throw new Error(`partial local evidence ${id} must name its gaps`);
    }
    byLeaf.set(id, { status: entry.status, operations: entry.operations, tests: entry.tests, gaps: entry.gaps });
  }
  return byLeaf;
}

export function buildCrosswalk(repositoryRoot = root) {
  const capabilities = parseYaml(readFileSync(join(repositoryRoot, CAPABILITIES_PATH), "utf8"));
  const familyMap = parseYaml(readFileSync(join(repositoryRoot, FAMILY_MAP_PATH), "utf8"));
  const register = JSON.parse(readFileSync(join(repositoryRoot, REGISTER_PATH), "utf8"));
  const taskState = new Map(register.tasks.map((task) => [task.id, task.state]));

  const leafIds = capabilities.capabilities.map((leaf) => leaf.id);
  const localEvidence = loadLocalEvidence(repositoryRoot, leafIds);
  const deferredIds = new Set(capabilities.capabilities.filter((leaf) => leaf.scopeStatus === "DEFERRED").map((leaf) => leaf.id));

  const records = leafIds.map((id) => {
    const leaf = capabilities.capabilities.find((entry) => entry.id === id);
    const familyId = leaf.familyId;
    const family = familyMap.families[familyId];
    if (!family) {
      return { id, familyId, scopeStatus: leaf.scopeStatus, classification: "UNCLASSIFIED" };
    }
    const classification = deferredIds.has(id) ? "OPTIONAL_DEFERRED" : "NOT_IMPLEMENTED";
    const blockingTaskRefs = classification === "OPTIONAL_DEFERRED"
      ? []
      : [...new Set([...(familyMap.sharedBlockingTaskRefs ?? []), ...family.taskRefs])];
    return {
      id,
      familyId,
      scopeStatus: leaf.scopeStatus,
      classification,
      blockingTaskRefs,
      verifiedTaskRefs: blockingTaskRefs.filter((task) => taskState.get(task) === "VERIFIED"),
      evidenceRefs: family.evidenceRefs ?? [],
      delegatedDependencies: family.delegatedDependencies ?? [],
      ...(localEvidence.has(id) ? { localEvidence: localEvidence.get(id) } : {}),
    };
  });

  const summary = {};
  for (const record of records) summary[record.classification] = (summary[record.classification] ?? 0) + 1;
  return {
    schemaVersion: "media.capability-implementation-crosswalk.v1",
    purpose: "Per-leaf implementation inventory for every authored PDP-0 capability intent; classifications cite exact task/source links and never fabricate success.",
    sources: { capabilities: CAPABILITIES_PATH, familyMap: FAMILY_MAP_PATH, register: REGISTER_PATH, localEvidence: LOCAL_EVIDENCE_PATH },
    policy: {
      implemented: "requires a VERIFIED register task bound to the capability family",
      delegated: "reserved for wholly externally executed intents; Media leaves consuming platform dependencies use delegatedDependencies",
      unknownFailsAudit: "any leaf without a classification, or any family missing from the reviewed map, fails --check",
      localEvidence: "optional per-leaf test-backed DEV_ONLY evidence; never changes classification; unknown leaves, missing tests or partial entries without gaps fail generation",
    },
    summary: {
      leafCount: records.length,
      byClassification: summary,
      localEvidence: Object.fromEntries([...localEvidence.values()].reduce((counts, entry) =>
        counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1), new Map())),
    },
    externalOwnedDependencies: familyMap.externalOwnedDependencies,
    records,
  };
}

function main() {
  const artifact = buildCrosswalk();
  const rendered = `${JSON.stringify(artifact, null, 2)}\n`;
  const current = (() => { try { return readFileSync(join(root, ARTIFACT_PATH), "utf8"); } catch { return ""; } })();
  if (process.argv.includes("--check")) {
    const failures = [];
    if (current !== rendered) failures.push("checked-in crosswalk is stale; regenerate with node scripts/generate-media-capability-implementation-crosswalk.mjs");
    const unclassified = artifact.records.filter((record) => record.classification === "UNCLASSIFIED");
    if (unclassified.length) failures.push(`${unclassified.length} capability leaves unclassified: ${unclassified.map((r) => r.id).join(", ")}`);
    const taskIds = new Set(JSON.parse(readFileSync(join(root, REGISTER_PATH), "utf8")).tasks.map((t) => t.id));
    const missing = artifact.records.flatMap((record) => record.blockingTaskRefs.filter((id) => !taskIds.has(id)).map((id) => `${record.id}→${id}`));
    if (missing.length) failures.push(`blocking task refs missing from register: ${missing.join(", ")}`);
    const implemented = artifact.records.filter((record) => record.classification === "IMPLEMENTED" && !record.verifiedTaskRefs.length);
    if (implemented.length) failures.push(`IMPLEMENTED claims without VERIFIED task evidence: ${implemented.map((r) => r.id).join(", ")}`);
    if (failures.length) {
      failures.forEach((failure) => console.error(`FAIL: ${failure}`));
      process.exit(1);
    }
    console.log(`Capability implementation crosswalk: current (${artifact.summary.leafCount} leaves; ${artifact.summary.byClassification.NOT_IMPLEMENTED ?? 0} NOT_IMPLEMENTED, ${artifact.summary.byClassification.OPTIONAL_DEFERRED ?? 0} OPTIONAL_DEFERRED, ${artifact.summary.byClassification.IMPLEMENTED ?? 0} IMPLEMENTED, ${artifact.summary.byClassification.DELEGATED ?? 0} DELEGATED)`);
  } else {
    writeFileSync(join(root, ARTIFACT_PATH), rendered);
    console.log(`wrote ${ARTIFACT_PATH}: ${artifact.summary.leafCount} leaves (${JSON.stringify(artifact.summary.byClassification)})`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
