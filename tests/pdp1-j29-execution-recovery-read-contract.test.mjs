import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = process.cwd();
const { parse } = createRequire(resolve(root, '../ghatana-tools/package.json'))('yaml');
const operations = parse(await readFile('.product-experience/pdp-1-domain-data/operations.yaml', 'utf8'));
const decisionLog = await readFile('.product-experience/decision-log.md', 'utf8');
const operationId = 'media.operation.stream-session.inspect-execution-recovery.v1';
const operation = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === operationId);
const keySet = (value) => Object.keys(value).sort();
const degradedState = '.product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-stream-session/stateDefinitions/DEGRADED';

const identityContext = { tenantId: 'tenant-3', principalId: 'principal-5' };
const snapshotId = { readVersion: 'read:v12', observedAt: '2026-10-11T12:00:00Z' };

function scopedFact(kind, sessionId, fields = {}, context = identityContext, snapshot = snapshotId) {
  return { kind, tenantId: context.tenantId, principalId: context.principalId, sessionId,
    readVersion: snapshot.readVersion, observedAt: snapshot.observedAt, ...fields };
}

function validSourceFacts(sessionId = 'session-7', context = identityContext, snapshot = snapshotId) {
  return {
    tenantId: context.tenantId,
    principalId: context.principalId,
    sessionId,
    readVersion: snapshot.readVersion,
    observedAt: snapshot.observedAt,
    selectedPriorEffectRange: scopedFact('source-selected-reconciliation-range', sessionId, {
      firstSequence: 10, lastSequence: 11, selection: 'COMPLETE_PRIOR_SESSION_EFFECTS_REQUIRING_RECONCILIATION',
    }, context, snapshot),
    facts: [
      scopedFact('state', sessionId, {
        canonicalStateRef: degradedState, stateAuthorityRef: 'state-authority:v3', stateEvidenceRef: 'state-evidence:v3',
      }, context, snapshot),
      scopedFact('consent', sessionId, { consentRef: 'consent:ref:v8', consentRevision: 8, consentCurrentness: 'CURRENT' }, context, snapshot),
      scopedFact('purpose', sessionId, { purposeRef: 'purpose:streaming', purposeRevision: 4, purposeCurrentness: 'CURRENT' }, context, snapshot),
      scopedFact('lease', sessionId, { leaseVersion: 'lease:v6', leaseCurrentness: 'CURRENT', fencingToken: 9 }, context, snapshot),
      scopedFact('sequence', sessionId, { lastAcknowledgedSequence: 11, nextSequence: 12 }, context, snapshot),
      scopedFact('frame-outcome', sessionId, { sequence: 10, outcomeRef: 'frame-outcome:v10' }, context, snapshot),
      scopedFact('frame-outcome', sessionId, { sequence: 11, outcomeRef: 'frame-outcome:v11' }, context, snapshot),
      scopedFact('reconnect-budget', sessionId, { reconnectBudgetRemaining: 2 }, context, snapshot),
    ],
  };
}

