import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fingerprintPxdDecisionSection } from "../scripts/lib/pdp0-phase-scoped-source-fingerprints.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const sha256 = text => createHash("sha256").update(text).digest("hex");
const readText = path => readFileSync(resolve(root, path), "utf8");
const readYaml = path => parse(readText(path));

const paths = {
  capabilities: ".product-experience/pdp-0-product-truth/capabilities.yaml",
  trust: ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml",
  quality: ".product-experience/pdp-0-product-truth/quality-policy.yaml",
  goals: ".product-experience/pdp-0-product-truth/goals-jtbd.yaml",
  requirements: ".product-experience/pdp-0-product-truth/requirements.yaml",
  channels: ".product-experience/pdp-0-product-truth/applications-channels.yaml",
  profiles: ".product-experience/pdp-0-product-truth/profile-semantics.yaml",
};

const expected = [
  ["media.project.organize", ["outcome", "ownerDefinition"]],
  ["media.artifact.import", ["outcome", "ownerDefinition"]],
  ["media.artifact.list", ["supportedParameters"]],
  ["media.artifact.search", ["outcome", "supportedParameters", "ownerDefinition"]],
  ["media.artifact.derive", ["outcome", "ownerDefinition"]],
  ["media.multimodal.describe", ["outcome", "ownerDefinition"]],
  ["media.multimodal.summarize", ["outcome", "ownerDefinition"]],
  ["media.audio.analysis.detect.beat-onset", ["outcome", "ownerDefinition"]],
  ["media.speech.synthesis.speaker.condition", ["inputArtifactTypes", "outcome", "ownerDefinition"]],
  ["media.generate.spatial.create.spatial-audio", ["outcome", "ownerDefinition"]],
  ["media.animation.material", ["explicitUnsupportedCases", "outcome", "ownerDefinition"]],
  ["media.edit.inpaint", ["outputArtifactTypes", "ownerDefinition"]],
  ["media.edit.matte", ["outputArtifactTypes", "ownerDefinition"]],
  ["media.edit.retime-slow-motion-speed-ramp", ["outcome", "outputArtifactTypes", "ownerDefinition"]],
  ["media.compose.multitrack-timeline", ["outcome", "outputArtifactTypes", "ownerDefinition"]],
  ["media.compose.safe-area", ["outcome", "outputArtifactTypes", "ownerDefinition"]],
  ["media.compose.reusable-composition", ["outcome", "outputArtifactTypes", "ownerDefinition"]],
  ["media.master.audio.stereo-width", ["explicitUnsupportedCases", "inputArtifactTypes", "outcome", "ownerDefinition"]],
  ["media.quality.rank", ["outcome", "ownerDefinition"]],
  ["media.deliver.subtitles", ["outcome", "ownerDefinition"]],
];

const reviewPath = "docs/implementation/verification/pdp-38/p0-capability-meaning-20-leaf-current-source-review-pxd216.json";
const refs = {
  requirement: id => `${paths.requirements}#requirements/@id=${id}`,
  channelRecord: id => `${paths.trust}#ownerCapabilityLeafAdjudication/records/@capabilityRef=${id}/channelApplicability`,
};

function sourceDocuments() {
  return Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, readYaml(path)]));
}

function recordsById(records, key) {
  return new Map((records ?? []).map(record => [record[key], record]));
}

function findGoal(goals, id) {
  return goals.outcomes?.find(goal => goal.id === id);
}

function applicabilityFor(documents, capabilityId, adjudication) {
  const ownerRow = adjudication.get(capabilityId);
  if (ownerRow?.channelApplicability?.length) return ownerRow.channelApplicability;
  return documents.channels.coordinatorDefinitionExtensionApplicability?.records
    ?.find(record => record.capabilityRef === capabilityId)?.declaredSupportedChannelRefs ?? [];
}

