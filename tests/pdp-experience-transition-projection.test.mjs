import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { projectPdp3TransitionCandidates } from "../scripts/lib/pdp3-transition-projection.mjs";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = async (path) => parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
const [bindingDocument, transitionSource, actions, stateMachines] = await Promise.all([
  readYaml(".product-experience/pdp-3-product-experience/state-transition-bindings.yaml"),
  readYaml(".product-experience/pdp-1-domain-data/transitions.yaml"),
  readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml"),
  readYaml(".product-experience/pdp-1-domain-data/states.yaml"),
]);

test("the only projected transition is the exact successful upload-finalization edge", () => {
  const candidates = projectPdp3TransitionCandidates({ bindingDocument, transitions: transitionSource, actions, stateMachines });
  assert.deepEqual(candidates, [bindingDocument.ownerTransitionProjectionCandidates.records[0].publicTransition]);
  assert.deepEqual(candidates[0], {
    id: "media.pdp3.transition.upload-receiving-to-verifying.v1",
    fromStateRef: "media-upload-and-artifact.RECEIVING",
    toStateRef: "media-upload-and-artifact.VERIFYING",
    actionRef: "media.action.resume-artifact-upload",
    guards: [
      "upload-bounds-and-current-authority-remain-valid",
      "RECEIVING-to-VERIFYING-after-required-upload-bytes-and-SHA-256-are-verified",
    ],
  });
});

test("foreign operations, actions, states, edge outcomes, and unreviewed additions are rejected", () => {
  const mutate = (fn) => {
    const copy = structuredClone(bindingDocument);
    fn(copy.ownerTransitionProjectionCandidates.records[0]);
    assert.throws(() => projectPdp3TransitionCandidates({ bindingDocument: copy, transitions: transitionSource, actions, stateMachines }), /Invalid PDP-3 transition candidate/u);
  };
  mutate((row) => { row.actionRef = "media.action.create-project"; });
  mutate((row) => { row.operationRef = "media.operation-slice.create-project"; });
  mutate((row) => { row.toStateRef = ".product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-job/stateDefinitions/COMPLETED"; });
  mutate((row) => { row.publicTransition.guards[1] = "finality-confirmed"; });
  const extra = structuredClone(bindingDocument);
  extra.ownerTransitionProjectionCandidates.records.push({ ...extra.ownerTransitionProjectionCandidates.records[0], id: "media.pdp3.transition-candidate.fake.v1" });
  assert.throws(() => projectPdp3TransitionCandidates({ bindingDocument: extra, transitions: transitionSource, actions, stateMachines }), /single-edge source set/u);
  const noExactEdge = structuredClone(transitionSource);
  noExactEdge.transitionRecords.find((row) => row.id === "media-upload-and-artifact/T01").operationRefs = ["media.operation-slice.begin-upload"];
  assert.throws(() => projectPdp3TransitionCandidates({ bindingDocument, transitions: noExactEdge, actions, stateMachines }), /PDP-1 operation binding/u);
});
