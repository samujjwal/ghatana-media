import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const candidatePhase = process.env.PDP_MIGRATION_CANDIDATE_PHASE ?? "ALL";
if (!["ALL", "PDP-0"].includes(candidatePhase)) throw new Error(`PDP_MIGRATION_CANDIDATE_PHASE must be ALL or PDP-0; got ${candidatePhase}`);
const p0Ids = ["MPSEM-0181-C002", "MPSEM-0291-C009", "MPSEM-0374-C006", "MPSEM-0455-C002", "MPSEM-0459-C002"];
const downstreamIds = ["MPSEM-0296-C005", "MPSEM-0315-C003", "MPSEM-0331-C001", "MPSEM-0350-C001", "MPSEM-1259-C001-S13"];
const ids = candidatePhase === "PDP-0" ? p0Ids : [...p0Ids.slice(0, 2), ...downstreamIds.slice(0, 4), ...p0Ids.slice(2), downstreamIds[4]];
const review = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/migration-semantics-review.yaml"), "utf8"));
const observations = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/migration-current-owner-target-observations.json"), "utf8"));
const observationById = new Map(observations.records.map((record) => [record.claimId, record]));
const yamlCache = new Map();
function resolveRef(ref) {
  const [path, pointer] = ref.split("#", 2);
  assert.ok(!path.endsWith(".md"), `${ref} must resolve to structured owner data`);
  if (!yamlCache.has(path)) yamlCache.set(path, parse(readFileSync(resolve(root, path), "utf8")));
  let value = yamlCache.get(path);
  for (const raw of pointer.split("/").filter(Boolean)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (segment.startsWith("@id=")) value = value.find((entry) => entry?.id === segment.slice(4));
    else if (/^\d+$/u.test(segment)) value = value[Number(segment)];
    else value = value[segment];
    assert.notEqual(value, undefined, `unresolved exact owner selector ${ref}`);
  }
  return value;
}
function findClaims(node, found = []) {
  if (Array.isArray(node)) for (const entry of node) findClaims(entry, found);
  else if (node && typeof node === "object") {
    if (typeof node.claimId === "string" && ids.includes(node.claimId)) found.push(node);
    for (const [key, value] of Object.entries(node)) if (key !== "claimId") findClaims(value, found);
  }
  return found;
}
const claims = new Map(findClaims(review).map((claim) => [claim.claimId, claim]));

test("PXD-120 records exact current owner observations for the active phase cohort", () => {
  assert.equal(observations.decisionRef, ".product-experience/decision-log.md#PXD-120");
  assert.deepEqual(ids.filter((id) => !claims.has(id)), []);
  assert.deepEqual(ids.filter((id) => !observationById.has(id)), []);
  for (const id of ids) {
    const claim = claims.get(id);
    const observation = observationById.get(id);
    assert.equal(claim.targetRef, observation.targetRef, `${id} target selector`);
    assert.equal(claim.exactSourceText, observation.sourceText, `${id} exact source text`);
    assert.equal(claim.targetTextSha256, observation.currentTargetValueSha256, `${id} current digest`);
    assert.equal(observation.acceptanceEffect, "none");
    assert.match(observation.disposition, /CLAIM_PARITY_REVIEWED|CLAIM_PARITY_RETAINED/u);
    const target = resolveRef(claim.targetRef);
    assert.equal(sha(JSON.stringify(target)), observation.currentTargetValueSha256, `${id} exact serialized target bytes`);
  }
  assert.equal(observationById.get("MPSEM-0181-C002").historicalTargetTextSha256, "04718d69cc37bcbfc8325d9bb2ca043c7b6dc228f3722877424a42ce273eefbe");
  assert.equal(observationById.get("MPSEM-0181-C002").disposition, "CURRENT_OWNER_RULE_EXTENDED_WITH_EXPLICIT_REUSE_FIRST_CLAUSE; CLAIM_PARITY_REVIEWED");
  const reuse = resolveRef(claims.get("MPSEM-0181-C002").targetRef).reuseBeforeSelection;
  assert.match(reuse, /Before selecting a new streaming stack, inspect the exact existing Ghatana-owned streaming modules and their public contracts/u);
  assert.match(reuse, /Reuse an existing module when it satisfies the requirements of the exact admitted Media capability\/profile/u);
  assert.match(reuse, /record the concrete profile requirement it cannot meet and the evidence for that reuse gap/u);
  assert.match(observations.records.filter((record) => (candidatePhase === "PDP-0" ? p0Ids : [...p0Ids, ...downstreamIds]).includes(record.claimId)).map((record) => record.claimParityBasis).join(" "), /No task\/phase acceptance, implementation, qualification, or runtime admission is asserted/u);
});

test("PXD-120 downstream owner observations remain available to later phases", { skip: candidatePhase === "PDP-0" }, () => {
  assert.deepEqual(downstreamIds.filter((id) => !claims.has(id)), []);
  assert.deepEqual(downstreamIds.filter((id) => !observationById.has(id)), []);
  for (const id of downstreamIds) {
    const claim = claims.get(id);
    const observation = observationById.get(id);
    assert.equal(claim.targetRef, observation.targetRef, `${id} target selector`);
    assert.equal(claim.exactSourceText, observation.sourceText, `${id} exact source text`);
    assert.equal(claim.targetTextSha256, observation.currentTargetValueSha256, `${id} current digest`);
    assert.equal(observation.acceptanceEffect, "none");
    assert.match(observation.disposition, /CLAIM_PARITY_REVIEWED|CLAIM_PARITY_RETAINED/u);
    assert.equal(sha(JSON.stringify(resolveRef(claim.targetRef))), observation.currentTargetValueSha256, `${id} exact serialized target bytes`);
  }
});

test("the PXD-120 observation set is exact and adds no claim beyond its bounded scope", () => {
  assert.deepEqual(observations.records.filter((record) => (candidatePhase === "PDP-0" ? p0Ids : [...p0Ids, ...downstreamIds]).includes(record.claimId)).map((record) => record.claimId), ids);
  for (const record of observations.records.filter((record) => (candidatePhase === "PDP-0" ? p0Ids : [...p0Ids, ...downstreamIds]).includes(record.claimId))) {
    assert.equal(record.acceptanceEffect, "none");
    assert.equal(record.targetHashEncoding, undefined);
  }
});
