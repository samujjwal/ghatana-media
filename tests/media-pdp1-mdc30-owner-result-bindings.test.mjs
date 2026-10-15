import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const operations = parse(readFileSync(".product-experience/pdp-1-domain-data/operations.yaml", "utf8"));
const capability = operations.capabilityOperationContracts.records.find((row) =>
  row.id === "media.operation.capability.media-speech-synthesis-dub");
const observations = new Map(operations.ownerTypedObservationContracts.records.map((row) => [row.id, row]));
const validations = new Map(operations.ownerTypedObservationValidationRules.records.map((row) => [row.observationContractRef, row]));

function valueAt(root, path) {
  const parts = path.replace(/^\$\.?/u, "").replace(/\[(\d+)\]/gu, ".$1").split(".").filter(Boolean);
  return parts.reduce((value, part) => value?.[part], root);
}

function assertBindings(rules, root) {
  for (const rule of rules) {
    assert.equal(rule.operator, "EXACT_EQUAL", `${rule.id} declares exact equality`);
    assert.deepEqual(valueAt(root, rule.leftRef), valueAt(root, rule.rightRef), rule.id);
  }
}

function requireDubbingSuccessBindings() {
  assert.ok(capability, "canonical dubbing command exists");
  assert.equal(capability.resultSchema.bindingRuleScope, "SUCCEEDED_ONLY");
  assert.equal(capability.resultSchema.bindingRules.length, 13);
  return capability.resultSchema.bindingRules;
}

test("C16 successful dubbing result echoes the exact request source, locale, segments, profiles, and candidate", () => {
  const rules = requireDubbingSuccessBindings();
  const root = {
    request: {
      requestId: "dub-request-16",
      input2: { payload: {
        artifactId: "source-artifact",
        versionId: "source-version-5",
        sourceContentDigest: `sha256:${"a".repeat(64)}`,
        sourceClockId: "clock-48khz",
        ticksPerSecond: 48_000,
        sourceDurationTicks: 920_000,
      } },
      parameters: {
        sourceLocale: "en-US",
        targetLocale: "fr-FR",
        translatedSegmentVersionRef: "translation@version-8",
        voiceProfileVersionRef: "voice-profile@version-3",
        outputProfileRef: "dub-profile@version-4",
      },
    },
    result: {
      requestId: "dub-request-16",
      acceptedRequest: {
        sourceArtifactId: "source-artifact",
        sourceArtifactVersionId: "source-version-5",
        sourceContentDigest: `sha256:${"a".repeat(64)}`,
        sourceClockId: "clock-48khz",
        ticksPerSecond: 48_000,
        sourceDurationTicks: 920_000,
        sourceLocale: "en-US",
        targetLocale: "fr-FR",
        translatedSegmentVersionRef: "translation@version-8",
        voiceProfileVersionRef: "voice-profile@version-3",
        outputProfileRef: "dub-profile@version-4",
        candidateOutputRef: "dub-candidate@version-1",
      },
      outputs: [{ payload: { reference: "dub-candidate@version-1" } }],
    },
  };
  assertBindings(rules, root);

  for (const rule of rules) {
    const mutated = structuredClone(root);
    const parts = rule.rightRef.replace(/^\$\.?/u, "").replace(/\[(\d+)\]/gu, ".$1").split(".");
    const leaf = parts.pop();
    const parent = parts.reduce((value, part) => value[part], mutated);
    parent[leaf] = typeof parent[leaf] === "number" ? parent[leaf] + 1 : `${parent[leaf]}-substituted`;
    assert.throws(() => assertBindings(rules, mutated), new RegExp(rule.id.replaceAll(".", "\\."), "u"),
      `${rule.id} rejects an accepted-result substitution`);
  }
});

