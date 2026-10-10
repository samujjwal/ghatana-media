import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const parse = require("yaml").parse;
const p0 = (name) => parse(readFileSync(resolve(root, `.product-experience/pdp-0-product-truth/${name}.yaml`), "utf8"));
const id = "media.master.audio.phase-noise-floor-analyze";
const measurement = "phase-noise-floor-measurement-record";
const mastered = "mastered-audio-candidate-with-measurements";

test("PXD-117 phase/noise-floor capability keeps its exact P0 measurement identity", () => {
  const capability = p0("capabilities").capabilities.find((row) => row.id === id);
  assert.ok(capability, `${id} exists as a P0 capability`);
  assert.equal(capability.operation, "phase-noise-floor-analyze");
  assert.equal(capability.label, "Analyze phase/noise floor");
  assert.deepEqual(capability.inputArtifactTypes, ["audio-artifact", "delivery-and-loudness-context"]);
  assert.deepEqual(capability.ownerDefinition.typedInputSlots, [
    { slotId: "input1", sourceType: "audio-artifact", cardinality: "EXACTLY_ONE", required: true },
    { slotId: "input2", sourceType: "delivery-and-loudness-context", cardinality: "EXACTLY_ONE", required: true },
  ]);
  assert.deepEqual(capability.outputArtifactTypes, [measurement]);
  assert.deepEqual(capability.ownerDefinition.successOutputs, [{ artifactType: measurement, requiredOnSuccess: true }]);
  assert.deepEqual(capability.ownerDefinition.nonSuccessOutputs, { REJECTED: [], UNKNOWN_OUTCOME: [] });

  const contract = capability.ownerDefinition.semanticOutcomeContract;
  assert.equal(contract.result, capability.outcome);
  assert.match(capability.outcome, /supplied audio is analyzed for phase and noise-floor properties under its delivery and loudness context/u);
  assert.match(capability.outcome, /measurement record without implying audio repair/u);
  assert.equal(contract.outputDistinctions.length, 2);
  assert.match(contract.outputDistinctions[0], /measurement record, not a modified\/mastered audio artifact/u);
  assert.match(contract.outputDistinctions[0], /do not imply repair/u);
  assert.match(contract.outputDistinctions[1], /does not mutate the audio artifact/u);
  assert.match(contract.unknownDisposition, /remain explicitly unknown/u);
  assert.match(contract.unknownDisposition, /block before dispatch/u);
  assert.match(contract.unknownDisposition, /do not silently substitute/u);
  assert.equal(capability.ownerDefinition.effect.effectIntentScope, "OBSERVATION_ONLY");
  assert.equal(capability.ownerDefinition.effect.noSilentFallback, true);

  const sourceLineage = capability.provenance.join(" ");
  assert.match(sourceLineage, /exact artifact\/version/u);
  assert.match(sourceLineage, /unknown linkage remains UNKNOWN/u);
  assert.ok(contract.sourceRefs.includes(
    `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${id}/ownerDefinition/typedInputSlots`));
  assert.ok(contract.sourceRefs.includes(
    `.product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerTrustReconstructionDispositions/records/@id=media.capability-trust-reconstruction.media-capability-adjudication-master-audio-phase-noise-floor-analyze.v1`));
});

