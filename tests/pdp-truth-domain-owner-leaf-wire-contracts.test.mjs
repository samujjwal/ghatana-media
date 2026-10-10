import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { resolveEffectiveOwnerLeafWireContract, validateOwnerLeafWireRequest, validateOwnerLeafWireResult } from "../scripts/lib/pdp-owner-leaf-wire-validation.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const parse = require("yaml").parse;
const operations = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));
const review = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml"), "utf8"));
const quality = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/quality-policy.yaml"), "utf8"));
const owner = operations.ownerLeafWireContracts;
const byCapability = new Map(owner.records.map((record) => [record.capabilityRef, record]));
const baseOperations = new Set(operations.capabilityOperationContracts.records.map((row) => row.id));
const adjudications = new Map(review.ownerCapabilityLeafAdjudication.records.map((row) => [row.capabilityRef, row]));
const qualityRows = new Map(quality.ownerQualityApplicabilityCrosswalk.records.map((row) => [row.capabilityRef, row]));

function example(schema) {
  if (Object.hasOwn(schema, "const")) return structuredClone(schema.const);
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf) return example(schema.anyOf[0]);
  if (schema.oneOf) return example(schema.oneOf[0]);
  if (Array.isArray(schema.type)) return example({ ...schema, type: schema.type.find((type) => type !== "null") });
  if (schema.type === "object") {
    const out = {};
    for (const key of schema.required ?? []) out[key] = example(schema.properties[key] ?? {});
    return out;
  }
  if (schema.type === "array") return Array.from({ length: schema.minItems ?? 0 }, () => example(schema.items ?? {}));
  if (schema.type === "integer") return schema.minimum ?? 1;
  if (schema.type === "number") return schema.minimum ?? 0;
  if (schema.type === "boolean") return false;
  if (schema.type === "string") {
    if (schema.pattern?.startsWith("^video/")) return "video/mp4";
    if (schema.pattern?.startsWith("^(?:image|video)/")) return "image/png";
    if (schema.pattern?.startsWith("^video/")) return "video/mp4";
    if (schema.pattern?.includes("image|video")) return "image/png";
    if (schema.pattern?.includes("sha256:")) return `sha256:${"a".repeat(64)}`;
    if (schema.format === "date-time") return "2026-10-09T12:00:00Z";
    return "ref";
  }
  return {};
}

function successFixture(contract) {
  const request = example(contract.requestSchema);
  const result = example(contract.resultSchema);
  result.outcome = "SUCCEEDED";
  result.observedAt = "2026-10-09T12:00:00Z";
  result.outputs = [example(contract.resultSchema.properties.outputs.items)];
  result.provenance.operationRef = contract.operationRef;
  result.provenance.sourceRefs = [];
  if (contract.capabilityRef.startsWith("media.simulation.output.")) {
    const output = result.outputs[0].payload;
    output.modelRef = request.input1.payload.modelRef;
    output.initialStateRef = request.input1.payload.initialStateRef;
    output.simulationStateInputRef = request.input1.payload.initialStateRef;
    output.passKind = request.input2.payload.passKind;
    output.profileId = request.input2.payload.profileId;
    output.profileVersion = request.input2.payload.profileVersion;
    output.simulationPlanRef = request.parameters.simulationPlanRef;
    output.passContractRef = request.parameters.passContractRef;
    output.productionEvidenceRef = "evidence-ref";
    result.provenance.profileId = request.input2.payload.profileId;
    result.provenance.profileVersion = request.input2.payload.profileVersion;
    result.provenance.sourceRefs = [output.modelRef, output.initialStateRef, output.simulationPlanRef, output.passContractRef, output.productionEvidenceRef];
  } else {
    const payload = request.input2.payload;
    payload.sourceArtifactId = request.input1.payload.artifactId;
    payload.sourceArtifactVersionRef = request.input1.payload.versionId;
    const output = result.outputs[0].payload.oneOf ? result.outputs[0].payload : result.outputs[0].payload;
    // JSON Schema's oneOf is in the schema, not in the instance: choose its first
    // exact output branch, then bind it to the request source and MIME family.
    const outputSchema = contract.resultSchema.properties.outputs.items.properties.payload.oneOf[0];
    const concrete = example(outputSchema);
    concrete.sourceArtifactId = request.input1.payload.artifactId;
    concrete.sourceArtifactVersionRef = request.input1.payload.versionId;
    concrete.editKind = payload.editKind;
    concrete.outputMediaType = request.input1.payload.declaredMediaType;
    concrete.provenanceRef = "evidence-ref";
    concrete.changeRecordRef = "change-ref";
    result.outputs[0].payload = concrete;
    result.provenance.sourceRefs = [concrete.sourceArtifactVersionRef, concrete.changeRecordRef, concrete.provenanceRef];
    if (contract.targetParameterRef) request.input2.payload.targetRef = request.input2.payload.editParameters[contract.targetParameterRef];
  }
  return { request, result };
}

