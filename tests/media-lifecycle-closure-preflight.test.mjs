import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMediaClosureInputState } from '../scripts/lib/media-closure-preflight.mjs';

const phases = ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'];
function fixture() {
  const obligations = phases.map((phase, i) => ({
    id: `media.pdp-${i}.specific-requirement`,
    disposition: 'REQUIRED',
    phaseSemantics: { applicableIn: [phase], blockingIn: [phase], affects: [phase] },
    requirementIds: [`MEDIA-REQ-PDP-${i}`],
    caseIds: [], observerIds: [], oracleIds: [],
  }));
  const program = {
    programId: 'media.program.v1',
    phases: phases.map((id, i) => ({
      id,
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
  input.binding.phases['PDP-0'].obligationIds.push(extra.id);
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
  input.consumer.providerBindings.push({ id: 'candidate-binding-requires-separate-Lifecycle-admission' });
  assert.throws(() => validateMediaClosureInputState(input), /needs caseIds/);
});

test('allows only input readiness, never Media-authored closure', () => {
  const input = fixture();
  Object.assign(input.pending, { status: 'INPUT_READY', closureStatus: 'NOT_EVALUATED', blockers: [] });
  input.consumer.providerBindings.push({ id: 'candidate-requires-separate-Lifecycle-admission' });
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

test('rejects hidden missing obligations and inconsistent phase selectors', () => {
  const input = fixture();
  input.surface.obligationIds.pop();
  assert.throws(() => validateMediaClosureInputState(input), /inventory/);
  const other = fixture();
  other.binding.phases['PDP-1'].obligationIds = [other.obligations[0].id];
  assert.throws(() => validateMediaClosureInputState(other), /diverge/);
});

test('rejects artificial green status with unaddressed owner blockers', () => {
  const input = fixture();
  Object.assign(input.pending, { status: 'INPUT_READY', closureStatus: 'NOT_EVALUATED' });
  assert.throws(() => validateMediaClosureInputState(input), /known blockers/);
});
