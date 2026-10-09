const EXPECTED_ID = "media.pdp3.transition-candidate.upload-receiving-to-verifying.v1";
const EXPECTED_SOURCE = ".product-experience/pdp-1-domain-data/transitions.yaml#transitionRecords/@id=media-upload-and-artifact/T01";
const EXPECTED_OPERATION_EDGE = `${EXPECTED_SOURCE}/operationEdgeBounds`;
const EXPECTED_STEP = ".product-experience/pdp-3-product-experience/journey-contracts/upload-import-and-verify-artifact.yaml#steps/2";
const EXPECTED_ACTION = "media.action.resume-artifact-upload";
const EXPECTED_OPERATION = "media.operation-slice.complete-upload";
const EXPECTED_WORKFLOW = ["media.operation-slice.inspect-upload", "media.operation-slice.append-upload-chunk", EXPECTED_OPERATION];
const EXPECTED_FROM_REF = ".product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-upload-and-artifact/stateDefinitions/RECEIVING";
const EXPECTED_TO_REF = ".product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-upload-and-artifact/stateDefinitions/VERIFYING";

const fail = (reason) => { throw new Error(`Invalid PDP-3 transition candidate: ${reason}`); };
const exact = (actual, expected, label) => {
  if (actual !== expected) fail(`${label} does not match its exact source binding`);
};
const sameArray = (actual, expected, label) => {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    fail(`${label} does not match its exact ordered source binding`);
  }
};

/**
 * Project only transition edges whose source contract explicitly bounds an
 * accepted edge, whose action includes that exact operation, and whose states
 * resolve in the PDP-1 machine. This returns a definition candidate only.
 */
export function projectPdp3TransitionCandidates({ bindingDocument, transitions, actions, stateMachines }) {
  const rows = bindingDocument?.ownerTransitionProjectionCandidates?.records;
  if (!Array.isArray(rows) || rows.length !== 1) fail("expected the bounded, enumerated single-edge source set");
  const binding = rows[0];
  exact(binding.id, EXPECTED_ID, "candidate id");
  exact(binding.sourceTransitionRef, EXPECTED_SOURCE, "transition source ref");
  exact(binding.operationEdgeRef, EXPECTED_OPERATION_EDGE, "accepted edge source ref");
  exact(binding.stepRef, EXPECTED_STEP, "journey step ref");
  exact(binding.actionRef, EXPECTED_ACTION, "action ref");
  exact(binding.operationRef, EXPECTED_OPERATION, "operation ref");
  sameArray(binding.workflowOperationRefs, EXPECTED_WORKFLOW, "ordered workflow operations");
  exact(binding.fromStateRef, EXPECTED_FROM_REF, "source state ref");
  exact(binding.toStateRef, EXPECTED_TO_REF, "target state ref");
  exact(binding.decisionRef, ".product-experience/decision-log.md#PXD-049", "bounded owner decision");
  exact(binding.runtimeAdmission, "NOT_ADMITTED", "runtime admission");
  exact(binding.acceptanceEffect, "none", "acceptance effect");

  const transition = transitions?.transitionRecords?.find((row) => row.id === "media-upload-and-artifact/T01");
  if (!transition) fail("PDP-1 transition record is missing");
  sameArray(transition.from, ["RECEIVING"], "PDP-1 source state");
  if (!transition.to?.includes("VERIFYING")) fail("PDP-1 target state is missing");
  sameArray(transition.operationRefs, [EXPECTED_OPERATION], "PDP-1 operation binding");
  exact(transition.operationEdgeBounds?.acceptedEdge, "RECEIVING-to-VERIFYING-after-required-upload-bytes-and-SHA-256-are-verified", "accepted edge condition");
  sameArray(transition.operationEdgeBounds?.excludedEdges, ["RECEIVING-to-REJECTED", "RECEIVING-to-EXPIRED"], "excluded failure edges");
  exact(transition.operationEdgeBounds?.decisionRef, ".product-experience/decision-log.md#PXD-049", "PDP-1 edge decision");

  const action = actions?.actions?.find((row) => row.id === EXPECTED_ACTION)
    ?? actions?.ownerDefinedActions?.find((row) => row.id === EXPECTED_ACTION);
  if (!action) fail("exact Media action is missing");
  const actionOperationRefs = action.compoundWorkflow?.orderedOperationRefs
    ?? action.actionDefinitionSemantics?.typedDefinition?.exactOperationRefs
    ?? action.actionDefinitionSemantics?.sourceEnvelope?.exactOperationRefs;
  sameArray(actionOperationRefs, EXPECTED_WORKFLOW, "action operation workflow");

  const machine = stateMachines?.stateMachines?.find((row) => row.machineId === "media-upload-and-artifact");
  const stateIds = new Set((machine?.stateDefinitions ?? []).map((row) => row.id));
  if (!stateIds.has("RECEIVING") || !stateIds.has("VERIFYING")) fail("exact PDP-1 states do not resolve");

  const publicTransition = binding.publicTransition;
  exact(publicTransition?.id, "media.pdp3.transition.upload-receiving-to-verifying.v1", "public candidate id");
  exact(publicTransition.fromStateRef, "media-upload-and-artifact.RECEIVING", "public source state");
  exact(publicTransition.toStateRef, "media-upload-and-artifact.VERIFYING", "public target state");
  exact(publicTransition.actionRef, EXPECTED_ACTION, "public action");
  sameArray(publicTransition.guards, [transition.ownerGuardDefinition, transition.operationEdgeBounds.acceptedEdge], "public transition guards");
  if (!Array.isArray(binding.notTransitionedWhen) || binding.notTransitionedWhen.length < 5) fail("unknown and rejected outcomes must remain non-transitioning");
  return [publicTransition];
}
