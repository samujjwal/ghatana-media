import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const review = require("yaml").parse(readFileSync(resolve(
  root,
  ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml",
), "utf8"));

const activeSections = ["ownerCapabilityLeafAdjudication", "ownerTrustReconstructionDispositions"];
const p0Prefix = ".product-experience/pdp-0-product-truth/";

function collectKeys(value, found = new Set()) {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, found);
    return found;
  }
  for (const [key, nested] of Object.entries(value)) {
    found.add(key);
    collectKeys(nested, found);
  }
  return found;
}

test("capability leaf review distinguishes active P0 authority from retained historical evidence", () => {
  const boundary = review.authorityBoundary;
  assert.deepEqual(boundary.activePdp0Authority.sections, activeSections);
  assert.match(boundary.activePdp0Authority.sourceRule, /no PDP-1 operation, wire schema, or domain-object identity is required/u);
  assert.equal(boundary.activePdp0Authority.provenanceObservations.section, "ownerTrustReconstructionDispositions");
  assert.equal(boundary.activePdp0Authority.independentAcceptance, "P0-010-independent-review-open");
  assert.equal(boundary.activePdp0Authority.executionAdmission, "NOT_ADMITTED");
  assert.equal(boundary.activePdp0Authority.qualification, "NOT_EVALUATED");

  const historical = boundary.historicalReviewEvidenceOnly;
  assert.equal(historical.gating, false);
  assert.match(historical.meaning, /do not establish current PDP-0 authority/u);
  for (const section of ["sourceInventory", "sourceReferences", "leaves", "ownerOperationBindingAdjudication", "sourcePinReconciliations", "ownerDefinitionSourceReconciliation"]) {
    assert.ok(historical.sections.includes(section), `${section} is historical review evidence`);
    assert.ok(Object.hasOwn(review, section), `${section} remains available to legacy consumers`);
  }
  assert.equal(boundary.downstreamConsumerCompatibility.section, "pdp0ToPdp1ConsumerHandoff");
  assert.equal(boundary.downstreamConsumerCompatibility.gatingForPdp0, false);

  const classified = new Set([
    ...boundary.activePdp0Authority.sections,
    ...historical.sections,
    boundary.downstreamConsumerCompatibility.section,
  ]);
  for (const section of Object.keys(review)) {
    if (!["schemaVersion", "artifactId", "productId", "status", "purpose", "authorityBoundary"].includes(section)) {
      assert.ok(classified.has(section), `${section} has an explicit authority classification`);
    }
  }

  const capabilityAuthority = review.ownerCapabilityLeafAdjudication;
  assert.equal(capabilityAuthority.records.length, 462);
  assert.ok(capabilityAuthority.records.every(({ independentAcceptance }) =>
    independentAcceptance === "P0-010-independent-review-open"),
  "each active P0 leaf keeps only the explicitly open P0-010 review");
  assert.ok(capabilityAuthority.records.every(({ independentAcceptance }) =>
    independentAcceptance !== "P0-010-and-independent-PDP1-review-open"),
  "PDP-1 review is not a prerequisite for active P0 leaf authority");
  assert.ok(capabilityAuthority.sourceRefs.every((ref) => ref.startsWith(p0Prefix)));
  assert.ok(capabilityAuthority.records.every(({ capabilitySourceRef }) => capabilitySourceRef.startsWith(p0Prefix)));

  const trustAuthority = review.ownerTrustReconstructionDispositions;
  assert.equal(trustAuthority.records.length, 462);
  assert.ok(trustAuthority.policyRef.startsWith(p0Prefix));
  const trustRefs = trustAuthority.records.flatMap(({ sourceRefs, outputBranches }) => [
    ...sourceRefs,
    ...outputBranches.map(({ sourceArtifactTypeRef }) => sourceArtifactTypeRef),
  ]);
  assert.ok(trustRefs.every((ref) => ref.startsWith(p0Prefix)));
  const activeKeys = new Set([
    ...collectKeys(capabilityAuthority),
    ...collectKeys(trustAuthority),
  ]);
  for (const key of ["operationRefs", "operationContractRef", "operationKind", "wireSchemaRefs", "domainObjectRefs", "payloadSchemaRef"]) {
    assert.ok(!activeKeys.has(key), `active P0 authority has no ${key}`);
  }
  const activeText = JSON.stringify({ capabilityAuthority, trustAuthority });
  assert.doesNotMatch(activeText, /\.product-experience\/pdp-[13]-/u);
});
