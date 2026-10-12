import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const artifactPath = "docs/implementation/verification/pdp-38/migration-p2-97-owner-review-candidate.json";
const artifact = JSON.parse(readFileSync(resolve(root, artifactPath), "utf8"));
const currentOwnerObservations = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/migration-current-owner-target-observations.json"), "utf8"));
const partitionPath = "docs/implementation/verification/pdp-38/migration-pending-owner-partition-499.json";
const partition = JSON.parse(readFileSync(resolve(root, partitionPath), "utf8"));
const yamlCache = new Map();
const jsonSha256 = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const textSha256 = (value) => createHash("sha256").update(value).digest("hex");

function resolveExactRef(ref) {
  const [file, pointer] = ref.split("#");
  if (!yamlCache.has(file)) yamlCache.set(file, parse(readFileSync(resolve(root, file), "utf8")));
  return pointer.split("/").filter(Boolean).reduce((value, rawToken) => {
    const token = rawToken.replace(/~1/gu, "/").replace(/~0/gu, "~");
    const byId = token.match(/^@id=(.+)$/u);
    if (byId) return Array.isArray(value) ? value.find((row) => row?.id === byId[1]) : undefined;
    if (Array.isArray(value) && /^\d+$/u.test(token)) return value[Number(token)];
    return value?.[token];
  }, yamlCache.get(file));
}

function removeClause(value, clause) {
  if (typeof value === "string") return value.replaceAll(clause, "[material clause removed]");
  if (Array.isArray(value)) return value.map((item) => removeClause(item, clause));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key.replaceAll(clause, "removed-material-key"), removeClause(item, clause),
    ]));
  }
  return value;
}

function materialMatch(value, clauses) {
  const serialized = JSON.stringify(value);
  return clauses.every((clause) => serialized.includes(clause));
}

