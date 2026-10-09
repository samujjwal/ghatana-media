import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const source = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/nonfunctional-requirements.yaml"), "utf8"));

const requirements = new Map(source.requirements.map((row) => [row.id, row]));
const protocols = source.ownerMeasurementDefinitions.records;
const protocolByRequirement = new Map(protocols.map((row) => [row.requirementRef, row]));
const requiredFields = ["metric", "unit", "scope", "samplePopulation", "protocol", "invalidOrAbstain", "requiredEvidence", "observationStatus", "sourceRefs"];

function validateDefinition(doc) {
  const rows = doc.ownerMeasurementDefinitions?.records;
  if (!Array.isArray(rows)) return ["records must be an array"];
  const errors = [];
  const seen = new Set();
  const requirementRefs = new Set();
  for (const row of rows) {
    if (!row.id || seen.has(row.id)) errors.push(`missing or duplicate id: ${row.id}`);
    seen.add(row.id);
    for (const field of requiredFields) {
      if (row[field] === undefined || row[field] === null || row[field] === "" || (Array.isArray(row[field]) && row[field].length === 0)) {
        errors.push(`${row.id}: missing ${field}`);
      }
    }
    if (!requirements.has(row.requirementRef)) errors.push(`${row.id}: unknown requirementRef`);
    if (requirementRefs.has(row.requirementRef)) errors.push(`${row.id}: duplicate requirementRef`);
    requirementRefs.add(row.requirementRef);
    if (row.observationStatus !== "NOT_EVALUATED") errors.push(`${row.id}: definition cannot promote observation status`);
    if (!row.samplePopulation?.include || !row.samplePopulation?.exclude) errors.push(`${row.id}: include/exclude population required`);
    if (!Array.isArray(row.protocol) || row.protocol.some((step) => typeof step !== "string" || !step.trim())) errors.push(`${row.id}: protocol steps must be nonempty prose`);
    if (!Array.isArray(row.sourceRefs) || row.sourceRefs.some((ref) => typeof ref !== "string" || !ref.startsWith(".product-experience/"))) errors.push(`${row.id}: sourceRefs must be repository references`);
  }
  if (requirementRefs.size !== requirements.size || [...requirements.keys()].some((id) => !requirementRefs.has(id))) errors.push("methods must reference every NFR exactly once");
  const perf = rows.find((row) => row.requirementRef === "NFR-PERF-001");
  const perfRequirement = doc.requirements.find((row) => row.id === "NFR-PERF-001");
  if (perf && perfRequirement) {
    const expectedBudgets = new Set((perfRequirement.initialProposedBudgets ?? []).map((budget) => budget.id));
    const mappedBudgets = (perf.surfaceProtocols ?? []).map((surface) => surface.proposedBudgetRef);
    if (mappedBudgets.length !== expectedBudgets.size || new Set(mappedBudgets).size !== mappedBudgets.length || mappedBudgets.some((id) => !expectedBudgets.has(id))) errors.push("performance surface protocols must map each proposed budget exactly once");
    if (!perf.latencyPopulationRule || !/every initiated operation/.test(perf.latencyPopulationRule) || !/cannot pass/.test(perf.latencyPopulationRule)) errors.push("performance initiation denominator and unknown-timing rule required");
    if (!perf.quantileRule || !/ceil\(0\.95\*N\)-1/.test(perf.quantileRule)) errors.push("performance quantile rule required");
    if ((perf.surfaceProtocols ?? []).some((surface) => !surface.startBoundary || !surface.endBoundary || !surface.load)) errors.push("each performance surface needs exact boundaries and load");
  }
  return errors;
}

const sourceDocumentCache = new Map();
function resolveSourceRef(reference) {
  const hashAt = reference.indexOf("#");
  if (hashAt < 1 || hashAt === reference.length - 1) return { ok: false, reason: "reference requires a file and stable fragment" };
  const sourcePath = reference.slice(0, hashAt);
  const fragment = reference.slice(hashAt + 1);
  if (!sourcePath.startsWith(".product-experience/") || sourcePath.includes("..")) return { ok: false, reason: "reference must stay within Product Experience sources" };
  let doc = sourceDocumentCache.get(sourcePath);
  if (!doc) {
    try {
      doc = parse(readFileSync(resolve(root, sourcePath), "utf8"));
      sourceDocumentCache.set(sourcePath, doc);
    } catch {
      return { ok: false, reason: `missing or invalid YAML source ${sourcePath}` };
    }
  }
  let value = doc;
  for (const segment of fragment.split("/")) {
    if (!segment || value === null || value === undefined) return { ok: false, reason: `unresolvable fragment ${fragment}` };
    if (Array.isArray(value)) value = value.find((item) => item && (item.id === segment || item.machineId === segment));
    else if (typeof value === "object" && Object.hasOwn(value, segment)) value = value[segment];
    else value = undefined;
  }
  return value === undefined ? { ok: false, reason: `unresolvable fragment ${fragment}` } : { ok: true, value };
}

