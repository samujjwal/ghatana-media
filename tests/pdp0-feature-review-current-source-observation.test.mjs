import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const readText = (path) => readFileSync(resolve(root, path), "utf8");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const pxd098Path = "docs/implementation/verification/pdp-38/feature-review-45-clause-material-review.json";
const pxd105Path = "docs/implementation/verification/pdp-38/direct-definition-criteria-review.json";
const sourcePath = ".product-experience/pdp-0-product-truth/quality-policy.yaml";
const observationPath = "docs/implementation/verification/pdp-38/feature-review-quality-current-source-observation.json";

test("PXD-098 quality referent observation records only the exact phase-noise applicability correction", () => {
  const pxd098Text = readText(pxd098Path);
  const pxd098 = JSON.parse(pxd098Text);
  const pxd105 = JSON.parse(readText(pxd105Path));
  const observation = JSON.parse(readText(observationPath));
  const sourceText = readText(sourcePath);
  const source = parse(sourceText);
  const metric = source.metricDefinitions.find(({ id }) => id === observation.record.identity);
  const cleanup = observation.currentSourceAuthorityCleanupObservation.records.find(({ identity }) => identity === observation.record.identity);
  const historicalReferent = pxd098.records.flatMap(({ referents = [] }) => referents)
    .find(({ identity }) => identity === observation.record.identity);
  const p0_07 = pxd105.records.find(({ taskId }) => taskId === "P0-07");

  assert.equal(hash(pxd098Text), observation.baseReviewSha256, "PXD-098 remains byte-for-byte immutable");
  assert.equal(observation.baseReviewRef, pxd098Path);
  assert.equal(observation.baseReviewSha256, "9294d3e13ee01e35bbe24b8cfaefec23316b17d43b969f057924a980e46cb922");
  assert.equal(observation.decisionRef, ".product-experience/decision-log.md#PXD-105");
  assert.equal(observation.currentCutRef, `${pxd105Path}#P0-07`);
  assert.equal(observation.currentCutDecisionRef, p0_07.decisionRef);
  assert.equal(p0_07.sourceFingerprints[sourcePath], observation.sourcePinSha256,
    "the historical source pin matches PXD-105 and is retained as history");
  assert.equal(observation.currentSourceSha256, "cc57b1aa3522114482e7cc2c13a3b8e4d6db92948b0a64d83d13c47a9ab6ac46",
    "PXD-124 remains pinned to its earlier observed quality source cut");
  assert.notEqual(hash(sourceText), observation.currentSourceSha256,
    "the additive P0 quality current-source review supersedes this preserved intermediate observation");
  assert.equal(cleanup.priorContentSha256, observation.record.currentContentSha256,
    "the original PXD-105 observation remains an exact historical record digest");
  assert.equal(hash(JSON.stringify(metric)), cleanup.currentContentSha256);
  assert.equal(historicalReferent.sourceRef, observation.record.sourceRef);
  assert.equal(historicalReferent.contentSha256, observation.record.historicalPxd098ContentSha256);
  assert.deepEqual(observation.record.changedPaths, [
    { path: ["ownerCurrentApplicability", "capabilityRefs"], removed: ["media.master.audio.phase-noise-floor-analyze"], added: [] },
    { path: ["ownerCurrentApplicability", "applicableCount"], prior: 117, current: 116 },
    { path: ["ownerCurrentApplicability", "notApplicableCount"], prior: 345, current: 346 },
  ], "the supplement names only the exact capability and denominator dispositions that changed");
  assert.equal(metric.ownerCurrentApplicability.capabilityRefs.includes("media.master.audio.phase-noise-floor-analyze"), false);
  assert.equal(metric.ownerCurrentApplicability.applicableCount + metric.ownerCurrentApplicability.notApplicableCount, 462);
  assert.equal(metric.scope, observation.record.preserved.scope);
  assert.deepEqual(metric.dimensionRefs, observation.record.preserved.dimensionRefs);
  assert.equal(observation.record.semanticParityRationale.includes("phase-noise-floor measurement"), true);
  assert.equal(observation.acceptanceEffect, "none");
  assert.equal(observation.additionalCurrentSourceObservation.acceptanceEffect, "none");
  assert.deepEqual(observation.additionalCurrentSourceObservation.changedPaths.map(({ path }) => path), [["integrationGaps", "capabilityReferences"], ["integrationGaps", "domainAndFidelityReferences"], ["integrationGaps", "privacyAndRightsGates"]]);
  assert.deepEqual(observation.additionalCurrentSourceObservation.resolvedOwnerApplicability, { dimensions: 6, metrics: 16, capabilityLeaves: 462, status: "COMPLETE_DEFINITION_ONLY", measurementAndCalibration: "NOT_EVALUATED", sourceRef: ".product-experience/pdp-0-product-truth/quality-policy.yaml#ownerQualityApplicabilityCrosswalk", rootCapabilityRefPlaceholdersRemoved: { dimensions: 6, metrics: 16 }, capabilityRefState: "P0 applicability is defined by the owner crosswalk", candidateQualificationState: "NOT_EVALUATED" });
  assert.match(observation.acceptanceBoundary, /does not renew PXD-098 material approval/u);
});