test("C22 acknowledgment resolves one immutable delivery result and keeps its fingerprint separate from the query fingerprint", () => {
  const contract = observations.get("media.observation-contract.destination-delivery-acknowledgment.v1");
  assert.ok(contract);
  const resolution = contract.resolvedOwnerResult;
  assert.equal(resolution.resultRef, "$.request.deliveryRequestResultRef");
  assert.equal(resolution.exactOperationRef, "media.operation.action.deliver-exact-version");
  assert.equal(resolution.immutableResultRequired, true);
  assert.deepEqual(resolution.trustedResolutionScope, ["tenantScopeRef", "principalRef", "currentReadAuthorityRef", "currentReadVersion"]);
  const queryFingerprint = resolution.queryFingerprint;
  assert.equal(queryFingerprint.resultPath, "$.result.requestFingerprint");
  assert.equal(queryFingerprint.originalCommandFingerprintPath, "$.request.deliveryRequestFingerprint");
  assert.equal(queryFingerprint.neverSubstitute, true);
  assert.match(queryFingerprint.derivation, /acknowledgment query over its own canonical request/u);
  assert.match(queryFingerprint.commandFingerprintDerivation, /delivery payload plus trusted tenant\/principal/u);

  const resolvedResult = {
    deliveryRequestId: "delivery-request-22",
    deliveryRequestFingerprint: `sha256:${"b".repeat(64)}`,
    exactTargetRef: "artifact-version@version-7",
    destinationRef: "destination@version-2",
  };
  const request = {
    deliveryRequestResultRef: "delivery-result@version-1",
    deliveryRequestId: resolvedResult.deliveryRequestId,
    deliveryRequestFingerprint: resolvedResult.deliveryRequestFingerprint,
    artifactVersionRef: resolvedResult.exactTargetRef,
    destinationRef: resolvedResult.destinationRef,
  };
  const acknowledgmentQueryFingerprint = `sha256:${"c".repeat(64)}`;
  const acknowledgmentResult = {
    requestFingerprint: acknowledgmentQueryFingerprint,
    observation: { originalRequestFingerprint: resolvedResult.deliveryRequestFingerprint },
  };
  assert.deepEqual(valueAt({ request }, queryFingerprint.originalCommandFingerprintPath),
    valueAt({ result: acknowledgmentResult }, "$.result.observation.originalRequestFingerprint"));
  assert.deepEqual(valueAt({ result: acknowledgmentResult }, queryFingerprint.resultPath), acknowledgmentQueryFingerprint);
  assert.notEqual(acknowledgmentResult.requestFingerprint, acknowledgmentResult.observation.originalRequestFingerprint,
    "the fixture carries the independently derived query fingerprint and original delivery fingerprint in separate fields");
  for (const binding of resolution.fieldBindings) {
    const resolvedValue = valueAt(resolvedResult, binding.resolvedResultPath);
    const requestValue = valueAt({ request }, binding.requestPath);
    assert.equal(binding.operator, binding.id.endsWith("artifact-version") ? "SAME_EXACT_IMMUTABLE_ARTIFACT_VERSION" : "EXACT_EQUAL");
    assert.deepEqual(resolvedValue, requestValue, binding.id);
    const substituted = structuredClone(request);
    const parts = binding.requestPath.replace(/^\$\.request\./u, "").split(".");
    const leaf = parts.pop();
    const parent = parts.reduce((value, part) => value[part], substituted);
    parent[leaf] = `${parent[leaf]}-substituted`;
    assert.notDeepEqual(resolvedValue, valueAt({ request: substituted }, binding.requestPath),
      `${binding.id} detects substitution in the resolved command result tuple`);
  }
  assert.equal(resolution.mismatchDisposition, "UNKNOWN_WITHOUT_ACKNOWLEDGMENT");
});