test("every declared NFR has one complete owner measurement method without implying observation or acceptance", () => {
  assert.equal(requirements.size, 14);
  assert.equal(protocols.length, requirements.size);
  assert.deepEqual(validateDefinition(source), []);
  for (const [id, requirement] of requirements) {
    const method = protocolByRequirement.get(id);
    assert.ok(method, `${id} has a method`);
    assert.match(method.id, /^media\.nfr-measurement\./);
    assert.match(method.unit, /\S/);
    assert.match(method.scope, /\S/);
    assert.equal(method.observationStatus, "NOT_EVALUATED");
    assert.match(requirement.acceptance, /\S/);
    for (const ref of method.sourceRefs) assert.equal(resolveSourceRef(ref).ok, true, `${id} sourceRef resolves: ${ref}`);
  }
});

test("performance method binds all six proposed budgets while preserving unnamed environments as a gate", () => {
  const method = protocolByRequirement.get("NFR-PERF-001");
  const perf = requirements.get("NFR-PERF-001");
  assert.equal(perf.initialProposedBudgets.length, 6);
  const budgetIds = perf.initialProposedBudgets.map((budget) => budget.id);
  const surfaceProtocolIds = method.surfaceProtocols.map((surface) => surface.proposedBudgetRef);
  assert.deepEqual(new Set(budgetIds), new Set(surfaceProtocolIds));
  assert.equal(new Set(budgetIds).size, 6);
  assert.ok(method.surfaceProtocols.every((surface) => surface.startBoundary && surface.endBoundary && surface.load));
  assert.match(method.latencyPopulationRule, /every initiated operation/);
  assert.match(method.latencyPopulationRule, /missing\/unknown timing.*cannot pass/);
  assert.match(method.quantileRule, /ceil\(0\.95\*N\)-1/);
  assert.match(method.protocol.join(" "), /30 warm-up observations.*1000 initiated measured operations/);
  assert.ok(method.surfaceProtocols.some((surface) => surface.load.includes("five measured minutes")));
  assert.ok(perf.initialProposedBudgets.every((budget) => budget.environment === "not-yet-named"));
  assert.match(method.invalidOrAbstain, /not-yet-named/);
  assert.equal(method.observationStatus, "NOT_EVALUATED");
});

test("missing method material and attempted qualification promotion fail validation", () => {
  const missingPopulation = structuredClone(source);
  delete missingPopulation.ownerMeasurementDefinitions.records[0].samplePopulation.exclude;
  assert.ok(validateDefinition(missingPopulation).some((error) => error.includes("include/exclude population required")));

  const missingEvidence = structuredClone(source);
  missingEvidence.ownerMeasurementDefinitions.records[1].requiredEvidence = [];
  assert.ok(validateDefinition(missingEvidence).some((error) => error.includes("missing requiredEvidence")));

  const promoted = structuredClone(source);
  promoted.ownerMeasurementDefinitions.records[2].observationStatus = "QUALIFIED";
  assert.ok(validateDefinition(promoted).some((error) => error.includes("definition cannot promote observation status")));

  const omittedNfr = structuredClone(source);
  omittedNfr.ownerMeasurementDefinitions.records.pop();
  assert.ok(validateDefinition(omittedNfr).some((error) => error.includes("methods must reference every NFR exactly once")));

  const duplicateRequirementSameCount = structuredClone(source);
  duplicateRequirementSameCount.ownerMeasurementDefinitions.records[13].requirementRef = duplicateRequirementSameCount.ownerMeasurementDefinitions.records[0].requirementRef;
  assert.ok(validateDefinition(duplicateRequirementSameCount).some((error) => error.includes("duplicate requirementRef")));
  assert.ok(validateDefinition(duplicateRequirementSameCount).some((error) => error.includes("methods must reference every NFR exactly once")));

  const forgedSource = structuredClone(source);
  forgedSource.ownerMeasurementDefinitions.records[0].sourceRefs[1] = ".product-experience/pdp-1-domain-data/not-a-source.yaml#invented";
  assert.equal(resolveSourceRef(forgedSource.ownerMeasurementDefinitions.records[0].sourceRefs[1]).ok, false);
  forgedSource.ownerMeasurementDefinitions.records[0].sourceRefs[1] = ".product-experience/pdp-1-domain-data/operations.yaml#inventedStableField";
  assert.equal(resolveSourceRef(forgedSource.ownerMeasurementDefinitions.records[0].sourceRefs[1]).ok, false);

  const missingPerfSurface = structuredClone(source);
  missingPerfSurface.ownerMeasurementDefinitions.records.find((row) => row.requirementRef === "NFR-PERF-001").surfaceProtocols.pop();
  assert.ok(validateDefinition(missingPerfSurface).some((error) => error.includes("performance surface protocols must map each proposed budget exactly once")));
});

test("SLO and human/specialist methods remain gated on their real external evidence", () => {
  const slo = protocolByRequirement.get("NFR-SLO-001");
  assert.match(slo.invalidOrAbstain, /service owner names and approves/);
  assert.equal(requirements.get("NFR-SLO-001").status, "open-owner-decision");
  assert.equal(protocolByRequirement.get("NFR-SIMPLE-001").observationStatus, "NOT_EVALUATED");
  assert.equal(protocolByRequirement.get("NFR-FIDELITY-001").observationStatus, "NOT_EVALUATED");
  assert.match(protocolByRequirement.get("NFR-FIDELITY-001").invalidOrAbstain, /owner, model\/solver/);
});
