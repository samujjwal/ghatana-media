import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = async (path) => parse(await readFile(path, "utf8"));

const [p0, p1, p2, p3, actions, explorerClient, routeSource, browserTest, liveTest, decisionLog] = await Promise.all([
  readYaml(".product-experience/pdp-0-product-truth/journey-catalog.yaml"),
  readYaml(".product-experience/pdp-1-domain-data/operations.yaml"),
  readYaml(".product-experience/pdp-2-design-interface-system/api/conventions.yaml"),
  readYaml(".product-experience/pdp-3-product-experience/declarative-production-experience.yaml"),
  readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml"),
  readFile("apps/media-experience-explorer/src/dev-simulation-client.ts", "utf8"),
  readFile("launcher/src/main/java/com/ghatana/media/launcher/MediaDevSimulationRoutes.java", "utf8"),
  readFile("apps/media-experience-explorer/test/dev-simulation-live-browser.mjs", "utf8"),
  readFile("integration-tests/src/test/java/com/ghatana/media/integration/MediaDevExplorerSimulationLiveIT.java", "utf8"),
  readFile(".product-experience/decision-log.md", "utf8"),
]);

test("J-15 binds only its DEV_ONLY stored-result readback to the exact query route", () => {
  const journey = p0.journeys.find((record) => record.id === "J-15");
  const sourceBinding = journey.developmentOnlyExample.primaryHosted.readbackActionBinding;
  const scenario = p3.sourceBoundScenarios.find((record) => record.id === "media.declarative.p3.scenario.j15-hosted-simulation-output.v1");
  const experienceBinding = scenario.developmentOnlyExample.readbackActionBinding;
  const transport = p2.ownerDefinedDevelopmentOnlyApiCandidate.routeSdkBindings.find((record) => record.apiOperationId === sourceBinding.apiOperationId);
  const operation = p1.ownerDefinedOperationContracts.records.find((record) => record.id === sourceBinding.operationRef);
  const action = actions.actions.find((record) => record.id === sourceBinding.actionRef);

  assert.equal(sourceBinding.decisionRef, "PXD-264");
  assert.equal(sourceBinding.actionRef, "media.action.inspect-simulation-result");
  assert.equal(sourceBinding.operationRef, "media.operation.action.inspect-simulation-result");
  assert.equal(sourceBinding.channelRef, "media.channel.web");
  assert.equal(sourceBinding.method, "GET");
  assert.equal(sourceBinding.path, "/dev/v1/simulations/{simulationId}");
  assert.ok(journey.developmentOnlyExample.primaryHosted.evidenceRefs.includes(".product-experience/decision-log.md#PXD-264"));
  assert.equal(sourceBinding.transportBindingRef, ".product-experience/pdp-2-design-interface-system/api/conventions.yaml#ownerDefinedDevelopmentOnlyApiCandidate/routeSdkBindings");
  assert.equal(sourceBinding.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(sourceBinding.journeyAcceptance, "OPEN");

  assert.equal(transport.method, sourceBinding.method);
  assert.equal(transport.path, sourceBinding.path);
  assert.equal(transport.pdp1SemanticRef, sourceBinding.operationRef);
  assert.deepEqual(transport.routePermission, ["media:project:dev:read", "media:artifact:read"]);
  assert.match(p2.ownerDefinedDevelopmentOnlyApiCandidate.status, /implementation, verification, runtime admission, and production support are not asserted/u);
  assert.equal(p2.ownerDefinedDevelopmentOnlyApiCandidate.productionAdmission, "NOT_ADMITTED");
  assert.equal(operation.operationKind, "QUERY");
  assert.equal(operation.actionRef, sourceBinding.actionRef);
  assert.match(operation.sourceEffect, /Read the result and declared measurements/u);
  assert.match(action.effect, /Read the result and declared measurements/u);
  assert.equal(action.finality, "read-only; no-write-finality");

  assert.equal(experienceBinding.decisionRef, sourceBinding.decisionRef);
  assert.equal(experienceBinding.p0BindingSource, ".product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=J-15/developmentOnlyExample/primaryHosted/readbackActionBinding");
  assert.equal(experienceBinding.operationRef, sourceBinding.operationRef);
  assert.equal(experienceBinding.apiOperationId, sourceBinding.apiOperationId);
  assert.equal(experienceBinding.transportBindingRef, sourceBinding.transportBindingRef);
  assert.equal(experienceBinding.route, "GET /dev/v1/simulations/{simulationId}");
  assert.equal(experienceBinding.p1MachineState, "NONE; inspect-simulation-result is a read-only query and the DEV_ONLY outcome is not a job-state transition");
  assert.match(experienceBinding.channelBoundary, /UNBOUND and NOT_ADMITTED/u);
  assert.equal(experienceBinding.journeyAcceptance, "OPEN");
  assert.ok(scenario.developmentOnlyExample.productionEligible === false);
  assert.equal(scenario.developmentOnlyExample.independentScientificQualification, "NOT_ESTABLISHED");

  assert.match(explorerClient, /reopen: \(simulationId\) => call\("GET", `\/dev\/v1\/simulations\//u);
  assert.match(routeSource, /var found = simulation\.reopen\(tenantId, principalId, pathSegment\(one\.group\(1\)\)\)/u);
  assert.match(browserTest, /#sim-reopen-id/u);
  assert.match(liveTest, /MediaDevExplorerSimulationLiveIT/u);
  assert.match(decisionLog, /### PXD-264 — Bind the DEV_ONLY J-15 simulation result readback/u);
  assert.match(decisionLog, /Do not bind the PXD-244 POST\/run action to the canonical `media\.action\.submit-simulation` operation/u);
});
