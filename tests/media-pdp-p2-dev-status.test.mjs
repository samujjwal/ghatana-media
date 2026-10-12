import assert from "node:assert/strict";
import test from "node:test";
import { buildPdp2DevStatus, buildPdp2SourceCensus, p2Criteria, p2SourceRoots, p2SuiteFiles } from "../scripts/report-media-pdp-readiness.mjs";

const hash = "a".repeat(64);
const passingVerification = () => Object.fromEntries(p2Criteria.map(id => [id, {
  status: "PASS", command: `node --test ${p2SuiteFiles[id].join(" ")}`,
  testCount: 1, passedTestCount: 1, skippedTestCount: 0, outputSha256: hash,
  testSourceFingerprints: Object.fromEntries(p2SuiteFiles[id].map(file => [file, hash])),
}]));
const passingConformance = () => ({
  ok: true, mode: "DEFINITION_ONLY", acceptanceClaim: "NONE",
  screenInstanceScope: "DEFERRED_PDP3_INSTANCE_VALIDATION",
  deferredP3ScreenCompositionFindings: [{
    ownerPhase: "PDP-3",
    screenId: "media.view.inspect-media",
    detail: "consequence action media.action.inspect-source is absent from actions",
  }],
  deferredAdmissionGates: [
    { id: "shared-artifact-binding", disposition: "EXTERNAL_PENDING" },
    { id: "conformance-and-specialist-review", disposition: "INDEPENDENT_PENDING" },
  ],
  summary: { unexplained: 0, screenContracts: 47 },
});

test("PDP-2 pins the current interface parity ledger and action registry consumed by P2-07", () => {
  assert.ok(p2SourceRoots.includes(".product-experience/interface-parity"));
  assert.ok(p2SourceRoots.includes(".product-experience/pdp-3-product-experience/action-registry.yaml"));
});

test("PDP-2 development gate requires nine source-pinned suites and definition-only conformance", () => {
  const census = buildPdp2SourceCensus();
  assert.deepEqual(census.integrityIssues, []);
  const status = buildPdp2DevStatus({
    mainSha: "0".repeat(40), sourceShaSet: {}, verification: passingVerification(),
    sourceCensus: census, sourceCutStable: true, designConformance: passingConformance(),
  });
  assert.equal(status.phase, "PDP-2");
  assert.equal(status.status, "DEV_COMPLETE");
  assert.deepEqual(status.exportedHandoffIds, ["media.pdp2-pdp3.design-interface-handoff.v1"]);
  assert.deepEqual(status.importedHandoffIds, ["media.pdp1-pdp2.canonical-domain-handoff.v1"]);
  assert.equal(status.definitionOnlyConformance.acceptanceClaim, "NONE");
  assert.deepEqual(status.definitionOnlyConformance.deferredP3ScreenCompositionFindings, [{
    ownerPhase: "PDP-3",
    screenId: "media.view.inspect-media",
    detail: "consequence action media.action.inspect-source is absent from actions",
  }]);
  assert.equal(status.definitionOnlyConformance.scannedCanonicalScreenContracts, 47);
  assert.equal(status.directDevelopmentCriteria["P2-09"].testStatus, "PASS");
});

test("PDP-2 cannot complete on a changed source cut, skipped suite, stale source evidence, or invented review gate", () => {
  const census = buildPdp2SourceCensus();
  const verification = passingVerification();
  verification["P2-04"].skippedTestCount = 1;
  verification["P2-07"].testSourceFingerprints = { "tests/forged.test.mjs": hash };
  const conformance = passingConformance();
  conformance.deferredAdmissionGates[0] = { id: "shared-artifact-binding", disposition: "RESOLVED_OWNER" };
  const status = buildPdp2DevStatus({
    mainSha: "0".repeat(40), sourceShaSet: {}, verification,
    sourceCensus: census, sourceCutStable: false, designConformance: conformance,
  });
  assert.equal(status.status, "IN_PROGRESS");
  assert.ok(status.outstandingMeaningIds.some(id => id.startsWith("P2-04:")));
  assert.ok(status.outstandingMeaningIds.some(id => id.startsWith("P2-07:")));
  assert.ok(status.outstandingMeaningIds.includes("P2-09:source-cut-changed-during-verification"));
  assert.ok(status.outstandingMeaningIds.includes("P2-09:definition-only-design-conformance-not-green"));
});
