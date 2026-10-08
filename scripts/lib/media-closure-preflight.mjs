import assert from 'node:assert/strict';

/**
 * A source-input check, not a Lifecycle closure verifier. Allows a recorded
 * PENDING state today and a future INPUT_READY state only with complete,
 * traceable local producer declarations. Neither state asserts a receipt.
 */
export function validateMediaClosureInputState({
  consumer, program, surface, binding, obligations, pending,
}) {
  const phaseIds = ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'];
  const dependencies = {
    'PDP-0': [],
    'PDP-1': ['PDP-0'],
    'PDP-2': ['PDP-0', 'PDP-1'],
    'PDP-3': ['PDP-0', 'PDP-1', 'PDP-2'],
  };

  assert.deepEqual(program.phases.map((phase) => phase.id), phaseIds);
  assert.equal(surface.phaseProgramRef, program.programId);
  assert.equal(surface.phaseBindingRef, binding.bindingId);
  assert.equal(binding.closureSurfaceId, surface.id);
  assert.equal(binding.programId, program.programId);
  assert.ok(Array.isArray(obligations) && obligations.length >= phaseIds.length,
    'at least one requirement obligation per phase');
  const byId = new Map(obligations.map((item) => [item.id, item]));
  assert.equal(byId.size, obligations.length, 'duplicate obligation identity');
  for (const obligation of obligations) {
    assert.ok(Array.isArray(obligation.requirementIds) && obligation.requirementIds.length > 0,
      `${obligation.id} must be scoped to at least one source requirement`);
    assert.equal(new Set(obligation.requirementIds).size, obligation.requirementIds.length,
      `${obligation.id} duplicates a requirement identity`);
    for (const key of ['caseIds', 'observerIds', 'oracleIds']) {
      assert.ok(Array.isArray(obligation[key]), `${obligation.id} must declare ${key}`);
      assert.equal(new Set(obligation[key]).size, obligation[key].length,
        `${obligation.id} duplicates ${key}`);
    }
  }

  for (const phaseId of phaseIds) {
    const phase = program.phases.find((item) => item.id === phaseId);
    assert.deepEqual(phase.dependsOn ?? [], dependencies[phaseId]);
    const selected = phase.obligationIds ?? [];
    assert.ok(selected.length > 0, `${phaseId} needs at least one obligation`);
    const overlay = binding.phases[phaseId];
    assert.equal(overlay?.applicability, 'APPLICABLE');
    assert.deepEqual(overlay.obligationIds, selected,
      `${phaseId} definition and consumer binding diverge`);
    assert.equal(new Set(selected).size, selected.length,
      `${phaseId} selects duplicate obligations`);
    for (const id of selected) {
      const obligation = byId.get(id);
      assert.ok(obligation, `${phaseId} missing obligation ${id}`);
      assert.equal(obligation.disposition, 'REQUIRED');
      assert.ok(obligation.phaseSemantics.applicableIn.includes(phaseId),
        `${id} lacks applicableIn ${phaseId}`);
      assert.ok(obligation.phaseSemantics.blockingIn.includes(phaseId),
        `${id} lacks blockingIn ${phaseId}`);
      assert.ok(obligation.phaseSemantics.affects.includes(phaseId),
        `${id} lacks affects ${phaseId}`);
    }
  }

  assert.deepEqual(
    [...new Set(surface.obligationIds)].sort(),
    [...byId.keys()].sort(),
    'surface must inventory exactly the selected obligation population',
  );
  assert.equal(surface.obligationIds.length, obligations.length,
    'surface obligation population contains duplicates');

  assert.equal(consumer.schemaVersion, 'ghatana.closure.consumer');
  assert.deepEqual(consumer.contractSet, { id: 'ghatana.closure', version: '1' });
  assert.ok(Array.isArray(consumer.providerBindings));
  for (const key of ['surfaces', 'phasePrograms', 'phaseBindings', 'obligations']) {
    assert.ok(consumer.sources[key]?.length > 0, `missing consumer source ${key}`);
  }

  assert.deepEqual(pending.receipts, [], 'Media cannot author Lifecycle receipts');
  assert.equal(pending.currentness, 'UNKNOWN',
    'Media cannot author Lifecycle currentness');
  if (pending.status === 'PENDING') {
    assert.equal(pending.closureStatus, 'BLOCKED');
    assert.ok(Array.isArray(pending.blockers) && pending.blockers.length > 0,
      'PENDING requires explicitly recorded blockers');
    return { inputStatus: 'PENDING', phaseCount: phaseIds.length, obligationCount: obligations.length };
  }

  assert.equal(pending.status, 'INPUT_READY',
    'only PENDING or proof-addressable INPUT_READY source state is permitted');
  assert.equal(pending.closureStatus, 'NOT_EVALUATED',
    'Media input readiness is not Lifecycle closure');
  assert.deepEqual(pending.blockers, [], 'input-ready declarations cannot retain known blockers');
  assert.ok(consumer.providerBindings.length > 0,
    'input ready needs admitted provider bindings, not a placeholder');
  for (const obligation of obligations) {
    for (const key of ['caseIds', 'observerIds', 'oracleIds']) {
      assert.ok(Array.isArray(obligation[key]) && obligation[key].length > 0,
        `input-ready obligation ${obligation.id} needs ${key}`);
      assert.equal(new Set(obligation[key]).size, obligation[key].length,
        `input-ready obligation ${obligation.id} duplicates ${key}`);
    }
  }
  return { inputStatus: 'INPUT_READY', phaseCount: phaseIds.length, obligationCount: obligations.length };
}
