import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const source = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capabilities.yaml"), "utf8"));
const operations = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));
const byId = new Map(source.capabilities.map((row) => [row.id, row]));

function owner(id) {
  const row = byId.get(id);
  assert.ok(row, `P0 capability exists: ${id}`);
  return row.ownerDefinition;
}

function slotTypes(id) {
  return owner(id).typedInputSlots.map(({ sourceType }) => sourceType);
}

function outputRequiredness(id) {
  return Object.fromEntries(owner(id).successOutputs.map(({ artifactType, requiredOnSuccess }) => [artifactType, requiredOnSuccess]));
}

const correctionReviewPath = "docs/implementation/verification/pdp-38/p0-existing-operation-semantic-corrections-current-source-review.json";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("source-asset attachment names the exact source and project versions", () => {
  const id = "media.project.source-asset.attach";
  assert.deepEqual(slotTypes(id), ["user-intent", "exact-versioned-project", "source-asset-with-immutable-version"]);
  assert.deepEqual(byId.get(id).inputArtifactTypes, slotTypes(id));
  assert.match(owner(id).semanticOutcomeContract.result, /exact immutable version of one source asset/u);
  assert.match(owner(id).semanticOutcomeContract.result, /source-asset membership of the selected project version/u);
});

test("artifact derivation types source version, profile version, output type, purpose, and rights", () => {
  const id = "media.artifact.derive";
  assert.deepEqual(slotTypes(id), [
    "exact-source-versioned-media-or-project-reference",
    "transformation-profile-identity-version-and-digest",
    "requested-output-artifact-type-media-type-and-byte-budget",
    "purpose-and-rights-decision-context",
  ]);
  assert.deepEqual(byId.get(id).inputArtifactTypes, slotTypes(id));
  assert.match(owner(id).semanticOutcomeContract.result, /selected transformation-profile identity\/version\/configuration digest/u);
  assert.match(owner(id).semanticOutcomeContract.result, /configuration digest/u);
  assert.match(owner(id).semanticOutcomeContract.result, /requested output artifact type\/media type\/byte budget/u);
});

test("output registration types candidate lineage, digest, media metadata, policy, and optional project revision", () => {
  const id = "media.artifact.output.register";
  assert.deepEqual(slotTypes(id), [
    "exact-source-version-lineage-set",
    "rights-and-retention-context",
    "output-candidate-with-lineage",
    "content-digest",
    "media-type-and-byte-length",
    "policy-decision-reference",
    "authorized-target-workspace",
    "optional-exact-project-version",
  ]);
  assert.deepEqual(byId.get(id).inputArtifactTypes, slotTypes(id));
  const sourceLineage = owner(id).typedInputSlots[0];
  assert.equal(sourceLineage.cardinality, "ZERO_OR_MORE");
  assert.equal(sourceLineage.required, true);
  assert.equal(sourceLineage.emptyDisposition, "EXPLICIT_SOURCE_FREE_OUTPUT_GENERATED_FROM_REQUEST");
  assert.deepEqual(owner(id).typedInputSlots.slice(-2).map(({ cardinality, required }) => [cardinality, required]), [
    ["EXACTLY_ONE", true],
    ["ZERO_OR_ONE", false],
  ]);
  const meaning = owner(id).semanticOutcomeContract.result;
  for (const term of ["Candidate lineage", "Content digest", "media type", "byte length", "policy decision", "authorized target workspace", "Workspace-only registration may omit the exact project version", "project-targeted registration requires it for stale-version checking", "source-free registration does not require a source artifact"]) assert.ok(meaning.includes(term));
  assert.match(owner(id).guards.preconditions.join(" "), /If registering into a project, the exact project version is supplied and compared to prevent stale registration/u);
});

