import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readText = (path) => readFileSync(resolve(root, path), "utf8");
const readYaml = (path) => parse(readText(path));
const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const artifact = JSON.parse(readText("docs/implementation/verification/pdp-38/migration-domain-model-owner-review.json"));
const approval = JSON.parse(readText("docs/implementation/verification/pdp-38/migration-coordinator-review-112.json"));
const approvedById = new Map(approval.records.map((record) => [record.claimId, record]));
const ledger = readYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
const claims = ledger.pdp38ClaimReconciliation.records.flatMap((record) => record.claims ?? [])
  .flatMap((claim) => claim.subclaims ?? [claim]);
const claimById = new Map(claims.map((claim) => [claim.claimId, claim]));

function resolveRef(ref) {
  const [path, pointer = ""] = ref.split("#", 2);
  let value = readYaml(path);
  for (const raw of pointer.split("/").filter(Boolean)) {
    const part = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (part.startsWith("@id=")) value = Array.isArray(value) ? value.find((entry) => entry.id === part.slice(4)) : undefined;
    else if (/^\d+$/u.test(part)) value = value[Number(part)];
    else value = value?.[part];
    assert.notEqual(value, undefined, `exact target resolves: ${ref}`);
  }
  return value;
}

const requiredPredicates = {
  "MPSEM-0217-C001": ["Tenant/workspace membership", "immutable revision reference", "access policy", "copying does not widen access"],
  "MPSEM-0218-C001": ["Immutable content identity", "digest", "technical descriptors", "origin", "owner references"],
  "MPSEM-0218-C002": ["Access, lifecycle, retention, and deletion/purge state are separate"],
  "MPSEM-0219-C001": ["Project-specific use", "artifact version", "purpose", "crop/trim", "presentation bindings"],
  "MPSEM-0219-C002": ["References bytes; does not duplicate or redefine them"],
  "MPSEM-0220-C001": ["Versioned parameterized processing", "typed parameters", "bounds", "required ports", "safe variants", "no provider or engine execution object"],
  "MPSEM-0221-C001": ["Durable requested operation", "immutable request/plan references", "attempts", "outputs", "verification-job finality does not replace artifact lifecycle"],
  "MPSEM-0222-C001": ["worker claim/fencing token", "deadline", "side-effect boundary", "provider execution reference", "reconciliation state"],
  "MPSEM-0223-C001": ["Immutable typed nodes/edges", "parameter contracts", "bounded stateful loops stay inside typed node contracts"],
  "MPSEM-0224-C001": ["Admitted concrete graph", "capability bindings", "resource bounds", "policy-decision references", "cost reservation", "plan fingerprint", "re-planning creates a successor plan"],
  "MPSEM-0225-C001": ["Mutable execution progression", "immutable observations", "Run progression never mutates source graph or plan"],
  "MPSEM-0226-C001": ["Narrative/visual intent", "purpose", "timing", "controls", "transitions", "not permission or proof of model behavior"],
  "MPSEM-0227-C001": ["Versioned visual scene entities", "typed bindings to model state or observables", "Visual representation is distinct from physical/model state"],
  "MPSEM-0228-C001": ["Tracks, keyframes, curves, constraints", "bindings to scene properties", "contradictory owners are invalid"],
  "MPSEM-0229-C001": ["Initial physical/model state", "quantities and units", "Scientific/physical core values cannot be unitless", "boundary conditions", "sampled output contract", "Model truth and numerical state are distinct from scene mesh"],
  "MPSEM-0230-C001": ["Rational-time tracks and clips", "audio mix", "delivery intent", "Editorial/presentation clocks remain distinct from simulation time and wall-clock deadlines"],
  "MPSEM-0231-C001": ["Typed references", "camera/subject trajectories", "static/motion regions", "do not imply model/identity truth"],
  "MPSEM-0232-C001": ["Scene-to-scene identity", "qualified comparison observations"],
  "MPSEM-0232-C002": ["A continuity observation is not identity proof"],
  "MPSEM-0233-C001": ["Metric/version", "applicability", "score and unit", "uncertainty", "failure region", "Visual quality is not scientific/domain fidelity"],
  "MPSEM-0234-C001": ["Registered outputs", "exact technical descriptors", "validation", "degradation", "publication certainty", "A successful render is not a successful delivery or external publication"],
  "MPSEM-0235-C002": ["Separate authority references", "permission", "lawful/contractual permitted use", "observed creation history"],
  "MPSEM-0236-C001": ["Use opaque stable IDs and explicit version/hash references", "never rely on engine object identity"],
  "MPSEM-0236-C003": ["versioned, discriminated payload", "closed typed fields", "operation-specific invariants"],
  "MPSEM-0236-C004": ["Arbitrary Map<string, unknown> is not an adequate contract for core operation semantics", "required fields", "cross-field constraints"],
  "MPSEM-0259-C002": ["DEFAULT_AUDIO_FORMAT uses 16000 Hz for the client STT default", "not a universal mastering or artifact rate"],
  "MPSEM-0272-C001": ["Visual quality is not scientific/domain fidelity"],
};