test("C25 delegated result references resolve to exact typed query results and reject substituted identities or lineage", () => {
  const contract = observations.get("media.observation-contract.delegated-integration-result-context.v1");
  assert.ok(contract);
  const rule = contract.resultResolutionRules.find((row) => row.id === "media.observation-resolution.delegated-context.exact-typed-result-tuple");
  assert.ok(rule);
  assert.equal(rule.appliesWhen, "BOUNDED_CONTEXT_RETURNED");
  assert.equal(rule.collectionPath, "$.result.observation.resultRefs[*]");
  assert.deepEqual(rule.resolveResultRefUnderTrustedContext, ["tenantScopeRef", "principalRef", "readAuthorityRef", "readVersion"]);
  assert.ok(rule.validateResolvedResultWith.uniqueValidationRuleRequired);
  assert.match(rule.digestRule, /sha256 over the canonical exact owner result body/u);
  const lineageRule = rule.sourceSpecificBindings.find((row) => row.resultKind === "OUTPUT_PREVIEW_VERSION");
  assert.deepEqual(lineageRule.tupleFields, ["artifactVersionRef", "artifactDigest", "sourceLineage"]);
  const statusContractRef = ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.job-status-seven-dimension.v1";
  const statusContract = observations.get("media.observation-contract.job-status-seven-dimension.v1");
  const statusIdentity = rule.operationIdentityBindings.find((row) => row.resultKind === "JOB_STATUS");
  assert.ok(statusIdentity);
  assert.deepEqual(statusIdentity.bindings.map((row) => [row.identityKind, row.tuplePath, row.resolvedPath]), [
    ["PRESENTATION", "$.operationRef", "$.resolvedResult.presentationOperationRef"],
    ["SOURCE_QUERY", "$.sourceQueryOperationRef", "$.resolvedResult.operationRef"],
  ]);
  assert.equal(statusIdentity.typedContractOperationRefMustInclude, "$.sourceQueryOperationRef");
  assert.deepEqual(statusContract.operationRefs, ["media.operation.job-status.read-dimensions.v1"]);
  assert.equal(statusContract.sourceQueryOperationRef, ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.job-status.read-dimensions.v1");
  assert.deepEqual(statusContract.resultSchema.properties.operationRef.enum, ["media.operation.job-status.read-dimensions.v1"]);
  assert.deepEqual(statusContract.resultSchema.properties.presentationOperationRef.enum, ["media.operation.action.view-job-status"]);
  const statusObservationSchema = statusContract.resultSchema.properties.observation.oneOf.find((branch) => branch.properties?.dimensionRefs);
  const sevenDimensionSchema = statusObservationSchema.properties.dimensionRefs;
  const sevenDimensionResult = sevenDimensionSchema.items.enum;
  assert.equal(sevenDimensionSchema.minItems, 7);
  assert.equal(sevenDimensionSchema.maxItems, 7);
  assert.equal(sevenDimensionSchema.uniqueItems, true);
  assert.deepEqual([...sevenDimensionResult].sort(), ["overallJob", "stageProgress", "attemptClaimAndLease", "cancellationOutcome", "remoteOutcomeCertainty", "qualityDisposition", "deliveryStatus"].sort());

  const tuple = {
    resultKind: "OUTPUT_PREVIEW_VERSION",
    operationRef: "media.operation.action.inspect-output-preview-and-version",
    observationContractRef: ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.output-preview-version-lineage.v1",
    resultRef: "output-result@version-3",
    queryId: "output-query-25",
    requestFingerprint: `sha256:${"d".repeat(64)}`,
    resultDigest: `sha256:${"e".repeat(64)}`,
    readVersion: "read-version-25",
    observedAt: "2026-10-13T12:00:00Z",
    currentness: "CURRENT",
    artifactVersionRef: "output-artifact@version-9",
    artifactDigest: `sha256:${"f".repeat(64)}`,
    sourceLineage: [{ sourceArtifactVersionRef: "source@version-1", sourceDigest: `sha256:${"1".repeat(64)}`, relationRef: "derived-from" }],
  };
  const resolvedResult = {
    immutableResultRef: tuple.resultRef,
    observationContractRef: tuple.observationContractRef,
    operationRef: tuple.operationRef,
    queryId: tuple.queryId,
    requestFingerprint: tuple.requestFingerprint,
    canonicalResultDigest: tuple.resultDigest,
    readVersion: tuple.readVersion,
    observedAt: tuple.observedAt,
    currentness: tuple.currentness,
    observation: {
      artifactVersionRef: tuple.artifactVersionRef,
      artifactDigest: tuple.artifactDigest,
      sourceLineage: structuredClone(tuple.sourceLineage),
    },
  };
  const resolveValid = (candidate, result) => {
    const expanded = { ...candidate, resolvedResult: result };
    const recordMatches = rule.resolvedRecordMustMatch.every((join) =>
      valueAt(expanded, join.tuplePath) === valueAt(expanded, join.resolvedPath));
    const identity = rule.operationIdentityBindings.find((row) => row.resultKind === candidate.resultKind);
    const identitiesMatch = identity?.bindings.every((binding) =>
      valueAt(expanded, binding.tuplePath) === valueAt(expanded, binding.resolvedPath)
      && valueAt(expanded, binding.tuplePath) === binding.exactValue) === true;
    const typedOperationIsDeclared = !identity?.typedContractOperationRefMustInclude
      || observations.get(candidate.observationContractRef.split("@id=").at(-1))?.operationRefs
        .includes(valueAt(expanded, identity.typedContractOperationRefMustInclude)) === true;
    const lineageMatches = candidate.resultKind !== "OUTPUT_PREVIEW_VERSION" || lineageRule.tupleFields.every((field) =>
      JSON.stringify(candidate[field]) === JSON.stringify(valueAt(expanded, `${lineageRule.resolvedResultPath}.${field}`)));
    return recordMatches && identitiesMatch && typedOperationIsDeclared && lineageMatches;
  };
  assert.equal(resolveValid(tuple, resolvedResult), true);
  const contractId = tuple.observationContractRef.split("@id=").at(-1);
  assert.equal(observations.get(contractId).operationRefs.includes(tuple.operationRef), true);
  assert.equal(validations.get(contractId).observationContractRef, contractId,
    "the tuple's exact contract has one source validator");
  for (const join of rule.resolvedRecordMustMatch) {
    const changed = structuredClone(tuple);
    changed[join.tuplePath.replace(/^\$\./u, "")] = "substituted";
    assert.equal(resolveValid(changed, resolvedResult), false, `${join.id ?? join.tuplePath} rejects a substituted resolved-result identity`);

    const changedResolved = structuredClone(resolvedResult);
    const resolvedPath = join.resolvedPath.replace(/^\$\.resolvedResult\./u, "").split(".");
    const resolvedLeaf = resolvedPath.pop();
    const resolvedParent = resolvedPath.reduce((value, part) => value[part], changedResolved);
    resolvedParent[resolvedLeaf] = `${resolvedParent[resolvedLeaf]}-substituted`;
    assert.equal(resolveValid(tuple, changedResolved), false,
      `${join.id ?? join.resolvedPath} rejects a substituted resolved owner result while the candidate tuple stays unchanged`);
  }
  const changedLineage = structuredClone(tuple);
  changedLineage.sourceLineage[0].sourceDigest = `sha256:${"2".repeat(64)}`;
  assert.equal(resolveValid(changedLineage, resolvedResult), false, "delegated lineage must equal the exact resolved preview result");
  const changedResolvedLineage = structuredClone(resolvedResult);
  changedResolvedLineage.observation.sourceLineage[0].sourceDigest = `sha256:${"2".repeat(64)}`;
  assert.equal(resolveValid(tuple, changedResolvedLineage), false,
    "the exact result digest/lineage remains joined when the candidate tuple is unchanged");

  const statusTuple = {
    resultKind: "JOB_STATUS",
    operationRef: "media.operation.action.view-job-status",
    sourceQueryOperationRef: "media.operation.job-status.read-dimensions.v1",
    observationContractRef: statusContractRef,
    resultRef: "job-status-result@version-6",
    queryId: "job-status-query-25",
    requestFingerprint: `sha256:${"7".repeat(64)}`,
    resultDigest: `sha256:${"8".repeat(64)}`,
    readVersion: "job-status-read-25",
    observedAt: "2026-10-13T12:01:00Z",
    currentness: "CURRENT",
  };
  const dimensionRefs = ["overallJob", "stageProgress", "attemptClaimAndLease", "cancellationOutcome", "remoteOutcomeCertainty", "qualityDisposition", "deliveryStatus"];
  const statusResolvedResult = {
    immutableResultRef: statusTuple.resultRef,
    observationContractRef: statusTuple.observationContractRef,
    operationRef: statusTuple.sourceQueryOperationRef,
    presentationOperationRef: statusTuple.operationRef,
    queryId: statusTuple.queryId,
    requestFingerprint: statusTuple.requestFingerprint,
    canonicalResultDigest: statusTuple.resultDigest,
    readVersion: statusTuple.readVersion,
    observedAt: statusTuple.observedAt,
    currentness: statusTuple.currentness,
    observation: {
      jobId: "job-25",
      sourceResultRef: "job-status-source-result@version-6",
      sourceResultDigest: `sha256:${"9".repeat(64)}`,
      sourceResultSchemaRef: statusContract.sourceResultSchemaRef,
      stageRefs: [],
      qualitySubjectVersionRefs: [],
      destinationRefs: [],
      dimensionRefs,
    },
  };
  assert.equal(resolveValid(statusTuple, statusResolvedResult), true,
    "JOB_STATUS retains the view-job-status presentation identity while resolving the seven-dimension source query");
  assert.deepEqual(statusResolvedResult.observation.dimensionRefs, sevenDimensionResult);
  for (const binding of statusIdentity.bindings) {
    const tuplePath = binding.tuplePath.replace(/^\$\./u, "");
    const changedTuple = structuredClone(statusTuple);
    changedTuple[tuplePath] = `${changedTuple[tuplePath]}-substituted`;
    assert.equal(resolveValid(changedTuple, statusResolvedResult), false,
      `${binding.identityKind} identity rejects a substituted tuple value`);

    const resolvedPath = binding.resolvedPath.replace(/^\$\.resolvedResult\./u, "");
    const changedResolved = structuredClone(statusResolvedResult);
    changedResolved[resolvedPath] = `${changedResolved[resolvedPath]}-substituted`;
    assert.equal(resolveValid(statusTuple, changedResolved), false,
      `${binding.identityKind} identity rejects a substituted exact result value`);
  }

  const processingIdentity = rule.operationIdentityBindings.find((row) => row.resultKind === "PROCESSING_PARAMETERS");
  const processingTuple = {
    resultKind: "PROCESSING_PARAMETERS",
    operationRef: "media.operation.action.review-processing-parameters",
    observationContractRef: ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.processing-parameter-read.v1",
    resultRef: "processing-parameters-result@version-2",
    queryId: "processing-parameters-query-25",
    requestFingerprint: `sha256:${"a".repeat(64)}`,
    resultDigest: `sha256:${"b".repeat(64)}`,
    readVersion: "processing-parameters-read-25",
    observedAt: "2026-10-13T12:02:00Z",
    currentness: "CURRENT",
  };
  const processingResolvedResult = {
    immutableResultRef: processingTuple.resultRef,
    observationContractRef: processingTuple.observationContractRef,
    operationRef: processingTuple.operationRef,
    queryId: processingTuple.queryId,
    requestFingerprint: processingTuple.requestFingerprint,
    canonicalResultDigest: processingTuple.resultDigest,
    readVersion: processingTuple.readVersion,
    observedAt: processingTuple.observedAt,
    currentness: processingTuple.currentness,
    observation: {},
  };
  assert.ok(processingIdentity);
  assert.equal(resolveValid(processingTuple, processingResolvedResult), true,
    "PROCESSING_PARAMETERS keeps its exact single operation identity");
  const changedProcessing = structuredClone(processingResolvedResult);
  changedProcessing.operationRef = "media.operation.action.view-job-status";
  assert.equal(resolveValid(processingTuple, changedProcessing), false,
    "PROCESSING_PARAMETERS rejects an operation identity substitution");
});