test("owner wire overlays close all 11 simulation pass leaves and 18 edit leaves", () => {
  assert.equal(owner.records.length, 29);
  assert.equal(owner.outputTypes.records.length, 11);
  assert.equal(owner.mediaTypePolicies.records.length, 18);
  assert.equal(new Set(owner.records.map((row) => row.id)).size, 29);
  for (const contract of owner.records) {
    assert.ok(baseOperations.has(contract.operationRef), `${contract.id} binds an exact canonical base operation`);
    assert.equal(contract.definitionStatus, "OWNER_DEFINED_DEFINITION_ONLY");
    assert.equal(contract.executionAdmission, "NOT_ADMITTED");
    assert.equal(contract.qualificationState, "NOT_EVALUATED");
    assert.ok(contract.requestSchema.additionalProperties === false);
    assert.ok(contract.resultSchema.additionalProperties === false);
    const leaf = adjudications.get(contract.capabilityRef);
    assert.ok(leaf, `${contract.capabilityRef} has an exact PDP-0 leaf disposition`);
    assert.equal(leaf.ownerLeafWireContractRef, contract.id);
    assert.ok(leaf.exactTypedOutputSchemaRefs.includes(contract.ownerOutputSchemaRef ?? contract.successOutputSchemaRef));
    const qualityRow = qualityRows.get(contract.capabilityRef);
    assert.ok(qualityRow, `${contract.capabilityRef} has a complete quality row`);
    if (contract.capabilityRef.startsWith("media.simulation.output.")) {
      const slug = contract.capabilityRef.split(".").at(-1);
      assert.equal(contract.outputType, `simulation-pass-result-${slug}`);
      assert.equal(contract.outputTypeRef, `media.owner-output-type.simulation-pass-result-${slug}.v1`);
      assert.deepEqual(leaf.exactTypedOutputSchemaRefs, [contract.ownerOutputSchemaRef]);
      assert.deepEqual(contract.domainObjectRefs, ["media.domain.media-run"]);
      assert.deepEqual(qualityRow.outputArtifactTypes, [contract.outputType]);
      assert.equal(qualityRow.ownerCapabilityIntentRef,
        `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${contract.capabilityRef}`);
    }
    const { request, result } = successFixture(contract);
    const resolved = resolveEffectiveOwnerLeafWireContract(operations, contract.capabilityRef);
    assert.equal(resolved.valid, true, `${contract.capabilityRef} resolves through the production overlay resolver`);
    assert.equal(resolved.contract.id, contract.id);
    assert.equal(resolved.contract.baseOperation.id, contract.operationRef);
    const requestCheck = validateOwnerLeafWireRequest(contract, request);
    assert.deepEqual(requestCheck.valid, true, `${contract.id} has a positive typed request fixture: ${JSON.stringify(requestCheck.errors)}`);
    const resultCheck = validateOwnerLeafWireResult(contract, request, result);
    assert.deepEqual(resultCheck.valid, true, `${contract.id} has a positive, source-bound success fixture: ${JSON.stringify(resultCheck)}`);
  }
});