// Small executable oracle for the owner-defined read semantics. Internal source facts
// carry the host scope and snapshot tuple; these values never appear in the wire result.
function classifyObservation(request, trustedContext, result, sourceFacts) {
  const unknown = () => ({ disposition: 'UNKNOWN' });
  if (!result || result.sessionId !== request.sessionId || !result.readVersion || !result.observedAt
    || !sourceFacts || sourceFacts.tenantId !== trustedContext.tenantId
    || sourceFacts.principalId !== trustedContext.principalId
    || sourceFacts.sessionId !== request.sessionId
    || sourceFacts.readVersion !== result.readVersion || sourceFacts.observedAt !== result.observedAt) return unknown();
  const observation = result.observation;
  if (!observation || observation.disposition !== 'OBSERVED') return unknown();
  const scopeMatches = (fact) => fact
    && fact.tenantId === trustedContext.tenantId
    && fact.principalId === trustedContext.principalId
    && fact.sessionId === request.sessionId
    && fact.readVersion === result.readVersion
    && fact.observedAt === result.observedAt;
  if (!Array.isArray(sourceFacts.facts) || !sourceFacts.facts.every(scopeMatches)
    || !scopeMatches(sourceFacts.selectedPriorEffectRange)
    || sourceFacts.selectedPriorEffectRange.selection !== 'COMPLETE_PRIOR_SESSION_EFFECTS_REQUIRING_RECONCILIATION') return unknown();
  const allowedFactKinds = new Set(['state', 'consent', 'purpose', 'lease', 'sequence', 'frame-outcome', 'reconnect-budget']);
  const factKindCounts = new Map();
  for (const fact of sourceFacts.facts) {
    if (!allowedFactKinds.has(fact.kind)) return unknown();
    factKindCounts.set(fact.kind, (factKindCounts.get(fact.kind) ?? 0) + 1);
  }
  if (['state', 'consent', 'purpose', 'lease', 'sequence', 'reconnect-budget']
    .some((kind) => factKindCounts.get(kind) !== 1)) return unknown();
  const facts = Object.fromEntries(sourceFacts.facts.map((fact) => [fact.kind, fact]));
  const frameFacts = sourceFacts.facts.filter(({ kind }) => kind === 'frame-outcome');
  const { firstSequence, lastSequence } = observation.resolvedFrameOutcomeRange ?? {};
  const refs = observation.resolvedFrameOutcomeRefs;
  const selectedRange = sourceFacts.selectedPriorEffectRange;
  const rangeCount = Number.isSafeInteger(firstSequence) && Number.isSafeInteger(lastSequence)
    && firstSequence <= lastSequence ? lastSequence - firstSequence + 1 : -1;
  const outputMatchesSelectedRange = firstSequence === selectedRange.firstSequence
    && lastSequence === selectedRange.lastSequence;
  const seenSequences = new Set();
  const seenOutcomeRefs = new Set();
  const completeRefs = Array.isArray(refs) && refs.length > 0 && refs.length === rangeCount
    && refs.length === frameFacts.length
    && refs.every((row) => {
      if (!row || row.sessionId !== request.sessionId
        || !Number.isSafeInteger(row.sequence) || row.sequence < firstSequence || row.sequence > lastSequence
        || typeof row.outcomeRef !== 'string' || row.outcomeRef.length === 0
        || seenSequences.has(row.sequence) || seenOutcomeRefs.has(row.outcomeRef)) return false;
      seenSequences.add(row.sequence);
      seenOutcomeRefs.add(row.outcomeRef);
      return true;
    })
    && seenSequences.size === rangeCount
    && frameFacts.every((fact) => refs.some((row) => row.sessionId === fact.sessionId
      && row.sequence === fact.sequence && row.outcomeRef === fact.outcomeRef));
  const valid = outputMatchesSelectedRange
    && observation.canonicalStateRef === facts.state?.canonicalStateRef
    && observation.stateAuthorityRef === facts.state?.stateAuthorityRef
    && observation.stateEvidenceRef === facts.state?.stateEvidenceRef
    && observation.canonicalStateRef === degradedState
    && observation.consentRef === facts.consent?.consentRef
    && observation.consentRevision === facts.consent?.consentRevision
    && observation.consentCurrentness === facts.consent?.consentCurrentness
    && observation.consentCurrentness === 'CURRENT'
    && observation.purposeRef === facts.purpose?.purposeRef
    && observation.purposeRevision === facts.purpose?.purposeRevision
    && observation.purposeCurrentness === facts.purpose?.purposeCurrentness
    && observation.purposeCurrentness === 'CURRENT'
    && observation.purposeRef?.length <= 256
    && observation.leaseVersion === facts.lease?.leaseVersion
    && observation.leaseCurrentness === facts.lease?.leaseCurrentness
    && observation.leaseCurrentness === 'CURRENT'
    && observation.fencingToken === facts.lease?.fencingToken
    && observation.lastAcknowledgedSequence === facts.sequence?.lastAcknowledgedSequence
    && observation.nextSequence === facts.sequence?.nextSequence
    && observation.nextSequence === observation.lastAcknowledgedSequence + 1
    && observation.resolvedFrameOutcomeCoverage === 'EXHAUSTIVE_SOURCE_VALIDATED'
    && completeRefs
    && observation.reconnectBudgetRemaining === facts['reconnect-budget']?.reconnectBudgetRemaining
    && Number.isSafeInteger(observation.reconnectBudgetRemaining) && observation.reconnectBudgetRemaining >= 0;
  return valid
    ? { disposition: 'OBSERVED', reconnectEligible: observation.reconnectBudgetRemaining > 0 }
    : unknown();
}

