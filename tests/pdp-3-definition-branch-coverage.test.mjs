import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluatePdp3StepDefinition } from "../scripts/lib/pdp3-step-definition-oracle.mjs";
import { createStepBranchDefinitionFixture } from "../libs/media-experience-simulation/src/fixtures.ts";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const experience = ".product-experience/pdp-3-product-experience";
const readYaml = async (path) => parse(await readFile(path, "utf8"));
const oraclePath = `${experience}/step-definition-oracles.yaml`;
const oracleDocument = await readYaml(oraclePath);
const registry = await readYaml(`${experience}/scenario-fixture-registry.yaml`);
const operations = await readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
const guardFactContracts = await readYaml(`${experience}/step-guard-fact-contracts.yaml`);
const domainStates = await readYaml(".product-experience/pdp-1-domain-data/states.yaml");
const operationRows = [
  ...(operations.operations ?? []),
  ...(operations.individualOperationContracts?.records ?? []),
  ...(operations.ownerDefinedOperationContracts?.records ?? []),
  ...(operations.capabilityOperationContracts?.records ?? []),
];
const operationByRef = new Map(operationRows.flatMap((row) => [
  [row.id, row], ...(row.operationRefs ?? []).map((ref) => [ref, row]),
]));
const contractByStepRef = new Map();
for (const filename of (await readdir(`${experience}/journey-contracts`)).filter((name) => name.endsWith(".yaml"))) {
  const contract = await readYaml(`${experience}/journey-contracts/${filename}`);
  contract.steps.forEach((step, index) => contractByStepRef.set(`${experience}/journey-contracts/${filename}#/steps/${index}`, step));
}
const actionDocument = await readYaml(`${experience}/action-registry.yaml`);
const actionsById = new Map([...(actionDocument.actions ?? []), ...(actionDocument.ownerDefinedActions ?? [])].map((row) => [row.id, row]));
const operationKinds = Object.fromEntries(operationRows.flatMap((row) => row.id && row.operationKind
  ? [[row.id, row.operationKind], ...(row.operationRefs ?? []).map((ref) => [ref, row.operationKind])]
  : []));
const ownerActionsById = new Map((actionDocument.ownerDefinedActions ?? []).map((row) => [row.id, row]));
const evaluatorOptions = { operationKinds, ownerActionsById };
const caseBranches = [
  ["positiveCases", "positive", "PASS"],
  ["wrongPurposeCases", "positive", "PASS"],
  ["deniedCases", "denied", "DENIED"],
  ["unknownCases", "unknown", "UNKNOWN"],
];

function projectCase(journeyIndex, stepIndex, journey, step, casesKey, branch, input, caseIndex) {
  const oracleRef = `${oraclePath}#journeys/${journeyIndex}/steps/${stepIndex}/branchOracles/${casesKey}/${caseIndex}`;
  const stepRef = step.sourceRef;
  assert.equal(contractByStepRef.has(stepRef), true, `${step.id} sourceRef resolves to its authored journey step`);
  const fixtureInput = {
    fixtureId: `media.definition-branch.${journey.journeyId.toLowerCase()}.${step.id.toLowerCase()}.${casesKey.replace("Cases", "")}-${caseIndex + 1}`,
    sourceRef: oracleRef,
    journeyRef: journey.journeyId,
    stepRef,
    branch,
    case: input.case,
    guardVerdict: input.guardVerdict,
    expectedDecision: input.expectedDecision,
    ...(input.selectedCapabilityRef ? { selectedCapabilityRef: input.selectedCapabilityRef } : {}),
    ...(input.selectedOperationRef ? { selectedOperationRef: input.selectedOperationRef } : {}),
  };
  // The existing factory intentionally narrows unknown cases to hold/replay semantics;
  // preserve the nine source-declared no-action cases as literal bounded projections.
  const fixture = branch === "unknown" && input.expectedDecision === "NON_EXECUTABLE_NO_ACTION_DISPATCH"
    ? {
      fixtureKind: "STEP_GUARD_BRANCH_INPUT",
      ...fixtureInput,
      synthetic: true,
      dispatch: "NEVER",
      ownerAcceptedOutcomeOracle: false,
      runtimeAdmission: "NOT_ADMITTED",
    }
    : createStepBranchDefinitionFixture(fixtureInput);
  assert.equal(fixture.fixtureKind, "STEP_GUARD_BRANCH_INPUT");
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.journeyRef, journey.journeyId);
  assert.equal(fixture.stepRef, stepRef);
  assert.equal(fixture.sourceRef, oracleRef);
  assert.equal(fixture.dispatch, "NEVER");
  assert.equal(fixture.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(fixture.ownerAcceptedOutcomeOracle, false);
  assert.equal("scenarioRef" in fixture, false);
  assert.equal("startingState" in fixture, false);
  assert.equal("authorityEvidence" in fixture, false);
  return fixture;
}