test("PXD-124 proposed supplement records exact duplicate-root-field removals without changing historical pins", () => {
  const observation = JSON.parse(readText(observationPath));
  const sourceText = readText(sourcePath);
  const source = parse(sourceText);
  const supplement = observation.currentSourceAuthorityCleanupObservation;
  const expected = [
    { id: "QUALITY-METRIC-AUDIO-LOUDNESS-TRUE-PEAK", priorHash: "e109dbbc2d8cb250c3220625a541e38d03eaca7b727515a4c9e693e99fb5c34e", currentHash: "a832079b794897c863842e628eb754f5912b2efc56a9075d97140a5023ead161", nestedHash: "c0b70301b87219e01c52bfa6c1e91a6d35b731654f23f3fed6632f7e1d2f54a4", priorState: "pending-P0-003-and-P0-008-integration" },
    { id: "QUALITY-METRIC-AUDIO-DEFECTS", priorHash: "5d7b7f7f12e1ad69f6ee97d102b4af58c59435b485c1d6bfc56bc6c60e8b3fa5", currentHash: "9a0a6634dc347fe6599735f5927539cf4bcf4a01a882b78cfbb7e1d2fc653436", nestedHash: "c0b70301b87219e01c52bfa6c1e91a6d35b731654f23f3fed6632f7e1d2f54a4", priorState: "pending-P0-003-integration" },
    { id: "QUALITY-METRIC-AUDIO-NATURALNESS", priorHash: "c9265c66a3278143df06fd4578d2ae10804f381877ad77396be42416a7965e7d", currentHash: "8e4f317e956321cd5821001dd8d8b52e24d2127f68a57f74da0eeb0ccc14c26d", nestedHash: "99755033356d67a631c3b6f2286eedabd55c5a806cf1291544e59f71b1bbad95", priorState: "pending-P0-003-integration" },
  ];
  assert.equal(supplement.proposedDecisionRef, ".product-experience/decision-log.md#PXD-124");
  assert.equal(supplement.status, "PROPOSED_ADDITIVE_CURRENT_SOURCE_SUPPLEMENT");
  assert.equal(supplement.acceptanceEffect, "none");
  assert.equal(supplement.sourcePinSha256, observation.sourcePinSha256);
  assert.equal(supplement.currentSourceSha256, observation.currentSourceSha256,
    "PXD-124 remains an internally consistent observation of its earlier source cut");
  assert.notEqual(supplement.currentSourceSha256, hash(sourceText),
    "the full P0 quality review owns the current source pin");
  assert.equal(supplement.records.length, expected.length);
  for (const item of expected) {
    const record = supplement.records.find(({ identity }) => identity === item.id);
    const metric = source.metricDefinitions.find(({ id }) => id === item.id);
    assert.equal(record.priorContentSha256, item.priorHash);
    assert.equal(record.currentContentSha256, item.currentHash);
    assert.deepEqual(record.changedPaths, [
      { path: ["capabilityRefs"], prior: [], current: "ABSENT" },
      { path: ["capabilityRefState"], prior: item.priorState, current: "ABSENT" },
    ]);
    assert.equal(Object.hasOwn(metric, "capabilityRefs"), false);
    assert.equal(Object.hasOwn(metric, "capabilityRefState"), false);
    assert.equal(hash(JSON.stringify(metric)), record.currentContentSha256);
    assert.equal(hash(JSON.stringify(metric.ownerCurrentApplicability)), record.preservedNestedOwnerApplicabilitySha256);
  }
});

