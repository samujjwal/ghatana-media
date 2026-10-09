import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readText = (path) => readFileSync(resolve(root, path), "utf8");
const readYaml = (path) => parse(readText(path));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const artifactPath = "docs/implementation/verification/pdp-38/migration-temporal-owner-review.json";
const artifact = JSON.parse(readText(artifactPath));
const approval = JSON.parse(readText("docs/implementation/verification/pdp-38/migration-coordinator-review-112.json"));
const approvedById = new Map(approval.records.map((record) => [record.claimId, record]));
const ledger = readYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
const claims = ledger.pdp38ClaimReconciliation.records.flatMap((record) => record.claims ?? [])
  .flatMap((claim) => claim.subclaims ?? [claim]);
const claimById = new Map(claims.map((claim) => [claim.claimId, claim]));

function resolveRef(ref) {
  const [source, pointer = ""] = ref.split("#", 2);
  let value = readYaml(source);
  for (const raw of pointer.split("/").filter(Boolean)) {
    const part = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (part.startsWith("@id=")) value = Array.isArray(value) ? value.find((entry) => entry.id === part.slice(4)) : undefined;
    else if (/^\d+$/u.test(part)) value = value[Number(part)];
    else value = value?.[part];
    assert.notEqual(value, undefined, `exact temporal owner ref resolves: ${ref}`);
  }
  return value;
}