test("conditional upload, import, inspection, and transcription outputs are not guaranteed on every success", () => {
  const optional = {
    "media.artifact.upload": [
      "verification-job-reference-only-if-issued-by-owner-contract",
      "artifact-version-reference-only-after-owner-confirmed-registration",
    ],
    "media.artifact.upload.resume": ["verification-reference-only-if-issued-by-owner-contract"],
    "media.artifact.import": [
      "artifact-version-reference-only-after-owner-confirmed-registration",
      "verification-or-quarantine-state-when-issued",
    ],
    "media.artifact.inspect": ["rights-retention-and-provenance-references-when-authorized"],
    "media.speech.transcription.file": [
      "transcript-draft-with-source-version-and-timebase-if-produced",
      "language-and-recognition-evidence-when-provided",
    ],
  };
  for (const [id, conditionalOutputs] of Object.entries(optional)) {
    const requiredness = outputRequiredness(id);
    for (const artifactType of conditionalOutputs) assert.equal(requiredness[artifactType], false, `${id} ${artifactType} is conditional`);
  }
  assert.equal(outputRequiredness("media.artifact.upload")["stable-uploadId-and-owner-acknowledged-transfer-state"], true);
  assert.equal(outputRequiredness("media.artifact.import")["import-observation-and-source-resolution-evidence"], true);
  assert.equal(outputRequiredness("media.artifact.inspect")["authorized-artifact-version-summary"], true);
  assert.equal(outputRequiredness("media.speech.transcription.file")["owner-issued-transcription-job-reference"], true);

  const review = JSON.parse(readFileSync(resolve(root, correctionReviewPath), "utf8"));
  const successorReview = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd206.json"), "utf8"));
  const capabilityBytes = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capabilities.yaml"));
  const qualityPolicyBytes = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/quality-policy.yaml"));
  const channelReviewBytes = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml"));
  const profileSemanticsBytes = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/profile-semantics.yaml"));
  assert.equal(review.decisionRef, ".product-experience/decision-log.md#PXD-142");
  assert.equal(review.decisionRefStatus, "APPROVED_BOUNDED_CURRENT_SOURCE_CORRECTION; see .product-experience/decision-log.md#PXD-142");
  assert.equal(review.sources.capabilities.currentSha256, "d66135cd7fb2f8fa4d506fcfde197d28af43e478defc35dd886986100466cfcf",
    "PXD-142's capability fingerprint remains a historical source pin after the separate PXD-153 reopen");
  assert.equal(review.sources.qualityPolicy.currentSha256, review.qualityDispositionPreservation.currentQualityPolicySha256,
    "PXD-142 keeps the exact quality-policy fingerprint from its historical source cut");
  assert.notEqual(review.sources.qualityPolicy.currentSha256, sha256(qualityPolicyBytes),
    "later PXD successors record the current policy without rewriting PXD-142 history");
  assert.equal(review.sources.channelApplicability.currentSha256, "60557c2ae73052232b5a7f8b08a521cfabcdc275c416707b47155a878c7b8cea",
    "PXD-142 retains its immutable historical channel-applicability source pin");
  assert.notEqual(review.sources.channelApplicability.currentSha256, sha256(channelReviewBytes),
    "later source revisions do not rewrite PXD-142 history");
  assert.equal(successorReview.decisionRef, ".product-experience/decision-log.md#PXD-206");
  assert.equal(successorReview.sources.leafReview.path, ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml");
  assert.equal(successorReview.sources.leafReview.sha256, "dfcbc43e98f5f89285f6bc9bad4e56a40235fea5e9e7efd691724bfb8d431af5",
    "PXD-206 preserves its exact leaf-review source cut");
  assert.notEqual(successorReview.sources.leafReview.sha256, sha256(channelReviewBytes),
    "PXD-207 and later source revisions do not rewrite the PXD-206 historical cut");
  assert.equal(review.sources.profileSemantics.currentSha256, "822767f9562487f5e0d05a984fffaf4a6862f4db67d123c13b7fdc5dbe83ea9a",
    "PXD-142 retains its immutable historical profile-semantics source pin");
  assert.notEqual(review.sources.profileSemantics.currentSha256, sha256(profileSemanticsBytes),
    "later source revisions do not rewrite PXD-142 history");
  assert.equal(successorReview.sources.profileSemantics.path, ".product-experience/pdp-0-product-truth/profile-semantics.yaml");
  assert.equal(successorReview.sources.profileSemantics.sha256, sha256(profileSemanticsBytes),
    "PXD-206 records the current profile-semantics fingerprint after the PXD-142 cut");
  assert.deepEqual(review.typedInputCorrections.map(({ capabilityId }) => capabilityId).sort(), [
    "media.artifact.derive",
    "media.artifact.output.register",
    "media.project.source-asset.attach",
  ]);
  assert.equal(review.optionalSuccessOutputCorrections.length, 5);
  assert.ok(review.optionalSuccessOutputCorrections.every(({ outputs }) => outputs.every(({ requiredOnSuccess }) => requiredOnSuccess === false)));
  assert.deepEqual(review.inputShapePopulationProjection.current, {
    capabilityCount: 462,
    slotCount: 939,
    distinctSharedShapeCount: 142,
  });
  assert.equal(successorReview.population.typedInputSlotCount, 939);
  assert.equal(successorReview.population.currentDistinctSharedInputShapeCount, 144,
    "PXD-206 records the current 462-leaf shape population after the two source changes");
  assert.deepEqual(review.inputShapePopulationProjection.prior, {
    capabilityCount: 462,
    slotCount: 930,
    distinctSharedShapeCount: 129,
  });
  assert.equal(review.inputShapePopulationProjection.identityPopulationUnchanged, true);
  assert.ok(review.regressionSources.includes("tests/pdp0-development-handoff.test.mjs"));
  assert.ok(review.regressionSources.includes("tests/pdp0-bounded-resource-admission.test.mjs"));
  assert.equal(review.qualityAndChannelDecisionBoundary.qualityApplicabilityDecisionsChanged, false);
  assert.equal(review.qualityAndChannelDecisionBoundary.channelApplicabilityDecisionsChanged, false);
  assert.ok(review.qualityAndChannelDecisionBoundary.sourceProjectionChanges.length > 0);
  assert.equal(review.developmentEvidence.focusedTestStatus, "PASS");
  assert.equal(review.developmentEvidence.focusedTestCount, 62);
  assert.equal(review.developmentEvidence.phaseGateStatus, "PASS");
  assert.equal(review.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(review.acceptanceEffect, "none; current-source review and regression evidence only");
});

test("PXD-153 aligns upload byte-length minimum with the positive begin-upload size", () => {
  const capabilityBytes = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capabilities.yaml"));
  const decisionText = readFileSync(resolve(root, ".product-experience/decision-log.md"), "utf8");
  const currentReview = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/p0-upload-byte-length-minimum-current-source-review.json"), "utf8"));
  const upload = owner("media.artifact.upload");
  const parameterSchema = upload.parameterSchema;
  const expectedSize = operations.individualOperationContracts.records
    .find(({ id }) => id === "media.operation-slice.begin-upload")
    .ownerWireSchema.requestSchema.properties.expectedSizeBytes;
  const operation = operations.individualOperationContracts.records
    .find(({ id }) => id === "media.operation-slice.begin-upload");

  assert.equal(parameterSchema.properties.declaredByteLength.minimum, 1);
  assert.equal(parameterSchema.properties.declaredByteLength.maximum, 2147483648);
  assert.equal(parameterSchema.emptyDisposition, "NOT_EMPTY");
  assert.equal(expectedSize.minimum, 1);
  assert.equal(expectedSize.maximum, 2147483648);
  assert.match(operation.sourceBounds, /positive expected size/u);
  assert.equal(currentReview.decisionRef, ".product-experience/decision-log.md#PXD-153");
  assert.match(decisionText, /### PXD-153 — Reopen only the upload declared-byte-length minimum/u);
  assert.match(decisionText, /supersedes only PXD-142's historical interpretation/u);
  assert.equal(currentReview.source.currentSha256, "4b4b4f1ab5d4908c93af5c6b4c2be47008b04f75ac45160a1be5e167edbec42d",
    "PXD-153 remains pinned to its historical source cut");
  assert.equal(currentReview.correction.p0FieldRef,
    ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.artifact.upload/ownerDefinition/parameterSchema/properties/declaredByteLength");
  assert.equal(currentReview.correction.oldScalar.minimum, 0);
  assert.equal(currentReview.correction.newScalar.minimum, 1);
  assert.equal(currentReview.correction.newScalar.maximum, parameterSchema.properties.declaredByteLength.maximum);
  assert.equal(currentReview.correction.emptyDisposition, "NOT_EMPTY");
  assert.equal(currentReview.p1Evidence.expectedSizeBytesMinimum, expectedSize.minimum);
  assert.equal(currentReview.p1Evidence.expectedSizeBytesMaximum, expectedSize.maximum);
  assert.equal(currentReview.p1Evidence.preservedBoundary.maximumRequestBytes, 65536);
  assert.equal(currentReview.p1Evidence.preservedBoundary.runtimeAvailability, "NOT_ADMITTED");
  assert.equal(currentReview.p1Evidence.preservedBoundary.qualification, "NOT_ESTABLISHED");
  assert.equal(currentReview.regressionEvidence.status, "PASS");
  assert.equal(currentReview.regressionEvidence.tests, 1);
  assert.equal(currentReview.regressionEvidence.passed, 1);
  assert.equal(currentReview.regressionEvidence.failed, 0);
  assert.equal(currentReview.acceptanceEffect, "none; bounded current-source correction evidence only");
});

test("PXD-171 preserves its source-cut pin and its exact corrections remain present in current capability source", () => {
  const capabilityBytes = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capabilities.yaml"));
  const decisionText = readFileSync(resolve(root, ".product-experience/decision-log.md"), "utf8");
  const currentReview = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/p0-capability-corrections-current-source-review-current.json"), "utf8"));
  const predecessor142 = JSON.parse(readFileSync(resolve(root, correctionReviewPath), "utf8"));
  const predecessor153 = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/p0-upload-byte-length-minimum-current-source-review.json"), "utf8"));
  const byKey = new Map(currentReview.records.map((record) => [`${record.capabilityId}|${record.fieldPath}`, record]));
  const expected = new Map();
  for (const correction of predecessor142.typedInputCorrections) {
    expected.set(`${correction.capabilityId}|ownerDefinition.typedInputSlots`, correction.typedInputSlots);
  }
  for (const correction of predecessor142.optionalSuccessOutputCorrections) {
    expected.set(`${correction.capabilityId}|ownerDefinition.successOutputs`, correction.outputs);
  }
  expected.set("media.artifact.upload|ownerDefinition.parameterSchema.properties.declaredByteLength", predecessor153.correction.newScalar);

  assert.equal(currentReview.decisionRef, ".product-experience/decision-log.md#PXD-171");
  assert.match(decisionText, /### PXD-171 — Recheck retained capability corrections on the current P0 source/u);
  assert.equal(currentReview.source.path, ".product-experience/pdp-0-product-truth/capabilities.yaml");
  assert.equal(currentReview.source.currentSha256, "f9a979392587069dbb9c2a653fe9866e9b61ee31192725404ec01e5426291f5d");
  assert.notEqual(currentReview.source.currentSha256, sha256(capabilityBytes), "PXD-171 remains historical after the PXD-196 source change");
  assert.equal(currentReview.source.capabilityCount, 462);
  assert.equal(currentReview.records.length, 9);
  assert.equal(currentReview.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(currentReview.acceptanceEffect, "none; exact corrected subfields reviewed against current P0 source");
  assert.deepEqual([...byKey.keys()].sort(), [...expected.keys()].sort());

  for (const [key, expectedValue] of expected) {
    const record = byKey.get(key);
    const current = record.fieldPath.split(".").reduce((value, field) => value?.[field], byId.get(record.capabilityId));
    if (record.fieldPath.endsWith("declaredByteLength")) {
      assert.deepEqual({ minimum: current.minimum, maximum: current.maximum }, expectedValue, key);
      assert.equal(owner(record.capabilityId).parameterSchema.emptyDisposition, predecessor153.correction.emptyDisposition);
    } else if (record.fieldPath.endsWith("successOutputs")) {
      const projection = current.filter(({ artifactType }) => expectedValue.some((output) => output.artifactType === artifactType))
        .map(({ artifactType, requiredOnSuccess }) => ({ artifactType, requiredOnSuccess }));
      assert.deepEqual(projection, expectedValue, key);
    } else if (key === "media.artifact.derive|ownerDefinition.typedInputSlots") {
      assert.deepEqual(current.map((slot) => {
        if (slot.slotId !== "input1") return slot;
        const { optionalSemanticComponents: _addition, ...fields } = slot;
        return fields;
      }), expectedValue, key);
      assert.deepEqual(current[0].optionalSemanticComponents, [{
        id: "clipSourceTimeRange",
        when: "Requested output is a source-derived clip.",
        fields: { sourceTimeRange: "Required explicit interval in the exact source version timebase." },
        constraints: ["Never infer or rebase the interval without an explicit mapping contract."],
      }], "PXD-206 additive source-clip input semantics remain visible beside PXD-171 history");
      assert.equal(record.fieldSha256, "bc50817dce92660334b595f30f2dc9735d045499a843ce9d30fbff80b521d81c", key);
    } else {
      assert.deepEqual(current, expectedValue, key);
      assert.equal(record.fieldSha256, sha256(JSON.stringify(current)), key);
    }
    assert.equal(record.sourceRef,
      `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${record.capabilityId}/${record.fieldPath.replaceAll(".", "/")}`);
  }
});