function validateMaterial(row, target) {
  const text = JSON.stringify(target);
  for (const predicate of requiredPredicates[row.claimId] ?? []) {
    assert.ok(text.includes(predicate), `${row.claimId} must preserve: ${predicate}`);
  }
}

test("the complete live 27-claim domain-model cohort points to exact owner records and keeps history unchanged", () => {
  assert.equal(artifact.schemaVersion, "media.pdp38-migration-domain-model-owner-review.v1");
  assert.equal(artifact.recordCount, 27);
  assert.equal(artifact.records.length, 27);
  assert.equal(new Set(artifact.records.map(({ claimId }) => claimId)).size, 27);
  for (const row of artifact.records) {
    const original = claimById.get(row.claimId);
    const approved = approvedById.get(row.claimId);
    assert.ok(original, `${row.claimId} is a current ledger claim`);
    assert.ok(approved, `${row.claimId} has a separate coordinator approval record`);
    assert.equal(original.exactSourceText, row.exactSourceText);
    assert.equal(original.sourceTextSha256, row.sourceTextSha256);
    assert.equal(approved.previousTargetRef, row.previousTargetRef);
    assert.equal(approved.previousTargetValueSha256, row.previousTargetValueSha256);
    assert.equal(row.semanticReviewStatus, "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY");
    assert.equal(row.coordinatorReviewStatus, "PENDING");
    assert.equal(row.acceptanceEffect, "none");
    const target = resolveRef(row.proposedTargetRef);
    assert.equal(sha(target), row.proposedTargetValueSha256, `${row.claimId} exact current owner value pin`);
    assert.equal(approved.currentTargetRef, row.proposedTargetRef);
    assert.equal(approved.currentTargetValueSha256, row.proposedTargetValueSha256);
    assert.equal(original.semanticReviewRef, `docs/implementation/verification/pdp-38/migration-coordinator-review-112.json#/records/@claimId=${row.claimId}`);
    assert.equal(original.semanticReviewStatus, "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED");
    assert.equal(original.targetRef, approved.currentTargetRef);
    assert.equal(original.targetTextSha256, approved.currentTargetValueSha256);
    validateMaterial(row, target);
  }
  assert.deepEqual(artifact.nonClaims, [
    "No canonical PDP-1 handoff acceptance",
    "No legacy-wire compatibility or round-trip claim",
    "No implementation/runtime admission",
    "No independent expert acceptance",
    "Historical target pins and source text remain unchanged",
  ]);
});

test("domain definitions reject loss of material ownership, lifecycle, state, and fidelity boundaries", () => {
  const row = (claimId) => artifact.records.find((entry) => entry.claimId === claimId);
  const mutate = (claimId, edit) => {
    const claim = row(claimId);
    const target = structuredClone(resolveRef(claim.proposedTargetRef));
    const mutated = edit(target);
    assert.throws(() => validateMaterial(claim, mutated === undefined ? target : mutated));
  };
  mutate("MPSEM-0218-C002", (target) => { target.stateBoundary = ""; });
  mutate("MPSEM-0219-C002", (target) => { target.stateBoundary = "Bytes are copied into project state."; });
  mutate("MPSEM-0220-C001", (target) => { target.stateBoundary = ""; });
  mutate("MPSEM-0224-C001", (target) => { target.meaning = target.meaning.replace("cost reservation", ""); });
  mutate("MPSEM-0228-C001", (target) => { target.stateBoundary = ""; });
  mutate("MPSEM-0229-C001", (target) => { target.typedRequirements = ""; });
  mutate("MPSEM-0232-C002", (target) => { target.stateBoundary = "Continuity proves identity."; });
  mutate("MPSEM-0234-C001", (target) => { target.stateBoundary = "A successful render is a successful publication."; });
  mutate("MPSEM-0236-C004", (target) => { target.rule = target.rule.replace("Arbitrary Map<string, unknown> is not an adequate contract for core operation semantics", "Arbitrary Map<string, unknown> is an adequate contract for core operation semantics"); });
});
