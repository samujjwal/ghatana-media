import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(new URL('..', import.meta.url).pathname);
const requireTools = createRequire(path.resolve(repositoryRoot, '../ghatana-tools/package.json'));
const { parse } = requireTools('yaml');
const readYaml = (sourcePath) => parse(readFileSync(path.join(repositoryRoot, sourcePath), 'utf8'));
const p1 = readYaml('.product-experience/pdp-1-domain-data/operations.yaml');
const registry = readYaml('.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml');
const journeyPath = '.product-experience/pdp-3-product-experience/journey-contracts/long-running-job-observation-and-recovery.yaml';
const journey = readYaml(journeyPath);
const edges = ['media.pdp3.channel-binding.j20.web.v1', 'media.pdp3.channel-binding.j20.cli.v1']
  .map((id) => registry.edges.find((edge) => edge.id === id));

test('J20 web and CLI operation proofs project exact cancellation and retry state applicability', () => {
  assert.ok(edges.every(Boolean));
  const expected = [
    { operationRef: 'media.operation-slice.cancel-job', ordinal: 4 },
    { operationRef: 'media.operation-slice.retry-job', ordinal: 5 },
  ];
  const expectedEdgeStateRefs = new Set();

  for (const { operationRef, ordinal } of expected) {
    const step = journey.steps[ordinal];
    const semantics = step.stepDefinitionSemantics;
    const applicability = semantics.transitionApplicability;
    assert.equal(applicability.operationRef, operationRef);
    assert.equal(applicability.transitionRef, null);
    assert.equal(applicability.runtimeAdmission, 'NOT_ADMITTED');
    for (const stateRef of applicability.stateRefs) expectedEdgeStateRefs.add(stateRef);

    for (const edge of edges) {
      const proof = edge.p1OperationStateProofs.find((row) => row.operationRef === operationRef);
      assert.ok(proof, `${edge.id} has the operation-level proof`);
      assert.deepEqual(proof.stateRefs, [], 'P1 operation-level stateRefs remain empty because no transition is defined');
      assert.deepEqual(proof.transitionRefs, [], 'no transition reference is invented');
      assert.deepEqual(proof.journeyStateApplicability, {
        sourceRef: `${journeyPath}#/steps/${ordinal}/stepDefinitionSemantics/transitionApplicability`,
        operationStateSemanticsRef: applicability.sourceRef,
        stateRefs: applicability.stateRefs,
        transitionRef: null,
        authorityRefs: semantics.canonicalBindingDisposition.authorityRefs,
        ...(operationRef === 'media.operation-slice.retry-job'
          ? { eligibilityAuthoritySourceRef: applicability.eligibilityAuthoritySourceRef }
          : {}),
      });
      for (const stateRef of applicability.stateRefs) {
        assert.ok(edge.p1StateRefs.some((row) => row.stateRef === stateRef), `${edge.id} includes exact P1 state ref ${stateRef}`);
        assert.ok(edge.pdp1StateOrObservationRefs.includes(stateRef), `${edge.id} includes exact P1 state inventory ref ${stateRef}`);
      }
    }
  }

  for (const edge of edges) {
    assert.ok([...expectedEdgeStateRefs].every((ref) => edge.pdp1StateOrObservationRefs.includes(ref)));
    assert.equal(edge.unknownOutcomeDisposition, 'PRESERVE_UNKNOWN_AS_NEITHER_SUCCESS_NOR_FAILURE; RECONCILE_SAME_IDENTITY; NO_BLIND_RETRY');
    assert.equal(edge.transportDisposition, 'UNBOUND');
    assert.equal(edge.transportRefOrUnbound, 'UNBOUND');
    assert.equal(edge.channelTransportEquivalence, 'UNBOUND');
    assert.equal(edge.runtimeAdmission, 'NOT_ADMITTED');
    assert.match(edge.logicalDefinitionBlockers.join(' '), /no exact cancellation or retry transition ID\/finality is defined or joined/u);
    assert.match(edge.logicalDefinitionBlockers.join(' '), /Retry remains conditional on current owner eligibility; UNKNOWN does not authorize replay/u);
  }

  const retrySemantics = journey.steps[5].stepDefinitionSemantics.transitionApplicability;
  assert.match(retrySemantics.eligibilityDisposition, /Conditional definition only/u);
  assert.match(retrySemantics.eligibilityDisposition, /UNKNOWN prior outcome denies retry/u);

  const cancelOperation = p1.individualOperationContracts.records.find(({ id }) => id === 'media.operation-slice.cancel-job');
  const retryOperation = p1.individualOperationContracts.records.find(({ id }) => id === 'media.operation-slice.retry-job');
  assert.ok(cancelOperation && retryOperation);
  assert.match(cancelOperation.ownerDefinition.stateSemantics.join(' '), /cancellation-request-is-not-CANCELLED/u);
  assert.match(cancelOperation.ownerDefinition.resultSchema.finality, /durable-request-record-or-terminal-job-observation/u);
  assert.match(cancelOperation.ownerDefinition.recovery, /never-map-detach-or-timeout-to-cancellation-confirmation/u);
  const cancelStep = journey.steps[4];
  const cancelDeadlineBranch = cancelStep.failure.branches.find(({ id }) => id === 'deadline-semantics-unavailable');
  assert.ok(cancelDeadlineBranch, 'cancellation deadline behavior remains explicitly unavailable');
  assert.equal(cancelDeadlineBranch.sourceRef,
    '.product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts/records/@id=media.operation-slice.cancel-job/ownerDefinition');
  assert.equal(cancelDeadlineBranch.disposition,
    'BLOCKED_NO_P1_CANCEL_DEADLINE_FIELD_GUARD_OR_RESULT_SEMANTIC; preserve-pending-or-UNKNOWN-and-do-not-infer-timeout-as-cancellation');
  assert.match(cancelDeadlineBranch.blocker, /no deadline request field, deadline guard, or deadline-specific error\/result/u);
  assert.match(cancelStep.stepDefinitionSemantics.action.finality, /pending-until-authoritative-stop/u);
  assert.doesNotMatch(cancelStep.stepDefinitionSemantics.action.finality, /timeout.*CANCELLED|CANCELLED.*timeout/u);
  assert.ok(retryOperation.ownerDefinition.guards.includes('prior-outcome-is-not-unknown'));
  assert.match(retryOperation.ownerDefinition.authority, /retry-budget-and-rights-are-authority-read/u);
  assert.match(retryOperation.ownerDefinition.resultSchema.finality, /durable-new-attempt-identity-and-fence/u);
  assert.match(retryOperation.ownerDefinition.recovery, /do-not-retry-until-it-classifies-a-safe-retryable-outcome/u);
  assert.equal(journey.pdp1ResultEvidence.operationResultBindings.find(({ operationRef }) => operationRef === cancelOperation.id).unknownDisposition,
    'UNKNOWN retains the same request identity and requires reconciliation; no terminal cancellation is inferred.');
  assert.equal(journey.pdp1ResultEvidence.operationResultBindings.find(({ operationRef }) => operationRef === retryOperation.id).unknownDisposition,
    'UNKNOWN requires reconciliation of the same request identity before any new request; UNKNOWN does not authorize replay.');
});
