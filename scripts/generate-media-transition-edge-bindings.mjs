import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const parse = createRequire(new URL("../../ghatana-tools/package.json", import.meta.url))("yaml").parse;
const stringify = createRequire(new URL("../../ghatana-tools/package.json", import.meta.url))("yaml").stringify;
const p1 = ".product-experience/pdp-1-domain-data";
const p3 = ".product-experience/pdp-3-product-experience";
const read = (path) => parse(readFileSync(path, "utf8"));
const transitions = read(`${p1}/transitions.yaml`);
const guardContracts = read(`${p1}/transition-guard-contracts.yaml`);
const states = read(`${p1}/states.yaml`);
const actions = read(`${p3}/action-registry.yaml`);
const oracle = read(`${p3}/step-definition-oracles.yaml`);
const oracleBySourceRef = new Map(oracle.journeys.flatMap((journey) => journey.steps.map((step) => [step.sourceRef, step])));
const journeyContracts = [];
for (const name of [
  "analyze-image-video-geometry-and-tracks.yaml", "animate-3d-scenes-and-characters.yaml", "animate-vector-or-procedural-scenes.yaml",
  "authorized-text-to-speech-to-approved-audio.yaml", "check-which-processing-options-are-eligible.yaml", "clean-noisy-interview-audio.yaml",
  "compose-and-render-reviewed-media.yaml", "continue-safely-when-processing-is-unavailable.yaml", "create-review-and-deliver-from-a-brief.yaml",
  "delete-or-revoke-media-with-visible-lifecycle.yaml", "deliver-export-with-destination-acknowledgement.yaml", "edit-tracked-media-region-with-undo.yaml",
  "explore-domain-simulation-and-review-measurements.yaml", "export-spatial-media-with-format-loss-reporting.yaml", "first-use-and-project-creation.yaml",
  "generate-from-references-and-review-continuity.yaml", "inspect-quality-and-optimize-within-bounds.yaml", "live-session-loss-consent-change-and-bounded-recovery.yaml",
  "long-running-job-observation-and-recovery.yaml", "mix-and-master-music-and-effects.yaml", "refine-simulation-passes-with-semantic-validation.yaml",
  "repair-video-with-measured-quality.yaml", "return-bounded-results-to-integrating-products.yaml", "return-grounded-typed-consumer-results.yaml",
  "review-exact-version-and-recheck-changes.yaml", "run-cli-batch-and-review-verified-outputs.yaml", "transcribe-and-correct-captions.yaml",
  "translate-and-dub-existing-video.yaml", "upload-import-and-verify-artifact.yaml", "work-locally-and-reconcile-after-reconnect.yaml",
]) journeyContracts.push({ filename: name, journey: read(`${p3}/journey-contracts/${name}`) });

const allTransitions = [
  ...(transitions.transitionRecords ?? []).map((row) => ({ row, collection: "transitionRecords" })),
  ...(transitions.ownerDefinedTransitionRecords ?? []).map((row) => ({ row, collection: "ownerDefinedTransitionRecords" })),
];
const guardByTransition = new Map(guardContracts.records.map((row) => [row.transitionId, row]));
const statesByMachine = new Map(states.stateMachines.map((machine) => [machine.machineId, machine]));
const p3Refs = new Map();
for (const { filename, journey } of journeyContracts) {
  for (const [stepIndex, step] of (journey.steps ?? []).entries()) {
    const exactRefs = [step.transitionRef, ...(step.transitionRefs ?? [])].filter((ref) => typeof ref === "string" && /^[^ ]+\/T\d+$/u.test(ref));
    for (const transitionRef of exactRefs) {
      const rows = p3Refs.get(transitionRef) ?? [];
      rows.push({
        journeyRef: journey.journeyId,
        stepRef: `${p3}/journey-contracts/${filename}#/steps/${stepIndex}`,
        stepId: step.stepId ?? null,
        actionRef: oracleBySourceRef.get(`${p3}/journey-contracts/${filename}#/steps/${stepIndex}`)?.canonicalBindings?.actionRef ?? step.action ?? null,
        canonicalOperationRefs: oracleBySourceRef.get(`${p3}/journey-contracts/${filename}#/steps/${stepIndex}`)?.canonicalBindings?.operationRefs ?? [],
      });
      p3Refs.set(transitionRef, rows);
    }
  }
}