test("PXD-098 defect and naturalness observations remain exact one-record supplements", () => {
  const pxd098 = JSON.parse(readText(pxd098Path));
  const pxd105 = JSON.parse(readText(pxd105Path));
  const sourceText = readText(sourcePath);
  const source = parse(sourceText);
  const p0_07 = pxd105.records.find(({ taskId }) => taskId === "P0-07");
  const expected = [
    {
      path: "docs/implementation/verification/pdp-38/feature-review-audio-defects-current-source-observation.json",
      id: "QUALITY-METRIC-AUDIO-DEFECTS", priorHash: "e9f9798be75dc293d8d3e2282a15bdfd387fcc86bc8b8b100dc7b550584a10bb",
      currentHash: "5d7b7f7f12e1ad69f6ee97d102b4af58c59435b485c1d6bfc56bc6c60e8b3fa5", priorApplicable: 117, currentApplicable: 116,
      priorExcluded: 345, currentExcluded: 346, scope: "Audio noise, clipping, distortion, intelligibility, and signal defects for a declared task.",
    },
    {
      path: "docs/implementation/verification/pdp-38/feature-review-audio-naturalness-current-source-observation.json",
      id: "QUALITY-METRIC-AUDIO-NATURALNESS", priorHash: "a42cc26400a1f75862b11c7d67fcb5892e0d018f58a01935e522a2c59350e21f",
      currentHash: "c9265c66a3278143df06fd4578d2ae10804f381877ad77396be42416a7965e7d", priorApplicable: 60, currentApplicable: 59,
      priorExcluded: 402, currentExcluded: 403, scope: "Naturalness of generated, converted, enhanced, or synthesized audio for a declared content and locale class.",
    },
  ];
  const sourceHash = hash(sourceText);
  const historicalQualitySourceHash = JSON.parse(readText(observationPath)).currentSourceSha256;
  assert.equal(p0_07.sourceFingerprints[sourcePath], "3e0f82742ca924248d3ea1ab83085d939ba67b445f9676935a82dd0a3871b3de");

  for (const item of expected) {
    const text = readText(item.path);
    const observation = JSON.parse(text);
    const metric = source.metricDefinitions.find(({ id }) => id === item.id);
    const cleanup = JSON.parse(readText(observationPath)).currentSourceAuthorityCleanupObservation.records.find(({ identity }) => identity === item.id);
    const referent = pxd098.records.flatMap(({ referents = [] }) => referents)
      .find(({ identity }) => identity === item.id);
    assert.equal(observation.currentSourceSha256, historicalQualitySourceHash);
    assert.notEqual(observation.currentSourceSha256, sourceHash);
    assert.equal(hash(JSON.stringify(metric)), cleanup.currentContentSha256);
    assert.equal(referent.contentSha256, item.priorHash);
    assert.equal(observation.record.historicalPxd098ContentSha256, item.priorHash);
    assert.equal(observation.record.currentContentSha256, item.currentHash);
    assert.equal(cleanup.priorContentSha256, item.currentHash);
    assert.equal(observation.record.preserved.scope, item.scope);
    assert.equal(observation.record.changedPaths[1].prior, item.priorApplicable);
    assert.equal(observation.record.changedPaths[1].current, item.currentApplicable);
    assert.equal(observation.record.changedPaths[2].prior, item.priorExcluded);
    assert.equal(observation.record.changedPaths[2].current, item.currentExcluded);
    assert.equal(metric.ownerCurrentApplicability.capabilityRefs.includes("media.master.audio.phase-noise-floor-analyze"), false);
    assert.equal(metric.ownerCurrentApplicability.applicableCount + metric.ownerCurrentApplicability.notApplicableCount, 462);
    assert.equal(observation.acceptanceEffect, "none");
    assert.equal(observation.scope.includes(item.id), true);
  }
});

