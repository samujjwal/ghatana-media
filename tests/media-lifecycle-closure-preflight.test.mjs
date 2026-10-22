import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMediaClosureInputState } from '../scripts/lib/media-closure-preflight.mjs';

const sourcePdpPhases = ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'];
const sourcePhaseToClosurePhaseId = {
  'PDP-0': 'media.product-truth.definition-acceptance',
  'PDP-1': 'media.canonical-domain-data.definition-acceptance',
  'PDP-2': 'media.design-interface-system.definition-acceptance',
  'PDP-3': 'media.complete-product-experience.definition-acceptance',
};
const phases = sourcePdpPhases.map((phase) => sourcePhaseToClosurePhaseId[phase]);
function fixture() {
  const obligations = sourcePdpPhases.map((sourcePhase, i) => ({
    id: `media.pdp-${i}.specific-requirement`,
    disposition: 'REQUIRED',
    phaseSemantics: {
      applicableIn: [sourcePhaseToClosurePhaseId[sourcePhase]],
      blockingIn: [sourcePhaseToClosurePhaseId[sourcePhase]],
      affects: [sourcePhaseToClosurePhaseId[sourcePhase]],
    },
    requirementIds: [`MEDIA-REQ-PDP-${i}`],
    caseIds: [], observerIds: [], oracleIds: [],
  }));
  const program = {
    programId: 'media.program.v1',
    metadata: { mediaSourcePhaseMapping: { sourcePhaseToClosurePhaseId } },
    phases: phases.map((id, i) => ({
      id,
      metadata: { sourcePdpPhaseId: sourcePdpPhases[i] },
      dependsOn: phases.slice(0, i),
      obligationIds: [obligations[i].id],
    })),
  };
  const surface = {
    id: 'media.product-definition',
    phaseProgramRef: program.programId,
    phaseBindingRef: 'media.phase-binding',
    obligationIds: obligations.map((o) => o.id),
  };
  const binding = {
    bindingId: 'media.phase-binding',
    closureSurfaceId: surface.id,
    programId: program.programId,
    phases: Object.fromEntries(program.phases.map((p) => [p.id, {
      applicability: 'APPLICABLE', obligationIds: [...p.obligationIds],
    }])),
  };
  const consumer = {
    schemaVersion: 'ghatana.closure.consumer',
    contractSet: { id: 'ghatana.closure', version: '1' },
    sources: Object.fromEntries(
      ['surfaces', 'phasePrograms', 'phaseBindings', 'obligations'].map((key) => [key, ['fixture']]),
    ),
    providerBindings: [],
  };
  const pending = {
    status: 'PENDING', closureStatus: 'BLOCKED',
    blockers: [{ id: 'need-producer' }],
    receipts: [], currentness: 'UNKNOWN',
  };
  return { consumer, program, surface, binding, obligations, pending };
}

function providerBindingInput(input) {
  input.consumer.providerRegistry = {
    schemaVersion: 'closure-source-ref', kind: 'file', ref: 'scripts/closure/provider-registry.json',
  };
  input.consumer.providerBindings.push({
    schemaVersion: 'closure-provider-binding',
    bindingId: 'media-proof-producer',
    capability: 'proof-producer',
    providerRef: {
      schemaVersion: 'closure-provider-ref', id: 'ghatana-lifecycle.proof-producer',
      version: '1', capability: 'proof-producer',
    },
    selection: { mode: 'SINGLE' },
  });
}

test('admits truthful PENDING source inputs without claiming completion', () => {
  const result = validateMediaClosureInputState(fixture());
  assert.equal(result.inputStatus, 'PENDING');
  assert.equal(result.phaseCount, 4);
});

test('allows additional requirement-specific obligations without one-per-phase ceiling', () => {
  const input = fixture();
  const extra = { ...structuredClone(input.obligations[0]), id: 'media.pdp-0.extra' };
  input.obligations.push(extra);
  input.program.phases[0].obligationIds.push(extra.id);
  input.binding.phases[phases[0]].obligationIds.push(extra.id);
  input.surface.obligationIds.push(extra.id);
  assert.equal(validateMediaClosureInputState(input).obligationCount, 5);
});

