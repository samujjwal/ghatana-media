import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readText = (path) => readFileSync(resolve(root, path), "utf8");
const yamlCache = new Map();
const readYaml = (path) => {
  const text = readText(path);
  const cached = yamlCache.get(path);
  if (cached?.text === text) return cached.value;
  const value = parse(text);
  yamlCache.set(path, { text, value });
  return value;
};
const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const artifact = JSON.parse(readText("docs/implementation/verification/pdp-38/migration-goal-owner-review.json"));
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

const predicates = {
  "MPSEM-0004-C001": ["speech recognition and synthesis", "spatial-media extension points", "not promises that a particular operation"],
  "MPSEM-0029-C003": ["Reuse public Ghatana security", "Shared/platform owners retain those generic mechanics", "Media owns domain-specific intent, state, policy"],
  "MPSEM-0032-C004": ["Local Explorer simulations", "not evidence of production runtime behavior", "cross-environment reproducibility"],
  "MPSEM-0035-C005": ["arbitrary frame-level correction", "scientific truth"],
  "MPSEM-0046-C003": ["Existing Media callers and integrations use an explicit supported public Media contract"],
  "MPSEM-0046-C005": ["Exercise the public contract from both the Media and consumer repositories", "without importing source implementation"],
  "MPSEM-0057-C003": ["duplicate old-name/new-name business implementations"],
  "MPSEM-0077-C003": ["Scientific validity", "pedagogical truth", "clinical decisions", "campaign claims", "remain with their qualified domain owners"],
  "MPSEM-0078-C001": ["Every capability family named as required product-definition scope remains in the product-definition population"],
  "MPSEM-0080-C003": ["presentation result", "not a validated scientific simulator", "visual plausibility"],
  "MPSEM-0091-C001": ["security, identity, audit, observability, workflow", "Media owns domain-specific intent, state, policy"],
  "MPSEM-0097-C003": ["exact destination owner's admitted public operation and version", "unknown-outcome reconciliation", "missing owner contract evidence keeps the effect unavailable or unresolved"],
  "MPSEM-0098-C002": ["Data Cloud owns that compatibility/read-model contract", "Media owns media bytes, artifact and job lifecycle"],
  "MPSEM-0098-C003": ["governed enterprise metadata, context, read models", "A metadata projection is not canonical Media artifact state"],
  "MPSEM-0103-C003": ["Tools development mechanics do not put Media outside the ecosystem", "do not waive published Kernel contracts"],
  "MPSEM-0170-C001": ["Every capability family named as required product-definition scope remains"],
  "MPSEM-0170-C004": ["does not disappear when implementation is future", "Preserve its intended channel, priority, implementation lane"],
  "MPSEM-0172-C003": ["A technical substep remains an implementation detail", "disclosure alone does not create a separately executable operation"],
  "MPSEM-0181-C002": ["candidate-library or engine selection is not an integration mandate", "smallest stack", "no integration, candidate qualification, or runtime admission implied"],
  "MPSEM-0187-C003": ["Speaker diarization may assign temporary speaker turns or clusters without identifying a real person", "diarization success is not identity proof"],
  "MPSEM-0193-C001": ["AI Inference owns generic inference public contracts", "Media submits only through an exact admitted AI Inference public operation"],
  "MPSEM-0213-C004": ["Adding an engine does not require moving a public API into that engine's implementation language"],
  "MPSEM-0316-C003": ["does not authorize a second implementation of the same business logic"],
  "MPSEM-0318-C001": ["Help, version, doctor", "supported Ghatana identity flows", "do not constitute Media media-processing operations"],
  "MPSEM-0320-C002": ["Create, Improve, Edit, Animate, Simulate, Understand, and Deliver", "not seven competing permanently separate workspaces"],
  "MPSEM-0324-C001": ["synth plan", "synth image", "synth video", "synth audio", "synth music", "synth compose", "synth render", "synth run", "do not make each alias a separately admitted backend capability"],
  "MPSEM-0338-C001": ["Starting, accepting, or submitting a requested action is not successful completion", "A request acknowledgement cannot replace a completed output"],
  "MPSEM-0352-C006": ["Existing supported Ghatana authentication methods", "First-run creation does not bypass authentication"],
  "MPSEM-0370-C002": ["signed provenance statement proves only what its issuer and trust model attest", "does not establish truth, copyright clearance, lawful use, or scientific accuracy"],
  "MPSEM-0371-C004": ["A quality score, provider result, or visual preference cannot override safety, rights"],
  "MPSEM-0386-C002": ["not evidence of production runtime behavior", "in-memory diagnostic providers"],
  "MPSEM-0440-C003": ["outcome-intent launchers over one Media product model", "not seven competing permanently separate workspaces"],
  "MPSEM-0441-C002": ["First use does not require a person to choose an engine, model, queue, or codec"],
  "MPSEM-0443-C003": ["policy-compatible, explainable, and reversible", "cannot silently select an unqualified engine"],
  "MPSEM-0444-C004": ["First-run creation does not bypass authentication", "missing required local capability"],
  "MPSEM-0448-C002": ["Material regeneration invalidates only approvals whose approved material changed", "does not authorize a different output or destination"],
  "MPSEM-0160-C002": ["deterministic visual/interaction projection of already accepted PDP definitions", "Missing, stale, unresolved, or unaccepted source inputs", "outside the current 38-task mandate"],
  "MPSEM-0374-C002": ["Shared Workflow may supply generic state, command, and idempotency mechanics", "Media owns product-specific job and attempt definitions, durable repository, authority guards, handlers", "Persist the accepted job, attempt identity, and dispatch intent before an external effect", "unknown outcomes require reconciliation against the exact effect identity", "no public runtime identity/version is admitted"],
};