function validObservation(sessionId = 'session-7') {
  return {
    disposition: 'OBSERVED',
    canonicalStateRef: degradedState,
    stateAuthorityRef: 'state-authority:v3',
    stateEvidenceRef: 'state-evidence:v3',
    consentRef: 'consent:ref:v8',
    consentRevision: 8,
    consentCurrentness: 'CURRENT',
    purposeRef: 'purpose:streaming',
    purposeRevision: 4,
    purposeCurrentness: 'CURRENT',
    leaseVersion: 'lease:v6',
    leaseCurrentness: 'CURRENT',
    fencingToken: 9,
    lastAcknowledgedSequence: 11,
    nextSequence: 12,
    resolvedFrameOutcomeCoverage: 'EXHAUSTIVE_SOURCE_VALIDATED',
    resolvedFrameOutcomeRange: { firstSequence: 10, lastSequence: 11 },
    resolvedFrameOutcomeRefs: [
      { sessionId, sequence: 10, outcomeRef: 'frame-outcome:v10' },
      { sessionId, sequence: 11, outcomeRef: 'frame-outcome:v11' },
    ],
    reconnectBudgetRemaining: 2,
  };
}

function validResult(sessionId = 'session-7', observation = validObservation(sessionId), snapshot = snapshotId) {
  return { sessionId, readVersion: snapshot.readVersion, observedAt: snapshot.observedAt, observation };
}