test('requires every obligation to cite a source requirement and unique case memberships', () => {
  const missing = fixture();
  delete missing.obligations[0].requirementIds;
  assert.throws(() => validateMediaClosureInputState(missing), /source requirement/);
  const duplicate = fixture();
  duplicate.obligations[0].caseIds = ['media.scenario.same', 'media.scenario.same'];
  assert.throws(() => validateMediaClosureInputState(duplicate), /duplicates caseIds/);
});

test('rejects INPUT_READY without producer and case/observer/oracle coverage', () => {
  const input = fixture();
  Object.assign(input.pending, { status: 'INPUT_READY', closureStatus: 'NOT_EVALUATED', blockers: [] });
  assert.throws(() => validateMediaClosureInputState(input), /provider bindings/);
  providerBindingInput(input);
  assert.throws(() => validateMediaClosureInputState(input), /needs caseIds/);
});

test('allows only input readiness, never Media-authored closure', () => {
  const input = fixture();
  Object.assign(input.pending, { status: 'INPUT_READY', closureStatus: 'NOT_EVALUATED', blockers: [] });
  providerBindingInput(input);
  for (const obligation of input.obligations) {
    obligation.caseIds = [`${obligation.id}.case`];
    obligation.observerIds = [`${obligation.id}.observer`];
    obligation.oracleIds = [`${obligation.id}.oracle`];
  }
  assert.equal(validateMediaClosureInputState(input).inputStatus, 'INPUT_READY');
  input.pending.closureStatus = 'CLOSED';
  assert.throws(() => validateMediaClosureInputState(input), /NOT_EVALUATED/);
  input.pending.closureStatus = 'NOT_EVALUATED';
  input.pending.currentness = 'CURRENT';
  assert.throws(() => validateMediaClosureInputState(input), /currentness/);
});

test('requires unique versioned public provider bindings and a provider registry for readiness', () => {
  const input = fixture();
  Object.assign(input.pending, { status: 'INPUT_READY', closureStatus: 'NOT_EVALUATED', blockers: [] });
  providerBindingInput(input);
  for (const obligation of input.obligations) {
    obligation.caseIds = [`${obligation.id}.case`];
    obligation.observerIds = [`${obligation.id}.observer`];
    obligation.oracleIds = [`${obligation.id}.oracle`];
  }
  input.consumer.providerBindings[0].providerRef.version = '';
  assert.throws(() => validateMediaClosureInputState(input), /versioned provider identity/);

  const noRegistry = fixture();
  Object.assign(noRegistry.pending, { status: 'INPUT_READY', closureStatus: 'NOT_EVALUATED', blockers: [] });
  providerBindingInput(noRegistry);
  for (const obligation of noRegistry.obligations) {
    obligation.caseIds = [`${obligation.id}.case`];
    obligation.observerIds = [`${obligation.id}.observer`];
    obligation.oracleIds = [`${obligation.id}.oracle`];
  }
  delete noRegistry.consumer.providerRegistry;
  assert.throws(() => validateMediaClosureInputState(noRegistry), /provider registry source/);
});

test('rejects hidden missing obligations and inconsistent phase selectors', () => {
  const input = fixture();
  input.surface.obligationIds.pop();
  assert.throws(() => validateMediaClosureInputState(input), /inventory/);
  const other = fixture();
  other.binding.phases[phases[1]].obligationIds = [other.obligations[0].id];
  assert.throws(() => validateMediaClosureInputState(other), /diverge/);
});

test('rejects source PDP labels reused as Lifecycle Closure phase IDs', () => {
  const input = fixture();
  input.program.phases[0].id = 'PDP-0';
  assert.throws(() => validateMediaClosureInputState(input), /distinct from Media source PDP labels/u);
});

test('rejects artificial green status with unaddressed owner blockers', () => {
  const input = fixture();
  Object.assign(input.pending, { status: 'INPUT_READY', closureStatus: 'NOT_EVALUATED' });
  assert.throws(() => validateMediaClosureInputState(input), /known blockers/);
});