test("animation owner observation pins one current PXD-098 referent without claiming parity or broader approval", () => {
  const artifactPath = "docs/implementation/verification/pdp-38/feature-review-animation-property-owner-current-source-observation.json";
  const pxd098Text = readText(pxd098Path);
  const pxd098 = JSON.parse(pxd098Text);
  const pxd105 = JSON.parse(readText(pxd105Path));
  const observation = JSON.parse(readText(artifactPath));
  const sourcePath = ".product-experience/pdp-1-domain-data/relationships.yaml";
  const sourceText = readText(sourcePath);
  const source = parse(sourceText);
  const record = source.relationships.find(({ id }) => id === observation.record.identity);
  const historicalReferent = pxd098.records.flatMap(({ referents = [] }) => referents)
    .find(({ identity }) => identity === observation.record.identity);
  const clause = pxd098.records.find(({ clauseId }) => clauseId === "media.feature-review-clause.animation-spatial.scene-graph-and-animation-clock");
  const p0_07 = pxd105.records.find(({ taskId }) => taskId === "P0-07");

  assert.equal(hash(pxd098Text), observation.baseReviewSha256);
  assert.equal(observation.sourcePinSha256, p0_07.sourceFingerprints[sourcePath]);
  assert.equal(hash(sourceText), observation.currentSourceSha256);
  assert.equal(hash(JSON.stringify(record)), observation.record.currentContentSha256);
  assert.equal(historicalReferent.contentSha256, observation.record.historicalPxd098ContentSha256);
  assert.equal(historicalReferent.sourceRef, observation.record.sourceRef);
  assert.equal(clause.criterion, "Scene hierarchy, animation clock domains, transforms and object identity use the normative animation rule and typed time descriptors.");
  assert.equal(record.ownerDefinition.ownerDecisionId, "PXD-119");
  assert.deepEqual(observation.record.changedPaths.map(({ path }) => path), [["sourceRefs"], ["scopeStatus"], ["ownerDefinition"]]);
  assert.deepEqual(observation.record.changedPaths[2].current, record.ownerDefinition);
  assert.equal(observation.record.sourceInterpretation.includes("byte or semantic parity"), true);
  assert.equal(observation.acceptanceEffect, "none");
  assert.equal(observation.scope.includes("does not create a PDP-0 prerequisite"), true);
  assert.equal(observation.acceptanceBoundary.includes("no approval of unrelated animation/spatial contracts"), true);
});