test("owner wire base selectors resolve an exact real operation, profile, and bound", () => {
  for (const record of owner.records) {
    const resolved = resolveEffectiveOwnerLeafWireContract(operations, record.capabilityRef);
    assert.equal(resolved.valid, true, `${record.id} resolves its actual base operation selector`);
    assert.equal(resolved.contract.baseOperation.id, record.operationRef);
  }
  const first = owner.records[0];
  const foreignFile = structuredClone(operations);
  foreignFile.ownerLeafWireContracts.records[0].baseOperationContractRef = `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilityOperationContracts/records/@id=${first.operationRef}`;
  assert.equal(resolveEffectiveOwnerLeafWireContract(foreignFile, first.capabilityRef).valid, false,
    "a syntactically valid selector in a different source file is rejected");
  const wrongValidOperation = structuredClone(operations);
  wrongValidOperation.ownerLeafWireContracts.records[0].baseOperationContractRef = `.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/@id=${owner.records[1].operationRef}`;
  assert.equal(resolveEffectiveOwnerLeafWireContract(wrongValidOperation, first.capabilityRef).valid, false,
    "a different valid operation cannot be substituted by matching only a pointer prefix");
  const wrongValidProfile = structuredClone(operations);
  wrongValidProfile.capabilityOperationContracts.records.find(({ id }) => id === first.operationRef).familyProfileRef = operations.capabilityOperationContracts.families.find(({ id }) => id !== operations.capabilityOperationContracts.records.find(({ id }) => id === first.operationRef).familyProfileRef)?.id;
  assert.equal(resolveEffectiveOwnerLeafWireContract(wrongValidProfile, first.capabilityRef).valid, false,
    "a different existing profile that does not own the leaf is rejected");
});

test("simulation passes reject cross-pass output, missing provenance and wrong source bindings", () => {
  const simulation = owner.records.filter((row) => row.capabilityRef.startsWith("media.simulation.output."));
  assert.equal(simulation.length, 11);
  for (const contract of simulation) {
    const fixture = successFixture(contract);
    const other = simulation.find((row) => row.id !== contract.id);
    const wrongPassOutput = structuredClone(fixture.result);
    wrongPassOutput.outputs[0].artifactType = other.outputType;
    assert.equal(validateOwnerLeafWireResult(contract, fixture.request, wrongPassOutput).valid, false, `${contract.id} rejects another pass result type`);
    const wrongKind = structuredClone(fixture.request);
    wrongKind.input2.payload.passKind = "different-pass";
    assert.equal(validateOwnerLeafWireRequest(contract, wrongKind).valid, false, `${contract.id} rejects a wrong requested pass`);
    const missingEvidence = structuredClone(fixture.result);
    delete missingEvidence.outputs[0].payload.productionEvidenceRef;
    assert.equal(validateOwnerLeafWireResult(contract, fixture.request, missingEvidence).valid, false, `${contract.id} rejects missing evidence`);
    const wrongModel = structuredClone(fixture.result);
    wrongModel.outputs[0].payload.modelRef = "different-model";
    assert.equal(validateOwnerLeafWireResult(contract, fixture.request, wrongModel).reason, "CROSS_FIELD_BINDING_REJECTED");
    const sameVersionDifferentProfile = structuredClone(fixture.request);
    sameVersionDifferentProfile.input2.payload.profileId = "different-profile";
    assert.equal(validateOwnerLeafWireResult(contract, sameVersionDifferentProfile, fixture.result).reason, "CROSS_FIELD_BINDING_REJECTED",
      `${contract.id} binds the selected profile ID as well as its version`);
    const differentProfileVersion = structuredClone(fixture.request);
    differentProfileVersion.input2.payload.profileVersion = "v-2";
    assert.equal(validateOwnerLeafWireResult(contract, differentProfileVersion, fixture.result).reason, "CROSS_FIELD_BINDING_REJECTED",
      `${contract.id} rejects a substituted profile version`);
    const contradictoryPassContract = structuredClone(fixture.request);
    contradictoryPassContract.input2.payload.passContractRef = "pass-contract-other";
    assert.equal(validateOwnerLeafWireRequest(contract, contradictoryPassContract).reason, "REQUEST_FIELD_BINDING_REJECTED",
      `${contract.id} rejects conflicting pass contract references before any outcome`);
    for (const rule of contract.crossFieldRules) {
      assert.equal(rule.whenOutcome, "SUCCEEDED");
      assert.equal(rule.scope, "SUCCESS_OUTPUT_ONLY");
      const missingRuleResult = structuredClone(fixture.result);
      const resultPath = rule.rightRef.match(/^\$\.result\.outputs\[0\]\.payload\.(.+)$/u)?.[1];
      if (resultPath) delete missingRuleResult.outputs[0].payload[resultPath];
      else if (rule.rightRef.startsWith("$.result.provenance.")) delete missingRuleResult.provenance[rule.rightRef.slice("$.result.provenance.".length)];
      else if (rule.rightRef === "$.result.provenance.sourceRefs") missingRuleResult.provenance.sourceRefs = [];
      assert.equal(validateOwnerLeafWireResult(contract, fixture.request, missingRuleResult).valid, false, `${rule.id} rejects a missing output binding`);
    }
    const fabricatedWorldOutput = structuredClone(fixture.result);
    fabricatedWorldOutput.outputs[0].payload.simulationWorldVersionRef = "invented-world-version";
    assert.equal(validateOwnerLeafWireResult(contract, fixture.request, fabricatedWorldOutput).valid, false, `${contract.id} rejects a fabricated world-output field`);
    for (const outcome of ["REJECTED", "UNKNOWN_OUTCOME"]) {
      const nonSuccess = structuredClone(fixture.result);
      nonSuccess.outcome = outcome;
      nonSuccess.outputs = [];
      assert.equal(validateOwnerLeafWireResult(contract, fixture.request, nonSuccess).valid, true, `${contract.id} represents ${outcome} without claiming output`);
      nonSuccess.outputs = [fixture.result.outputs[0]];
      assert.equal(validateOwnerLeafWireResult(contract, fixture.request, nonSuccess).valid, false, `${contract.id} rejects output finality for ${outcome}`);
    }
  }
});