test("P3-C/P3-E source cases project and fail closed across all 30 journeys", () => {
  assert.equal(oracleDocument.journeyCount, 30);
  assert.equal(oracleDocument.stepCount, 130);
  assert.equal(oracleDocument.journeys.length, 30);
  assert.equal(registry.journeyCoverage.journeysWithoutExactSimulationSeeds.length, 26);
  const perJourney = new Map();
  let projected = 0;

  for (const [journeyIndex, journey] of oracleDocument.journeys.entries()) {
    let count = 0;
    for (const [stepIndex, step] of journey.steps.entries()) {
      const sourceStep = contractByStepRef.get(step.sourceRef);
      assert.ok(sourceStep, `${journey.journeyId}/${step.id} exact contract step exists`);
      assert.equal(step.runtimeAdmission, "NOT_ADMITTED");
      for (const [casesKey, branch, verdict] of caseBranches) {
        const cases = step.branchOracles?.[casesKey] ?? [];
        for (const [caseIndex, item] of cases.entries()) {
          assert.equal(item.guardVerdict, verdict, `${journey.journeyId}/${step.id}/${item.case} exact verdict`);
          const fixture = projectCase(journeyIndex, stepIndex, journey, step, casesKey, branch, item, caseIndex);
          const definition = sourceStep.stepDefinitionSemantics;
          assert.ok(definition, `${journey.journeyId}/${step.id} has a definition evaluator binding`);
          const guards = definition.action?.guards ?? [];
          const fixtureGuardOutcomes = Object.fromEntries(guards.map((guard) => [
            guard, verdict === "PASS" ? "TRUE" : verdict === "DENIED" ? "FALSE" : "UNKNOWN",
          ]));
          const result = evaluatePdp3StepDefinition(definition, {
            sourceRef: definition.sourceRef,
            actorRef: definition.action?.actorRefs?.[0] ?? "media.creator",
            targetRefs: definition.canonicalBindings?.objectRefs ?? [],
            fixtureGuardOutcomes,
            selectedActionRef: null,
          }, evaluatorOptions);
          assert.equal(result.dispatch, "NONE", `${fixture.sourceRef} never dispatches`);
          assert.equal(result.effectApplied, false, `${fixture.sourceRef} never claims an effect`);
          assert.equal(result.runtimeAdmission, "NOT_ADMITTED", `${fixture.sourceRef} remains unadmitted`);
          assert.equal(result.retryAuthorized, false, `${fixture.sourceRef} cannot authorize replay`);
          assert.ok(!Object.hasOwn(result, "ownerAcceptedOutcome"), `${fixture.sourceRef} does not emit accepted owner evidence`);
          if (branch === "denied") assert.equal(fixture.guardVerdict, "DENIED");
          if (branch === "unknown") assert.ok(["HOLD_WITHOUT_EFFECT_OR_REPLAY", "NON_EXECUTABLE_NO_ACTION_DISPATCH"].includes(fixture.expectedDecision));
          count += 1;
          projected += 1;
        }
      }
    }
    assert.ok(count > 0, `${journey.journeyId} has explicit source-derived branch coverage`);
    perJourney.set(journey.journeyId, count);
  }

  assert.equal(perJourney.size, 30);
  assert.equal(projected, 415);
  assert.deepEqual([...perJourney.values()].reduce((sum, count) => sum + count, 0), projected);
  assert.equal(Math.min(...perJourney.values()), 6);
});