function validateMaterial(row, target) {
  const text = JSON.stringify(target);
  for (const phrase of predicates[row.claimId] ?? []) assert.ok(text.includes(phrase), `${row.claimId} preserves: ${phrase}`);
}

test("the complete 39-claim goal cohort keeps history and distinguishes semantic routes, metadata, and unresolved authority", () => {
  assert.equal(artifact.schemaVersion, "media.pdp38-migration-goal-owner-review.v1");
  assert.equal(artifact.recordCount, 39);
  assert.equal(artifact.records.length, 39);
  assert.equal(new Set(artifact.records.map(({ claimId }) => claimId)).size, 39);
  for (const row of artifact.records) {
    const original = claimById.get(row.claimId);
    const approved = approvedById.get(row.claimId);
    assert.ok(original, `${row.claimId} remains a source claim`);
    assert.ok(approved, `${row.claimId} has the coordinator's separate approval overlay`);
    assert.equal(original.exactSourceText, row.exactSourceText);
    assert.equal(original.sourceTextSha256, row.sourceTextSha256);
    assert.equal(approved.previousTargetRef, row.previousTargetRef);
    assert.equal(approved.previousTargetValueSha256, row.previousTargetValueSha256);
    assert.equal(original.semanticReviewRef, `${"docs/implementation/verification/pdp-38/migration-coordinator-review-112.json"}#/records/@claimId=${row.claimId}`);
    assert.equal(original.semanticReviewStatus, approved.semanticReviewStatus);
    assert.equal(row.coordinatorReviewStatus, "PENDING");
    assert.equal(row.acceptanceEffect, "none");
    if (row.proposedDisposition === "NON_NORMATIVE_SOURCE_METADATA") {
      assert.equal(row.claimId, "MPSEM-0035-C001");
      assert.equal(original.disposition, "NON_NORMATIVE_SOURCE_METADATA");
      assert.equal(original.sourceEvidenceRef, approved.currentTargetRef);
      const line = readText("docs/migration/expert-reviewed-master-plan.md").split("\n")[113];
      assert.match(line, /^\| REV-15 — Quality claims were overbroad \|/u);
      assert.deepEqual(row.metadataFields, ["table-row-heading"]);
      continue;
    }
    if (row.proposedDisposition === "UNRESOLVED_OWNER_OR_AUTHORITY") {
      assert.fail(`${row.claimId} now has a source-owned clause and must not remain in the unresolved partition`);
    }
    const target = resolveRef(row.proposedTargetRef);
    assert.equal(sha(target), row.proposedTargetValueSha256, `${row.claimId} exact target hash`);
    validateMaterial(row, target);
    assert.equal(original.targetRef, approved.currentTargetRef);
    assert.equal(original.targetTextSha256, approved.currentTargetValueSha256);
  }
  assert.equal(artifact.records.filter((row) => row.proposedTargetRef).length, 38);
  assert.equal(artifact.records.filter((row) => row.proposedDisposition === "NON_NORMATIVE_SOURCE_METADATA").length, 1);
  assert.equal(artifact.records.filter((row) => row.proposedDisposition === "UNRESOLVED_OWNER_OR_AUTHORITY").length, 0);
});

test("goal source rules reject loss of required scope, policy gates, and effect finality", () => {
  const row = (claimId) => artifact.records.find((entry) => entry.claimId === claimId);
  const mutate = (claimId, edit) => {
    const claim = row(claimId);
    const target = structuredClone(resolveRef(claim.proposedTargetRef));
    edit(target);
    assert.throws(() => validateMaterial(claim, target));
  };
  mutate("MPSEM-0004-C001", (target) => { target.rule = target.rule.replace("speech recognition and synthesis;", ""); });
  mutate("MPSEM-0097-C003", (target) => { target.rule = target.rule.replace("unknown-outcome reconciliation", ""); });
  mutate("MPSEM-0170-C004", (target) => { target.rule = target.rule.replace("does not disappear when implementation is future", ""); });
  mutate("MPSEM-0338-C001", (target) => { target.rule = target.rule.replace("A request acknowledgement cannot replace a completed output", ""); });
  mutate("MPSEM-0443-C003", (target) => { target.rule = target.rule.replace("cannot silently select an unqualified engine", ""); });
  mutate("MPSEM-0160-C002", (target) => { target.rule = target.rule.replace("deterministic visual/interaction projection of already accepted PDP definitions", "arbitrary projection"); });
  mutate("MPSEM-0374-C002", (target) => { target.rule = target.rule.replace("Persist the accepted job, attempt identity, and dispatch intent before an external effect", ""); });
});
