import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = async (path) => parse(await readFile(path, "utf8"));

const [p0, p1, p2, p3, actions, decisionLog, explorerClient, installedClient, hostOutputRoute, hostContentRoute, browserTest] = await Promise.all([
  readYaml(".product-experience/pdp-0-product-truth/journey-catalog.yaml"),
  readYaml(".product-experience/pdp-1-domain-data/operations.yaml"),
  readYaml(".product-experience/pdp-2-design-interface-system/api/conventions.yaml"),
  readYaml(".product-experience/pdp-3-product-experience/declarative-production-experience.yaml"),
  readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml"),
  readFile(".product-experience/decision-log.md", "utf8"),
  readFile("apps/media-experience-explorer/src/dev-creative-outputs-client.ts", "utf8"),
  readFile("libs/audio-video-client/src/dev-creative-output.ts", "utf8"),
  readFile("launcher/src/main/java/com/ghatana/media/launcher/MediaDevCreativeOutputRoutes.java", "utf8"),
  readFile("launcher/src/main/java/com/ghatana/media/launcher/MediaDevArtifactContentRoutes.java", "utf8"),
  readFile("apps/media-experience-explorer/test/dev-creative-outputs-live-browser.mjs", "utf8"),
]);

test("J-13 binds only the DEV_ONLY PXD-253 exact GLB download/readback", () => {
  const journey = p0.journeys.find((record) => record.id === "J-13");
  const example = journey.developmentOnlyExample;
  const binding = example.verifiedDownloadReadbackBinding;
  const scenario = p3.caseExperiences.find((record) => record.id === "media.declarative.p3.case.003.v1");
  const experienceBinding = scenario.developmentOnlyExample.verifiedDownloadReadbackBinding;
  const metadataTransport = p2.ownerDefinedDevelopmentOnlyApiCandidate.routeSdkBindings
    .find((record) => record.apiOperationId === binding.apiOperationId);
  const supportingContentRoute = p2.ownerDefinedDevelopmentOnlyApiCandidate.excludedSupportingRoutes
    .find((record) => record.path === binding.contentRoute.slice("GET ".length));
  const operation = p1.ownerDefinedOperationContracts.records.find((record) => record.id === binding.operationRef);
  const action = actions.actions.find((record) => record.id === binding.actionRef);

  assert.equal(example.decisionRef, "PXD-253");
  assert.equal(example.status, "DEV_ONLY_SOURCE_FREE_SYNTHETIC_FIXTURE");
  assert.equal(example.fixtureLineage.outputDigest, "SHA-256 over the exact local GLB candidate bytes; integrity only, not an authoritative artifact receipt.");
  assert.equal(binding.decisionRef, "PXD-267");
  assert.equal(binding.actionRef, "media.action.inspect-output-preview-and-version");
  assert.equal(binding.operationRef, "media.operation.action.inspect-output-preview-and-version");
  assert.equal(binding.channelRef, "media.channel.web");
  assert.equal(binding.apiOperationId, "media.dev.http.getCreativeOutput");
  assert.equal(binding.metadataRoute, "GET /dev/v1/creative-outputs/{outputId}");
  assert.equal(binding.contentRoute, "GET /dev/v1/artifacts/{artifactId}/content");
  assert.match(binding.selector, /outputId returned by the same PXD-253 local GLB export/u);
  assert.match(binding.selector, /artifactId must equal that outputId/u);
  assert.match(binding.exactVersion, /immutable sha256 artifactVersionId/u);
  assert.match(binding.consumer, /^Verified GLB download\/readback/u);
  assert.equal(binding.productionEligible, false);
  assert.equal(binding.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(binding.journeyAcceptance, "OPEN");

  assert.equal(metadataTransport.method, "GET");
  assert.equal(metadataTransport.path, binding.metadataRoute.slice("GET ".length));
  assert.deepEqual(metadataTransport.routePermission, ["media:project:dev:read", "media:artifact:read"]);
  assert.equal(metadataTransport.pdp1SemanticRef, binding.operationRef);
  assert.equal(p2.ownerDefinedDevelopmentOnlyApiCandidate.routeSdkBindings.length, 7,
    "the J-13 readback does not add a PXD-232 route/SDK pair");
  assert.match(supportingContentRoute.disposition, /supporting exact-version byte-read/u);
  assert.equal(operation.operationKind, "QUERY");
  assert.deepEqual(operation.stateRefs, []);
  assert.equal(operation.sourceFinality, "read-only-or-navigation; no-write-finality");
  assert.equal(action.finality, "read-only-or-navigation; no-write-finality");
  assert.equal(p2.ownerDefinedDevelopmentOnlyApiCandidate.productionAdmission, "NOT_ADMITTED");

  assert.equal(scenario.developmentOnlyExample.supportedViewerParity, "NOT_ESTABLISHED");
  assert.equal(scenario.developmentOnlyExample.durableProjectJobLineage, "NOT_ESTABLISHED");
  assert.equal(scenario.developmentOnlyExample.authoritativeReceipt, "NOT_ESTABLISHED");
  assert.equal(scenario.developmentOnlyExample.rightsAndRuntimeAuthority, "NOT_ESTABLISHED");
  assert.equal(scenario.developmentOnlyExample.independentCoordinateQualification, "NOT_ESTABLISHED");
  assert.equal(scenario.developmentOnlyExample.productionEligible, false);
  assert.equal(experienceBinding.p0BindingSource,
    ".product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=J-13/developmentOnlyExample/verifiedDownloadReadbackBinding");
  assert.equal(experienceBinding.operationRef, binding.operationRef);
  assert.equal(experienceBinding.apiOperationId, binding.apiOperationId);
  assert.match(experienceBinding.scopeBoundary, /No GLB geometry rendering, scene viewing, viewer parity, or coordinate qualification/u);
  assert.equal(experienceBinding.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(experienceBinding.journeyAcceptance, "OPEN");

  assert.match(explorerClient, /getOutput: \(outputId\) => call\("GET", `\/dev\/v1\/creative-outputs\//u);
  assert.match(installedClient, /artifactId !== outputId/u);
  assert.match(installedClient, /artifactVersionId !== `sha256:\$\{sha256\}`/u);
  assert.match(installedClient, /headers: \{ Accept: artifact\.contentType, "If-Match": artifact\.artifactVersionId \}/u);
  assert.match(installedClient, /actualSha !== artifact\.sha256/u);
  assert.match(hostOutputRoute, /outputs\.reopen\(tenantId, principalId, pathSegment\(single\.group\(1\)\)\)/u);
  assert.match(hostOutputRoute, /not available in this tenant and owner scope/u);
  assert.match(hostContentRoute, /expectedVersion\(exchange, out\)/u);
  assert.match(hostContentRoute, /runtime\.copyArtifactContent\(tenantId, principalId, artifactId, expected\.get\(\)/u);
  assert.match(hostContentRoute, /no bytes were released/u);

  assert.match(browserTest, /getByRole\("button", \{ name: "Export GLB" \}\)/u);
  assert.match(browserTest, /assertVerifiedContent\(glbId, "glb", glbSha, "spatial GLB"\)/u);
  assert.match(browserTest, /readWithInstalledClient\(creativeOutputClient, glbId,[\s\S]{0,130}"SPATIAL_GLB_EXPORT", glbSha/u);
  assert.match(browserTest, /getByRole\("button", \{ name: "Reopen output from the host" \}\)/u);
  assert.match(browserTest, /await reopenById\(glbId, "SPATIAL_GLB_EXPORT"\)/u);
  assert.match(browserTest, /restartedGlbBytes,[\s\S]{0,100}installedClientBytes\.get\(glbId\)/u);
  assert.match(decisionLog, /### PXD-267 — Bind the DEV_ONLY J-13 exact GLB download\/readback/u);
  assert.match(decisionLog, /Do not add a route, dependency, or PXD-232 route\/SDK pair/u);
});
