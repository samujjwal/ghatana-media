import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { validateOwnerClosedJsonSchema } from "../scripts/lib/pdp-owner-leaf-wire-validation.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const operations = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));
const capabilities = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capabilities.yaml"), "utf8"));
const j05 = parse(readFileSync(resolve(root, ".product-experience/pdp-3-product-experience/journey-contracts/analyze-image-video-geometry-and-tracks.yaml"), "utf8"));
const purposeBindings = parse(readFileSync(resolve(root, ".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml"), "utf8"));

function visit(value, predicate) {
  if (!value || typeof value !== "object") return undefined;
  if (predicate(value)) return value;
  for (const child of Object.values(value)) {
    const found = visit(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function requiredObject(schema, name) {
  assert.equal(schema?.type, "object", `${name} is an object schema`);
  assert.equal(schema.additionalProperties, false, `${name} is closed`);
  return schema;
}

function sameValue(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && sameValue(left[key], right[key]));
}

function validateKnownScopeBindings(request, observation) {
  const selectors = request.input2.payload.scopeSelectors;
  const temporal = observation.temporalScope;
  if (temporal.disposition === "KNOWN") {
    if (selectors?.temporalApplicability !== "SELECTED") {
      return { valid: false, reason: "KNOWN_TEMPORAL_SCOPE_WITHOUT_SELECTED_APPLICABILITY" };
    }
    const frames = (selectors.frameSelectors ?? []).filter(({ selectorRef }) => selectorRef === temporal.selectorRef);
    const frame = frames.length === 1 ? frames[0] : undefined;
    const range = selectors.temporalRange?.selectorRef === temporal.selectorRef ? selectors.temporalRange : undefined;
    if ((frames.length > 1) || (Boolean(frame) === Boolean(range))) {
      return { valid: false, reason: "KNOWN_TEMPORAL_SCOPE_SELECTOR_NOT_UNIQUELY_REQUESTED" };
    }
    if (frame) {
      for (const key of ["streamRef", "frameIndex", "frameIndexOrigin", "sourceTimeBaseRef", "sourcePresentationTime"]) {
        if (temporal[key] !== undefined || frame[key] !== undefined) {
          if (!sameValue(temporal[key], frame[key])) {
            return { valid: false, reason: `KNOWN_TEMPORAL_SCOPE_${key.toUpperCase()}_MISMATCH` };
          }
        }
      }
    } else {
      if (!temporal.sourceTimeRange
        || temporal.sourceTimeRange.start !== range.start
        || temporal.sourceTimeRange.end !== range.end
        || temporal.sourceTimeRange.clockRef !== range.clockRef
        || temporal.sourceTimeBaseRef !== range.sourceTimeBaseRef) {
        return { valid: false, reason: "KNOWN_TEMPORAL_SCOPE_RANGE_MISMATCH" };
      }
    }
  }

  const spatial = observation.spatialScope;
  if (spatial.disposition === "KNOWN") {
    if (selectors?.spatialApplicability !== "SELECTED") {
      return { valid: false, reason: "KNOWN_SPATIAL_SCOPE_WITHOUT_SELECTED_APPLICABILITY" };
    }
    const regions = (selectors.regionSelectors ?? []).filter(({ selectorRef }) => selectorRef === spatial.selectorRef);
    if (regions.length !== 1) return { valid: false, reason: regions.length ? "KNOWN_SPATIAL_SCOPE_SELECTOR_NOT_UNIQUELY_REQUESTED" : "KNOWN_SPATIAL_SCOPE_SELECTOR_NOT_REQUESTED" };
    const region = regions[0];
    for (const key of ["regionRef", "coordinateContextRef", "bounds"]) {
      if (spatial[key] !== undefined || region[key] !== undefined) {
        if (!sameValue(spatial[key], region[key])) {
          return { valid: false, reason: `KNOWN_SPATIAL_SCOPE_${key.toUpperCase()}_MISMATCH` };
        }
      }
    }
  }
  return { valid: true };
}

function validateSourceObservationBindings(request, value, trustedTenantId) {
  const observations = value.sourceObservations;
  const observedDimensions = value.dimensionResults
    .filter(({ disposition }) => disposition === "OBSERVED")
    .map(({ dimensionRef }) => dimensionRef);
  const requiresObservations = value.overallDisposition === "COMPLETE" || observedDimensions.length > 0;
  if (requiresObservations && (!Array.isArray(observations) || observations.length === 0)) {
    return { valid: false, reason: "SOURCE_OBSERVATIONS_REQUIRED_FOR_COMPLETE_OR_OBSERVED" };
  }
  if (!observations) return { valid: true };

  const source = request.input1.payload;
  const requestedDimensions = new Set(request.input2.payload.dimensions);
  for (const observation of observations) {
    if (observation.subjectVersion.tenantId !== trustedTenantId
      || observation.subjectVersion.artifactId !== source.artifactId
      || observation.subjectVersion.versionId !== source.versionId) {
      return { valid: false, reason: "SOURCE_OBSERVATION_SUBJECT_MISMATCH" };
    }
    if (!requestedDimensions.has(observation.dimensionRef)) {
      return { valid: false, reason: "SOURCE_OBSERVATION_DIMENSION_NOT_REQUESTED" };
    }
    const scopeBinding = validateKnownScopeBindings(request, observation);
    if (!scopeBinding.valid) return scopeBinding;
  }
  for (const dimensionRef of observedDimensions) {
    if (!observations.some(({ dimensionRef: observedRef, subjectVersion }) =>
      observedRef === dimensionRef && subjectVersion.tenantId === trustedTenantId
        && subjectVersion.artifactId === source.artifactId && subjectVersion.versionId === source.versionId)) {
      return { valid: false, reason: "OBSERVED_DIMENSION_HAS_NO_MATCHING_SOURCE_OBSERVATION" };
    }
  }
  return { valid: true };
}

function visualValue(overrides = {}) {
  const observation = {
    dimensionRef: "dimension:objects",
    subjectVersion: { tenantId: "tenant-1", artifactId: "artifact-1", versionId: "version-7" },
    temporalScope: { disposition: "UNKNOWN" },
    spatialScope: { disposition: "UNKNOWN" },
    observedAt: "2026-10-19T10:00:00Z",
    provenanceDisclosure: { method: "UNKNOWN", provider: "UNKNOWN", model: "UNKNOWN", modelVersion: "UNKNOWN" },
    disposition: "OBSERVED",
    evidenceRefs: ["media:evidence:1"],
    reasonRefs: ["media:reason:1"],
  };
  return {
    analysisRef: "media:analysis:1",
    sourceRefs: ["media:source:artifact-1:version-7"],
    dimensionResults: [{
      dimensionRef: "dimension:objects",
      disposition: "OBSERVED",
      evidenceRef: "media:evidence:1",
      uncertaintyDisposition: "UNKNOWN",
      reasonRef: "media:reason:1",
    }],
    overallDisposition: "COMPLETE",
    sourceObservations: [observation],
    ...overrides,
  };
}

test("every P0 vision capability and currently selected J05 option traces to source-scoped P1 schemas", () => {
  const records = operations.capabilityOperationContracts.records;
  const p0VisionCapabilities = capabilities.capabilities.filter(({ familyId }) => familyId === "media.vision");
  const p3StepPurpose = purposeBindings.records.find(({ id }) => id === "media.pdp3.step-purpose-binding.j05-step-02.v1");
  assert.equal(p3StepPurpose.journeyRef, j05.journeyId);
  const p3SelectedOperations = p3StepPurpose.capabilityOptions.flatMap(({ operationRefs }) => operationRefs);
  const expectedOperationIds = new Set();
  for (const capability of p0VisionCapabilities) {
    const operation = records.find(({ capabilityRef }) => capabilityRef === capability.id);
    assert.ok(operation, `P0 capability ${capability.id} maps to a P1 operation`);
    expectedOperationIds.add(operation.id);
  }
  assert.ok(p0VisionCapabilities.length > 0, "P0 media.vision capability inventory is present");
  assert.ok(p3SelectedOperations.length > 0, "current J05 step-02 selected operations are present");
  for (const operationId of p3SelectedOperations) {
    assert.ok(expectedOperationIds.has(operationId), `J05 option ${operationId} is a P0 vision capability with P1 ownership`);
  }
  assert.equal(p3SelectedOperations.length, new Set(p3SelectedOperations).size, "purpose binding contains unique operation refs");

  for (const id of expectedOperationIds) {
    const operation = records.find((record) => record.id === id);
    const sourceIdentity = visit(operation.requestSchema, (node) =>
      node.type === "object" && node.properties?.artifactId && node.properties?.versionId
        && node.required?.includes("artifactId") && node.required?.includes("versionId"));
    assert.ok(sourceIdentity, `${id} requires an exact immutable source version`);

    const selectorOwner = visit(operation.requestSchema, (node) => node.properties?.scopeSelectors);
    assert.ok(selectorOwner, `${id} exposes typed source scope selectors`);
    const scope = selectorOwner.properties.scopeSelectors;
    assert.equal(scope?.properties?.temporalApplicability?.enum?.join(","), "SELECTED,NOT_APPLICABLE,UNKNOWN");
    assert.equal(scope?.properties?.spatialApplicability?.enum?.join(","), "SELECTED,NOT_APPLICABLE,UNKNOWN");
    assert.ok(scope?.properties?.frameSelectors?.items?.required?.includes("streamRef"));
    assert.ok(scope?.properties?.frameSelectors?.items?.required?.includes("frameIndex"));
    assert.ok(scope?.properties?.regionSelectors?.items?.required?.includes("coordinateContextRef"));

    const observations = visit(operation.resultSchema, (node) => node.properties?.sourceObservations);
    assert.ok(observations, `${id} can carry canonical source-scoped observations`);
    const completenessRules = visit(operation.resultSchema, (node) => node.allOf?.some((rule) =>
      rule.if?.properties?.overallDisposition?.const === "COMPLETE"
        && rule.then?.required?.includes("sourceObservations")));
    assert.ok(completenessRules, `${id} rejects COMPLETE without source observations`);
    assert.ok(visit(operation.resultSchema, (node) => node.allOf?.some((rule) =>
      rule.if?.properties?.dimensionResults?.contains?.properties?.disposition?.const === "OBSERVED"
        && rule.then?.required?.includes("sourceObservations"))), `${id} rejects OBSERVED dimensions without source observations`);
    const observation = requiredObject(observations.properties.sourceObservations.items, `${id}.sourceObservations[]`);
    assert.deepEqual(observation.required, [
      "dimensionRef", "subjectVersion", "temporalScope", "spatialScope", "observedAt",
      "provenanceDisclosure", "disposition", "evidenceRefs", "reasonRefs",
    ]);
    assert.deepEqual(observation.properties.subjectVersion.required, ["tenantId", "artifactId", "versionId"]);
    assert.deepEqual(observation.properties.temporalScope.properties.disposition.enum, ["KNOWN", "NOT_APPLICABLE", "UNKNOWN"]);
    assert.deepEqual(observation.properties.spatialScope.properties.disposition.enum, ["KNOWN", "NOT_APPLICABLE", "UNKNOWN"]);
    assert.deepEqual(observation.properties.disposition.enum, ["OBSERVED", "ESTIMATED", "PARTIAL", "ABSTAINED", "NOT_APPLICABLE", "UNKNOWN"]);
    assert.equal(observation.properties.sourceSignals.items.properties.sourceReported.const, true);
    assert.ok(observation.properties.sourceSignals.items.required.includes("sourceReported"));
    assert.deepEqual(observation.properties.sourceSignals.items.properties.value.oneOf.map(({ type }) => type), ["number", "string"]);
    assert.match(observation.properties.interpretationBoundary.const, /NO_CALIBRATION_PROBABILITY_CORRECTNESS/);
  }
});

test("shared visual observation output keeps provider/model and confidence source-reported only", () => {
  const output = operations.capabilityOperationContracts.outputPayloadSchemas.find(
    ({ id }) => id === "media.typed-output.typed-visual-analysis-result-with-applicability-and-uncertainty",
  );
  assert.ok(output);
  const observationOwner = visit(output.schema, (node) => node.properties?.sourceObservations);
  assert.ok(observationOwner);
  const observation = observationOwner.properties.sourceObservations.items;
  assert.equal(observation.properties.providerRef.format, "opaque-reference");
  assert.equal(observation.properties.modelRef.format, "opaque-reference");
  assert.deepEqual(observation.properties.provenanceDisclosure.required, ["method", "provider", "model", "modelVersion"]);
  for (const field of ["method", "provider", "model", "modelVersion"]) {
    assert.deepEqual(observation.properties.provenanceDisclosure.properties[field].enum, ["SOURCE_REPORTED", "NOT_REPORTED", "UNKNOWN"]);
  }
  assert.deepEqual(observation.properties.sourceSignals.items.required, [
    "kind", "signalRef", "value", "metricRef", "metricVersion", "methodRef", "sourceReported",
  ]);
  assert.equal(observation.properties.sourceSignals.items.properties.sourceReported.const, true);
  assert.match(observation.properties.interpretationBoundary.const, /NO_CALIBRATION_PROBABILITY_CORRECTNESS/);
});

test("legacy opaque timeRange stays fail-closed and vision analysis observations remain inline values", () => {
  const detect = operations.capabilityOperationContracts.records.find(
    ({ id }) => id === "media.operation.capability.media-vision-detect",
  );
  assert.ok(visit(detect.requestSchema, (node) => node.properties?.timeRange));
  const profile = operations.capabilityOperationContracts.families.find(
    ({ id }) => id === "media.capability-profile.media-vision",
  );
  assert.match(profile.profilePolicy, /legacy opaque `timeRange`/);
  assert.match(profile.profilePolicy, /absence is never a negative finding/);
  assert.match(profile.profilePolicy, /does not select or imply a shared coordinate convention/);

  const legacy = operations.operations.find(
    ({ id }) => id === "media.operation.vision-analysis",
  );
  assert.match(legacy.effect.observationValueDisposition, /NONPERSISTENT_INLINE_RESULT_VALUE/);
  assert.match(legacy.transition.status, /not-applicable-to-nonpersistent-inline-result/);
  assert.ok(legacy.inputSemantics.requestScopeRef.includes("media.typed-input.analysis-request"));
  assert.ok(legacy.effect.resultSchemaRef.includes("media.typed-output.typed-visual-analysis-result-with-applicability-and-uncertainty"));
});

test("COMPLETE and OBSERVED outputs reject omitted source observations", () => {
  const output = operations.capabilityOperationContracts.outputPayloadSchemas.find(
    ({ id }) => id === "media.typed-output.typed-visual-analysis-result-with-applicability-and-uncertainty",
  );
  const request = {
    input1: { payload: { artifactId: "artifact-1", versionId: "version-7" } },
    input2: { payload: { dimensions: ["dimension:objects"] } },
  };

  const completeWithoutObservations = visualValue();
  delete completeWithoutObservations.sourceObservations;
  const completeResult = { artifactType: output.artifactType, payload: { value: completeWithoutObservations } };
  assert.equal(validateOwnerClosedJsonSchema(output.schema, completeResult).valid, false);
  assert.deepEqual(validateSourceObservationBindings(request, completeWithoutObservations, "tenant-1"), {
    valid: false,
    reason: "SOURCE_OBSERVATIONS_REQUIRED_FOR_COMPLETE_OR_OBSERVED",
  });

  const partialObservedWithoutObservations = visualValue({ overallDisposition: "PARTIAL" });
  delete partialObservedWithoutObservations.sourceObservations;
  const partialResult = { artifactType: output.artifactType, payload: { value: partialObservedWithoutObservations } };
  assert.equal(validateOwnerClosedJsonSchema(output.schema, partialResult).valid, false);
  assert.equal(validateSourceObservationBindings(request, partialObservedWithoutObservations, "tenant-1").valid, false);
});

test("source observations reject mismatched artifact versions and unrequested dimensions", () => {
  const request = {
    input1: { payload: { artifactId: "artifact-1", versionId: "version-7" } },
    input2: { payload: { dimensions: ["dimension:objects"] } },
  };
  const mismatchedSubject = visualValue();
  mismatchedSubject.sourceObservations[0].subjectVersion.versionId = "version-8";
  assert.deepEqual(validateSourceObservationBindings(request, mismatchedSubject, "tenant-1"), {
    valid: false,
    reason: "SOURCE_OBSERVATION_SUBJECT_MISMATCH",
  });

  const unrequestedDimension = visualValue();
  unrequestedDimension.sourceObservations[0].dimensionRef = "dimension:faces";
  assert.deepEqual(validateSourceObservationBindings(request, unrequestedDimension, "tenant-1"), {
    valid: false,
    reason: "SOURCE_OBSERVATION_DIMENSION_NOT_REQUESTED",
  });

  const observedDimensionWithoutMatch = visualValue();
  observedDimensionWithoutMatch.sourceObservations[0].dimensionRef = "dimension:faces";
  const twoRequestedDimensions = {
    ...request,
    input2: { payload: { dimensions: ["dimension:objects", "dimension:faces"] } },
  };
  assert.deepEqual(validateSourceObservationBindings(twoRequestedDimensions, observedDimensionWithoutMatch, "tenant-1"), {
    valid: false,
    reason: "OBSERVED_DIMENSION_HAS_NO_MATCHING_SOURCE_OBSERVATION",
  });

  const mismatchedTenant = visualValue();
  assert.deepEqual(validateSourceObservationBindings(request, mismatchedTenant, "tenant-2"), {
    valid: false,
    reason: "SOURCE_OBSERVATION_SUBJECT_MISMATCH",
  });
});

test("KNOWN source scope requires source-linked temporal and spatial coordinates", () => {
  const output = operations.capabilityOperationContracts.outputPayloadSchemas.find(
    ({ id }) => id === "media.typed-output.typed-visual-analysis-result-with-applicability-and-uncertainty",
  );
  const resultFor = (value) => ({ artifactType: output.artifactType, payload: { value } });

  const knownTimeWithoutCoordinates = visualValue();
  knownTimeWithoutCoordinates.sourceObservations[0].temporalScope = {
    disposition: "KNOWN",
    selectorRef: "media:selector:frame-1",
    streamRef: "media:stream:1",
    sourceTimeBaseRef: "media:timebase:1",
  };
  assert.equal(validateOwnerClosedJsonSchema(output.schema, resultFor(knownTimeWithoutCoordinates)).valid, false);

  const knownRegionWithoutContext = visualValue();
  knownRegionWithoutContext.sourceObservations[0].spatialScope = {
    disposition: "KNOWN",
    selectorRef: "media:selector:region-1",
    regionRef: "media:region:1",
  };
  assert.equal(validateOwnerClosedJsonSchema(output.schema, resultFor(knownRegionWithoutContext)).valid, false);

  const knownCoordinates = visualValue();
  knownCoordinates.sourceObservations[0].temporalScope = {
    disposition: "KNOWN",
    selectorRef: "media:selector:frame-1",
    streamRef: "media:stream:1",
    sourceTimeBaseRef: "media:timebase:1",
    frameIndex: 12,
    frameIndexOrigin: "ZERO_BASED",
  };
  knownCoordinates.sourceObservations[0].spatialScope = {
    disposition: "KNOWN",
    selectorRef: "media:selector:region-1",
    regionRef: "media:region:1",
    coordinateContextRef: "media:coordinate-context:image-version-7",
  };
  assert.equal(validateOwnerClosedJsonSchema(output.schema, resultFor(knownCoordinates)).valid, true);
});

test("KNOWN scopes must join exact requested selectors and source coordinates", () => {
  const request = {
    input1: { payload: { artifactId: "artifact-1", versionId: "version-7" } },
    input2: { payload: {
      dimensions: ["dimension:objects"],
      scopeSelectors: {
        temporalApplicability: "SELECTED",
        frameSelectors: [{ selectorRef: "media:selector:frame-1", streamRef: "media:stream:1", frameIndex: 12, frameIndexOrigin: "ZERO_BASED", sourceTimeBaseRef: "media:timebase:1" }],
        spatialApplicability: "SELECTED",
        regionSelectors: [{ selectorRef: "media:selector:region-1", regionRef: "media:region:1", coordinateContextRef: "media:coordinate-context:image-version-7" }],
      },
    } },
  };
  const known = visualValue();
  known.sourceObservations[0].temporalScope = { disposition: "KNOWN", selectorRef: "media:selector:frame-1", streamRef: "media:stream:1", frameIndex: 12, frameIndexOrigin: "ZERO_BASED", sourceTimeBaseRef: "media:timebase:1" };
  known.sourceObservations[0].spatialScope = { disposition: "KNOWN", selectorRef: "media:selector:region-1", regionRef: "media:region:1", coordinateContextRef: "media:coordinate-context:image-version-7" };
  assert.deepEqual(validateSourceObservationBindings(request, known, "tenant-1"), { valid: true });

  const unrequestedTemporal = structuredClone(known);
  unrequestedTemporal.sourceObservations[0].temporalScope.selectorRef = "media:selector:unrequested";
  assert.equal(validateSourceObservationBindings(request, unrequestedTemporal, "tenant-1").reason, "KNOWN_TEMPORAL_SCOPE_SELECTOR_NOT_UNIQUELY_REQUESTED");
  const differingFrame = structuredClone(known);
  differingFrame.sourceObservations[0].temporalScope.frameIndex = 13;
  assert.equal(validateSourceObservationBindings(request, differingFrame, "tenant-1").reason, "KNOWN_TEMPORAL_SCOPE_FRAMEINDEX_MISMATCH");
  const unselectedTemporalScope = structuredClone(known);
  assert.equal(validateSourceObservationBindings({ ...request, input2: { payload: { ...request.input2.payload, scopeSelectors: { ...request.input2.payload.scopeSelectors, temporalApplicability: "NOT_APPLICABLE" } } } }, unselectedTemporalScope, "tenant-1").reason, "KNOWN_TEMPORAL_SCOPE_WITHOUT_SELECTED_APPLICABILITY");
  const noTemporalSelection = structuredClone(known);
  noTemporalSelection.sourceObservations[0].temporalScope.disposition = "KNOWN";
  assert.equal(validateSourceObservationBindings({ ...request, input2: { payload: { dimensions: ["dimension:objects"], scopeSelectors: { temporalApplicability: "UNKNOWN", spatialApplicability: "SELECTED", regionSelectors: request.input2.payload.scopeSelectors.regionSelectors } } } }, noTemporalSelection, "tenant-1").reason, "KNOWN_TEMPORAL_SCOPE_WITHOUT_SELECTED_APPLICABILITY");
  const differingRegion = structuredClone(known);
  differingRegion.sourceObservations[0].spatialScope.regionRef = "media:region:other";
  assert.equal(validateSourceObservationBindings(request, differingRegion, "tenant-1").reason, "KNOWN_SPATIAL_SCOPE_REGIONREF_MISMATCH");
  differingRegion.sourceObservations[0].spatialScope.regionRef = "media:region:1";
  differingRegion.sourceObservations[0].spatialScope.coordinateContextRef = "media:coordinate-context:other";
  assert.equal(validateSourceObservationBindings(request, differingRegion, "tenant-1").reason, "KNOWN_SPATIAL_SCOPE_COORDINATECONTEXTREF_MISMATCH");
  const unrequestedRegion = structuredClone(known);
  unrequestedRegion.sourceObservations[0].spatialScope.selectorRef = "media:selector:other";
  assert.equal(validateSourceObservationBindings(request, unrequestedRegion, "tenant-1").reason, "KNOWN_SPATIAL_SCOPE_SELECTOR_NOT_REQUESTED");
});

test("field-level provenance requires explicit model and model-version disclosure", () => {
  const output = operations.capabilityOperationContracts.outputPayloadSchemas.find(
    ({ id }) => id === "media.typed-output.typed-visual-analysis-result-with-applicability-and-uncertainty",
  );
  const resultFor = (value) => ({ artifactType: output.artifactType, payload: { value } });
  const reportedModelWithoutValue = visualValue();
  reportedModelWithoutValue.sourceObservations[0].provenanceDisclosure.model = "SOURCE_REPORTED";
  assert.equal(validateOwnerClosedJsonSchema(output.schema, resultFor(reportedModelWithoutValue)).valid, false);

  const partialDisclosure = visualValue();
  partialDisclosure.sourceObservations[0].modelRef = "media:model:vision-1";
  partialDisclosure.sourceObservations[0].provenanceDisclosure.model = "SOURCE_REPORTED";
  assert.equal(validateOwnerClosedJsonSchema(output.schema, resultFor(partialDisclosure)).valid, true);

  const unreportedModelWithValue = visualValue();
  unreportedModelWithValue.sourceObservations[0].modelRef = "media:model:vision-1";
  unreportedModelWithValue.sourceObservations[0].provenanceDisclosure.model = "NOT_REPORTED";
  assert.equal(validateOwnerClosedJsonSchema(output.schema, resultFor(unreportedModelWithValue)).valid, false);

  const omittedModelStatus = visualValue();
  delete omittedModelStatus.sourceObservations[0].provenanceDisclosure.model;
  assert.equal(validateOwnerClosedJsonSchema(output.schema, resultFor(omittedModelStatus)).valid, false);
});
