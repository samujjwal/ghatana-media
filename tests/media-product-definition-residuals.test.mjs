import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMediaProductDefinitionResidualReport,
  renderMediaProductDefinitionResidualJson,
  renderMediaProductDefinitionResidualMarkdown,
  validateProjectionFieldCoverage,
  validateProjectionSourceReferences,
  validateSdkIdentityPartition,
} from "../scripts/lib/media-product-definition-residuals.mjs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

test("current parity census includes owner intents, adapter-required methods and legacy reads without widening acceptance", () => {
  const parity = buildMediaProductDefinitionResidualReport().operationParity;
  assert.equal(parity.totalObservedIdentities, 287);
  assert.equal(parity.acceptedBindingCount, 0);
  const ui = parity.surfaces.find(({ name }) => name === "UI action registry");
  assert.equal(ui.observedIdentities.length, 147);
  assert.equal(ui.historicalSnapshot.denominator, 146);
  assert.ok(ui.observedIdentities.includes("media.action.request-live-session-reconnect"));
  assert.equal(ui.unresolvedIdentities.includes("media.action.request-live-session-reconnect"), false);
  const grpc = parity.surfaces.find(({ name }) => name === "gRPC");
  assert.equal(grpc.observedIdentities.length, 43);
  for (const method of ["AdaptModel", "CreateProfile", "GetProfile", "UpdateProfile"]) {
    assert.ok(grpc.observedIdentities.includes(`STTService.${method}`));
  }
  const sdk = parity.surfaces.find(({ name }) => name === "SDK registry");
  assert.equal(sdk.observedIdentities.length, 30);
  assert.ok(sdk.observedIdentities.includes("media.sdk.listProviderCapabilities"));
  assert.equal(sdk.unresolvedIdentities.includes("media.sdk.listProviderCapabilities"), false);
  for (const surface of parity.surfaces) {
    assert.equal(surface.observedIdentities.length, surface.denominator, surface.name);
    assert.equal(new Set(surface.observedIdentities).size, surface.denominator, surface.name);
    assert.equal(surface.unresolvedIdentities.length, surface.counts.unresolved ?? 0, surface.name);
  }
});

