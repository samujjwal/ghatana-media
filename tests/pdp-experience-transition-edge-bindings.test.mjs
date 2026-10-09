import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { validatePdp3TransitionEdgeBindings } from "../scripts/lib/pdp3-transition-edge-binding-validation.mjs";

const parse = createRequire(new URL("../../ghatana-tools/package.json", import.meta.url))("yaml").parse;
const read = async (path) => parse(await readFile(path, "utf8"));
const p1 = ".product-experience/pdp-1-domain-data";
const p3 = ".product-experience/pdp-3-product-experience";
const filenames = [
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
];
const [bindingDocument, transitions, guardContracts, states, stepOracles, actions, ...journeys] = await Promise.all([
  read(`${p3}/journey-transition-edge-bindings.yaml`),
  read(`${p1}/transitions.yaml`),
  read(`${p1}/transition-guard-contracts.yaml`),
  read(`${p1}/states.yaml`),
  read(`${p3}/step-definition-oracles.yaml`),
  read(`${p3}/action-registry.yaml`),
  ...filenames.map((filename) => read(`${p3}/journey-contracts/${filename}`).then((document) => ({ filename, document }))),
]);
const oracleBySourceRef = new Map(stepOracles.journeys.flatMap((journey) => journey.steps.map((step) => [step.sourceRef, step])));
const input = { bindingDocument, transitions, guardContracts, states, journeys, stepOracles: oracleBySourceRef, actions };

test("all 55 P1 transitions and every exact guarded edge are source-linked without runtime promotion", () => {
  assert.deepEqual(validatePdp3TransitionEdgeBindings(input), { transitions: 55, guardedEdges: 165 });
  assert.equal(bindingDocument.records.length, 55);
  assert.equal(bindingDocument.records.reduce((count, row) => count + row.edgeBindings.length, 0), 165);
  assert.equal(bindingDocument.records.filter((row) => row.journeyActionDisposition === "EXACT_JOURNEY_TRANSITION_ACTION_AND_OPERATION_INTERSECTION").length, 1);
  assert.equal(bindingDocument.records.find((row) => row.transitionId === "media-upload-and-artifact/T01").exactJourneyBindings[0].stepId, "J02-3");
  const byDisposition = new Map();
  for (const row of bindingDocument.records) byDisposition.set(row.transitionInvocationDisposition, (byDisposition.get(row.transitionInvocationDisposition) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries(byDisposition), {
    "P1_EVENT_TRIGGER_PENDING; NO_EXACT_PUBLIC_OPERATION_OR_JOURNEY_ACTION": 44,
    "AUTHORITY_SOURCE_EVENT_REQUIRED; PUBLIC_OPERATION_AND_TRANSPORT_EXPLICITLY_UNBOUND": 6,
    "P1_OPERATION_FAMILY_PROPOSAL_ONLY; NO_EXACT_ACTION_INVOCATION": 3,
    "EXACT_P3_JOURNEY_ACTION_AND_P1_OPERATION_REFERENCE": 1,
    "P1_EXPLICITLY_NO_VERIFICATION_OPERATION_IDENTITY; NO_ROUTE_OR_RUNTIME_ADMISSION": 1,
  });
  for (const row of bindingDocument.records) {
    assert.equal(row.eventTriggerSourceRef, `${row.transitionRef}/eventTriggers`);
    assert.equal(row.operationBindingSourceRef, `${row.transitionRef}/operationBinding`);
  }
});

test("foreign transitions, guards, state edges, operations, and invented journey actions fail closed", () => {
  const mutate = (fn) => {
    const copy = structuredClone(bindingDocument);
    fn(copy);
    assert.throws(() => validatePdp3TransitionEdgeBindings({ ...input, bindingDocument: copy }), /Invalid PDP-3 transition edge binding/u);
  };
  mutate((copy) => { copy.records[0].transitionRef = ".product-experience/pdp-1-domain-data/transitions.yaml#transitionRecords/@id=media-job/T02"; });
  mutate((copy) => { copy.records[0].guardContractRef = ".product-experience/pdp-1-domain-data/transition-guard-contracts.yaml#records/@id=media.transition-guard-contract.media-job.t02"; });
  mutate((copy) => { copy.records[0].edgeBindings[0].toStateRef = ".product-experience/pdp-1-domain-data/states.yaml#stateMachines/@machineId=media-job/stateDefinitions/@id=COMPLETED"; });
  mutate((copy) => { copy.records[0].edgeBindings[0].when.all[0].fact = "foreign-tenant.matches"; });
  mutate((copy) => { copy.records[0].operationRefs = ["media.operation-slice.create-project"]; });
  mutate((copy) => { copy.records.find((row) => row.transitionId === "media-rights-and-consent/consent/T01").transitionInvocationDisposition = "P1_EVENT_TRIGGER_PENDING; NO_EXACT_PUBLIC_OPERATION_OR_JOURNEY_ACTION"; });
  mutate((copy) => { copy.records[0].eventTriggerSourceRef = ".product-experience/pdp-1-domain-data/transitions.yaml#transitionRecords/@id=media-job/T02/eventTriggers"; });
  mutate((copy) => { copy.records[1].exactJourneyBindings = [{ journeyRef: "J-99", stepRef: "foreign", actionRef: "media.action.create-project", canonicalOperationRefs: ["media.operation-slice.create-project"] }]; });
});