function validateMaterial(record, target) {
  const text = JSON.stringify(target);
  const has = (expression) => assert.match(text, expression, `${record.claimId} retains ${expression}`);
  switch (record.claimId) {
    case "MPSEM-0030-C004":
      has(/exact owner/iu); has(/does not establish a general bypass/iu); has(/idempotency/iu); has(/reconciliation/iu); has(/DENY_OR_UNRESOLVED/iu);
      break;
    case "MPSEM-0256-C002":
    case "MPSEM-0256-C003":
    case "MPSEM-0256-C007":
    case "MPSEM-0257-C001":
    case "MPSEM-0257-C002":
    case "MPSEM-0257-C003": {
      assert.equal(target.id, "media.value.source-frame-sample-mapping");
      const rules = target.rules.join(" ");
      assert.match(rules, /VFR presentation index resolves through the retained explicit frame map/u);
      assert.match(rules, /encoder priming\/padding/u);
      assert.match(rules, /Frame-rate\/sample-rate conversion/u);
      assert.match(rules, /new immutable artifact/u);
      if (record.claimId === "MPSEM-0257-C001") assert.match(rules, /Drop-frame timecode is UNSUPPORTED unless a versioned adapter/u);
      if (record.claimId === "MPSEM-0257-C002") assert.match(rules, /24000\/1001 source cannot silently become 24 fps/u);
      if (record.claimId === "MPSEM-0256-C007") assert.match(rules, /Last-frame PTS and total duration must follow the explicit container\/model contract/u);
      break;
    }
    case "MPSEM-0258-C001":
    case "MPSEM-0258-C002":
    case "MPSEM-0258-C003":
    case "MPSEM-0258-C004": {
      assert.equal(target.id, "media.value.image-video-technical-descriptor");
      const schema = target.schema;
      for (const key of ["width", "height", "pixelAspectRatio", "orientation", "cleanAperture", "frameTimeMapRef", "bitDepth", "chromaSubsampling", "range", "primaries", "transferFunction", "matrixCoefficients", "alphaMode", "hdrMetadataRef", "colorConfigurationVersionRef", "lutVersionRef"]) assert.ok(schema.properties.metadata.required.includes(key), `missing image/video descriptor ${key}`);
      assert.ok(schema.required.includes("colorConfigurationFingerprint"));
      assert.ok(schema.required.includes("alphaConversion"));
      assert.ok(schema.required.includes("preserveAlphaRequired"));
      const rules = target.rules.join(" ");
      assert.match(rules, /Display-referred and scene-referred processing remain distinct/u);
      assert.match(rules, /Required alpha preservation forbids flattening or discarding alpha/u);
      break;
    }
    case "MPSEM-0259-C001":
    case "MPSEM-0259-C004": {
      assert.equal(target.id, "media.value.audio-technical-descriptor");
      const required = target.schema.properties.metadata.required;
      for (const key of ["codec", "container", "sampleFormat", "sampleRate", "channelCount", "channelLayout", "durationTimeRef", "sampleCount", "loudnessMeasurementRef", "truePeakMeasurementRef", "encoderDelaySamples", "encoderPaddingSamples"]) assert.ok(required.includes(key), `missing audio descriptor ${key}`);
      assert.match(target.rules.join(" "), /A 16 kHz mono STT input profile does not define universal output mastering/u);
      break;
    }
    case "MPSEM-0260-C004":
    case "MPSEM-0291-C001": {
      const geometry = record.claimId === "MPSEM-0260-C004" ? target : resolveRef(".product-experience/pdp-1-domain-data/value-objects.yaml#/ownerDescriptorDefinitions/records/@id=media.value.resolved-visual-geometry-plan");
      for (const field of ["requestedDisplayAspect", "modelDimensions", "finalDimensions", "aspectPreservationDisposition", "aspectChangeAuthorityRef"]) assert.ok(geometry.schema.required.includes(field), `missing geometry field ${field}`);
      const rules = geometry.rules.join(" ");
      assert.match(rules, /fallback permission preserves requested display aspect/u);
      assert.match(rules, /UNKNOWN is not preservation/u);
      if (record.claimId === "MPSEM-0291-C001") {
        assert.equal(target.default, true);
        assert.equal(target.mutableByFallback, false);
        assert.match(target.rule, /new explicit user intent or delivery specification/u);
      }
      break;
    }
    case "MPSEM-0262-C001":
    case "MPSEM-0262-C002":
    case "MPSEM-0272-C002":
      assert.equal(target.id, "media.value.simulation-fidelity-definition");
      for (const field of ["equationsOrConstraintsVersionRef", "initialConditionsVersionRef", "boundaryConditionsVersionRef", "solverVersionRef", "stepPolicy", "stepAndToleranceContractRef", "integrationPolicyVersionRef", "collisionRepresentationVersionRef", "massInertiaContractRef", "materialParametersVersionRef", "domainOwnerFidelityTierRef", "ownerReviewedTierMappingRef", "validityDomainVersionRef"]) assert.ok(target.schema.required.includes(field), `missing simulation fidelity field ${field}`);
      assert.match(target.rules.join(" "), /a photorealistic render cannot become scientifically validated/u);
      assert.match(target.rules.join(" "), /Visual LOD changes cannot lower the model fidelity/u);
      break;
    case "MPSEM-0270-C001":
      assert.equal(target.id, "media.value.replay-provenance-definition");
      for (const field of ["sourceVersionRefs", "outputVersionRefs", "executionProvenanceVersionRef", "replayClass", "methodAndScopeVersionRef", "qualifiedEvidenceRef"]) assert.ok(target.schema.required.includes(field));
      break;
    case "MPSEM-0314-C001":
      assert.equal(target.id, "media.interop.legacy-audio-video-package-preservation");
      assert.deepEqual(target.packageRecords.map((record) => record.package), ["@audio-video/client", "@audio-video/types"]);
      assert.match(target.preservationRule, /separately approved compatibility map/u);
      assert.match(target.preservationRule, /not prove a published immutable artifact/u);
      assert.match(target.preservationRule, /not silently reinterpreted as rational clock\/time-map values/u);
      break;
    default:
      break;
  }
}