test("residual report validates exact projection dispositions and pinned sources", () => {
  const root = resolve(new URL("..", import.meta.url).pathname);
  const report = buildMediaProductDefinitionResidualReport();

  assert.deepEqual(report.diagnostics, []);
  assert.deepEqual(report.projectionMappingAudit, {
    blockerSource: "generated candidate fieldMappingBlockers",
    completeness: "TOP_LEVEL_SCHEMA_FIELDS_AND_EMPTY_COLLECTION_DECLARATIONS_VALIDATED; NESTED_SEMANTICS_NOT_INFERRED",
    checks: [
      "Current public schema properties are compared with generated candidate keys, field-source mappings, dispositions, and recorded schema-field inventory.",
      "Missing optional fields require an explicit omission disposition; empty candidate collections require a blocker whose status and source match the field disposition and whose reason is nonblank, or an explicit empty-source disposition.",
    ],
    limitation: "These checks detect top-level omissions and unreported empty collections; they do not infer nested record completeness, mapping semantics, owner decisions, or acceptance.",
  });
  assert.deepEqual(report.projections.map(({ phase }) => phase), ["PDP-0", "PDP-2", "PDP-3"]);
  assert.deepEqual(report.projections.map(({ unresolvedFieldCount }) => unresolvedFieldCount), [0, 0, 9]);
  assert.deepEqual(report.projections.map(({ unresolvedFields }) => unresolvedFields.map(({ field }) => field)), [
    [],
    [],
    ["actions", "componentContracts", "effects", "finality", "fixtures", "journeys", "scenarios", "transitions", "views"],
  ]);
  assert.deepEqual(report.projections[0].intentionalOmissions.map(({ field, status }) => ({ field, status })), [
    { field: "createdAt", status: "OPTIONAL_AUTHORED_METADATA_OMITTED_INTENTIONALLY" },
    { field: "updatedAt", status: "OPTIONAL_AUTHORED_METADATA_OMITTED_INTENTIONALLY" },
  ]);
  for (const projection of report.projections) {
    assert.equal(projection.unresolvedFieldCount, projection.unresolvedFields.length);
    assert.ok(projection.mappedFieldCount >= projection.unresolvedFieldCount);
    assert.equal(projection.schemaFieldCount, projection.mappedFieldCount);
    assert.ok(projection.emptyCollections.every(({ declaredBlocker }) => declaredBlocker));
    assert.ok(projection.unresolvedFields.every((field) => field.id && field.status && field.reasons.length));
  }
  assert.equal(report.capabilityCoverage.leafCount, 462, "capability denominator must not shrink without an explicit source-scope revision");
  assert.equal(report.capabilityCoverage.unresolvedCount, 383);
  assert.equal(new Set(report.capabilityCoverage.unresolvedLeafIds).size, report.capabilityCoverage.unresolvedCount);
  assert.equal(report.capabilityCoverage.applicability.total, 462);
  assert.equal(report.capabilityCoverage.applicability.classified, 79);
  assert.equal(report.capabilityCoverage.applicability.unresolved, 383);
  assert.equal(report.capabilityCoverage.acceptedCoverageCount, 0);
  assert.equal(report.capabilityCoverage.unresolvedLeaves.length, 383);
  assert.ok(report.capabilityCoverage.unresolvedLeaves.every((leaf) => leaf.id && leaf.sourceRef && leaf.rationale));
  assert.equal(Object.values(report.capabilityCoverage.dispositionCounts).reduce((sum, count) => sum + count, 0), report.capabilityCoverage.leafCount);
  assert.equal(report.migrationSemantics.uniqueContentUnits, 1340);
  assert.equal(report.migrationSemantics.unresolvedCount, 260);
  assert.equal(report.migrationSemantics.semanticReviewRequiredCount, 260);
  assert.equal(report.migrationSemantics.ownerClassifiedNonNormativeCount, 89);
  assert.equal(report.migrationSemantics.originalStructuralUnresolvedCount, 349);
  assert.equal(report.migrationSemantics.mixedRequiresDecompositionCount, 124);
  assert.equal(report.migrationSemantics.sourceChangeLedger.changedClusterCount, 15);
  assert.equal(report.migrationSemantics.sourceChangeLedger.historicalSha256,
    report.migrationSemantics.sourcePins.find(({ path }) => path === "docs/migration/expert-reviewed-master-plan.md").sha256);
  assert.equal(report.migrationSemantics.sourceChangeLedger.observedCurrentSha256, report.migrationSemantics.sourceChangeLedger.actualCurrentSha256);
  assert.notEqual(report.migrationSemantics.sourceChangeLedger.historicalSha256, report.migrationSemantics.sourceChangeLedger.actualCurrentSha256);
  assert.equal(report.migrationSemantics.sourceChangeLedger.unmappedClusterIds.length, 2);
  assert.deepEqual(report.migrationSemantics.sourceChangeLedger.unmappedClusterIds, ["MSC-01", "MSC-09"]);
  assert.equal(report.migrationSemantics.sourceChangeLedger.clusters.length, 15);
  assert.ok(report.migrationSemantics.sourceChangeLedger.clusters.every((cluster) => cluster.currentLineSpans.length && cluster.changedClaims));
  assert.ok(report.migrationSemantics.unresolvedItemIds.every((id) => /^MPSEM-\d+$/u.test(id)));
  assert.ok(report.migrationSemantics.mixedItemIds.every((id) => /^MPSEM-\d+$/u.test(id)));
  assert.equal(Object.values(report.migrationSemantics.classificationCounts).reduce((sum, count) => sum + count, 0), 1340);
  assert.equal(report.migrationSemantics.total, 1340);
  assert.equal(report.migrationSemantics.applicable, 325);
  assert.equal(report.migrationSemantics.unresolvedItems.length, 260);
  assert.ok(report.migrationSemantics.unresolvedItems.every((item) => item.id && item.sourceLocations.length && item.classificationBasis));
  assert.equal(report.operationParity.surfaceCount, 9);
  assert.equal(report.operationParity.totalObservedIdentities, 287);
  const historicalUi = report.operationParity.surfaces.find(({ name }) => name === "UI action registry").historicalSnapshot;
  assert.equal(historicalUi.denominator, 146);
  assert.equal(historicalUi.operationBindingCounts.unresolved, 132);
  assert.equal(report.operationParity.unresolvedIdentityCount, 154);
  assert.equal(report.operationParity.unresolvedIdentityCount, report.operationParity.surfaces.reduce((sum, surface) => sum + surface.unresolvedIdentities.length, 0));
  assert.ok(report.operationParity.surfaces.every((surface) => surface.observedIdentities.length === surface.denominator));
  assert.ok(report.operationParity.surfaces.every((surface) => surface.unresolvedIdentities.length === (surface.counts.unresolved ?? 0)));
  const sdkSurface = report.operationParity.surfaces.find(({ name }) => name === "SDK registry");
  assert.ok(sdkSurface.observedIdentities.includes("media.sdk.getArtifact"));
  assert.ok(sdkSurface.observedIdentities.includes("media.sdk.getUploadSession"));
  const cliRuntimeSurface = report.operationParity.surfaces.find(({ name }) => name === "CLI host-configured runtime consumers");
  assert.equal(cliRuntimeSurface.denominator, 1);
  assert.deepEqual(cliRuntimeSurface.observedIdentities, ["media.cli.artifact.inspect"]);
  assert.deepEqual(sdkSurface.observedIdentities.filter((id) => [
    "media.sdk.getServiceStatus",
    "media.sdk.getAllServicesStatus",
    "media.sdk.addEventListener",
    "media.sdk.removeEventListener",
  ].includes(id)).sort(), [
    "media.sdk.addEventListener",
    "media.sdk.getAllServicesStatus",
    "media.sdk.getServiceStatus",
    "media.sdk.removeEventListener",
  ]);
  assert.equal(report.designConformance.gateCount, 7);
  assert.equal(report.designConformance.resolvedOwnerGateCount, 5);
  assert.equal(report.designConformance.openGateCount, 2);
  assert.deepEqual(report.designConformance.gates
    .filter((gate) => gate.status !== "RESOLVED_OWNER")
    .map(({ id, status }) => ({ id, status })), [
    { id: "shared-artifact-binding", status: "EXTERNAL_PENDING" },
    { id: "conformance-and-specialist-review", status: "INDEPENDENT_PENDING" },
  ]);
  const obligations = JSON.parse(readFileSync(resolve(root, "config/closure/media-product-definition/obligations.json"), "utf8"));
  assert.equal(report.lifecycle.obligationCount, obligations.length);
  assert.equal(report.lifecycle.totalProofRoutes, obligations.length);
  assert.equal(report.lifecycle.obligationsMissingCaseIds.length, obligations.filter(record => !(record.caseIds?.length)).length);
  const l02Links = JSON.parse(readFileSync(resolve(root, "config/closure/media-product-definition/l02-source-case-links.json"), "utf8"));
  const l03Candidates = JSON.parse(readFileSync(resolve(root, "config/closure/media-product-definition/l03-proof-route-candidates.json"), "utf8"));
  const draftLink = l02Links.candidateLinks.find(({ caseId }) => caseId === "media.definition-case.caption-draft.edit");
  const transcriptionSubmissionLink = l02Links.candidateLinks.find(({ caseId }) => caseId === "media.definition-case.transcription-submission.accept");
  assert.equal(l02Links.candidateLinks.length, 65);
  assert.equal(new Set(l02Links.candidateLinks.map(({ obligationId }) => obligationId)).size, 44);
  assert.equal(l02Links.unmappedObligationIds.length, obligations.length - 44);
  assert.deepEqual(draftLink, {
    obligationId: "media.pdp-1.requirement.media.operation.caption-draft-write",
    caseId: "media.definition-case.caption-draft.edit",
    method: "SOURCE_DEFINITION_CONTRACT_ASSERTIONS",
    testIdentity: {
      sourcePath: "tests/media-caption-draft-operation-definition.test.mjs",
      testName: "caption draft edit definition",
    },
    assertionEvidence: "assert.deepEqual(validateMediaCaptionDraftDefinition(base), []);",
    negativeAssertionVariables: [
      "staleDraftOverwrite", "unboundedDraftRevision", "timingCanInferClock", "textEditChangesTiming",
      "validationFailurePartiallyApplies", "localUndoDeletesParent", "forgedAdmission", "wrongActionBinding",
    ],
    scope: "PARTIAL_SOURCE_DEFINITION_ASSERTIONS_ONLY",
    admission: "NOT_LIFECYCLE_ADMITTED",
    ownerDecisionRef: ".product-experience/decision-log.md#PXD-069",
  });
  assert.deepEqual(transcriptionSubmissionLink, {
    obligationId: "media.pdp-1.requirement.media.operation.transcription-submission",
    caseId: "media.definition-case.transcription-submission.accept",
    method: "SOURCE_DEFINITION_CONTRACT_ASSERTIONS",
    testIdentity: {
      sourcePath: "tests/media-transcription-submission-definition.test.mjs",
      testName: "submission definition rejects replay, authority, and finality overclaims",
    },
    assertionEvidence: "assert.deepEqual(validateMediaTranscriptionSubmissionDefinition(base), []);",
    negativeAssertionVariables: [
      "partialReplay", "fingerprintOmitsAuthority", "fingerprintNormalizes", "callerGrantsRights",
      "languageInferred", "ackMeansCompleted", "receiptReadSkipsAuth", "dependsOnReturnedFingerprint", "profileNotQualified",
      "unknownSubmitField", "branchMixedPayload", "callerSuppliedIdentity", "nullRequestId", "nullRightsEvidence", "implicitConsentDefault",
    ],
    scope: "PARTIAL_SOURCE_DEFINITION_ASSERTIONS_ONLY",
    admission: "NOT_LIFECYCLE_ADMITTED",
    ownerDecisionRef: ".product-experience/decision-log.md#PXD-073",
  });
  assert.equal(l03Candidates.l02CaseLinkReview.reviewedLinkCount, 65);
  assert.equal(l03Candidates.l02CaseLinkReview.reviewedObligationCount, 44);
  assert.equal(l03Candidates.l02CaseLinkReview.obligationDenominator, obligations.length);
  assert.equal(l03Candidates.l02CaseLinkReview.unmappedObligationCount, obligations.length - 44);
  assert.equal(l03Candidates.l02CaseLinkReview.candidateRouteCount, 0);
  assert.equal(l03Candidates.l02CaseLinkReview.authoritativeAssignments, `UNCHANGED_ZERO_OF_${obligations.length}`);
  const l03Explanation = l03Candidates.l02CaseLinkReview.missingSemantics.join(" ");
  assert.match(l03Explanation, /source-only caption-draft edit definition assertions/u);
  assert.match(l03Explanation, /not a native provider or correction-runtime observation/u);
  assert.match(l03Explanation, /source-only transcription-submission assertions in tests\/media-transcription-submission-definition\.test\.mjs/u);
  assert.match(l03Explanation, /do not establish a qualified recognition provider, runtime dispatch observation or native proof route/u);
  assert.ok(l03Candidates.routes.every(({ obligationIds }) =>
    !obligationIds.includes(draftLink.obligationId) && !obligationIds.includes(transcriptionSubmissionLink.obligationId)));
  assert.equal(report.lifecycle.receiptEvaluation.status, "NOT_EVALUATED");
  assert.equal(report.lifecycle.receiptEvaluation.authoritativeReceiptCount, null);
  assert.equal(report.lifecycle.currentnessEvaluation.status, "NOT_EVALUATED");
  assert.equal(report.productExperience.screenViewCount, 47);
  assert.equal(report.productExperience.journeyCount, 30);
  assert.equal(report.productExperience.stepCount, 130);
  assert.equal(report.productExperience.stepsWithScreenContracts, 130);
  assert.equal(report.productExperience.stepsWithActionBindings, 120);
  assert.equal(report.productExperience.journeyTrace.journeyCount, 30);
  assert.equal(report.productExperience.journeyTrace.orderedStepCount, 130);
  assert.equal(report.productExperience.journeyTrace.steps.length, 130);
  assert.equal(report.productExperience.journeyTrace.screenContractBindings.unresolvedSteps.length, 0);
  assert.equal(report.productExperience.journeyTrace.actionBindings.linkedSteps.length, 120);
  assert.equal(report.productExperience.journeyTrace.actionBindings.unresolvedSteps.length, 10);
  assert.ok(report.productExperience.journeyTrace.steps.every((step) => step.journeyRef && step.sourceRef && step.stepKey));
  assert.ok(report.productExperience.journeyTrace.actionBindings.linkedSteps
    .every((step) => step.actionRef && step.actionBindingState === "SOURCE_LINKED_PROPOSAL"));
  assert.match(renderMediaProductDefinitionResidualMarkdown(report), /authoritative receipt\/currentness evaluation is NOT_EVALUATED/u);
  for (const pin of [...report.capabilityCoverage.sourcePins, ...report.migrationSemantics.sourcePins]) {
    const actual = createHash("sha256").update(readFileSync(resolve(root, pin.path))).digest("hex");
    assert.equal(pin.state, actual === pin.sha256 ? "CURRENT" : "STALE", `${pin.path}: historical pin currency follows exact bytes`);
  }
  const staleMigrationPaths = report.migrationSemantics.sourcePins.filter(pin => pin.state === "STALE").map(pin => pin.path);
  for (const path of ["docs/migration/expert-reviewed-master-plan.md", ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml", ".product-experience/pdp-0-product-truth/constitution.yaml", ".product-experience/pdp-0-product-truth/goals-jtbd.yaml"]) assert.ok(staleMigrationPaths.includes(path));
  assert.notEqual(report.migrationSemantics.declaredSourceLineCount, report.migrationSemantics.currentSourceLineCount);
});

test("residual report output is deterministic and clearly diagnostic", () => {
  const first = buildMediaProductDefinitionResidualReport();
  const second = buildMediaProductDefinitionResidualReport();

  assert.equal(renderMediaProductDefinitionResidualJson(first), renderMediaProductDefinitionResidualJson(second));
  assert.match(renderMediaProductDefinitionResidualMarkdown(first), /diagnostic-only/u);
  assert.match(renderMediaProductDefinitionResidualMarkdown(first), /TOP_LEVEL_SCHEMA_FIELDS_AND_EMPTY_COLLECTION_DECLARATIONS_VALIDATED/u);
  assert.match(renderMediaProductDefinitionResidualMarkdown(first), /do not infer nested record completeness/u);
  assert.match(renderMediaProductDefinitionResidualMarkdown(first), /Projection mappings/u);
});

test("SDK residual partition includes bounded operations and rejects missing, duplicate, or invented members", () => {
  const sourceIdentities = ["sdk.read", "sdk.begin", "sdk.part", "sdk.complete", "sdk.legacy"];
  const parserArtifactIdentities = ["sdk.legacy"];
  const categories = {
    proposed: [],
    boundedCanonicalReads: ["sdk.read"],
    boundedCanonicalOperations: ["sdk.begin", "sdk.part", "sdk.complete"],
    unresolved: [],
    transportOnly: [],
  };
  assert.deepEqual(validateSdkIdentityPartition({ sourceIdentities, parserArtifactIdentities, categories }), []);
  assert.ok(validateSdkIdentityPartition({
    sourceIdentities,
    parserArtifactIdentities,
    categories: { ...categories, boundedCanonicalOperations: ["sdk.begin", "sdk.part"] },
  }).some((diagnostic) => /cover exactly the source identities/u.test(diagnostic)));
  assert.ok(validateSdkIdentityPartition({
    sourceIdentities,
    parserArtifactIdentities,
    categories: { ...categories, boundedCanonicalOperations: [...categories.boundedCanonicalOperations, "sdk.begin"] },
  }).some((diagnostic) => /must be unique|must be disjoint/u.test(diagnostic)));
  assert.ok(validateSdkIdentityPartition({
    sourceIdentities,
    parserArtifactIdentities,
    categories: { ...categories, boundedCanonicalOperations: [...categories.boundedCanonicalOperations, "sdk.forged"] },
  }).some((diagnostic) => /cover exactly the source identities/u.test(diagnostic)));
});

test("projection field audit catches missing schema fields and unreported empty collections", () => {
  const root = resolve(new URL("..", import.meta.url).pathname);
  const source = {
    phase: "PDP-3",
    name: "experience-specification",
    path: ".product-experience/pdp-3-product-experience/generated/experience-specification.candidate.json",
  };
  const candidate = JSON.parse(readFileSync(resolve(root, source.path), "utf8"));
  assert.deepEqual(validateProjectionFieldCoverage(root, source, candidate), []);

  const omitted = structuredClone(candidate);
  delete omitted.candidateModel.views;
  delete omitted.candidateFieldSources.views;
  delete omitted.candidateMappingReview.fieldDispositions.views;
  omitted.fieldMappingBlockers = omitted.fieldMappingBlockers.filter(({ field }) => field !== "views");
  const omittedDiagnostics = validateProjectionFieldCoverage(root, source, omitted);
  assert.ok(omittedDiagnostics.some((diagnostic) => /public schema field has no candidate field source: views/u.test(diagnostic)));
  assert.ok(omittedDiagnostics.some((diagnostic) => /public schema field is omitted from candidateModel/u.test(diagnostic)));

  const emptyWithoutBlocker = structuredClone(candidate);
  emptyWithoutBlocker.candidateModel.journeys = [];
  emptyWithoutBlocker.fieldMappingBlockers = emptyWithoutBlocker.fieldMappingBlockers.filter(({ field }) => field !== "journeys");
  assert.ok(validateProjectionFieldCoverage(root, source, emptyWithoutBlocker)
    .some((diagnostic) => /empty candidate collection has no blocker or explicit empty-source disposition: journeys/u.test(diagnostic)));

  const emptyReasonBlocker = structuredClone(candidate);
  emptyReasonBlocker.candidateModel.journeys = [];
  emptyReasonBlocker.fieldMappingBlockers.find(({ field }) => field === "journeys").reasons = [];
  assert.ok(validateProjectionFieldCoverage(root, source, emptyReasonBlocker)
    .some((diagnostic) => /empty candidate collection has no blocker or explicit empty-source disposition: journeys/u.test(diagnostic)));

  const mismatchedBlockerSource = structuredClone(candidate);
  mismatchedBlockerSource.candidateModel.journeys = [];
  mismatchedBlockerSource.fieldMappingBlockers.find(({ field }) => field === "journeys").sourceDisposition = "stale source mapping";
  const sourceDiagnostics = validateProjectionFieldCoverage(root, source, mismatchedBlockerSource);
  assert.ok(sourceDiagnostics.some((diagnostic) => /blocker source does not match its field disposition: journeys/u.test(diagnostic)));
  assert.ok(sourceDiagnostics.some((diagnostic) => /empty candidate collection has no blocker or explicit empty-source disposition: journeys/u.test(diagnostic)));
});

test("projection source validation rejects unregistered and stale local sources", () => {
  const root = resolve(new URL("..", import.meta.url).pathname);
  const path = ".product-experience/pdp-2-design-interface-system/generated/experience-language.candidate.json";
  const source = { phase: "PDP-2", name: "experience-language", path };
  const candidate = JSON.parse(readFileSync(resolve(root, path), "utf8"));
  assert.deepEqual(validateProjectionSourceReferences(root, source, candidate), []);

  const unregistered = structuredClone(candidate);
  unregistered.candidateFieldSources.subjectId.sourceRef = ".product-experience/missing-authority.yaml";
  assert.ok(validateProjectionSourceReferences(root, source, unregistered)
    .some((diagnostic) => /subjectId sourceRef is not present in sourceAuthorities/u.test(diagnostic)));

  const stale = structuredClone(candidate);
  stale.sourceAuthorities.find(({ sourceRef }) => sourceRef === stale.candidateFieldSources.subjectId.sourceRef).sha256 = "0".repeat(64);
  assert.ok(validateProjectionSourceReferences(root, source, stale)
    .some((diagnostic) => /subjectId source authority is stale/u.test(diagnostic)));
});