test("edit leaves reject wrong operation parameters, unsupported media types and unbound source/output versions", () => {
  const edits = owner.records.filter((row) => row.capabilityRef.startsWith("media.edit."));
  assert.equal(edits.length, 18);
  for (const contract of edits) {
    const fixture = successFixture(contract);
    const wrongKind = structuredClone(fixture.request);
    wrongKind.input2.payload.editKind = "different-edit";
    assert.equal(validateOwnerLeafWireRequest(contract, wrongKind).valid, false, `${contract.id} rejects another edit kind`);
    const missingParameter = structuredClone(fixture.request);
    delete missingParameter.input2.payload.editParameters[Object.keys(contract.requestSchema.properties.input2.properties.payload.properties.editParameters.properties)[0]];
    assert.equal(validateOwnerLeafWireRequest(contract, missingParameter).valid, false, `${contract.id} rejects a missing exact edit parameter`);
    const unknownField = structuredClone(fixture.request);
    unknownField.input2.payload.unreviewedCallerField = true;
    assert.equal(validateOwnerLeafWireRequest(contract, unknownField).valid, false, `${contract.id} rejects unknown request fields`);
    const wrongSource = structuredClone(fixture.result);
    wrongSource.outputs[0].payload.sourceArtifactVersionRef = "different-source-version";
    assert.equal(validateOwnerLeafWireResult(contract, fixture.request, wrongSource).reason, "CROSS_FIELD_BINDING_REJECTED");
    const sameVersionDifferentArtifact = structuredClone(fixture.request);
    sameVersionDifferentArtifact.input1.payload.artifactId = "artifact-other";
    assert.equal(validateOwnerLeafWireResult(contract, sameVersionDifferentArtifact, fixture.result).reason, "CROSS_FIELD_BINDING_REJECTED",
      `${contract.id} rejects a source version reused from a different artifact identity`);
    const wrongSourceArtifact = structuredClone(fixture.result);
    wrongSourceArtifact.outputs[0].payload.sourceArtifactId = "artifact-other";
    assert.equal(validateOwnerLeafWireResult(contract, fixture.request, wrongSourceArtifact).reason, "CROSS_FIELD_BINDING_REJECTED",
      `${contract.id} rejects output lineage to a different source artifact`);
    for (const rule of contract.crossFieldRules) {
      assert.equal(rule.whenOutcome, "SUCCEEDED");
      assert.equal(rule.scope, "SUCCESS_OUTPUT_ONLY");
    }
    const unknownMime = structuredClone(fixture.request);
    unknownMime.input1.payload.declaredMediaType = "application/json";
    assert.equal(validateOwnerLeafWireRequest(contract, unknownMime).valid, false, `${contract.id} rejects non-media MIME input`);
    const wrongOutputFamily = structuredClone(fixture.result);
    wrongOutputFamily.outputs[0].payload.outputMediaType = contract.sourceMediaFamilies.includes("video") ? "video/mp4" : "video/mp4";
    if (contract.sourceMediaFamilies.length === 1 && contract.sourceMediaFamilies[0] === "video") {
      const wrongImage = structuredClone(fixture.request);
      wrongImage.input1.payload.declaredMediaType = "image/png";
      assert.equal(validateOwnerLeafWireRequest(contract, wrongImage).valid, false, `${contract.id} is video-only`);
    }
    if (fixture.request.input1.payload.declaredMediaType.startsWith("image/")) {
      assert.equal(validateOwnerLeafWireResult(contract, fixture.request, wrongOutputFamily).reason, "CROSS_FIELD_BINDING_REJECTED", `${contract.id} cannot change image input into video output`);
    }
  }
});

