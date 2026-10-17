import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPdp3DevStatus,
  buildPdp3SourceCensus,
  isExplicitVerificationTestPath,
  p3Criteria,
  p3SuiteFiles,
} from "../scripts/report-media-pdp-readiness.mjs";

const hash = "a".repeat(64);
const passingVerification = () => Object.fromEntries(p3Criteria.map(id => [id, {
  status: "PASS",
  command: `node --test ${p3SuiteFiles[id].join(" ")}`,
  testCount: 1,
  passedTestCount: 1,
  skippedTestCount: 0,
  outputSha256: hash,
  testSourceFingerprints: Object.fromEntries(p3SuiteFiles[id].map(file => [file, hash])),
}]));
const passingProjection = () => ({
  status: "PASS",
  current: true,
  schemaValid: true,
  publicValidatorPassed: true,
  fieldMappingBlockers: [],
  outputSha256: hash,
});

test("phase verification pins explicit root or package test files without allowing discovery paths", () => {
  assert.equal(isExplicitVerificationTestPath("tests/example.test.mjs"), true);
  assert.equal(isExplicitVerificationTestPath("libs/media-experience-simulation/tests/example.test.mjs"), true);
  assert.equal(isExplicitVerificationTestPath("tests"), false);
  assert.equal(isExplicitVerificationTestPath("scripts/example.mjs"), false);
  assert.equal(isExplicitVerificationTestPath("tests/../scripts/example.test.mjs"), false);
  assert.equal(isExplicitVerificationTestPath("libs/media-experience-simulation/tests/../src/example.test.mjs"), false);
});

test("PDP-3 census consumes the frozen PDP-0/1/2 handoffs and exact 47/30/130 denominators", () => {
  const census = buildPdp3SourceCensus();
  assert.deepEqual(census.integrityIssues, []);
  assert.deepEqual(census.channelDefinitionCoverage, {
    totalEdges: 61,
    completeLogicalEdges: 43,
    incompleteLogicalEdges: 18,
    incompleteEdgeIds: census.channelDefinitionCoverage.incompleteEdgeIds,
  });
  assert.equal(new Set(census.channelDefinitionCoverage.incompleteEdgeIds).size, 18);
  assert.deepEqual(census.populations, {
    screens: 47,
    baselineScreens: 41,
    laneSpecificViews: 6,
    journeys: 30,
    orderedSteps: 130,
    purposeBindings: 130,
    uiActions: 148,
    scenarios: 31,
    syntheticScenarioDefinitions: 31,
    journeysWithSeededScenarios: 4,
    journeysExplicitlyWithoutSeededScenarios: 26,
    operationUnknownOutcomeOracleBindings: 48,
    operationUnknownOutcomeSourceBindingOccurrences: 59,
    boundedRecoveryNoQueryOracles: 105,
  });
  assert.deepEqual(census.developmentOracleCoverage.operationUnknownOutcome, {
    uniqueOperationCount: 44,
    sourceBindingOccurrenceCount: 59,
    boundStepOperationCount: 48,
    status: "PASS",
  });
  assert.deepEqual(census.developmentOracleCoverage.recoveryWithoutSameIdentityReadJoin, {
    sourceRecoveryStepCount: 106,
    oracleCount: 105,
    unimplementedTypedRecoverySteps: 105,
    exactSupportingQueryCount: 1,
    status: "BOUNDED_UNKNOWN_WITH_EXACT_QUERY_EXCEPTION",
  });
  assert.equal(census.screenIds.length, 47, "all baseline screens and lane views are returned");
  assert.equal(new Set(census.screenIds).size, 47, "canonical screen IDs are unique across both populations");
  assert.deepEqual(census.importedHandoffIds, [
    "media.pdp0-pdp1.capability-intent-handoff.v1",
    "media.pdp1-pdp2.canonical-domain-handoff.v1",
    "media.pdp2-pdp3.design-interface-handoff.v1",
  ]);
  assert.deepEqual(census.exportedHandoffIds, [], "PDP-3 is the terminal phase in this plan");
});