test("PDP-2 candidate is the complete exact 97-claim pending partition with immutable claim text", () => {
  const current = partition.records.filter(({ sourceOwnerPhase }) => sourceOwnerPhase === "PDP-2");
  const rows = artifact.records;
  assert.equal(artifact.cohort.pendingLeafClaims, 97);
  assert.equal(artifact.cohort.normativeOrInterfaceDefinitionRoutes, 96);
  assert.equal(artifact.cohort.historicalExternalSourceFact, 1);
  assert.equal(artifact.cohort.approvalStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.equal(rows.length, 97);
  assert.equal(current.length, 97);
  assert.equal(new Set(rows.map(({ claimId }) => claimId)).size, 97);
  assert.deepEqual(new Set(rows.map(({ claimId }) => claimId)), new Set(current.map(({ claimId }) => claimId)));
  const currentById = new Map(current.map((row) => [row.claimId, row]));
  for (const row of rows) {
    const source = currentById.get(row.claimId);
    assert.equal(row.exactSourceText, source.exactSourceText, `${row.claimId} preserves exact source claim text`);
    assert.equal(row.sourceTextSha256, source.sourceTextSha256, `${row.claimId} preserves its source text hash`);
    assert.equal(row.previousTargetRef, source.currentTargetRef, `${row.claimId} preserves the pre-candidate owner locator`);
    assert.equal(row.semanticDisposition.includes("PENDING_COORDINATOR"), true);
    assert.equal(row.acceptanceEffect, "none");
    assert.equal(row.independentAcceptance, "NOT_CLAIMED");
  }
});

test("current normative routes resolve to current source values and reject every material-clause deletion", () => {
  const rows = artifact.records.filter(({ claimId }) => !["MPSEM-0458-C001", "MPSEM-0034-C001"].includes(claimId));
  assert.equal(rows.length, 95);
  for (const row of rows) {
    assert.ok(row.proposedTargetRef.includes("#"), `${row.claimId} uses an exact source selector`);
    assert.ok(row.exactMaterialClauses.length > 0, `${row.claimId} has complete material predicates`);
    assert.equal(row.negativeCases.length, row.exactMaterialClauses.length + 2);
    const currentValue = resolveExactRef(row.proposedTargetRef);
    assert.notEqual(currentValue, undefined, `${row.claimId} target resolves with literal YAML selector semantics`);
    if (row.claimId === "MPSEM-0042-C003") {
      assert.match(currentValue.registryCoverageRule, /one unique command ID in the finite Media command registry/u);
      assert.match(currentValue.registryCoverageRule, /sole source for help\/completion/u);
      assert.match(currentValue.registryCoverageRule, /No command or alias may be inferred/u);
      assert.match(currentValue.currentPopulation, /47 finite command identities/u);
      assert.match(currentValue.currentPopulation, /machine-only disposition/u);
      assert.match(currentValue.scopeStatus, /NOT_ADMITTED/u);
    }
    assert.equal(jsonSha256(row.targetValue), row.targetValueSha256, `${row.claimId} immutable target snapshot hash is valid`);
    assert.equal(materialMatch(row.targetValue, row.exactMaterialClauses), true,
      `${row.claimId} historical review snapshot preserves its exact material clauses`);
    for (const clause of row.exactMaterialClauses) {
      assert.equal(materialMatch(removeClause(structuredClone(row.targetValue), clause), row.exactMaterialClauses), false,
        `${row.claimId} historical review snapshot rejects removal of ${clause}`);
    }
    const observation = currentOwnerObservations.records.find(({ claimId }) => claimId === row.claimId);
    if (observation) {
      assert.equal(observation.historicalTargetTextSha256 ?? observation.reportedReviewTargetValueSha256, row.targetValueSha256,
        `${row.claimId} observation links the immutable candidate target hash`);
      assert.equal(jsonSha256(currentValue), observation.currentTargetValueSha256 ?? observation.recomputedCurrentTargetValueSha256,
        `${row.claimId} current target hash is covered by the claim scoped observation`);
      assert.match(observation.claimParityBasis, /current/iu);
      assert.match(observation.historicalReviewRef, /migration-coordinator-p2-review-97\.json/u);
      assert.equal(observation.acceptanceEffect, "none");
      for (const clause of row.exactMaterialClauses.filter((candidate) => JSON.stringify(currentValue).includes(candidate))) {
        assert.equal(JSON.stringify(removeClause(structuredClone(currentValue), clause)).includes(clause), false,
          `${row.claimId} current source rejects removal of still-applicable ${clause}`);
      }
    } else {
      assert.equal(jsonSha256(currentValue), row.targetValueSha256, `${row.claimId} target value is pinned in this pending review cut`);
      assert.deepEqual(currentValue, row.targetValue, `${row.claimId} review snapshot matches the current owner value`);
      assert.equal(materialMatch(currentValue, row.exactMaterialClauses), true);
    }
  }
});

test("OpenVDB stays a historical cited license fact, not an invented Media candidate or admission", () => {
  const row = artifact.records.find(({ claimId }) => claimId === "MPSEM-0458-C001");
  const masterPlan = readFileSync(resolve(root, "docs/migration/expert-reviewed-master-plan.md"), "utf8").split(/\r?\n/u);
  assert.equal(row.proposedTargetRef, `${row.ownerSourceFile}#line=${artifact.historicalSourceClaim.sourceLine}`);
  assert.equal(row.semanticDisposition, "HISTORICAL_EXTERNAL_LICENSE_FACT_PRESERVED_PENDING_COORDINATOR_REVIEW");
  assert.ok(row.targetValue.includes("OpenVDB’s official license page identifies MPL-2.0"));
  assert.ok(row.targetValue.includes("[W02]"));
  assert.equal(textSha256(masterPlan[artifact.historicalSourceClaim.sourceLine - 1]), row.targetValueSha256);
  assert.equal(materialMatch(row.targetValue, row.exactMaterialClauses), true);
  for (const clause of row.exactMaterialClauses) {
    assert.equal(materialMatch(removeClause(row.targetValue, clause), row.exactMaterialClauses), false,
      `historical source fact rejects removal of ${clause}`);
  }
  const correctHistoricalDisposition = (candidate) => candidate.semanticDisposition === "HISTORICAL_EXTERNAL_LICENSE_FACT_PRESERVED_PENDING_COORDINATOR_REVIEW"
    && candidate.runtimeAdmission === "NOT_APPLICABLE"
    && candidate.acceptanceEffect === "none"
    && candidate.routeClassificationRequirements?.includes("historical external source fact only")
    && candidate.routeClassificationRequirements?.includes("not a Media candidate or owner decision")
    && candidate.routeClassificationRequirements?.includes("no license admission or legal clearance");
  assert.equal(correctHistoricalDisposition(row), true);
  for (const required of row.routeClassificationRequirements) {
    const weakened = structuredClone(row);
    weakened.routeClassificationRequirements = weakened.routeClassificationRequirements.filter((entry) => entry !== required);
    assert.equal(correctHistoricalDisposition(weakened), false, `${required} is a material route boundary`);
  }
  assert.equal(row.runtimeAdmission, "NOT_APPLICABLE");
  assert.equal(row.acceptanceEffect, "none");
});