test("current P0 owner review and trust records preserve measurement semantics and fail closed", () => {
  const review = p0("capability-leaf-review");
  const adjudication = review.ownerCapabilityLeafAdjudication.records.find((row) => row.capabilityRef === id);
  const trust = review.ownerTrustReconstructionDispositions.records.find((row) => row.capabilityRef === id);
  assert.ok(adjudication);
  assert.deepEqual(adjudication.inputArtifactTypes, ["audio-artifact", "delivery-and-loudness-context"]);
  assert.deepEqual(adjudication.outputArtifactTypes, [measurement]);
  assert.match(adjudication.normativeMeaning, /product intent only/u);

  assert.ok(trust);
  assert.deepEqual(trust.inputArtifactTypes, ["audio-artifact", "delivery-and-loudness-context"]);
  assert.deepEqual(trust.outputArtifactTypes, [measurement]);
  assert.equal(trust.outputBranches.length, 1);
  const branch = trust.outputBranches[0];
  assert.equal(branch.outputArtifactType, measurement);
  assert.equal(branch.outcomes.length, 1);
  const outcome = branch.outcomes[0];
  assert.equal(outcome.disposition, "NO_RECONSTRUCTION_OR_INFERENCE");
  assert.equal(outcome.epistemicRole, "MEASUREMENT_RECORD_NOT_TRANSFORMED_MEDIA");
  assert.match(outcome.meaning, /exact typed phase-noise-floor measurement record/u);
  assert.match(outcome.meaning, /bound audio artifact version/u);
  assert.match(outcome.meaning, /not mastered audio or an audio derivative/u);
  assert.match(outcome.meaning, /does not itself modify or produce the measured source audio/u);
  assert.match(outcome.meaning, /missing or mismatched source identity.*remains UNKNOWN/u);
  assert.match(trust.unknownPolicy, /UNKNOWN_OR_ABSTAINED/u);
  assert.match(trust.unknownPolicy, /reject foreign\/stale source/u);
  assert.match(trust.unknownPolicy, /missing capability identity or current authority/u);
});

test("current P0 quality joins use the measurement record as the phase metric subject", () => {
  const capability = p0("capabilities").capabilities.find((row) => row.id === id);
  const quality = p0("quality-policy");
  const crosswalk = quality.ownerQualityApplicabilityCrosswalk;
  const row = crosswalk.records.find((record) => record.capabilityRef === id);
  assert.ok(row, "current quality applicability row joins to the exact capability identity");
  assert.equal(row.ownerCapabilityIntentRef,
    `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${id}`);
  assert.equal(row.ownerOutputSemanticShapeRef, `${row.ownerCapabilityIntentRef}/outputArtifactTypes`);
  assert.deepEqual(row.inputArtifactTypes, capability.inputArtifactTypes);
  assert.deepEqual(row.outputArtifactTypes, [measurement]);

  const phase = row.metricApplicability["QUALITY-METRIC-AUDIO-SPECTRAL-PHASE"];
  assert.equal(phase.status, "APPLICABLE");
  assert.deepEqual(phase.subjectInputArtifactTypes, ["audio-artifact"]);
  assert.deepEqual(phase.subjectOutputArtifactTypes, [measurement]);
  assert.deepEqual(phase.requiredReferenceArtifactTypes, []);
  assert.equal(phase.measurementState, "NOT_EVALUATED");
  assert.equal(phase.qualificationState, "NOT_EVALUATED");
  assert.deepEqual(row.ownerMeasurementBindings, [{ metricRef: "QUALITY-METRIC-AUDIO-SPECTRAL-PHASE", outputArtifactTypes: [measurement] }]);
  for (const metricRef of ["QUALITY-METRIC-AUDIO-DEFECTS", "QUALITY-METRIC-AUDIO-LOUDNESS-TRUE-PEAK", "QUALITY-METRIC-AUDIO-NATURALNESS"]) {
    assert.equal(row.metricApplicability[metricRef].status, "NOT_APPLICABLE", metricRef);
    assert.deepEqual(row.metricApplicability[metricRef].subjectOutputArtifactTypes, [], metricRef);
  }

  const ownerRecords = [capability, ...crosswalk.records.filter((record) => record.capabilityRef === id)];
  const adjudication = p0("capability-leaf-review").ownerCapabilityLeafAdjudication.records.find((record) => record.capabilityRef === id);
  const trust = p0("capability-leaf-review").ownerTrustReconstructionDispositions.records.find((record) => record.capabilityRef === id);
  ownerRecords.push(adjudication, trust);
  for (const record of ownerRecords) {
    assert.ok(!JSON.stringify(record).includes(mastered), "no current P0 owner record substitutes mastered audio");
  }
});
