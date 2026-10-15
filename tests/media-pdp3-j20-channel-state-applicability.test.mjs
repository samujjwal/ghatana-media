import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(new URL('..', import.meta.url).pathname);
const requireTools = createRequire(path.resolve(repositoryRoot, '../ghatana-tools/package.json'));
const { parse } = requireTools('yaml');
const readYaml = (sourcePath) => parse(readFileSync(path.join(repositoryRoot, sourcePath), 'utf8'));
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
    assert.match(edge.logicalDefinitionBlockers.join(' '), /No exact cancellation or retry transition ID\/finality is defined or joined/u);
    assert.match(edge.logicalDefinitionBlockers.join(' '), /retry remains conditional on current owner eligibility, and UNKNOWN does not authorize replay/u);
  }

  const retrySemantics = journey.steps[5].stepDefinitionSemantics.transitionApplicability;
  assert.match(retrySemantics.eligibilityDisposition, /Conditional definition only/u);
  assert.match(retrySemantics.eligibilityDisposition, /UNKNOWN prior outcome denies retry/u);
});