function stateRef(machineId, dimension, stateId) {
  const machine = statesByMachine.get(machineId);
  if (!machine) return { ref: null, disposition: "STATE_MACHINE_NOT_RESOLVED" };
  const direct = (machine.stateDefinitions ?? []).find((state) => state.id === stateId);
  if (direct) return { ref: `${p1}/states.yaml#stateMachines/@machineId=${machineId}/stateDefinitions/@id=${stateId}`, disposition: "EXACT_STATE_DEFINITION" };
  if (dimension) {
    const byDimension = machine.stateDefinitionsByDimension?.[dimension];
    if (Array.isArray(byDimension) && byDimension.some((state) => state.id === stateId)) {
      return { ref: `${p1}/states.yaml#stateMachines/@machineId=${machineId}/stateDefinitionsByDimension/${dimension}/@id=${stateId}`, disposition: "EXACT_DIMENSION_STATE_DEFINITION" };
    }
  }
  return { ref: null, disposition: "STATE_ID_NOT_RESOLVED_IN_EXACT_MACHINE_DIMENSION" };
}

const records = allTransitions.map(({ row, collection }) => {
  const guard = guardByTransition.get(row.id);
  if (!guard) throw new Error(`Missing exact guard contract for ${row.id}`);
  const transitionRef = `${p1}/transitions.yaml#${collection}/@id=${row.id}`;
  const guardRef = `${p1}/transition-guard-contracts.yaml#records/@id=${guard.id}`;
  const sourceEdges = guard.edgeRules.map((edge, index) => {
    const from = stateRef(row.sourceMachineId, row.stateDimension ?? guard.stateDimension, edge.from);
    const to = stateRef(row.sourceMachineId, row.stateDimension ?? guard.stateDimension, edge.to);
    const legalFrom = (row.from ?? []).includes(edge.from);
    const legalTo = (row.to ?? []).includes(edge.to);
    return {
      id: `media.transition-edge-binding.${row.id.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}.${String(index + 1).padStart(2, "0")}.v1`,
      edgeRuleRef: `${guardRef}/edgeRules/${index}`,
      fromStateRef: from.ref,
      toStateRef: to.ref,
      stateResolution: from.disposition === "EXACT_STATE_DEFINITION" || from.disposition === "EXACT_DIMENSION_STATE_DEFINITION"
        ? to.disposition : from.disposition,
      sourceLegality: legalFrom && legalTo ? "GUARD_EDGE_IS_MEMBER_OF_TRANSITION_FROM_AND_TO" : "GUARD_EDGE_CONFLICTS_WITH_TRANSITION_FROM_OR_TO",
      when: edge.when,
    };
  });
  const exactJourneyBindings = p3Refs.get(row.id) ?? [];
  const actionCompatible = exactJourneyBindings.length > 0 && exactJourneyBindings.every((binding) =>
    binding.actionRef && (row.operationRefs ?? []).some((operationRef) => binding.canonicalOperationRefs.includes(operationRef)));
  const eventTriggerSource = row.eventTriggers ?? "NOT_DECLARED_IN_P1_TRANSITION";
  const operationBindingSource = row.operationBinding ?? "NOT_DECLARED_IN_P1_TRANSITION";
  const transitionInvocationDisposition = actionCompatible
    ? "EXACT_P3_JOURNEY_ACTION_AND_P1_OPERATION_REFERENCE"
    : eventTriggerSource.includes("authority-source-event-required")
      ? "AUTHORITY_SOURCE_EVENT_REQUIRED; PUBLIC_OPERATION_AND_TRANSPORT_EXPLICITLY_UNBOUND"
      : operationBindingSource.includes("family reference only")
        ? "P1_OPERATION_FAMILY_PROPOSAL_ONLY; NO_EXACT_ACTION_INVOCATION"
        : operationBindingSource.includes("no-existing-verification-operation-identity")
          ? "P1_EXPLICITLY_NO_VERIFICATION_OPERATION_IDENTITY; NO_ROUTE_OR_RUNTIME_ADMISSION"
          : operationBindingSource.includes("successful-upload-finalization")
            ? "P1_BOUNDED_EXACT_OPERATION_EFFECT; JOURNEY_ACTION_REQUIRES_EXACT_STEP_BINDING"
            : (row.operationRefs ?? []).length
              ? "P1_OPERATION_REFERENCE_PRESENT; EVENT_OR_ACTION_INVOKER_NOT_ESTABLISHED"
              : eventTriggerSource.includes("pending-PDP1-004")
                ? "P1_EVENT_TRIGGER_PENDING; NO_EXACT_PUBLIC_OPERATION_OR_JOURNEY_ACTION"
                : "P1_TRIGGER_AND_ACTION_BINDING_NOT_SPECIFIED";
  return {
    id: `media.transition-step-binding.${row.id.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}.v1`,
    transitionId: row.id,
    transitionRef,
    guardContractRef: guardRef,
    sourceMachineId: row.sourceMachineId,
    stateDimension: row.stateDimension ?? guard.stateDimension ?? null,
    operationRefs: row.operationRefs ?? [],
    eventTriggerSource,
    operationBindingSource,
    eventTriggerSourceRef: `${transitionRef}/eventTriggers`,
    operationBindingSourceRef: `${transitionRef}/operationBinding`,
    transitionInvocationDisposition,
    fromStateRefs: (row.from ?? []).map((state) => ({ stateId: state, ...stateRef(row.sourceMachineId, row.stateDimension ?? guard.stateDimension, state) })),
    toStateRefs: (row.to ?? []).map((state) => ({ stateId: state, ...stateRef(row.sourceMachineId, row.stateDimension ?? guard.stateDimension, state) })),
    ownerGuardRef: guardRef,
    ownerGuardDisposition: row.ownerGuardDisposition ?? guard.ownerGuardDisposition ?? "SOURCE_DISPOSITION_NOT_PRESENT",
    edgeBindings: sourceEdges,
    exactJourneyBindings,
    journeyActionDisposition: actionCompatible
      ? "EXACT_JOURNEY_TRANSITION_ACTION_AND_OPERATION_INTERSECTION"
      : exactJourneyBindings.length
        ? "JOURNEY_TRANSITION_REF_CONFLICTS_WITH_EXACT_ACTION_OPERATION_BINDING"
      : "NO_EXACT_P3_JOURNEY_TRANSITION_REF; DO_NOT_INFER_ACTION_FROM_STATE_OR_OPERATION_NAMES",
    sourceStatus: "OWNER_DEFINITION_SOURCE_ONLY; independent review open; runtime NOT_ADMITTED",
    acceptanceEffect: "none",
  };
});

const document = {
  schemaVersion: "media.pdp-3-journey-transition-edge-bindings.v1",
  status: "Media-owned exact P1 transition and guard applicability; no action or runtime promotion",
  sourceRefs: [
    `${p1}/transitions.yaml#transitionRecords`,
    `${p1}/transitions.yaml#ownerDefinedTransitionRecords`,
    `${p1}/transition-guard-contracts.yaml#records`,
    `${p1}/states.yaml#stateMachines`,
    `${p3}/journey-contracts/*.yaml`,
  ],
  expectedTransitionCount: 55,
  recordCount: records.length,
  records,
  runtimeAdmission: "NOT_ADMITTED",
  acceptanceEffect: "none",
};
if (records.length !== 55) throw new Error(`Expected all 55 exact transition records, got ${records.length}`);
writeFileSync(`${p3}/journey-transition-edge-bindings.yaml`, stringify(document, { lineWidth: 120, aliasDuplicateObjects: false }));
console.log(JSON.stringify({ transitionRecords: records.length, edgeRules: records.reduce((sum, row) => sum + row.edgeBindings.length, 0), exactJourneyTransitionRefs: records.reduce((sum, row) => sum + row.exactJourneyBindings.length, 0) }, null, 2));