test("all temporal claims preserve their historical source/target observations and remain pending review", () => {
  assert.equal(artifact.schemaVersion, "media.pdp38-migration-temporal-owner-review.v1");
  assert.equal(artifact.recordCount, 24);
  assert.equal(artifact.records.length, 24);
  assert.equal(new Set(artifact.records.map(({ claimId }) => claimId)).size, 24);
  for (const record of artifact.records) {
    const original = claimById.get(record.claimId);
    const approved = approvedById.get(record.claimId);
    assert.ok(original, `${record.claimId} remains a live migration unit`);
    assert.ok(approved, `${record.claimId} has a separate PXD-090 approval entry`);
    assert.equal(original.exactSourceText, record.exactSourceText);
    assert.equal(original.sourceTextSha256, record.sourceTextSha256);
    assert.equal(approved.previousTargetRef, record.previousTargetRef, `${record.claimId} old locator remains in the approval audit`);
    assert.equal(approved.previousTargetValueSha256, record.previousTargetValueSha256, `${record.claimId} old value digest remains in the approval audit`);
    assert.equal(record.acceptanceEffect, "none");
    assert.equal(record.coordinatorReviewStatus, "PENDING");
    if (record.proposedDisposition === "NON_NORMATIVE_SOURCE_METADATA") {
      assert.equal(original.disposition, "NON_NORMATIVE_SOURCE_METADATA");
      assert.equal(original.sourceEvidenceRef, approved.currentTargetRef);
      const line = readText("docs/migration/expert-reviewed-master-plan.md").split("\n")[144];
      assert.match(line, /^\| Existing Java namespaces \| Preserve `com\.ghatana\.media\.\*`/u);
      assert.deepEqual(record.metadataFields, ["table-row-heading"]);
      continue;
    }
    const target = resolveRef(record.proposedTargetRef);
    assert.equal(sha(JSON.stringify(target)), record.proposedTargetValueSha256, `${record.claimId} exact current target hash`);
    assert.deepEqual(target, record.proposedExpectedOwnerValue);
    validateMaterial(record, target);
    assert.equal(original.semanticReviewRef, `docs/implementation/verification/pdp-38/migration-coordinator-review-112.json#/records/@claimId=${record.claimId}`);
    assert.equal(original.semanticReviewStatus, "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED");
    assert.equal(original.targetRef, approved.currentTargetRef);
    assert.equal(original.targetTextSha256, approved.currentTargetValueSha256);
  }
  assert.equal(artifact.nonClaims.includes("No legacy-wire equivalence"), true);
  assert.equal(artifact.nonClaims.includes("No runtime or scientific qualification"), true);
  assert.equal(artifact.nonClaims.includes("No independent expert acceptance"), true);
});

test("temporal owner clauses reject loss of source mapping, full descriptors, solver bounds and package compatibility", () => {
  const record = (id) => artifact.records.find((entry) => entry.claimId === id);
  const mutate = (id, edit) => {
    const row = record(id);
    const target = structuredClone(resolveRef(row.proposedTargetRef));
    edit(target);
    assert.throws(() => validateMaterial(row, target));
  };
  mutate("MPSEM-0257-C001", (target) => { target.rules = target.rules.filter((rule) => !/Drop-frame timecode/u.test(rule)); });
  mutate("MPSEM-0257-C002", (target) => { target.rules = target.rules.filter((rule) => !/24000\/1001/u.test(rule)); });
  mutate("MPSEM-0258-C001", (target) => { target.schema.properties.metadata.required = target.schema.properties.metadata.required.filter((field) => field !== "frameTimeMapRef"); });
  mutate("MPSEM-0258-C002", (target) => { target.schema.required = target.schema.required.filter((field) => field !== "colorConfigurationFingerprint"); });
  mutate("MPSEM-0259-C001", (target) => { target.schema.properties.metadata.required = target.schema.properties.metadata.required.filter((field) => field !== "encoderPaddingSamples"); });
  mutate("MPSEM-0262-C001", (target) => { target.schema.required = target.schema.required.filter((field) => field !== "stepAndToleranceContractRef"); });
  mutate("MPSEM-0272-C002", (target) => { target.rules = target.rules.filter((rule) => !/Visual LOD changes cannot lower/u.test(rule)); });
  mutate("MPSEM-0314-C001", (target) => { target.packageRecords.pop(); });
});
