import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const review = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml"), "utf8"));
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const hash = (value) => createHash("sha256").update(value).digest("hex");

function resolvePointer(reference) {
  const separator = reference.indexOf("#");
  const path = separator < 0 ? reference : reference.slice(0, separator);
  let value = readYaml(path);
  if (separator < 0) return value;
  for (const token of reference.slice(separator + 1).replace(/^\//u, "").split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    assert.ok(value !== null && typeof value === "object" && key in value, `stale capability review source ref ${reference}`);
    value = value[key];
  }
  return value;
}

test("capability review source pin changes are reconciled to the reviewed goal semantics", () => {
  const goalPath = ".product-experience/pdp-0-product-truth/goals-jtbd.yaml";
  const goalsText = readFileSync(resolve(root, goalPath));
  const goals = parse(goalsText.toString("utf8"));
  const goalPin = review.sourceInventory.find(({ path }) => path === goalPath);
  const impact = review.sourcePinReconciliations.find(({ path }) => path === goalPath);
  assert.ok(goalPin, "goals remain an explicit capability-review source");
  assert.ok(impact, "the changed goal pin has a semantic impact record");
  assert.equal(hash(goalsText), goalPin.sha256);
  assert.equal(goalPin.sha256, impact.currentSha256);
  assert.notEqual(impact.previousSha256, impact.currentSha256);
  assert.match(impact.result, /source-pin-reconciled/u);

  const semanticKeys = impact.reviewedCapabilityEvidence.semanticProjection;
  const semanticProjection = Object.fromEntries(semanticKeys.map((key) => [key, goals[key]]));
  assert.equal(hash(JSON.stringify(semanticProjection)), impact.reviewedCapabilityEvidence.semanticProjectionSha256);
  assert.equal(
    impact.reviewedCapabilityEvidence.previousSemanticProjectionSha256,
    impact.reviewedCapabilityEvidence.semanticProjectionSha256,
    "the source pin changed while every capability-relevant semantic field stayed identical",
  );
  assert.match(impact.reviewedCapabilityEvidence.impact, /unchanged as parsed YAML values/u);
  assert.match(impact.reviewedCapabilityEvidence.authorityMappingImpact, /actorRefs are not capability bindings/u);
  assert.match(impact.reviewedCapabilityEvidence.reviewImpact, /No capability evidence, source link, or coverage disposition changes/u);

  const sourceIntents = new Map(goals.intents.map(({ id, description }) => [id, description]));
  for (const intent of review.intents) {
    const source = resolvePointer(intent.sourceRef);
    assert.equal(source.id, intent.id, `${intent.id} source ref identifies the same intent`);
    assert.equal(source.description, intent.description, `${intent.id} reviewed description matches source`);
    assert.equal(sourceIntents.get(intent.id), intent.description);
  }
  const outcomeIds = new Set(goals.outcomes.map(({ id }) => id));
  for (const leaf of review.leaves) {
    for (const id of leaf.coverageDecision.purposeSpecificOutcomeRefs ?? []) {
      assert.ok(outcomeIds.has(id), `${leaf.id} outcome ${id} still resolves`);
    }
  }

  assert.equal(review.denominatorReconciliation.capabilityLeaves, 462);
  assert.equal(review.denominatorReconciliation.leavesWithUnresolvedApplicability, 383);
  assert.equal(review.denominatorReconciliation.unresolvedCoverageDispositions, 383);
  assert.equal(review.denominatorReconciliation.journeyStepDispositions, 77);
  assert.equal(review.denominatorReconciliation.machineOperationDispositions, 0);
  assert.ok(goals.authorityMapping, "the added authority mapping is present in the current goal source");
  assert.equal(review.denominatorReconciliation.platformDependencyDispositions, 2);
});

test("operation source changes reconcile affected leaf links without promoting coverage", () => {
  const path = ".product-experience/pdp-1-domain-data/operations.yaml";
  const sourceText = readFileSync(resolve(root, path));
  const operations = parse(sourceText.toString("utf8"));
  const sourcePin = review.sourceInventory.find(({ path: sourcePath }) => sourcePath === path);
  const impact = review.sourcePinReconciliations.find(({ path: sourcePath }) => sourcePath === path);
  assert.ok(sourcePin, "canonical operation families remain an explicit capability-review source");
  assert.ok(impact, "the changed canonical operation source has a semantic reconciliation");
  assert.equal(hash(sourceText), sourcePin.sha256);
  assert.equal(sourcePin.sha256, impact.currentSha256);
  assert.equal(impact.previousSha256, "e680643b45a5c3f25638b4f06ec0f9d544e2190c69c2c25f9a054445dcb3e085");
  assert.notEqual(impact.previousSha256, impact.currentSha256);
  assert.match(impact.result, /semantic-source-change-reconciled/u);

  const actionBindings = operations.sourceDenominators.uiProductActions.explicitOperationIds;
  const reconciledActions = impact.reviewedCapabilityEvidence.currentActionBindings;
  for (const [actionRef, operationRef] of Object.entries(reconciledActions)) {
    assert.equal(actionBindings[actionRef], operationRef, `${actionRef} maps to the reconciled canonical operation`);
  }
  for (const binding of impact.reviewedCapabilityEvidence.changedCapabilityLeafBindings) {
    const leaf = review.leaves.find(({ id }) => id === binding.leaf);
    assert.ok(leaf, `${binding.leaf} is still in the preserved capability denominator`);
  }

  const leaf = (id) => review.leaves.find(({ id: leafId }) => leafId === id);
  const exactBindings = (id) => leaf(id).operation.explicitOperationBindings.map(({ operationRef, viaActionRef }) => [viaActionRef, operationRef]);
  assert.deepEqual(exactBindings("media.artifact.inspect"), [
    ["media.action.inspect-artifact", "media.operation.artifact-ingest"],
    ["media.action.review-transcript", "media.operation.transcript-version-read"],
    ["media.action.compare-caption-versions", "media.operation.caption-version-read"],
  ]);
  assert.deepEqual(exactBindings("media.artifact.derive"), [
    ["media.action.correct-caption", "media.operation.caption-draft-write"],
    ["media.action.align-caption-timing", "media.operation.caption-draft-write"],
  ]);
  assert.deepEqual(exactBindings("media.job.submit"), [
    ["media.action.request-transcription", "media.operation.transcription-submission"],
  ]);
  assert.deepEqual(leaf("media.speech.transcription.file").operation.ambiguousOperationBindings[0].candidateOperationRefs, [
    "media.operation.transcription-submission",
    "media.operation.transcription",
  ], "the whole recognition capability remains unresolved across submission and execution semantics");
  assert.deepEqual(exactBindings("media.speech.transcription.forced-align"), [
    ["media.action.align-caption-timing", "media.operation.caption-draft-write"],
  ]);

  const transcription = operations.operations.find(({ id }) => id === "media.operation.transcription");
  assert.deepEqual(transcription.observedBindings.gRPC, ["STTService.Transcribe", "STTService.StreamTranscribe", "STTService.SubmitCorrection"]);
  assert.equal(operations.scopeStatus.startsWith("proposal-only"), true);
  assert.equal(review.denominatorReconciliation.capabilityLeaves, 462);
  assert.equal(review.denominatorReconciliation.unresolvedCoverageDispositions, 383);
  assert.equal(review.denominatorReconciliation.machineOperationDispositions, 0);
});

test("domain catalog identity changes reconcile to zero capability leaf references", () => {
  const path = ".product-experience/pdp-1-domain-data/domain-objects.yaml";
  const sourceText = readFileSync(resolve(root, path));
  const catalog = parse(sourceText.toString("utf8"));
  const sourcePin = review.sourceInventory.find(({ path: sourcePath }) => sourcePath === path);
  const impact = review.sourcePinReconciliations.find(({ path: sourcePath }) => sourcePath === path);
  assert.ok(sourcePin, "the canonical domain-object catalog remains an explicit capability-review source");
  assert.ok(impact, "the changed domain-object source pin has a semantic impact record");
  assert.equal(hash(sourceText), sourcePin.sha256);
  assert.equal(sourcePin.sha256, impact.currentSha256);
  assert.equal(impact.previousSha256, "b958fc9c56449d87b0113d17eb97838801cbe7d4ec73bf4dc8f1a21d04bc173f");
  assert.notEqual(impact.previousSha256, impact.currentSha256);
  assert.match(impact.result, /semantic-source-change-reconciled/u);

  const semanticProjection = review.leaves.map(({ id, domain }) => ({ id, canonicalDomainObjectRefs: domain.canonicalDomainObjectRefs }));
  assert.equal(review.leaves.length, 462);
  assert.equal(hash(JSON.stringify(semanticProjection)), impact.reviewedCapabilityEvidence.canonicalDomainObjectRefsSha256);
  assert.equal(
    impact.reviewedCapabilityEvidence.previousCanonicalDomainObjectRefsSha256,
    impact.reviewedCapabilityEvidence.canonicalDomainObjectRefsSha256,
    "all leaf-to-domain-object reference lists were empty before and after the catalog-only identity changes",
  );
  assert.deepEqual(impact.reviewedCapabilityEvidence.canonicalDomainObjectRefCounts, { total: 462, empty: 462, populated: 0 });
  assert.ok(review.leaves.every(({ domain }) => Array.isArray(domain.canonicalDomainObjectRefs) && domain.canonicalDomainObjectRefs.length === 0));
  assert.deepEqual(impact.reviewedCapabilityEvidence.coverageCounts, {
    total: 462,
    ownerCoverage: 79,
    unresolved: 383,
    journeySteps: 77,
    platformDependencies: 2,
    machineOperations: 0,
  });
  assert.equal(review.denominatorReconciliation.capabilityLeaves, 462);
  assert.equal(review.denominatorReconciliation.leavesWithOwnerCoverageDisposition, 79);
  assert.equal(review.denominatorReconciliation.leavesWithUnresolvedApplicability, 383);
  assert.equal(review.denominatorReconciliation.journeyStepDispositions, 77);
  assert.equal(review.denominatorReconciliation.platformDependencyDispositions, 2);
  assert.equal(review.denominatorReconciliation.machineOperationDispositions, 0);

  const captionVersion = catalog.objects.find(({ id }) => id === "media.domain.caption-version");
  assert.ok(captionVersion, "caption reconciliation is backed only by a named fixture record");
  assert.match(captionVersion.kind, /local-simulation-fixture/u);
  assert.match(captionVersion.scopeStatus, /not-an-observed-runtime-or-persistence-record/u);
  assert.match(captionVersion.lifecycle, /immutable-version-and-durable-history-semantics-unbound/u);
  assert.equal(catalog.objects.length, 38);
  assert.match(impact.reviewedCapabilityEvidence.impact, /unchanged/u);
  assert.match(impact.reviewedCapabilityEvidence.reviewImpact, /all 462 canonicalDomainObjectRefs arrays are empty/u);
});

test("non-inventoried constitution and actor records are not misrepresented as capability evidence", () => {
  const sources = new Set(Object.values(review.sourceReferences));
  const pinned = new Set(review.sourceInventory.map(({ path }) => path));
  for (const path of [
    ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml",
    ".product-experience/pdp-0-product-truth/constitution.yaml",
  ]) {
    assert.equal(sources.has(path), false, `${path} is not claimed as direct capability evidence`);
    assert.equal(pinned.has(path), false, `${path} is not pinned as an input to coverage dispositions`);
  }
  for (const item of review.sourcePinReconciliations[0].unrelatedChangedSources) {
    assert.ok(readFileSync(resolve(root, item.path), "utf8").length > 0);
    assert.match(item.disposition, /not-a-capability-review-source/u);
  }
});