test('J-29 has a closed exact-session contract with current recovery evidence', () => {
  assert.ok(operation, `missing ${operationId}`);
  assert.equal(operation.operationKind, 'QUERY');
  assert.deepEqual(operation.requestSchema.required, ['sessionId']);
  assert.equal(operation.requestSchema.additionalProperties, false);
  assert.deepEqual(keySet(operation.requestSchema.properties), ['sessionId']);
  assert.deepEqual(operation.trustedContext, { tenantId: 'host-attested', principalId: 'host-attested' });
  assert.deepEqual(operation.domainObjectRefs, ['media.domain.stream-session', 'media.domain.consent-record']);
  assert.ok(operation.sourceRefs.includes('.product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-stream-session'));
  assert.equal(operation.resultSchema.additionalProperties, false);
  assert.deepEqual(operation.resultSchema.required, ['sessionId', 'observation', 'observedAt', 'readVersion']);
  assert.deepEqual(keySet(operation.resultSchema.properties), ['observation', 'observedAt', 'readVersion', 'sessionId'],
    'wire result exposes no tenant, principal, or internal source identifiers');

  const [unknown, observed] = operation.resultSchema.properties.observation.oneOf;
  assert.equal(unknown.additionalProperties, false);
  assert.deepEqual(unknown.required, ['disposition']);
  assert.deepEqual(keySet(unknown.properties), ['disposition']);
  assert.equal(unknown.properties.disposition.const, 'UNKNOWN');
  assert.equal(observed.additionalProperties, false);
  assert.equal(observed.properties.disposition.const, 'OBSERVED');
  for (const field of [
    'canonicalStateRef', 'stateAuthorityRef', 'stateEvidenceRef',
    'consentRef', 'consentRevision', 'consentCurrentness',
    'purposeRef', 'purposeRevision', 'purposeCurrentness', 'leaseVersion', 'leaseCurrentness',
    'fencingToken', 'lastAcknowledgedSequence', 'nextSequence',
    'resolvedFrameOutcomeCoverage', 'resolvedFrameOutcomeRange', 'resolvedFrameOutcomeRefs',
    'reconnectBudgetRemaining',
  ]) assert.ok(observed.required.includes(field), `OBSERVED must require ${field}`);
  assert.deepEqual(keySet(observed.properties).sort(), observed.required.slice().sort(),
    'OBSERVED has no undeclared optional fields');
  assert.equal(observed.properties.consentCurrentness.const, 'CURRENT');
  assert.equal(observed.properties.purposeCurrentness.const, 'CURRENT');
  assert.equal(observed.properties.leaseCurrentness.const, 'CURRENT');
  assert.equal(observed.properties.purposeRef.format, 'opaque-reference');
  assert.equal(observed.properties.purposeRef.maxLength, 256);
  assert.equal(observed.properties.canonicalStateRef.const, degradedState);
  assert.equal(observed.properties.canonicalStateRef.enum, undefined, 'the old six-state schema would permit non-reconnectable states');
  assert.equal(observed.properties.resolvedFrameOutcomeCoverage.const, 'EXHAUSTIVE_SOURCE_VALIDATED');
  assert.equal(observed.properties.resolvedFrameOutcomeRefs.minItems, 1);
  assert.equal(observed.properties.resolvedFrameOutcomeRefs.uniqueItems, true);
  assert.equal(observed.properties.resolvedFrameOutcomeRefs.items.additionalProperties, false);
  assert.deepEqual(observed.properties.resolvedFrameOutcomeRefs.items.required, ['sessionId', 'sequence', 'outcomeRef']);

  assert.match(operation.readSemantics, /exact requested\s*MediaStreamSession/u);
  assert.match(operation.readSemantics, /host-attested tenant and current\s*principal/u);
  assert.match(operation.readSemantics, /does not bind or return ProcessingJob, JobAttempt, or MediaRun identities/u);
  assert.match(operation.readSemantics, /same coherent read snapshot/u);
  assert.match(operation.readSemantics, /Every returned state,\s*authority\/evidence reference, consent\/purpose revision/u);
  assert.match(operation.readSemantics, /exact host-attested tenant, current\s*principal, and requested session/u);
  assert.match(operation.readSemantics, /single readVersion and\s*observedAt/u);
  assert.match(operation.readSemantics, /Any identity, version, timestamp, or snapshot mismatch yields UNKNOWN/u);
  assert.match(operation.readSemantics, /CURRENT` means only that the referenced\s*consent or purpose revision is current/u);
  assert.match(operation.readSemantics, /does not mean consent is ACTIVE or grant\s*permission/u);
  assert.match(operation.readSemantics, /Reconnect authority remains a separate guard/u);
  assert.match(operation.readSemantics, /current canonical DEGRADED state/u);
  assert.match(operation.readSemantics, /nextSequence equal to\s*lastAcknowledgedSequence plus one/u);
  assert.match(operation.readSemantics, /source-selected interval of prior effects requiring\s*reconciliation/u);
  assert.match(operation.readSemantics, /cannot establish that an arbitrary\s*range is the correct interval/u);
  assert.match(observed.properties.resolvedFrameOutcomeRange.description, /complete source-selected interval/u);
  assert.match(operation.readSemantics, /positive budget is required for any reconnect eligibility/u);
  assert.match(operation.readSemantics, /never dispatches or replays work/u);
  assert.equal(operation.executionAdmission, 'NOT_ADMITTED');
  assert.match(operation.scopeStatus, /transport-and-runtime-NOT_ADMITTED/u);
  assert.match(decisionLog, /### PXD-160 — Define the exact J-29 execution\/recovery read boundary/u);
});

test('J-29 accepts only an exact-session exhaustive frame range with relationally current fields', () => {
  const request = { sessionId: 'session-7' };
  const resultWire = validResult();
  assert.deepEqual(Object.keys(resultWire).sort(), ['observation', 'observedAt', 'readVersion', 'sessionId'], 'tenant/principal stay in trusted context');
  const sourceFacts = validSourceFacts();
  const result = classifyObservation(request, identityContext, resultWire, sourceFacts);
  assert.deepEqual(result, { disposition: 'OBSERVED', reconnectEligible: true });

  const exhausted = validObservation();
  exhausted.reconnectBudgetRemaining = 0;
  sourceFacts.facts.find(({ kind }) => kind === 'reconnect-budget').reconnectBudgetRemaining = 0;
  assert.deepEqual(classifyObservation(request, identityContext, validResult('session-7', exhausted), sourceFacts), {
    disposition: 'OBSERVED', reconnectEligible: false,
  });

  for (const mutate of [
    (o) => { o.resolvedFrameOutcomeRefs = [o.resolvedFrameOutcomeRefs[0]]; }, // partial/missing sequence
    (o) => { o.resolvedFrameOutcomeRefs = []; }, // empty coverage
    (o) => { o.resolvedFrameOutcomeRefs[1].sequence = o.resolvedFrameOutcomeRefs[0].sequence; }, // duplicate sequence
    (o) => { o.resolvedFrameOutcomeRefs[1].outcomeRef = o.resolvedFrameOutcomeRefs[0].outcomeRef; }, // duplicate outcome ref
    (o) => { o.resolvedFrameOutcomeRefs[1].sessionId = 'other-session'; }, // mixed session
    (o) => { o.resolvedFrameOutcomeRefs[1].sequence = 12; }, // mixed/out-of-range sequence
    (o) => { o.resolvedFrameOutcomeRefs = undefined; }, // missing coverage
  ]) {
    const invalid = validObservation();
    mutate(invalid);
    assert.deepEqual(classifyObservation(request, identityContext, validResult('session-7', invalid), validSourceFacts()), { disposition: 'UNKNOWN' });
  }

  const arbitraryRange = validObservation();
  arbitraryRange.resolvedFrameOutcomeRange = { firstSequence: 10, lastSequence: 10 };
  arbitraryRange.resolvedFrameOutcomeRefs = [arbitraryRange.resolvedFrameOutcomeRefs[0]];
  assert.deepEqual(classifyObservation(request, identityContext, validResult('session-7', arbitraryRange), validSourceFacts()), { disposition: 'UNKNOWN' });

  const incompleteSelectedRange = validSourceFacts();
  incompleteSelectedRange.selectedPriorEffectRange.lastSequence = 12;
  assert.deepEqual(classifyObservation(request, identityContext, resultWire, incompleteSelectedRange), { disposition: 'UNKNOWN' });

  const duplicateStateFact = validSourceFacts();
  duplicateStateFact.facts.push({ ...duplicateStateFact.facts[0] });
  assert.deepEqual(classifyObservation(request, identityContext, resultWire, duplicateStateFact), { disposition: 'UNKNOWN' },
    'duplicate non-frame fact kinds must not select an arbitrary source record');
  const unknownFactKind = validSourceFacts();
  unknownFactKind.facts.push(scopedFact('unrecognized', 'session-7'));
  assert.deepEqual(classifyObservation(request, identityContext, resultWire, unknownFactKind), { disposition: 'UNKNOWN' });
});

test('J-29 returns UNKNOWN without observation fields for mismatched scope/snapshot or stale evidence', () => {
  for (const mutate of [
    (o) => { o.canonicalStateRef = '.product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-stream-session/stateDefinitions/CONNECTED'; },
    (o) => { o.purposeCurrentness = 'STALE'; },
    (o) => { o.purposeRevision = 0; },
    (o) => { o.consentCurrentness = 'STALE'; },
    (o) => { o.leaseCurrentness = 'STALE'; },
    (o) => { o.nextSequence = o.lastAcknowledgedSequence + 2; },
  ]) {
    const invalid = validObservation();
    mutate(invalid);
    assert.deepEqual(classifyObservation({ sessionId: 'session-7' }, identityContext,
      validResult('session-7', invalid), validSourceFacts()), { disposition: 'UNKNOWN' });
  }

  const request = { sessionId: 'session-7' };
  const cases = [
    ['tenant', (facts) => { facts.facts[0].tenantId = 'tenant-foreign'; }],
    ['principal', (facts) => { facts.facts[0].principalId = 'principal-foreign'; }],
    ['session', (facts) => { facts.sessionId = 'session-foreign'; }],
    ['readVersion', (facts) => { facts.facts[0].readVersion = 'read:other'; }],
    ['observedAt', (facts) => { facts.facts[0].observedAt = '2026-10-11T12:01:00Z'; }],
  ];
  for (const [label, mutateFacts] of cases) {
    const facts = validSourceFacts();
    mutateFacts(facts);
    const classified = classifyObservation(request, identityContext, validResult(), facts);
    assert.deepEqual(classified, { disposition: 'UNKNOWN' }, `${label} mismatch must expose no observation fields`);
  }
  const foreignTrustedContext = { tenantId: 'tenant-foreign', principalId: identityContext.principalId };
  assert.deepEqual(classifyObservation(request, foreignTrustedContext, validResult(), validSourceFacts()), { disposition: 'UNKNOWN' });
  const mismatchedResultSession = { ...validResult(), sessionId: 'session-foreign' };
  assert.deepEqual(classifyObservation(request, identityContext, mismatchedResultSession, validSourceFacts()), { disposition: 'UNKNOWN' });
  const mismatchedResultVersion = { ...validResult(), readVersion: 'read:other' };
  assert.deepEqual(classifyObservation(request, identityContext, mismatchedResultVersion, validSourceFacts()), { disposition: 'UNKNOWN' });
  const mismatchedResultTime = { ...validResult(), observedAt: '2026-10-11T12:01:00Z' };
  assert.deepEqual(classifyObservation(request, identityContext, mismatchedResultTime, validSourceFacts()), { disposition: 'UNKNOWN' });
});
