const RACE_AXES = Object.freeze([
  "providerDispatch", "externalEffect", "cancelRace", "retry", "staleFence", "deliveryAck",
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

/**
 * Validate the finite owner-declared race applicability census against the
 * actual state and transition populations. This checks source completeness;
 * it does not claim that a runtime enforces the listed race rules.
 */
export function validateOwnerMachineRaceApplicability({ states, transitions, guardContracts }) {
  const model = transitions?.ownerMachineRaceApplicability;
  const records = model?.records;
  const machines = states?.stateMachines;
  if (!Array.isArray(records) || !Array.isArray(machines)) fail("RACE_APPLICABILITY_SOURCE_MISSING");

  const machineById = new Map(machines.map((machine) => [machine.machineId, machine]));
  if (machineById.size !== machines.length || records.length !== machines.length) fail("RACE_MACHINE_POPULATION_MISMATCH");
  const rows = new Map(records.map((record) => [record.machineId, record]));
  if (rows.size !== records.length) fail("RACE_MACHINE_DUPLICATE");
  const rationaleCodes = new Set(Object.keys(model.rationaleCodeSemantics ?? {}));
  const transitionRows = [
    ...(transitions.transitionRecords ?? []),
    ...(transitions.ownerDefinedTransitionRecords ?? []),
  ];
  const guardRecords = guardContracts?.records ?? [];
  const guardsByTransition = new Map();
  for (const guard of guardRecords) {
    const transitionRef = guard.sourceTransitionRef;
    if (!transitionRef) continue;
    guardsByTransition.set(transitionRef, guard.id);
  }

  for (const [machineId, machine] of machineById) {
    const record = rows.get(machineId);
    if (!record || record.sourceMachineRef !== `.product-experience/pdp-1-domain-data/states.yaml#stateMachines/@machineId=${machineId}`) fail("RACE_MACHINE_REFERENCE_MISMATCH");
    const expectedStateRefs = machine.stateDefinitions
      ? machine.stateDefinitions.map((state) => `${record.sourceMachineRef}/stateDefinitions/@id=${state.id}`)
      : Object.entries(machine.stateDefinitionsByDimension ?? {}).flatMap(([dimension, statesForDimension]) =>
        statesForDimension.map((state) => `${record.sourceMachineRef}/stateDefinitionsByDimension/${dimension}/@id=${state.id}`));
    if (record.stateCount !== expectedStateRefs.length || JSON.stringify(record.stateRefs) !== JSON.stringify(expectedStateRefs)) fail("RACE_STATE_POPULATION_MISMATCH");

    const expectedTransitions = transitionRows.filter((transition) => transition.sourceMachineId === machineId);
    if (record.transitionCount !== expectedTransitions.length) fail("RACE_TRANSITION_POPULATION_MISMATCH");
    const expectedGuardRefs = expectedTransitions.flatMap((transition) => {
      const collection = transitions.transitionRecords.includes(transition) ? "transitionRecords" : "ownerDefinedTransitionRecords";
      const transitionRef = `.product-experience/pdp-1-domain-data/transitions.yaml#${collection}/@id=${transition.id}`;
      const guardId = guardsByTransition.get(transitionRef);
      return guardId ? [`.product-experience/pdp-1-domain-data/transition-guard-contracts.yaml#records/@id=${guardId}`] : [];
    });
    if (JSON.stringify(record.transitionGuardContractRefs) !== JSON.stringify(expectedGuardRefs)) fail("RACE_GUARD_POPULATION_MISMATCH");

    const axisRows = record.raceApplicability;
    if (!axisRows || JSON.stringify(Object.keys(axisRows).sort()) !== JSON.stringify([...RACE_AXES].sort())) fail("RACE_AXIS_POPULATION_MISMATCH");
    for (const axis of RACE_AXES) {
      const disposition = axisRows[axis];
      if (!["APPLICABLE", "NOT_APPLICABLE"].includes(disposition?.disposition)
        || !rationaleCodes.has(disposition.rationaleCode)
        || disposition.scope !== "machine-local state semantics; does not make a cross-machine guarantee") {
        fail("RACE_AXIS_DISPOSITION_INVALID");
      }
    }
    if (!record.unknownResolution || !(/UNKNOWN/u.test(record.unknownResolution) || /authoritative evidence/u.test(record.unknownResolution))
      || !/runtime enforcement.*NOT_ADMITTED/u.test(record.status ?? "")) fail("RACE_UNKNOWN_OR_RUNTIME_BOUNDARY_MISSING");
  }
  return { machineCount: machines.length, stateCount: records.reduce((sum, row) => sum + row.stateCount, 0), transitionCount: records.reduce((sum, row) => sum + row.transitionCount, 0), axisCount: RACE_AXES.length };
}