test("owner wire schemas reject invalid calendar dates, whitespace identifiers and undeclared formats", () => {
  const contract = owner.records[0];
  const fixture = successFixture(contract);
  for (const invalidDate of ["not-a-date", "2026-02-30T12:00:00Z", "2026-10-09T25:00:00Z"]) {
    const badResult = structuredClone(fixture.result);
    badResult.observedAt = invalidDate;
    assert.equal(validateOwnerLeafWireResult(contract, fixture.request, badResult).valid, false, `reject observedAt ${invalidDate}`);
    if (badResult.provenance.observedAt !== undefined) badResult.provenance.observedAt = invalidDate;
  }

  const findFormatPath = (schema, prefix = []) => {
    if (!schema || typeof schema !== "object") return null;
    if (schema.format && schema.format !== "date-time") return [...prefix, schema];
    if (Array.isArray(schema)) {
      for (let index = 0; index < schema.length; index += 1) {
        const found = findFormatPath(schema[index], [...prefix, index]);
        if (found) return found;
      }
      return null;
    }
    for (const [key, value] of Object.entries(schema)) {
      const found = findFormatPath(value, [...prefix, key]);
      if (found) return found;
    }
    return null;
  };
  const malformedSchema = structuredClone(contract.requestSchema);
  const located = findFormatPath(malformedSchema);
  assert.ok(located, "fixture request schema has an exact source-declared opaque scalar format");
  located.at(-1).format = "unregistered-owner-format";
  assert.equal(validateOwnerLeafWireRequest({ ...contract, requestSchema: malformedSchema }, fixture.request).valid, false);

  const findMutableString = (schema, value, prefix = []) => {
    if (!schema || typeof schema !== "object") return null;
    if (schema.type === "string" && schema.minLength && schema.format !== "date-time") return prefix;
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      const found = findMutableString(child, value, [...prefix, key]);
      if (found) return found;
    }
    return null;
  };
  const stringPath = findMutableString(contract.requestSchema);
  assert.ok(stringPath, "fixture request schema has a constrained opaque string");
  const whitespace = structuredClone(fixture.request);
  let cursor = whitespace;
  for (const part of stringPath.slice(0, -1)) cursor = cursor[part];
  cursor[stringPath.at(-1)] = "   ";
  assert.equal(validateOwnerLeafWireRequest(contract, whitespace).valid, false, "whitespace-only opaque references are invalid");
  const patternedSchema = structuredClone(contract.requestSchema);
  const findPattern = (schema, prefix = []) => {
    if (!schema || typeof schema !== "object") return null;
    if (schema.type === "string" && schema.pattern && schema.minLength) return prefix;
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      const found = findPattern(child, [...prefix, key]);
      if (found) return found;
    }
    return null;
  };
  const patternPath = findPattern(patternedSchema);
  assert.ok(patternPath, "fixture request schema includes a source-backed scalar pattern");
  const invalidScalar = structuredClone(fixture.request);
  cursor = invalidScalar;
  for (const part of patternPath.slice(0, -1)) cursor = cursor[part];
  cursor[patternPath.at(-1)] = "!invalid!";
  assert.equal(validateOwnerLeafWireRequest(contract, invalidScalar).valid, false, "custom formats retain the source scalar's exact pattern");
});
