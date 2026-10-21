import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const review = JSON.parse(readFileSync(resolve(root, ".product-experience/interface-parity/current-source-review.json"), "utf8"));

test("P1 interface review pins current sources and reconciles source populations without admission claims", () => {
  assert.equal(review.schemaVersion, "media.pdp1-interface-current-source-review.v1");
  for (const source of review.sources) {
    const actual = createHash("sha256").update(readFileSync(resolve(root, source.path))).digest("hex");
    assert.equal(actual, source.sha256, `${source.path} changed; refresh the current-source reconciliation`);
  }

  const parity = readYaml(".product-experience/interface-parity/operation-parity.yaml");
  const ownerOperations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const operationsBytes = readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"));
  const operationsSha256 = createHash("sha256").update(operationsBytes).digest("hex");
  const actionRegistry = readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml");
  const capabilities = readYaml(".product-experience/pdp-0-product-truth/capabilities.yaml");
  const operationReview = JSON.parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations-current-source-review.json"), "utf8"));
  const sourceReinspection = review.currentSourceCutDeltaReview.operationsSourceReinspection;
  assert.equal(review.currentSourceCutDeltaReview.operationsSha256, operationsSha256);
  assert.equal(sourceReinspection.populations.ownerTypedObservationContracts, 16);
  assert.equal(sourceReinspection.ownerTypedObservationContracts, 16);
  assert.equal(sourceReinspection.ownerTypedObservationValidationRules, 15);
  assert.equal(sourceReinspection.status, "REINSPECTED_CURRENT_SOURCE_CUT");
  assert.equal(sourceReinspection.sourceSha256, operationsSha256);
  assert.equal(sourceReinspection.previousReviewedSourceSha256,
    "2ea3da8af4d332be51c7322060641de5f59a13e3b00833e03105f5d13049d55c");
  assert.equal(sourceReinspection.previousSourceBytesAvailableInGit, false);
  assert.equal(sourceReinspection.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(sourceReinspection.transportAdmission, "NOT_ADMITTED");
  const authoritativeActions = actionRegistry.actions;
  assert.equal(authoritativeActions.length, 147);
  assert.equal(review.recomputedPopulations.currentUiActionIdentities,
    authoritativeActions.length + actionRegistry.ownerDefinedActions.length);
  const actualTypedActionSemantics = authoritativeActions.filter(({ actionDefinitionSemantics }) => actionDefinitionSemantics);
  assert.equal(actualTypedActionSemantics.length, authoritativeActions.length);
  assert.equal(review.currentSourceCutDeltaReview.typedUiActionSemanticRecordCount, actualTypedActionSemantics.length);
  const fallbackAction = authoritativeActions.find(({ id }) => id === "media.action.confirm-selected-fallback");
  const fallbackReview = review.currentSourceCutDeltaReview.fallbackActionOperationReconciliation;
  const fallbackOperation = ownerOperations.ownerDefinedOperationContracts.records.find(({ id }) =>
    id === "media.operation.fallback-selection.confirm.v1");
  assert.ok(fallbackAction && fallbackOperation);
  assert.deepEqual(fallbackReview, {
    actionRef: "media.action.confirm-selected-fallback",
    operationRefs: ["media.operation.fallback-selection.confirm.v1"],
    actionSourceSelector: ".product-experience/pdp-3-product-experience/action-registry.yaml#actions/@id=media.action.confirm-selected-fallback",
    ownerSourceSelector: ".product-experience/pdp-1-domain-data/operations.yaml#actionOperationDispositionInventory/records/@actionId=media.action.confirm-selected-fallback",
    operationSourceSelector: ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.fallback-selection.confirm.v1",
    operationKind: "COMMAND",
    runtimeAdmission: "NOT_ADMITTED",
    externalOwnerAcceptance: "PENDING",
    independentReview: "OPEN",
    transportAdmission: "NOT_ADMITTED",
  });
  assert.deepEqual(fallbackAction.actionDefinitionSemantics.typedDefinition.exactOperationRefs,
    fallbackReview.operationRefs);
  assert.equal(fallbackAction.actionDefinitionSemantics.typedDefinition.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(fallbackOperation.operationKind, fallbackReview.operationKind);
  assert.equal(fallbackOperation.scopeStatus,
    "OWNER_DEFINED_SELECTION_DEFINITION_ONLY; no fallback execution, provider, endpoint, transport, or runtime is admitted");
  assert.equal(ownerOperations.actionOperationDispositionInventory.records.find(({ actionId }) =>
    actionId === fallbackReview.actionRef).exactOperationRefs[0], fallbackReview.operationRefs[0]);
  const typedObservationIds = ownerOperations.ownerTypedObservationContracts.records.map(({ id }) => id);
  assert.equal(typedObservationIds.length, 16);
  assert.deepEqual(sourceReinspection.currentOwnerTypedObservationContractIds, typedObservationIds);
  assert.equal(ownerOperations.ownerTypedObservationValidationRules.records.length, 15);
  const candidateMetricPair = ownerOperations.ownerTypedObservationContracts.records.find(({ id }) =>
    id === "media.observation-contract.candidate-metric-pair.v1");
  const candidateMetricPairOperation = ownerOperations.ownerDefinedOperationContracts.records.find(({ id }) =>
    id === "media.operation.action.compare-candidate-on-metric");
  assert.ok(candidateMetricPair && candidateMetricPairOperation);
  assert.deepEqual(candidateMetricPair.operationRefs, [candidateMetricPairOperation.id]);
  assert.equal(candidateMetricPair.operationKind, "QUERY");
  assert.equal(candidateMetricPair.bindingStatus, "DEFINITION_ONLY_NO_EXISTING_ENDPOINT_OR_RUNTIME_BINDING");
  assert.equal(candidateMetricPairOperation.resultSchemaRef,
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.candidate-metric-pair.v1/resultSchema");
  assert.equal(candidateMetricPairOperation.scopeStatus,
    "proposal-authored; exact-pair-request-and-paired-evidence-result meaning defined; owner-acceptance-not-claimed; independent-PDP1-and-PDP3-review-open; transport/runtime-NOT_ADMITTED");
  assert.deepEqual(ownerOperations.ownerTypedObservationValidationRules.records
    .filter(({ observationContractRef }) => observationContractRef === candidateMetricPair.id), []);
  assert.equal(candidateMetricPair.runtimeAdmission, "NOT_ADMITTED");
  assert.ok(candidateMetricPairOperation.resultSchema.resultRules.length > 0,
    "candidate metric pair validation remains explicitly inline on its operation");
  assert.ok(candidateMetricPairOperation.resultSchema.resultRules.some((rule) =>
    rule.includes("no-delta-direction-threshold-pass-fail-aggregate-rank-winner-improvement-or-qualification")));
  assert.match(sourceReinspection.additionalObservationDisposition,
    /media\.observation-contract\.candidate-metric-pair\.v1.*owner acceptance is not claimed.*independent review is open.*NOT_ADMITTED/u);
  assert.equal(review.currentSourceCutDeltaReview.externalOwnerAcceptance, "PENDING");
  assert.equal(review.currentSourceCutDeltaReview.independentReview, "OPEN");
  assert.equal(review.currentSourceCutDeltaReview.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(review.currentSourceCutDeltaReview.transportAdmission, "NOT_ADMITTED");
  const ui = parity.surfaces.find(({ surface }) => surface === "UI action registry");
  const cli = parity.surfaces.find(({ surface }) => surface === "CLI fixture commands");
  const sourceTruth = parity.ownerDefinedSourceTruthMatrix.currentUiActionIdentityResolution;
  assert.equal(sourceTruth.currentIdentityCount, review.recomputedPopulations.currentUiActionIdentities);
  assert.deepEqual(sourceTruth.dispositionCounts, {
    operationIntent: review.recomputedPopulations.currentUiActionOperationIntent,
    localOrSessionOnly: review.recomputedPopulations.currentUiActionLocalOrSessionOnly,
    sharedIdentityBoundary: review.recomputedPopulations.currentUiActionSharedIdentityBoundary,
  });
  assert.equal(sourceTruth.currentIdentityCount, 148);
  assert.equal(sourceTruth.dispositionCounts.operationIntent, 97);
  assert.equal(ui.denominator, 148, "cross-interface UI registry denominator now includes confirmed-fallback J-27 action");
  assert.equal(ui.operationBindingCounts.unresolved, review.crossInterfaceActionBindingSnapshot.historicalUnresolvedCrossInterfaceBindings);
  assert.equal(review.crossInterfaceActionBindingSnapshot.currentActionDenominator, ui.denominator);
  assert.match(review.crossInterfaceActionBindingSnapshot.meaning, /does not override the current 148-identity semantic-role census/u);

  assert.equal(cli.identities.length, review.recomputedPopulations.fixtureCliCommands);
  assert.deepEqual(cli.dispositionCounts, { mappedProposal: 11, unresolved: 0 });
  assert.equal(review.roleReconciliation.fixtureCli.exactOperationIntentOnly, 2);
  assert.equal(review.roleReconciliation.fixtureCli.withoutDirectCommandRegistryOperationRef, 9);
  assert.equal(review.roleReconciliation.fixtureCli.productionAdmission, "NOT_ADMITTED");
  assert.equal(review.roleReconciliation.fixtureCli.executionScope, "DETERMINISTIC_SYNTHETIC_FIXTURE_ONLY");
  const directCommandOperationRefs = {
    "media.fixture-cli.caption-save-version": "media.operation.caption-version-write",
    "media.fixture-cli.caption-compare-versions": "media.operation.caption-version-read",
  };
  assert.deepEqual(review.semanticDelta.currentClassification.exactOwnerOperationIntentOnly, directCommandOperationRefs);
  assert.deepEqual(parity.typedInterfaceIdentityDispositions.cliFixture.exactOperationIntentOnly, directCommandOperationRefs);
  assert.deepEqual(review.semanticDelta.currentClassification.allActionRefOperationIntents,
    parity.typedInterfaceIdentityDispositions.cliFixture.operationIntentByAction);
  const actionToOperation = ownerOperations.sourceDenominators.uiProductActions.explicitOperationIds;
  const derivedIntentMap = Object.fromEntries(parity.typedFixtureCliContracts.map(({ identity, actionIntentRef }) => [
    identity, actionToOperation[actionIntentRef],
  ]));
  assert.deepEqual(derivedIntentMap, review.semanticDelta.currentClassification.allActionRefOperationIntents,
    "all fixture action refs must resolve only through current owner action-to-operation intent entries");
  const cliOwnerCensus = ownerOperations.sourceDenominators.cliSimulationCommands;
  assert.deepEqual(cliOwnerCensus.operationIntentByExactActionRef, review.semanticDelta.currentClassification.allActionRefOperationIntents);
  assert.equal(cliOwnerCensus.directCommandOperationRefIds.length, 2);
  assert.equal(cliOwnerCensus.unresolvedProductionRuntimeCommandIds.length, 11);
  assert.equal(review.semanticDelta.currentClassification.withoutDirectCommandRegistryOperationRef, 9);
  assert.match(review.semanticDelta.boundary, /production CLI remains NOT_ADMITTED/u);
  assert.deepEqual(parity.typedInterfaceIdentityDispositions.cliFixture.unresolvedIdentities, []);

  const provenanceCrosswalk = review.additionalSemanticReconciliations.find(({ id }) =>
    id === "PXD-152-PROVENANCE-ACTION-CROSSWALK");
  assert.deepEqual(provenanceCrosswalk && {
    actionRef: provenanceCrosswalk.actionRef,
    capabilityRef: provenanceCrosswalk.capabilityRef,
    operationRef: provenanceCrosswalk.operationRef,
    decisionRef: provenanceCrosswalk.decisionRef,
    runtimeAdmission: provenanceCrosswalk.runtimeAdmission,
  }, {
    actionRef: "media.action.inspect-provenance",
    capabilityRef: "media.provenance.source-lineage.inspect",
    operationRef: "media.operation-slice.inspect-provenance",
    decisionRef: ".product-experience/decision-log.md#PXD-152",
    runtimeAdmission: "NOT_ADMITTED",
  });
  const p0Provenance = capabilities.capabilities.find(({ id }) => id === provenanceCrosswalk.capabilityRef);
  const p3ProvenanceAction = actionRegistry.actions.find(({ id }) => id === provenanceCrosswalk.actionRef);
  const p1ProvenanceBinding = ownerOperations.capabilityOperationContracts.records.find(({ id }) =>
    id === "media.capability-binding.media-provenance-source-lineage-inspect");
  const p1ProvenanceOperation = ownerOperations.ownerDefinedOperationContracts.records.find(({ id }) =>
    id === provenanceCrosswalk.operationRef);
  assert.ok(p0Provenance.ownerDefinition.typedInputSlots.some(({ slotId, sourceType, alternatives }) =>
    slotId === "input1" && sourceType === "artifact-or-execution-reference"
      && alternatives.join(",") === "artifact,execution-reference"));
  assert.ok(p3ProvenanceAction.capabilityRefs.includes(provenanceCrosswalk.capabilityRef));
  assert.equal(p1ProvenanceBinding.capabilityRef, provenanceCrosswalk.capabilityRef);
  assert.deepEqual(p1ProvenanceBinding.operationRefs, [provenanceCrosswalk.operationRef]);
  assert.equal(p1ProvenanceBinding.operationKind, "QUERY");
  assert.equal(p1ProvenanceBinding.typedInputMappings.selectedAction.actionRef, provenanceCrosswalk.actionRef);
  assert.equal(p1ProvenanceBinding.executionReferenceBranchDisposition.decisionRef, provenanceCrosswalk.decisionRef);
  assert.deepEqual(p1ProvenanceBinding.executionReferenceBranchDisposition.acceptedIdentityRefs.map((ref) => ref.split("#").at(-1)), [
    "media.domain.processing-job", "media.domain.job-attempt",
  ]);
  assert.deepEqual(p1ProvenanceBinding.executionReferenceBranchDisposition.excludedIdentityRefs.map((ref) => ref.split("#").at(-1)), [
    "media.domain.media-run",
  ]);
  assert.equal(p1ProvenanceBinding.executionReferenceBranchDisposition.implementationStatus, "NOT_ADMITTED");
  assert.ok(p1ProvenanceOperation.sourceRefs.includes(provenanceCrosswalk.decisionRef));
  assert.deepEqual(operationReview.capabilityOperationMappingReconciliation.sourceActionCapabilityCrosswalk, {
    actionRef: provenanceCrosswalk.actionRef,
    capabilityRef: provenanceCrosswalk.capabilityRef,
    operationRef: provenanceCrosswalk.operationRef,
    operationBindingId: p1ProvenanceBinding.id,
    operationKind: "QUERY",
    decisionRef: provenanceCrosswalk.decisionRef,
    actionRegistrySha256: createHash("sha256").update(readFileSync(resolve(root, ".product-experience/pdp-3-product-experience/action-registry.yaml"))).digest("hex"),
    actionSelector: ".product-experience/pdp-3-product-experience/action-registry.yaml#actions/@id=media.action.inspect-provenance",
    bindingSelector: ".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/@id=media.capability-binding.media-provenance-source-lineage-inspect",
    meaning: operationReview.capabilityOperationMappingReconciliation.sourceActionCapabilityCrosswalk.meaning,
    runtimeAdmission: "NOT_ADMITTED",
  });

  const sdk = parity.surfaces.find(({ surface }) => surface === "SDK registry");
  assert.deepEqual(sdk.unresolved, review.sdkCandidateEquivalenceReview.equivalenceUnknownIds);
  const sdkRegistry = readYaml(".product-experience/pdp-3-product-experience/sdk/operation-registry.yaml");
  const sdkCensus = ownerOperations.sourceDenominators.sdkMethods;
  assert.equal(sdkCensus.registryRecords, 33);
  assert.equal(sdkCensus.parserDerivedPublicMethodIdentities, 30);
  assert.deepEqual(sdkCensus.exactObservedRegistryIds.slice().sort(), sdkRegistry.methods.map(({ id }) => id).sort());
  assert.equal(sdkCensus.exactObservedRegistryIds.includes("media.sdk.getUploadSession"), true);
  assert.deepEqual(sdkCensus.boundedCanonicalOperations, [
    "media.sdk.createUploadSession", "media.sdk.uploadPart", "media.sdk.completeUploadSession",
  ]);
  assert.deepEqual(sdkCensus.boundedCanonicalReads, ["media.sdk.getArtifact", "media.sdk.getUploadSession"]);
  assert.deepEqual(ownerOperations.sourceDenominators.sdkMethods.unresolvedOperationIds,
    review.sdkCandidateEquivalenceReview.equivalenceUnknownIds);
  assert.equal(review.sdkLegacyResolution.priorUnresolvedIdentityCount, 8);
  assert.equal(review.sdkLegacyResolution.currentUnresolvedIdentityCount, 0);
  assert.equal(review.sdkLegacyResolution.allNotAdmitted, true);
  const sdkIds = Object.keys(review.sdkLegacyResolution.classifications).sort();
  const sourceSdkIds = sdk.currentSourceMethodDefinitions.records.map(({ methodId }) => methodId).sort();
  assert.ok(sdkIds.every((identity) => sourceSdkIds.includes(identity)), "each originally tracked SDK gap retains a source-exact method record");
  for (const identity of sdkIds) {
    assert.match(review.sdkLegacyResolution.classifications[identity], /NOT_ADMITTED/u);
    assert.equal(sdk.currentSourceMethodDefinitions.records.find(({ methodId }) => methodId === identity).admission, "NOT_ADMITTED");
    assert.notEqual(parity.typedMethodDispositions.find(({ identity: id }) => id === identity).semanticBinding, "unresolved");
  }
  assert.deepEqual(review.sdkCandidateEquivalenceReview.equivalenceUnknownIds,
    []);
  for (const [identity, mismatch] of Object.entries(review.sdkCandidateEquivalenceReview.sourceBackedLegacyNonEquivalence)) {
    const role = parity.typedMethodDispositions.find(({ identity: id }) => id === identity);
    const contract = parity.typedSdkMethodContracts.find(({ identity: id }) => id === identity);
    assert.ok(role && contract, `${identity} requires both source-role and method contract evidence`);
    assert.equal(role.openApiBindingDisposition, "NOT_ADMITTED");
    assert.equal(contract.bindingStatus, "NOT_ADMITTED");
    assert.equal(contract.candidateOperationRef, null);
    assert.match(role.semanticBinding, /^LEGACY_/u);
    assert.match(mismatch, /legacy|caller|MediaProcessingJobSchema|TranscriptionRequestSchema|SynthesisRequestSchema|MultimodalAnalysisRequestSchema/u);
    assert.match(contract.bindingEvidence, /no active route|no-active-route|no canonical|legacy|MediaProcessingJobSchema|TranscriptionRequestSchema|RuntimeParser|SynthesisRequestSchema|MultimodalAnalysisRequestSchema/u);
  }
  const exactLegacyRationale = {
    "media.sdk.getStatus": /MediaProcessingJobSchema|no canonical job-observation DTO/u,
    "media.sdk.cancel": /MediaProcessingJobSchema|canonical cancellation receipt/u,
    "media.sdk.getResult": /RuntimeParser<T>|accepted target operation/u,
    "media.sdk.getOperation": /MediaProcessingJobSchema|canonical job-query/u,
    "media.sdk.cancelOperation": /MediaProcessingJobSchema|canonical cancellation receipt/u,
    "media.sdk.transcribe": /TranscriptionRequestSchema|sourceArtifactVersionId/u,
    "media.sdk.synthesize": /SynthesisRequestSchema|SynthesisResultSchema|rights guards/u,
    "media.sdk.analyzeMultimodal": /MultimodalAnalysisRequestSchema|MediaArtifact|temporal/u,
  };
  for (const [identity, rationale] of Object.entries(exactLegacyRationale)) {
    const role = parity.typedMethodDispositions.find(({ identity: id }) => id === identity);
    const contract = parity.typedSdkMethodContracts.find(({ identity: id }) => id === identity);
    assert.ok(role.semanticBinding.startsWith("LEGACY_"), `${identity} must retain a precise legacy disposition`);
    assert.equal(role.openApiBindingDisposition, "NOT_ADMITTED");
    assert.equal(contract.bindingStatus, "NOT_ADMITTED");
    assert.match(contract.bindingEvidence, rationale, `${identity} must preserve its source-specific mismatch rationale`);
    assert.equal(contract.candidateOperationRef, null);
  }
  for (const identity of review.sdkCandidateEquivalenceReview.equivalenceUnknownIds) {
    const role = parity.typedMethodDispositions.find(({ identity: id }) => id === identity);
    const contract = parity.typedSdkMethodContracts.find(({ identity: id }) => id === identity);
    assert.equal(role.semanticBinding, "equivalence-unknown; operation-owner-input-semantics-and-exact-leaf-crosswalk-pending");
    assert.equal(contract.bindingStatus, "UNRESOLVED");
    assert.equal(contract.candidateOperationRef, null);
  }

  for (const role of Object.values(review.roleReconciliation)) {
    if (role.runtimeAdmission) assert.equal(role.runtimeAdmission, "NOT_ADMITTED");
  }
  assert.equal(review.scope.phaseAcceptanceClaim, "NONE");
  assert.equal(review.scope.runtimeReachability, "NOT_ESTABLISHED");
  assert.equal(review.crossInterfaceActionBindingSnapshot.currentActionDenominator, 148);
  assert.equal(review.crossInterfaceActionBindingSnapshot.historicalUnresolvedCrossInterfaceBindings, 133);
});

test("J-06 is cross-linked to the exact request action rather than guidance search", () => {
  const actionRegistry = readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml");
  const guidance = actionRegistry.actions.find(({ id }) => id === "media.action.search-product-guidance");
  const submit = actionRegistry.actions.find(({ id }) => id === "media.action.submit-validated-request");
  const journey = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/return-grounded-typed-consumer-results.yaml");
  assert.ok(guidance);
  assert.ok(submit);
  assert.equal(guidance.journeyRefs.includes("J-06"), false);
  assert.equal(submit.journeyRefs.includes("J-06"), true);
  assert.equal(journey.journeyId, "J-06");
  assert.equal(journey.steps[0].actionRef, submit.id);
  assert.equal(submit.actionDefinitionSemantics.sourceEnvelope.runtimeAdmission, "NOT_ADMITTED");
});