test("P3-05 binds typed bounded definition fixtures to every journey step", () => {
  const coverage = registry.stepDefinitionOracleCoverage;
  assert.equal(coverage?.status,
    "ALL_30_JOURNEYS_AND_130_STEPS_HAVE_EXACT_BOUNDED_SYNTHETIC_DEFINITION_ORACLES; NOT_OWNER_ACCEPTED; NOT_RUNTIME_ADMITTED");
  assert.equal(coverage.journeyCount, 30);
  assert.equal(coverage.stepCount, 130);
  assert.equal(coverage.fixtureCount, 130);
  assert.equal(coverage.records.length, 130);
  assert.equal(coverage.invariants.dispatch, "NEVER");
  assert.equal(coverage.invariants.replay, "NEVER");
  assert.equal(coverage.invariants.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(coverage.invariants.ownerAcceptedOutcomeOracle, false);

  const records = new Map(coverage.records.map((record) => [`${record.journeyRef}:${record.stepRef}`, record]));
  const branchRows = new Map(oracleDocument.journeys.flatMap((journey, journeyIndex) => journey.steps.map((step, stepIndex) => [
    `${journey.journeyId}:${step.sourceRef}`,
    { journey, journeyIndex, step, stepIndex },
  ])));
  assert.equal(records.size, 130, "every canonical journey step has one unique fixture link");
  assert.deepEqual(new Set([...records.keys()]), new Set(branchRows.keys()));
  let typedGuardLinks = 0;
  let unknownOutcomeLinks = 0;
  let recoveryLinks = 0;
  let versionBindingLinks = 0;
  let staleVersionFixtureLinks = 0;
  let localEffectLinks = 0;
  for (const [key, record] of records) {
    const source = branchRows.get(key);
    assert.equal(record.stepOracleRef, `${oraclePath}#journeys/${source.journeyIndex}/steps/${source.stepIndex}`);
    assert.equal(record.fixtureId, `media.definition-step-oracle.${record.journeyRef.toLowerCase()}.${source.step.id.toLowerCase()}`);
    assert.deepEqual(record.branchCaseCounts, Object.fromEntries(
      ["positiveCases", "deniedCases", "unknownCases", "wrongPurposeCases"].map((name) => [name, source.step.branchOracles?.[name]?.length ?? 0]),
    ));
    assert.ok(record.branchCaseCounts.positiveCases + record.branchCaseCounts.deniedCases + record.branchCaseCounts.unknownCases > 0,
      `${key} references exact source cases rather than a verdict-only placeholder`);
    assert.equal(record.canonicalStateOrOwnerEvidence, "NOT_ASSERTED_BY_THIS_FIXTURE");
    assert.equal(record.dispatch, "NEVER");
    assert.equal(record.replay, "NEVER");
    assert.equal(record.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(record.ownerAcceptedOutcomeOracle, false);

    const exactGuardInstances = guardFactContracts.guardContracts.records.flatMap((guard, guardIndex) => guard.stepRefs.flatMap((stepRef, instanceIndex) =>
      stepRef === record.stepRef ? [{ guardRef: guard.guardRef, fixtureInstanceRef: `${experience}/step-guard-fact-contracts.yaml#guardContracts/records/${guardIndex}/stepRefs/${instanceIndex}` }] : []));
    assert.deepEqual(record.typedGuardFixtureRefs, exactGuardInstances,
      `${key} points to every exact typed guard instance; any remaining source guard is explicitly unresolved`);
    const linkedGuardRefs = new Set(exactGuardInstances.map(({ guardRef }) => guardRef));
    assert.deepEqual(record.unboundGuardRefs, [...new Set(source.step.guardRefs ?? source.step.canonicalBindings?.guardRefs ?? [])].filter((guardRef) => !linkedGuardRefs.has(guardRef)));
    if (record.unboundGuardRefs.length) {
      assert.equal(record.unboundPredicatesExpected, "UNKNOWN; no state or authority fact inferred");
      assert.equal(record.fixtureDisposition, "SYNTHETIC_FIXTURE_ONLY_UNBOUND_PREDICATE_NO_DISPATCH");
    }
    typedGuardLinks += record.typedGuardFixtureRefs.length;

    const operationRefs = [...new Set([...(source.step.canonicalBindings?.operationRefs ?? []), ...(source.step.canonicalBindings?.capabilityOptions ?? []).flatMap((option) => option.operationRefs ?? [])])];
    assert.deepEqual(record.operationRefs, operationRefs);
    for (const ref of record.operationSchemaRefs) {
      assert.match(ref, /^\.product-experience\/pdp-1-domain-data\/operations\.yaml#(?:media\.operation(?:-slice)?\.[^/]+\/(?:request|result)Schema|(?:operations\/@id=media\.operation(?:-slice)?\.[^/]+|(?:individualOperationContracts|ownerDefinedOperationContracts)\/records\/@id=media\.operation(?:-slice)?\.[^/]+)\/ownerWireSchema\/(?:request|result)Schema)$/u);
    }
    assert.ok(record.operationDefinitionFixtureRefs.every((ref) => registry.operationFamilyDefinitionFixtures.records.some((fixture) => fixture.definitionFixtureRef === ref && fixture.stepRef === record.stepRef)));
    unknownOutcomeLinks += record.unknownOutcomeFixtureRefs.length;
    recoveryLinks += record.recoveryFixtureRefs.length;
    versionBindingLinks += record.versionBindingRefs.length;
    staleVersionFixtureLinks += record.versionMismatchFixtureRefs.length;
    localEffectLinks += record.localEffectRefs.length;
  }
  assert.equal(typedGuardLinks, 254, "all 254 typed guard-step instances are linked into the bounded fixture corpus");
  assert.equal(unknownOutcomeLinks, 48);
  assert.equal(recoveryLinks, 106, "105 bounded no-query cases plus the exact query-bound exception");
  assert.equal(versionBindingLinks, 130, "all exact version-binding contracts stay linked; the separate stale-case test scopes the 64 applicable mismatch fixtures");
  assert.equal(staleVersionFixtureLinks, 64);
  assert.equal(localEffectLinks, 25);
});

test("guard unknown stays distinct from operation unknown outcome and recovery", () => {
  const linked = new Set();
  const sourceCaseKinds = new Map();
  const recoverySourceSteps = new Set();
  const staleCases = [];
  for (const journey of oracleDocument.journeys) {
    for (const step of journey.steps) {
      const operationRefs = [
        ...(step.canonicalBindings?.operationRefs ?? []),
        ...(step.canonicalBindings?.capabilityOptions ?? []).flatMap((option) => option.operationRefs ?? []),
      ];
      for (const ref of operationRefs) linked.add(ref);
      if (step.recovery || step.sessionRecoveryDefinition) recoverySourceSteps.add(`${journey.journeyId}/${step.id}`);
      for (const [casesKey, branch] of Object.entries(step.branchOracles ?? {})) {
        if (!Array.isArray(branch)) continue;
        for (const item of branch) {
          const kind = /unknown[- ]outcome/i.test(item.case) ? "operation-unknown-outcome"
            : /recover/i.test(item.case) ? "recovery"
              : /stale/i.test(item.case) ? "stale-guard" : null;
          if (kind) {
            const id = `${journey.journeyId}/${step.id}`;
            sourceCaseKinds.set(`${id}/${kind}`, item.case);
            if (kind === "stale-guard") staleCases.push(`${id}: ${item.case}`);
            assert.equal(casesKey.endsWith("Cases"), true);
          }
        }
      }
    }
  }
  const operationUnknownOutcomeRefs = [...linked].filter((ref) => JSON.stringify(operationByRef.get(ref) ?? {}).includes("UNKNOWN_OUTCOME"));
  assert.equal(operationUnknownOutcomeRefs.length, 47, "47 exact linked operation references resolve to definitions mentioning UNKNOWN_OUTCOME");
  assert.equal(recoverySourceSteps.size, 130, "every journey step has exact recovery source text");
  const boundedUnknown = registry.unseededJourneyFixtureAudit.branchApplicabilityAudit.boundedOperationUnknownOutcomeFixtures;
  const boundedRecovery = registry.unseededJourneyFixtureAudit.branchApplicabilityAudit.boundedRecoveryNoQueryFixtures;
  const boundedRecoveryQueries = registry.unseededJourneyFixtureAudit.branchApplicabilityAudit.boundedRecoveryObservationQueries;
  assert.equal(boundedUnknown.uniqueOperationCount, 44, "operation unknown-outcome corpus has 44 unique P1 operation identities");
  assert.equal(boundedUnknown.sourceBindingOccurrenceCount, 59, "operation unknown-outcome corpus preserves 59 source binding occurrences");
  assert.equal(boundedUnknown.records.length, 48, "unknown-outcome oracle records bind exact journey steps and operations");
  assert.equal(boundedRecovery.records.length, 105, "no-query corpus preserves every source recovery clause without the exact query-bound exception");
  assert.equal(boundedRecoveryQueries.recordCount, 1, "the exact same-session recovery query has its own explicit source row");
  assert.equal(boundedRecoveryQueries.records[0].operationRef, "media.operation.stream-session.inspect-execution-recovery.v1");
  assert.equal(boundedRecoveryQueries.records[0].operationKind, "QUERY");
  assert.equal(boundedRecovery.records.length + boundedRecoveryQueries.records.length, 106,
    "no-query plus exact-query corpora partition all source recovery-bearing steps");
  for (const record of boundedUnknown.records) {
    assert.ok(record.journeyRef && record.stepRef && record.operationRef && record.requestSchemaRef && record.resultSchemaRef);
    assert.equal(record.dispatch, "NEVER");
    assert.equal(record.replay, "NEVER");
    assert.equal(record.ownerAcceptedOutcomeOracle, false);
    assert.equal(record.expectedOutcome, "UNKNOWN_OUTCOME");
    assert.equal(record.runtimeAdmission, "NOT_ADMITTED");
  }
  for (const record of boundedRecovery.records) {
    assert.ok(record.journeyRef && record.stepRef && record.recoverySourceRef);
    assert.equal(record.oracleKind, "SAFE_NO_QUERY_UNKNOWN_WHILE_TYPED_RECOVERY_IS_UNIMPLEMENTED");
    assert.equal(record.dispatch, "NEVER");
    assert.equal(record.replay, "NEVER");
    assert.equal(record.ownerAcceptedOutcomeOracle, false);
    assert.equal(record.expectedObservation, "UNKNOWN");
    assert.equal(record.runtimeAdmission, "NOT_ADMITTED");
  }
  assert.ok(!boundedRecovery.records.some(record => record.journeyRef === "J-29"
    && record.stepRef.endsWith("/steps/1")), "J-29's exact observation QUERY is not mislabeled no-query");
  assert.equal([...sourceCaseKinds.keys()].filter((key) => key.endsWith("/operation-unknown-outcome")).length, 0,
    "operation UNKNOWN_OUTCOME stays distinct from guard UNKNOWN and is covered by exact P1 result-schema fixtures");
  assert.equal([...sourceCaseKinds.keys()].filter((key) => key.endsWith("/recovery")).length, 0,
    "source recovery text stays distinct from the bounded no-query UNKNOWN oracle corpus");
  assert.deepEqual(staleCases.sort(), [
    "J-05/J-05.step-01: analysis-evidence-unknown-or-stale",
    "J-05/J-05.step-02: analysis-evidence-unknown-or-stale",
    "J-08/J-08.step-02: missing-stale-budget-profile-source-or-prior-outcome",
    "J-29/J-29.step-04: any-exact-reconnect-guard-unknown-or-stale",
  ]);
  assert.equal(actionsById.size > 0, true);
});


test("P3-05 has exact-source synthetic start context for every unseeded journey and leaves unbound predicates UNKNOWN", () => {
  const auditRows = new Map(registry.unseededJourneyFixtureAudit.records.map((row) => [row.journeyRef, row]));
  const startCorpus = registry.unseededJourneyStartContextFixtures;
  const guardByRef = new Map(guardFactContracts.guardContracts.records.map((row) => [row.guardRef, row]));
  assert.equal(startCorpus.journeyCount, 26);
  assert.equal(startCorpus.records.length, 26);
  assert.equal(startCorpus.status, "BOUNDED_SYNTHETIC_CONTEXT_LINKS_ONLY; UNBOUND_PREDICATES_REMAIN_UNKNOWN; NOT_OWNER_EVIDENCE");
  assert.equal(domainStates.authorityStatus.startsWith("proposal-only"), true, "PDP-1 state inventory remains proposal-only, not accepted canonical authority");
  assert.deepEqual(new Set(startCorpus.records.map((row) => row.journeyRef)), new Set(auditRows.keys()));

  for (const record of startCorpus.records) {
    const audit = auditRows.get(record.journeyRef);
    const journeyIndex = oracleDocument.journeys.findIndex((row) => row.journeyId === record.journeyRef);
    const journey = oracleDocument.journeys[journeyIndex];
    const firstStep = journey.steps[0];
    assert.equal(record.sourceJourneyRef, audit.journeyContractRef);
    assert.equal(record.sourceStepRef, firstStep.sourceRef);
    assert.equal(record.sourceOracleStepRef, `${oraclePath}#journeys/${journeyIndex}/steps/0`);
    assert.equal(record.bindingId, firstStep.canonicalBindings.bindingId ?? null);
    assert.deepEqual(record.sourceDeclaredStateRefs, firstStep.canonicalBindings.stateRefs ?? []);
    assert.deepEqual(record.canonicalStateRefs, [], "proposal states are not elevated to accepted canonical state facts");
    assert.equal(record.synthetic, true);
    assert.equal(record.dispatch, "NEVER");
    assert.equal(record.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(record.ownerEvidence, false);
    assert.deepEqual(record.contextValues, [], "no unbound product or authority values are invented");
    assert.equal(record.branchFactCases.length, firstStep.inputCases?.length ?? 0);
    assert.deepEqual(record.sourceGuardRefs, firstStep.canonicalBindings.guardRefs ?? []);

    const expectedGuards = (firstStep.canonicalBindings.guardRefs ?? []).map((guardRef) => guardByRef.get(guardRef));
    assert.deepEqual(record.guardFactContracts.map((row) => row.guardRef), firstStep.canonicalBindings.guardRefs ?? []);
    assert.ok(record.guardFactContracts.every((row) => row.guardContractRef.endsWith("UNBOUND") || guardByRef.has(row.guardRef)), `${record.journeyRef} missing guard facts are explicit, not inferred`);
    for (const [index, branchCase] of record.branchFactCases.entries()) {
      const sourceCase = firstStep.inputCases[index];
      assert.equal(branchCase.case, sourceCase.case);
      assert.equal(branchCase.caseSourceRef, `${oraclePath}#journeys/${journeyIndex}/steps/0/inputCases/${index}`);
      assert.equal(branchCase.guardVerdict, sourceCase.guardVerdict);
      assert.deepEqual(branchCase.guardRefs, firstStep.canonicalBindings.guardRefs ?? []);
      assert.equal(branchCase.syntheticFact, null, "a verdict label is never treated as typed evidence");
      if (branchCase.guardRefs.length) {
        assert.equal(branchCase.factFixtureDisposition, "NO_SCHEMA_VALID_TYPED_GUARD_FACT; SOURCE CONTRACT DOES NOT BIND PREDICATE QUERY/RESULT");
        assert.ok(branchCase.factContractRefs.every((ref) => typeof ref === "string"));
        assert.ok(expectedGuards.some((guard) => !guard || !guard.requiredObservationContractRef || !guard.requiredObservationValidationRef),
          `${record.journeyRef}/${branchCase.case} remains blocked because exact typed predicate/query evidence is not bound`);
      }
    }
  }

  const j29 = startCorpus.records.find((row) => row.journeyRef === "J-29");
  assert.deepEqual(j29.unavailableRecoveryIdentityFields, [
    "consentRef", "purposeRef", "leaseVersion", "fencingToken", "lastAcknowledgedSequence", "nextSequence", "resolvedFrameOutcomeRefs", "reconnectBudget",
  ]);
  assert.equal(j29.recoveryFactDisposition, "UNIMPLEMENTED_SAME_SESSION_RESULT_IDENTITY_FIELDS_ABSENT");
});