test("PXD-216 enumerates and pins the current 20-leaf PDP-0 meaning review", () => {
  assert.ok(existsSync(resolve(root, reviewPath)),
    `PXD-216 current source review artifact is intentionally awaited: ${reviewPath}`);
  const review = JSON.parse(readText(reviewPath));
  assert.equal(review.decisionRef, ".product-experience/decision-log.md#PXD-216");
  assert.equal(review.ownerApproval, "NOT_CLAIMED");
  assert.equal(review.independentAcceptance, "NOT_CLAIMED");
  assert.equal(review.acceptanceEffect, "none");
  assert.equal(review.validation?.status, "PASS");
  assert.equal(review.validation?.testCount, review.validation?.passed);
  assert.equal(review.validation?.failed, 0);
  assert.deepEqual([...review.reviewedCapabilityIds].sort(), expected.map(([id]) => id).sort());
  assert.equal(new Set(review.reviewedCapabilityIds).size, expected.length);
  const changedFieldsById = new Map(review.changedFieldCoverage.map(({ capabilityId, fields }) => [capabilityId, fields]));
  for (const [id, fields] of expected) {
    assert.deepEqual(changedFieldsById.get(id), fields, `${id} PXD-216 changed-field coverage is exact`);
  }
  assert.equal(changedFieldsById.size, expected.length, "PXD-216 changed-field coverage contains exactly the reviewed leaves");

  const documents = sourceDocuments();
  for (const path of Object.values(paths).filter(path => path !== paths.capabilities)) {
    assert.equal(review.sourceFingerprints?.[path], sha256(readText(path)), `${path} is pinned to current bytes`);
  }
  const pxd216HistoricalCapabilities = execFileSync("git", ["show", `HEAD:${paths.capabilities}`], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  assert.equal(review.sourceFingerprints?.[paths.capabilities], sha256(pxd216HistoricalCapabilities),
    "PXD-216 retains its historical full-file source pin; PXD-223 establishes currentness for the unchanged reviewed slice");
  assert.equal(review.sourceFingerprints?.[`${paths.capabilities}#PXD-216-reviewed-capability-rows`], undefined,
    "source pins are file-current; the reviewed ID set is asserted separately");

  const capabilities = recordsById(documents.capabilities.capabilities, "id");
  const families = recordsById(documents.capabilities.families, "id");
  const requirements = recordsById(documents.requirements.requirements, "id");
  const trustRecords = recordsById(documents.trust.ownerTrustReconstructionDispositions.records, "capabilityRef");
  const ownerRows = recordsById(documents.trust.ownerCapabilityLeafAdjudication.records, "capabilityRef");
  const channelIds = new Set([
    ...(documents.channels.channels ?? []).map(row => row.id),
    ...(documents.channels.ownerDefinedChannels?.records ?? []).map(row => row.id),
  ]);
  const goalIds = new Set((documents.goals.outcomes ?? []).map(goal => goal.id));
  const intentIds = new Set((documents.goals.intents ?? []).map(intent => intent.id));

  for (const [id, changedFields] of expected) {
    const capability = capabilities.get(id);
    assert.ok(capability, `${id} exists once in capabilities`);
    assert.deepEqual(documents.capabilities.capabilities.filter(row => row.id === id).map(row => row.id), [id]);
    for (const field of changedFields) assert.ok(capability[field] !== undefined, `${id}.${field} is present`);

    const family = families.get(capability.familyId);
    assert.ok(family, `${id} resolves one family`);
    assert.equal(documents.capabilities.families.filter(row => row.id === capability.familyId).length, 1);
    assert.ok(family.capabilityIds?.includes(id), `${id} is listed in its unique family`);
    assert.equal(capability.requirementIds?.length, 1, `${id} has one family requirement`);
    const requirementId = capability.requirementIds[0];
    const requirement = requirements.get(requirementId);
    assert.ok(requirement, `${id} requirement ${requirementId} resolves`);
    assert.equal(documents.requirements.requirements.filter(row => row.id === requirementId).length, 1);
    assert.ok(requirement.acceptanceCases?.length > 0, `${requirementId} defines acceptance cases`);
    const acceptanceRefs = capability.ownerDefinition?.semanticOutcomeContract?.sourceRefs?.filter(ref =>
      ref.startsWith(`${paths.requirements}#requirements/@id=${requirementId}/acceptanceCases/@id=`)) ?? [];
    if (acceptanceRefs.length) {
      for (const ref of acceptanceRefs) {
        const caseId = ref.split("/acceptanceCases/@id=")[1];
        assert.ok(requirement.acceptanceCases.some(candidate => candidate.id === caseId), `${id} acceptance ref ${caseId} resolves`);
      }
    } else {
      assert.ok(requirement.acceptanceCases.some(candidate => candidate.id), `${id} has a resolvable family acceptance-case target`);
    }

    assert.ok(capability.actorRefs?.length && capability.actorRoles?.length, `${id} has actors and role labels`);
    assert.ok(capability.outcomeRefs?.length && capability.outcomeRefs.every(ref => goalIds.has(ref)), `${id} outcome refs resolve`);
    assert.ok(capability.inputArtifactTypes?.length && capability.outputArtifactTypes?.length, `${id} has typed inputs and outputs`);
    assert.ok(capability.intentRefs?.length && capability.intentRefs.every(ref => intentIds.has(ref)), `${id} intent refs resolve`);
    assert.equal(capability.ownerDefinition?.capabilityIntentId, id);
    assert.ok(capability.ownerDefinition?.familyProfileRef, `${id} binds a profile`);
    assert.ok(capability.ownerDefinition?.boundsRef, `${id} binds a bounds definition`);

    const trust = trustRecords.get(id);
    assert.ok(trust, `${id} has a trust disposition`);
    assert.ok(trust.outputBranches?.length, `${id} trust disposition covers output branches`);
    const owner = ownerRows.get(id);
    assert.ok(owner, `${id} has an owner-adjudication applicability row`);
    const channels = applicabilityFor(documents, id, ownerRows);
    assert.ok(channels.length, `${id} has channel applicability via owner row or PXD-207 extension`);
    for (const channel of channels) {
      const channelRef = typeof channel === "string" ? channel : channel.channelRef;
      if (channelRef) assert.ok(channelIds.has(channelRef), `${id} channel ${channelRef} resolves`);
    }

    assert.equal(capability.definitionState, "IN_SCOPE_DRAFT", `${id} remains a PDP-0 draft definition`);
    assert.match(capability.intentBindingState, /independent P0-010 semantic acceptance remains pending/iu,
      `${id} does not claim independent acceptance`);
    assert.equal(capability.supportDimensions?.runtimeAvailability, "UNKNOWN");
    assert.equal(capability.supportDimensions?.qualificationState, "NOT_EVALUATED");
  }
});

test("PXD-223 refreshes only source currentness for the preserved PXD-216 20-leaf review", () => {
  const currentness = JSON.parse(readText("docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd223.json"));
  const review = JSON.parse(readText(reviewPath));
  const liveBytes = readText(paths.capabilities);
  const historicalBytes = execFileSync("git", ["show", `HEAD:${paths.capabilities}`], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  const historical = parse(historicalBytes);
  const live = parse(liveBytes);
  const ids = review.reviewedCapabilityIds;
  const project = document => ids.map(id => {
    const rows = document.capabilities.filter(row => row.id === id);
    assert.equal(rows.length, 1, `${id} occurs exactly once`);
    return rows[0];
  });
  const historicalSlice = project(historical);
  const liveSlice = project(live);
  const sliceHash = rows => sha256(JSON.stringify(rows));

  assert.equal(currentness.decisionRef, ".product-experience/decision-log.md#PXD-223");
  assert.equal(currentness.authority.ownerApproval, "NOT_CLAIMED");
  assert.equal(currentness.authority.independentAcceptance, "NOT_CLAIMED");
  assert.equal(currentness.authority.acceptanceEffect, "none");
  assert.equal(currentness.authority.closure, "NOT_CLAIMED");
  assert.equal(currentness.currentSource.capabilitiesSha256, sha256(liveBytes));
  assert.equal(currentness.currentSource.capabilitiesSha256, "b688138bbdb6687a6f72b8faebbcd3fd24b4b0fcaef45131be431ab09ea3eeac");
  assert.equal(sha256(historicalBytes), currentness.preservedSemanticReview.historicalCapabilitiesSha256);
  assert.equal(currentness.preservedSemanticReview.historicalCapabilitiesSha256, "1c0daf9ee0cd600ec097baca0dded1d58d1803f6c147716a076705c37ad8cc26");
  assert.equal(sliceHash(historicalSlice), currentness.preservedSemanticReview.historicalReviewedRowsSha256);
  assert.equal(sliceHash(liveSlice), currentness.preservedSemanticReview.currentReviewedRowsSha256);
  assert.deepEqual(liveSlice, historicalSlice);
  assert.deepEqual(currentness.preservedSemanticReview.changedReviewedCapabilityIds, []);

  const historicalById = new Map(historical.capabilities.map(row => [row.id, row]));
  const liveById = new Map(live.capabilities.map(row => [row.id, row]));
  const changedRows = live.capabilities.flatMap(row => {
    const prior = historicalById.get(row.id);
    if (!prior || JSON.stringify(prior) === JSON.stringify(row)) return [];
    const priorOtherFields = { ...prior }; delete priorOtherFields.scopeStatus;
    const liveOtherFields = { ...row }; delete liveOtherFields.scopeStatus;
    assert.deepEqual(liveOtherFields, priorOtherFields, `${row.id} changes only scopeStatus`);
    return [{ capabilityId: row.id, field: "scopeStatus", from: prior.scopeStatus, to: row.scopeStatus }];
  });
  assert.deepEqual(live.capabilities.map(row => row.id).filter(id => !historicalById.has(id)), []);
  assert.deepEqual(historical.capabilities.map(row => row.id).filter(id => !liveById.has(id)), []);
  assert.deepEqual(currentness.currentSource.populationDelta.changedRows, changedRows);
  assert.equal(changedRows.length, 7);
  assert.equal(currentness.currentSource.populationDelta.addedRecordCount, 0);
  assert.equal(currentness.currentSource.populationDelta.removedRecordCount, 0);
  assert.equal(currentness.currentSource.populationDelta.otherCapabilityFieldsChanged, false);
  assert.equal(currentness.currentSource.populationDelta.disposition, "FUTURE_VERSION_DEFERRED; NOT_ASSERTED_APPROVED_OR_CURRENT");

  const decisionLog = readText(".product-experience/decision-log.md");
  assert.equal(fingerprintPxdDecisionSection(decisionLog, "PXD-223").sha256, currentness.decisionSectionSha256);
});

test("the 20 current meanings retain source, uncertainty, trust, candidate and fallback invariants", () => {
  const documents = sourceDocuments();
  const byId = recordsById(documents.capabilities.capabilities, "id");
  const text = id => JSON.stringify(byId.get(id));

  const search = text("media.artifact.search");
  assert.match(search, /UNINDEXED|unindexed/iu);
  assert.match(search, /unknown coverage is distinct from an empty result|unknown or unindexed scope is not represented as an empty result/iu);
  assert.match(search, /affirmative, current, scope-compatible rights\/license evidence|only exact immutable asset versions whose current authoritative rights\/license evidence explicitly permits/iu);
  assert.match(search, /UNKNOWN|review-required/iu);

  const list = byId.get("media.artifact.list");
  const listParameters = Object.keys(list.ownerDefinition.parameterSchema.properties);
  assert.deepEqual(listParameters, ["pageSize", "pageToken"]);
  assert.equal(list.ownerDefinition.parameterSchema.additionalProperties, false);
  assert.match(list.supportedParameters, /parameter fields in ownerDefinition\.parameterSchema:\s*pageSize,\s*pageToken\./iu);
  assert.doesNotMatch(list.supportedParameters, /searchIntent|transcriptQuery|semantic|transcript|duplicate search/iu,
    "artifact listing is not described as semantic, transcript, or duplicate search");

  const importMeaning = text("media.artifact.import");
  assert.match(importMeaning, /exact immutable source version/iu);
  assert.match(importMeaning, /provenance/iu);
  assert.match(importMeaning, /does not alter source media|does not mutate source/iu);

  for (const id of ["media.artifact.derive", "media.edit.inpaint", "media.edit.matte", "media.edit.retime-slow-motion-speed-ramp", "media.compose.multitrack-timeline", "media.compose.safe-area", "media.compose.reusable-composition"]) {
    assert.match(text(id), /candidate|draft/iu, `${id} distinguishes a candidate from a committed result`);
    assert.match(text(id), /exact|version/iu, `${id} binds source or project version provenance`);
  }

  assert.match(text("media.audio.analysis.detect.beat-onset"), /unknown or abstained|abstain/iu);
  assert.match(text("media.quality.rank"), /uncertainty handling|unresolved ranking disposition/iu);
  assert.match(text("media.speech.synthesis.speaker.condition"), /do not infer identity, consent, or permission/iu);
  assert.match(text("media.animation.material"), /arbitrary user-authored shader source or shader execution.*unsupported/iu);
  assert.match(text("media.generate.spatial.create.spatial-audio"), /do not silently fall back to stereo/iu);
  assert.match(text("media.master.audio.stereo-width"), /no silent stereo fallback/iu);
  assert.match(text("media.deliver.subtitles"), /package.*do not imply subtitle correctness.*successful delivery absent evidence/iu);

  const qualityRecords = documents.quality.ownerQualityApplicabilityCrosswalk?.records ?? [];
  const qualityIds = new Set(qualityRecords.map(record => record.capabilityRef));
  for (const [id] of expected) assert.ok(qualityIds.has(id), `${id} has an explicit quality applicability disposition`);
});
