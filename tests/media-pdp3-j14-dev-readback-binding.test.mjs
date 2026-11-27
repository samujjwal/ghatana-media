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

test("J-14 binds only its DEV_ONLY analytic result readback to the exact query route", () => {
  const journey = p0.journeys.find((record) => record.id === "J-14");
  const example = journey.developmentOnlyExample;
  const binding = example.readbackActionBinding;
  const scenario = p3.sourceBoundScenarios.find((record) => record.id === "media.declarative.p3.scenario.newton-constant-force.v1");
  const experienceBinding = scenario.developmentOnlyExample.readbackActionBinding;
  const transport = p2.ownerDefinedDevelopmentOnlyApiCandidate.routeSdkBindings
    .find((record) => record.apiOperationId === binding.apiOperationId);
  const operation = p1.ownerDefinedOperationContracts.records.find((record) => record.id === binding.operationRef);
  const action = actions.actions.find((record) => record.id === binding.actionRef);

  assert.equal(example.decisionRef, "PXD-252");
  assert.equal(example.status, "DEV_ONLY_SOURCE_FREE_ANALYTIC_SIMULATION");
  assert.match(example.scenario, /mass=2kg; force=6N/u);
  assert.equal(example.analyticOracleRef, ".product-experience/pdp-1-domain-data/declarative-production-contracts.yaml#scientificReferenceOracles/@id=media.declarative.oracle.force-motion.v1");
  assert.equal(example.evidenceClass, "DETERMINISTIC_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE");
  assert.equal(example.productionEligible, false);
  assert.equal(binding.decisionRef, "PXD-266");
  assert.equal(binding.actionRef, "media.action.inspect-simulation-result");
  assert.equal(binding.operationRef, "media.operation.action.inspect-simulation-result");
  assert.equal(binding.channelRef, "media.channel.web");
  assert.equal(binding.apiOperationId, "media.dev.http.getSimulation");
  assert.equal(binding.method, "GET");
  assert.equal(binding.path, "/dev/v1/simulations/{simulationId}");
  assert.match(binding.selector, /simulationId is the exact resultArtifact\.artifactId/u);
  assert.equal(binding.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(binding.journeyAcceptance, "OPEN");

  assert.equal(transport.method, binding.method);
  assert.equal(transport.path, binding.path);
  assert.equal(transport.pdp1SemanticRef, binding.operationRef);
  assert.deepEqual(transport.routePermission, ["media:project:dev:read", "media:artifact:read"]);
  assert.equal(p2.ownerDefinedDevelopmentOnlyApiCandidate.productionAdmission, "NOT_ADMITTED");
  assert.equal(operation.operationKind, "QUERY");
  assert.equal(operation.actionRef, binding.actionRef);
  assert.match(operation.sourceEffect, /Read the result and declared measurements/u);
  assert.match(action.effect, /Read the result and declared measurements/u);
  assert.equal(action.finality, "read-only; no-write-finality");

  assert.equal(scenario.developmentOnlyExample.decisionRef, "PXD-252");
  assert.equal(scenario.developmentOnlyExample.independentScientificQualification, "NOT_ESTABLISHED");
  assert.equal(scenario.developmentOnlyExample.productionEligible, false);
  assert.equal(experienceBinding.decisionRef, binding.decisionRef);
  assert.equal(experienceBinding.p0BindingSource, ".product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=J-14/developmentOnlyExample/readbackActionBinding");
  assert.equal(experienceBinding.operationRef, binding.operationRef);
  assert.equal(experienceBinding.apiOperationId, binding.apiOperationId);
  assert.equal(experienceBinding.route, "GET /dev/v1/simulations/{simulationId}");
  assert.match(experienceBinding.p1MachineState, /^NONE;/u);
  assert.match(experienceBinding.channelBoundary, /UNBOUND and NOT_ADMITTED/u);
  assert.equal(experienceBinding.journeyAcceptance, "OPEN");

  assert.match(explorerClient, /reopen: \(simulationId\) => call\("GET", `\/dev\/v1\/simulations\//u);
  assert.match(routeSource, /view\.put\("simulationId", run\.result\(\)\.artifactId\(\)\)/u);
  assert.match(routeSource, /var found = simulation\.reopen\(tenantId, principalId, pathSegment\(one\.group\(1\)\)\)/u);
  assert.match(browserTest, /#sim-reopen-id/u);
  assert.match(liveTest, /MediaDevExplorerSimulationLiveIT/u);
  assert.match(decisionLog, /### PXD-266 — Bind the DEV_ONLY J-14 analytic result readback/u);
  assert.match(decisionLog, /Do not bind the PXD-252 POST\/run request to canonical `media\.action\.submit-simulation`/u);
});
