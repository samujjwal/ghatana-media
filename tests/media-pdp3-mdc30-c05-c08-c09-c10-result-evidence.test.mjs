import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const toolsRequire = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = toolsRequire("yaml");
const p1Path = ".product-experience/pdp-1-domain-data/operations.yaml";
const p3Root = ".product-experience/pdp-3-product-experience";
const purposePath = `${p3Root}/journey-purpose-bindings.yaml`;
const unknownOutcomeRef = ".product-experience/pdp-1-domain-data/action-contracts.yaml#outcomes/@id=UNKNOWN_OUTCOME";
const journeys = new Map([
  ["J-05", ["MDC30-C-05", "analyze-image-video-geometry-and-tracks"]],
  ["J-08", ["MDC30-C-08", "repair-video-with-measured-quality"]],
  ["J-09", ["MDC30-C-09", "create-review-and-deliver-from-a-brief"]],
  ["J-10", ["MDC30-C-10", "generate-from-references-and-review-continuity"]],
]);
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const joinsOperation = (purpose, operationRef) =>
  [...(purpose.operationRefs ?? []), ...(purpose.actionExactOperationRefs ?? [])].includes(operationRef)
  || (purpose.relatedActionBindings ?? []).some((binding) =>
    binding.operationRef === operationRef || binding.selectedTargetOperationRef === operationRef);

test("MDC30 J05/J08/J09/J10 bind every exact operation-purpose result to P1 sources", () => {
  const operations = readYaml(p1Path);
  const registry = readYaml(`${p3Root}/journey-channel-contract-bindings.yaml`);
  const purposes = new Map(readYaml(purposePath).records.map((record) => [record.id, record]));
  const actionOps = new Map(operations.ownerDefinedOperationContracts.records.map((record) => [record.id, record]));
  const capabilityOps = new Map(operations.capabilityOperationContracts.records.map((record) => [record.id, record]));
  const profiles = new Map(operations.ownerDefinedOperationProfiles.profiles.map((profile) => [profile.id, profile]));

  for (const [journeyId, [taskId, fileStem]] of journeys) {
    const journeyPath = `${p3Root}/journey-contracts/${fileStem}.yaml`;
    const journey = readYaml(journeyPath);
    const edges = registry.edges.filter((edge) => edge.taskId === taskId);
    const expected = new Map();
    for (const edge of edges) {
      for (const operationBinding of edge.p1OperationBindings ?? []) {
        for (const purposeRef of edge.purposeBindingRefs ?? []) {
          const purposeId = purposeRef.split("@id=")[1];
          const purpose = purposes.get(purposeId);
          if (purpose && joinsOperation(purpose, operationBinding.operationRef)) {
            expected.set(`${operationBinding.operationRef}\n${purposeId}`, [operationBinding.operationRef, purposeId]);
          }
        }
      }
    }

    const evidence = journey.pdp1ResultEvidence;
    assert.ok(evidence, `${journeyId} has source-bound result evidence`);
    const bindings = evidence.operationResultBindings;
    assert.ok(Array.isArray(bindings));
    const actual = bindings.map((binding) => [binding.operationRef, binding.journeyPurposeBindingRef.split("@id=")[1]]);
    assert.deepEqual(actual.sort((a, b) => `${a[0]}\n${a[1]}`.localeCompare(`${b[0]}\n${b[1]}`)),
      [...expected.values()].sort((a, b) => `${a[0]}\n${a[1]}`.localeCompare(`${b[0]}\n${b[1]}`)),
      `${journeyId} covers every exact registry operation-purpose pair once`);
    assert.ok(evidence.sourceRefs.includes(unknownOutcomeRef));
    assert.equal(evidence.channelAndRuntimeBoundary.transport, "UNBOUND");
    assert.equal(evidence.channelAndRuntimeBoundary.runtimeAdmission, "NOT_ADMITTED");

    for (const binding of bindings) {
      const operation = actionOps.get(binding.operationRef) ?? capabilityOps.get(binding.operationRef);
      const isAction = actionOps.has(binding.operationRef);
      const purposeId = binding.journeyPurposeBindingRef.split("@id=")[1];
      const purpose = purposes.get(purposeId);
      const sourceRef = `${p1Path}#${isAction ? "ownerDefinedOperationContracts" : "capabilityOperationContracts"}/records/@id=${binding.operationRef}`;
      const profile = isAction ? profiles.get(operation.profileRef) : undefined;
      const resultSchemaRef = isAction
        ? `${p1Path}#ownerDefinedOperationProfiles/profiles/@id=${profile.id}/resultEnvelope`
        : `${sourceRef}/resultSchema`;
      const requestSchemaRef = isAction
        ? `${p1Path}#ownerDefinedOperationProfiles/profiles/@id=${profile.id}/requestEnvelope`
        : `${sourceRef}/requestSchema`;
      const versionField = isAction ? "contractVersion" : "operationVersion";
      const authorityField = isAction ? "authorityRefs" : "canonicalAuthorityRefs";
      const finalityField = isAction ? "sourceFinality" : "finality";
      const recoveryField = isAction ? "sourceRecovery" : "recovery";
      const expectedErrorsRef = isAction
        ? `${p1Path}#ownerDefinedOperationProfiles/profiles/@id=${profile.id}/errors`
        : `${sourceRef}/errors`;
      const schema = isAction ? profile.resultEnvelope : operation.resultSchema;

      assert.ok(operation, `${journeyId} operation resolves`);
      assert.ok(purpose, `${journeyId} purpose resolves`);
      assert.equal(purpose.journeyRef, journeyId);
      assert.equal(purpose.stepRef, binding.journeyStepRef);
      assert.ok(joinsOperation(purpose, binding.operationRef));
      assert.equal(binding.operationSourceRef, sourceRef);
      assert.equal(binding.requestSchemaRef, requestSchemaRef);
      assert.equal(binding.resultSchemaRef, resultSchemaRef);
      assert.equal(binding.operationVersion, operation[versionField]);
      assert.equal(binding.operationVersionRef, `${sourceRef}/${versionField}`);
      assert.deepEqual(binding.authorityRefs, operation[authorityField]);
      assert.equal(binding.authoritySourceRef, `${sourceRef}/${authorityField}`);
      assert.equal(binding.finalityRef, `${sourceRef}/${finalityField}`);
      assert.equal(binding.errorsRef, expectedErrorsRef);
      assert.equal(binding.recoveryRef, `${sourceRef}/${recoveryField}`);
      assert.equal(binding.unknownDispositionRef, unknownOutcomeRef);
      assert.deepEqual(binding.stateRefs, operation.stateRefs ?? [], "P1-owned state references are retained exactly");
      assert.deepEqual(binding.transitionRefs, operation.transitionRefs ?? [], "P1-owned transition references are retained exactly");
      assert.ok(Array.isArray(schema.required) ? schema.required.length > 0 : schema.fields?.length > 0);
      assert.match(binding.exactResult, /Exact P1 result schema/u);
      assert.ok(binding.exactResult.includes(operation[finalityField]));
      assert.ok(binding.unknownDisposition.includes(operation[recoveryField]));
      for (const ref of [sourceRef, requestSchemaRef, resultSchemaRef, binding.operationVersionRef,
        binding.authoritySourceRef, binding.finalityRef, binding.errorsRef, binding.recoveryRef,
        binding.journeyPurposeBindingRef]) {
        assert.ok(evidence.sourceRefs.includes(ref), `${journeyId} sourceRefs include ${ref}`);
      }
    }
  }
});
