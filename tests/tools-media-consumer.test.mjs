import assert from "node:assert/strict";
import test from "node:test";
import { exerciseMediaToolsConsumer } from "../apps/media-experience-explorer/src/tools-consumer.ts";

test("Media consumer can load, render, inspect, and dispatch through the Tools Explorer API", async () => {
  const result = await exerciseMediaToolsConsumer();

  assert.equal(result.activePackageId, "media.experience.simulation");
  assert.equal(result.toolsValidatorsPassed, true);
  assert.deepEqual(result.traceProjection, {
    sourceId: "ghatana.product/media",
    subjectId: "media",
    stageId: "establish-product-definition",
    nodeKinds: ["ProductDefinition", "DesiredOutcome", "Capability", "Requirement"],
    relationCount: 3,
  });
  assert.equal(result.initialRenderKind, "rendered");
  assert.equal(result.initialSourceStatus, "proposal-pending-owner-review");
  assert.equal(result.initialStateRef, "media.scenario.source-available");
  assert.equal(result.dispatchProducedResult, true);
  assert.equal(result.dispatchFinalityKind, "unknown");
  assert.equal(result.updatedRenderKind, "rendered");
  assert.equal(result.updatedSourceStatus, "proposal-pending-owner-review");
  assert.equal(result.authorityStatus, "proposal-pending-owner-review");
  assert.equal(result.currentnessOutputPresent, false);
  assert.ok(result.updatedAvailableActions.includes("media.action.request-transcription"));
  assert.ok(result.sourceRefs.includes(".product-experience/source-manifest.yaml"));
  assert.ok(result.sourceRefs.includes(".product-experience/pdp-0-product-truth/state-models.yaml"));
  assert.ok(result.sourceRefs.includes(".product-experience/pdp-3-product-experience/state-transition-bindings.yaml"));
  assert.deepEqual(result.diagnostics, []);
});
