import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = async (path) => parse(await readFile(path, "utf8"));

const [p0, p1, p2, p3, actions, explorerClient, contentClient, panel, serverRoute, browserTest, liveTest, decisionLog] = await Promise.all([
  readYaml(".product-experience/pdp-0-product-truth/journey-catalog.yaml"),
  readYaml(".product-experience/pdp-1-domain-data/operations.yaml"),
  readYaml(".product-experience/pdp-2-design-interface-system/api/conventions.yaml"),
  readYaml(".product-experience/pdp-3-product-experience/declarative-production-experience.yaml"),
  readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml"),
  readFile("apps/media-experience-explorer/src/dev-animation-client.ts", "utf8"),
  readFile("apps/media-experience-explorer/src/dev-artifact-content-client.ts", "utf8"),
  readFile("libs/audio-video-ui/src/screens/DevAnimationPanel.tsx", "utf8"),
  readFile("launcher/src/main/java/com/ghatana/media/launcher/MediaDevArtifactContentRoutes.java", "utf8"),
  readFile("apps/media-experience-explorer/test/dev-animation-live-browser.mjs", "utf8"),
  readFile("integration-tests/src/test/java/com/ghatana/media/integration/MediaDevExplorerAnimationLiveIT.java", "utf8"),
  readFile(".product-experience/decision-log.md", "utf8"),
]);

test("J-12 binds only exact-version DEV_ONLY animation preview readback", () => {
  const journey = p0.journeys.find((record) => record.id === "J-12");
  const binding = journey.developmentOnlyExample.previewReadbackActionBinding;
  const supportingRoute = p2.ownerDefinedDevelopmentOnlyApiCandidate.excludedSupportingRoutes
    .find((record) => record.path === binding.path);
  const routeBinding = supportingRoute.ownerDefinedConsumerBindings.find((record) => record.id === "media.dev.http-support.j12-animation-preview.v1");
  const scenario = p3.caseExperiences.find((record) => record.pdp0CaseId === "MEDIA-DECL-P0-AC-002");
  const experienceBinding = scenario.developmentOnlyExample.previewReadbackActionBinding;
  const action = actions.actions.find((record) => record.id === binding.actionRef);
  const operation = p1.ownerDefinedOperationContracts.records.find((record) => record.id === binding.operationRef);

  assert.equal(binding.decisionRef, "PXD-265");
  assert.equal(binding.actionRef, "media.action.inspect-output-preview-and-version");
  assert.equal(binding.operationRef, "media.operation.action.inspect-output-preview-and-version");
  assert.equal(binding.channelRef, "media.channel.web");
  assert.equal(binding.method, "GET");
  assert.equal(binding.path, "/dev/v1/artifacts/{artifactId}/content");
  assert.match(binding.exactVersionBinding, /If-Match/u);
  assert.equal(binding.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(binding.journeyAcceptance, "OPEN");

  assert.equal(p2.ownerDefinedDevelopmentOnlyApiCandidate.routeSdkBindings.length, 7);
  assert.match(supportingRoute.disposition, /not one of PXD-232's seven operations/u);
  assert.equal(routeBinding.method, binding.method);
  assert.equal(routeBinding.path, binding.path);
  assert.equal(routeBinding.actionRef, binding.actionRef);
  assert.equal(routeBinding.operationRef, binding.operationRef);
  assert.equal(routeBinding.request.ifMatch, "exact sha256 artifactVersionId returned by the same render");
  assert.match(routeBinding.response.consumerVerification, /SHA-256/u);
  assert.equal(routeBinding.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(operation.operationKind, "QUERY");
  assert.equal(operation.actionRef, binding.actionRef);
  assert.ok(operation.domainObjectRefs.includes("media.domain.artifact-version"));
  assert.equal(action.finality, "read-only-or-navigation; no-write-finality");

  assert.equal(experienceBinding.decisionRef, binding.decisionRef);
  assert.equal(experienceBinding.actionRef, binding.actionRef);
  assert.equal(experienceBinding.operationRef, binding.operationRef);
  assert.equal(experienceBinding.p2TransportSource, binding.transportSource);
  assert.equal(experienceBinding.exactVersion, "If-Match=registered video artifactVersionId from the same render response");
  assert.match(experienceBinding.explorerAction, /Load the video/u);
  assert.equal(experienceBinding.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(experienceBinding.journeyAcceptance, "OPEN");
  assert.equal(scenario.developmentOnlyExample.sourceRightsAuthority, "SYNTHETIC_TEST_ATTESTATION_ONLY");
  assert.equal(scenario.developmentOnlyExample.productionRendererQualification, "NOT_ESTABLISHED");

  assert.match(explorerClient, /readArtifactContent: createDevArtifactContentClient\(options\)/u);
  assert.match(contentClient, /\/dev\/v1\/artifacts\/\$\{encodeURIComponent\(artifactId\)\}\/content/u);
  assert.match(contentClient, /"If-Match": artifactVersionId/u);
  assert.match(panel, /Load the video \(verify bytes first\)/u);
  assert.match(panel, /readVerifiedContent\(\{ readArtifactContent: reader \}, video\)/u);
  assert.match(panel, /URL\.createObjectURL/u);
  assert.match(serverRoute, /hasDevOnlyPermission\(exchange, "media:artifact:read"\)/u);
  assert.match(serverRoute, /An explicit expected version/u);
  assert.match(serverRoute, /The artifact's immutable version does not match/u);
  assert.match(serverRoute, /no bytes were released/u);
  assert.match(browserTest, /Load the video/u);
  assert.match(browserTest, /Bytes verified against the registered version/u);
  assert.match(liveTest, /MediaDevExplorerAnimationLiveIT/u);
  assert.match(decisionLog, /### PXD-265 — Bind the DEV_ONLY J-12 exact-version animation preview read/u);
  assert.match(decisionLog, /outside PXD-232's seven selected route\/SDK operation pairs/u);
});