test("text-to-image observation records the exact P0/P1 decoupling delta without asserting equivalence", () => {
  const artifactPath = "docs/implementation/verification/pdp-38/feature-review-current-source-observation.json";
  const sourcePath = ".product-experience/pdp-0-product-truth/capabilities.yaml";
  const correctionPath = "docs/implementation/verification/pdp-38/feature-review-45-clause-reference-correction.json";
  const sourceText = readText(sourcePath);
  const source = parse(sourceText);
  const observation = JSON.parse(readText(artifactPath));
  const pxd098Text = readText(pxd098Path);
  const pxd098 = JSON.parse(pxd098Text);
  const correction = JSON.parse(readText(correctionPath));
  const pxd105 = JSON.parse(readText(pxd105Path));
  const semanticReview = JSON.parse(readText("docs/implementation/verification/pdp-38/p0-capability-semantic-current-source-review.json"));
  const leaf = source.capabilities.find(({ id }) => id === observation.record.identity);
  const historicalReferent = pxd098.records.flatMap(({ referents = [] }) => referents)
    .find(({ identity }) => identity === observation.record.identity);
  const p0_07 = pxd105.records.find(({ taskId }) => taskId === "P0-07");
  const correctionRecord = correction.records.find(({ identity }) => identity === observation.record.identity);
  const expectedPaths = [
    ["supportedParameters"], ["executionResourceRequirements"], ["ownerDefinition", "ownerDisposition"],
    ["ownerDefinition", "operationRefs"], ["ownerDefinition", "operationKind"], ["ownerDefinition", "operationContractRef"],
    ["ownerDefinition", "typedInputSlots", "0", "payloadSchemaRef"], ["ownerDefinition", "typedInputSlots", "1", "payloadSchemaRef"],
    ["ownerDefinition", "successOutputs", "0", "payloadSchemaRef"], ["ownerDefinition", "idempotency"],
    ["ownerDefinition", "recovery"], ["ownerDefinition", "canonicalAuthorityRefs"],
    ["ownerDefinition", "capabilityIntentId"], ["intentBindingState"], ["requirementTraceState"], ["semanticReferenceScope"],
  ];
  assert.equal(hash(pxd098Text), observation.baseReviewSha256);
  assert.equal(observation.decisionRef, ".product-experience/decision-log.md#PXD-105");
  assert.equal(observation.referenceCorrectionDecisionRef, ".product-experience/decision-log.md#PXD-101");
  assert.equal(p0_07.sourceFingerprints[sourcePath], observation.sourcePinSha256);
  assert.equal(observation.currentSourceSha256, "8e036751e35623a972668757082e1cc6f6c519d23d7f829a73cae1d117568b25",
    "the PXD-105 text-to-image observation remains pinned to its historical source cut");
  assert.notEqual(hash(sourceText), observation.currentSourceSha256,
    "later semantic corrections are recorded in a separate current-source review");
  assert.notEqual(hash(JSON.stringify(leaf)), observation.record.currentContentSha256,
    "the old record digest remains historical and is not presented as the current record");
  assert.equal(semanticReview.decisionRef, ".product-experience/decision-log.md#PXD-122");
  assert.equal(semanticReview.source.currentSha256, hash(sourceText));
  assert.equal(semanticReview.source.historicalComparison.priorSha256, observation.currentSourceSha256);
  assert.equal(semanticReview.source.historicalComparison.parsedPathDelta, "NOT_ASSERTED");
  assert.equal(historicalReferent.contentSha256, observation.record.historicalPxd098ContentSha256);
  assert.equal(correctionRecord.currentContentSha256, observation.record.priorPxd101CurrentContentSha256);
  assert.deepEqual(observation.record.changedPaths.map(({ path }) => path), expectedPaths);
  assert.equal(leaf.ownerDefinition.capabilityIntentId, leaf.id);
  assert.deepEqual(leaf.inputArtifactTypes, leaf.ownerDefinition.typedInputSlots.map(({ sourceType }) => sourceType));
  assert.equal(observation.record.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(observation.acceptanceEffect, "none");
  assert.equal(semanticReview.source.currentSha256, hash(sourceText));
  assert.notEqual(observation.record.currentContentSha256, hash(JSON.stringify(leaf)));
  assert.match(observation.record.interpretation, /does not claim that the record is unchanged/u);
  assert.match(observation.acceptanceBoundary, /No new clause approval/u);
});

test("capability-wide owner binding observation preserves all 462 P0 identities and P0-010 status", () => {
  const sourcePath = ".product-experience/pdp-0-product-truth/capabilities.yaml";
  const observationPath = "docs/implementation/verification/pdp-38/p0-capability-intent-owner-binding-current-source-observation.json";
  const sourceText = readText(sourcePath);
  const source = parse(sourceText);
  const observationText = readText(observationPath);
  const observation = JSON.parse(observationText);
  const semanticReview = JSON.parse(readText("docs/implementation/verification/pdp-38/p0-capability-semantic-current-source-review.json"));
  assert.equal(observation.source.currentSha256, semanticReview.source.historicalComparison.priorSha256,
    "PXD-121 remains pinned to its observed historical source cut");
  assert.equal(semanticReview.source.currentSha256, hash(sourceText));
  assert.equal(semanticReview.source.historicalComparison.parsedPathDelta, "NOT_ASSERTED");
  assert.equal(observation.source.recordPopulation.count, 462);
  assert.equal(observation.source.recordPopulation.identitySetChange, "none");
  assert.equal(source.capabilities.length, 462);
  assert.ok(source.capabilities.every(row => row.ownerDefinition.capabilityIntentId === row.id));
  assert.ok(source.capabilities.every(row => row.intentBindingState.startsWith("P0_OWNER_DEFINED_CAPABILITY_INTENT")));
  assert.equal(source.ownerDefinedCapabilityIntentBinding.id, "media.capability-intent.owner-binding.v1");
  assert.match(source.ownerDefinedCapabilityIntentBinding.exactLeafMeaningRule, /ownerDisposition selects its meaning/u);
  assert.match(source.ownerDefinedCapabilityIntentBinding.exactLeafMeaningRule, /does not relabel journey or platform records as machine capabilities/u);
  assert.equal(observation.acceptanceEffect.includes("independent P0-010 semantic acceptance remains pending"), true);
  assert.equal(hash(observationText), "e33af569db9ea0b510af334af8dfc4ae2e2c05cd0b2fa32e57a889e94023ba7a");
});

test("policy-authority observation records exact substantive fallback and offline additions without asserting parity", () => {
  const artifactPath = "docs/implementation/verification/pdp-38/feature-review-policy-authority-current-source-observation.json";
  const sourcePath = ".product-experience/pdp-0-product-truth/policy-authority-model.yaml";
  const sourceText = readText(sourcePath);
  const source = parse(sourceText);
  const observation = JSON.parse(readText(artifactPath));
  const pxd098Text = readText(pxd098Path);
  const pxd098 = JSON.parse(pxd098Text);
  const pxd105 = JSON.parse(readText(pxd105Path));
  const record = source.modelAcquisitionAndFallback;
  assert.equal(source.productPolicy.semanticOwner, "media");
  assert.ok(Object.values(source.productPolicy.platformMechanics).every(({ owner }) => typeof owner === "string" && owner.length > 0));
  assert.ok(source.productPolicy.independentGovernanceAxes.every(({ policyOwner }) => typeof policyOwner === "string" && policyOwner.length > 0));
  assert.match(source.productPolicy.requirementBinding, /owner-role bindings resolve through the named semanticOwner, mechanics owner, and policyOwner mappings/u);
  assert.match(source.productPolicy.requirementBinding, /pending-P0-010/u);
  const historicalReferent = pxd098.records.flatMap(({ referents = [] }) => referents)
    .find(({ identity }) => identity === observation.record.identity);
  const p0_07 = pxd105.records.find(({ taskId }) => taskId === "P0-07");
  assert.equal(hash(pxd098Text), observation.baseReviewSha256);
  assert.equal(observation.sourcePinSha256, p0_07.sourceFingerprints[sourcePath]);
  assert.equal(hash(sourceText), observation.currentSourceSha256);
  assert.equal(hash(JSON.stringify(record)), observation.record.currentContentSha256);
  assert.equal(historicalReferent.sourceRef, observation.record.sourceRef);
  assert.equal(historicalReferent.contentSha256, observation.record.historicalPxd098ContentSha256);
  assert.deepEqual(observation.record.changedPaths.map(({ path, prior, current }) => ({ path, prior, current })), [
    { path: ["fallback", "compatibilityDecisionRule"], prior: null, current: record.fallback.compatibilityDecisionRule },
    { path: ["offlineEntitlementWindow"], prior: null, current: record.offlineEntitlementWindow },
  ]);
  assert.equal(record.fallback.compatibilityDecisionRule.id, "media.policy.fallback-compatibility-decision.v1");
  assert.equal(record.offlineEntitlementWindow.id, "media.policy.offline-entitlement-validity-window.v1");
  assert.equal(observation.record.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(observation.acceptanceEffect, "none");
  assert.equal(observation.additionalCurrentSourceObservation.acceptanceEffect, "none");
  assert.deepEqual(observation.additionalCurrentSourceObservation.changedPaths.map(({ path }) => path), [["productPolicy", "requirementBinding"]]);
  assert.equal(observation.additionalCurrentSourceObservation.changedPaths[0].current, source.productPolicy.requirementBinding);
  assert.match(observation.acceptanceBoundary, /does not renew clause approval/u);
});

test("CLI channel observation records exact additions beyond PXD-098/PXD-105 without asserting parity", () => {
  const artifactPath = "docs/implementation/verification/pdp-38/feature-review-cli-channel-current-source-observation.json";
  const sourcePath = ".product-experience/pdp-0-product-truth/applications-channels.yaml";
  const sourceText = readText(sourcePath);
  const source = parse(sourceText);
  const observation = JSON.parse(readText(artifactPath));
  const pxd098Text = readText(pxd098Path);
  const pxd098 = JSON.parse(pxd098Text);
  const correction = JSON.parse(readText("docs/implementation/verification/pdp-38/feature-review-45-clause-reference-correction.json"));
  const pxd105 = JSON.parse(readText(pxd105Path));
  const record = source.channels.find(({ id }) => id === observation.record.identity);
  const historicalReferent = pxd098.records.flatMap(({ referents = [] }) => referents)
    .find(({ sourceRef, identity }) => sourceRef === observation.record.sourceRef && identity === observation.record.identity);
  const p0_07 = pxd105.records.find(({ taskId }) => taskId === "P0-07");
  const cliCorrection = correction.records.find(({ identity }) => identity === "media.channel.cli");
  assert.equal(hash(pxd098Text), observation.baseReviewSha256);
  assert.equal(observation.sourcePinSha256, p0_07.sourceFingerprints[sourcePath]);
  assert.equal(hash(sourceText), observation.currentSourceSha256);
  assert.equal(hash(JSON.stringify(record)), observation.record.currentContentSha256);
  assert.equal(historicalReferent.contentSha256, observation.record.historicalPxd098ContentSha256);
  assert.equal(cliCorrection, undefined, "PXD-101's exact correction is unrelated to this CLI referent");
  assert.deepEqual(observation.record.changedPaths.map(({ path, prior, current }) => ({ path, prior, current })), [
    { path: ["ownerCliDefinitionContract", "commandSurfaceSeparationRule"], prior: null, current: record.ownerCliDefinitionContract.commandSurfaceSeparationRule },
    { path: ["ownerCliDefinitionContract", "filenameArgumentRule"], prior: null, current: record.ownerCliDefinitionContract.filenameArgumentRule },
    { path: ["ownerCliDefinitionContract", "remoteCancellationRule"], prior: null, current: record.ownerCliDefinitionContract.remoteCancellationRule },
    { path: ["ownerCliDefinitionContract", "submissionWaitRule"], prior: null, current: record.ownerCliDefinitionContract.submissionWaitRule },
    { path: ["ownerCliDefinitionContract", "machineOutputRule"], prior: null, current: record.ownerCliDefinitionContract.machineOutputRule },
    { path: ["ownerCliDefinitionContract", "configurationPrecedenceRule"], prior: null, current: record.ownerCliDefinitionContract.configurationPrecedenceRule },
  ]);
  assert.equal(observation.record.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(observation.acceptanceEffect, "none");
  assert.equal(observation.currentSourceSha256, hash(sourceText));
  assert.equal(observation.additionalCurrentSourceObservation.acceptanceEffect, "none");
  assert.deepEqual(observation.additionalCurrentSourceObservation.changedPaths.map(({ path }) => path), [["ownerFeatureReviewApplicability", "sourceContractSelectors", "leafCapabilityProfileBoundsChannel"], ["ownerFeatureReviewApplicability", "sourceContractSelectors", "leafCapabilityProfileBoundsChannelRole"], ["ownerFeatureReviewApplicability", "sourceContractSelectors", "canonicalCapabilityOperationRole"]]);
  assert.match(observation.acceptanceBoundary, /No new clause approval/u);
});