test("PDP-3 development status requires every source-pinned suite, stable source cut, and current strict projection", () => {
  const sourceCensus = buildPdp3SourceCensus();
  sourceCensus.channelDefinitionCoverage = {
    totalEdges: 61,
    completeLogicalEdges: 61,
    incompleteLogicalEdges: 0,
    incompleteEdgeIds: [],
  };
  const status = buildPdp3DevStatus({
    mainSha: "0".repeat(40),
    sourceShaSet: {},
    verification: passingVerification(),
    sourceCensus,
    sourceCutStable: true,
    projectionCheck: passingProjection(),
  });
  assert.equal(status.phase, "PDP-3");
  assert.equal(status.status, "DEV_COMPLETE");
  assert.deepEqual(status.importedHandoffIds, [
    "media.pdp0-pdp1.capability-intent-handoff.v1",
    "media.pdp1-pdp2.canonical-domain-handoff.v1",
    "media.pdp2-pdp3.design-interface-handoff.v1",
  ]);
  assert.deepEqual(status.exportedHandoffIds, []);
  assert.equal(status.strictCurrentProjection.status, "PASS");
  assert.equal(status.channelDefinitionCoverage.incompleteLogicalEdges, 0);
  assert.equal(status.deferredAcceptance.some(item => item.includes("Lifecycle")), true);
});

test("PDP-3 cannot report DEV_COMPLETE while canonical channel-edge meaning gaps remain", () => {
  const sourceCensus = buildPdp3SourceCensus();
  const status = buildPdp3DevStatus({
    mainSha: "0".repeat(40),
    verification: passingVerification(),
    sourceCensus,
    sourceCutStable: true,
    projectionCheck: passingProjection(),
  });
  assert.equal(status.status, "IN_PROGRESS");
  assert.equal(status.channelDefinitionCoverage.completeLogicalEdges, 43);
  assert.equal(status.channelDefinitionCoverage.incompleteLogicalEdges, 18);
  for (const edgeId of sourceCensus.channelDefinitionCoverage.incompleteEdgeIds) {
    assert.ok(status.outstandingMeaningIds.includes(`P3-03:channel-logical-edge-incomplete:${edgeId}`));
  }
});

test("PDP-3 cannot complete with a skipped test, stale source cut, or non-current projection", () => {
  const verification = passingVerification();
  verification["P3-04"].skippedTestCount = 1;
  const status = buildPdp3DevStatus({
    mainSha: "0".repeat(40),
    verification,
    sourceCensus: buildPdp3SourceCensus(),
    sourceCutStable: false,
    projectionCheck: {...passingProjection(), current: false},
  });
  assert.equal(status.status, "IN_PROGRESS");
  assert.ok(status.outstandingMeaningIds.includes("P3-04:focused-development-tests-not-green-or-source-pinned"));
  assert.ok(status.outstandingMeaningIds.includes("P3-10:source-cut-changed-during-verification"));
  assert.ok(status.outstandingMeaningIds.includes("P3-01:strict-current-public-projection-not-green"));
});

test("PDP-3 cannot complete while semantic projection field blockers remain or are unaudited", () => {
  const base = {
    mainSha: "0".repeat(40),
    verification: passingVerification(),
    sourceCensus: buildPdp3SourceCensus(),
    sourceCutStable: true,
  };
  const blocked = buildPdp3DevStatus({
    ...base,
    projectionCheck: {...passingProjection(), fieldMappingBlockers: [{field: "journeys"}]},
  });
  assert.equal(blocked.status, "IN_PROGRESS");
  assert.ok(blocked.outstandingMeaningIds.includes("P3-01:unresolved-semantic-field:journeys"));
  assert.equal(blocked.strictCurrentProjection.semanticFieldBlockerCount, 1);

  const unaudited = buildPdp3DevStatus({
    ...base,
    projectionCheck: {...passingProjection(), fieldMappingBlockers: undefined},
  });
  assert.equal(unaudited.status, "IN_PROGRESS");
  assert.ok(unaudited.outstandingMeaningIds.includes("P3-01:semantic-field-mapping-blocker-audit-missing"));

  const missingRecoveryOracles = buildPdp3DevStatus({
    ...base,
    sourceCensus: {
      ...base.sourceCensus,
      developmentOracleCoverage: {
        ...base.sourceCensus.developmentOracleCoverage,
        recoveryWithoutSameIdentityReadJoin: {
          ...base.sourceCensus.developmentOracleCoverage.recoveryWithoutSameIdentityReadJoin,
          oracleCount: 104,
        },
      },
    },
    projectionCheck: passingProjection(),
  });
  assert.equal(missingRecoveryOracles.status, "IN_PROGRESS");
  assert.ok(missingRecoveryOracles.outstandingMeaningIds.includes("P3-05:bounded-recovery-no-query-oracles-incomplete"));
});
