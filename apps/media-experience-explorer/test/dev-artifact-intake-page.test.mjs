import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { artifactProxyGuard, isAllowedArtifactProxyRequest, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const appRoot = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, appRoot), "utf8");

test("local artifact intake page uses accessible public screens and a persistent DEV_ONLY notice", async () => {
  const html = await read("dev-artifact-intake.html");
  const source = await read("src/dev-artifact-intake.tsx");
  const intakeScreen = await read("../../libs/audio-video-ui/src/screens/ArtifactIntakeScreen.tsx");
  const inspectionScreen = await read("../../libs/audio-video-ui/src/screens/ArtifactInspectionScreen.tsx");
  const css = await read("src/dev-artifact-intake.css");
  assert.match(html, /<link rel="stylesheet" href="\/src\/dev-artifact-intake\.css"/u);
  assert.match(html, /DEV_ONLY · local storage/u);
  assert.match(html, /grant no rights, consent/u);
  assert.match(html, /Short-lived DEV_ONLY bearer token/u);
  assert.match(html, /<form id="connect-form" class="connect-form" method="post">/u);
  assert.match(html, /<input id="dev-token" type="password"/u);
  assert.doesNotMatch(html, /id="dev-token"[^>]*\sname=/u);
  assert.match(html, /Source classification/u);
  assert.match(html, /Storage retention/u);
  assert.match(html, /<option value="" selected disabled>Select a classification<\/option>/u);
  assert.match(html, /<option value="" selected disabled>Select a retention period<\/option>/u);
  assert.match(html, /value="P3650D"/u);
  assert.doesNotMatch(html, /<input id="retention"/u);
  assert.match(html, /id="disconnect-notice"/u);
  assert.match(html, /id="metadata-status"/u);
  assert.match(html, /id="artifact-id"/u);
  assert.match(html, /id="upload-result" role="status" aria-live="polite"/u);
  assert.match(html, /id="inspection-mount"/u);
  assert.match(source, /ArtifactIntakeScreen/u);
  assert.match(source, /ArtifactInspectionScreen/u);
  assert.match(source, /artifact inspection remains NOT_ADMITTED without a reviewed operation binding/u);
  assert.match(intakeScreen, /onArtifactCompleted\?: \(artifact: CanonicalMediaArtifactObservation\)/u);
  assert.match(intakeScreen, /label="Choose source media"/u);
  assert.match(intakeScreen, /Upload selected source/u);
  assert.match(inspectionScreen, /Refresh artifact metadata/u);
  assert.match(source, /onArtifactCompleted=\{handleArtifactCompleted\}/u);
  assert.match(source, /onUploadStateChange=\{handleUploadStateChange\}/u);
  assert.match(source, /currentStepId: "artifact-intake"/u);
  assert.match(source, /steps: \[\{ id: "artifact-intake"/u);
  assert.match(source, /CLASSIFICATIONS\.has\(classification\) && RETENTION_PERIODS\.has\(retention\)/u);
  assert.match(source, /uploadAllowed && metadataSelected/u);
  assert.match(source, /An upload request is pending/u);
  assert.match(source, /next === "reconciliation-required"/u);
  assert.match(source, /window\.addEventListener\("beforeunload"/u);
  assert.match(source, /event\.preventDefault\(\)/u);
  assert.match(intakeScreen, /onUploadStateChange\?: \(state: ArtifactUploadHostState\)/u);
  assert.match(source, /artifactIdInput\.value = artifact\.artifactId/u);
  assert.match(source, /capabilities\.artifactUpload === true/u);
  assert.match(source, /capabilities\.artifactRead === true/u);
  assert.match(source, /await hostClient\.getArtifactUploadPolicy\(\)/u);
  assert.match(source, /maxChunkBytes: verifiedUploadPolicy!\.maxChunkBytes/u);
  assert.match(source, /uploadCapability=\{uploadCapability\}/u);
  assert.match(source, /canonicalArtifactReadClient=\{readClient\}/u);
  assert.match(source, /classification,\s*retention/u);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie/u);
  assert.match(source, /baseUrl:\s*origin/u);
  assert.match(source, /getAccessToken:\s*\(\)\s*=>\s*bearerToken/u);
  assert.match(css, /^@import "@audio-video\/ui\/styles\.css";/u);
});

test("artifact Vite proxy is loopback only and marks POST/PUT transport failure unknown", async () => {
  const vite = await read("vite.config.mjs");
  const packageJson = JSON.parse(await read("package.json"));
  assert.match(vite, /"\/api\/v1\/artifacts"\s*:/u);
  assert.match(vite, /target:\s*`http:\/\/127\.0\.0\.1:\$\{devProjectTimelineProxyPort\}`/u);
  assert.match(vite, /Number\(process\.env\.MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT \?\? "8093"\)/u);
  assert.match(vite, /optimizeDeps:\s*\{\s*include:\s*\["@noble\/hashes\/sha2\.js"\]\s*\}/u,
    "the browser SHA-256 dependency must be optimized before the host begins serving its module graph");
  assert.match(vite, /artifactProxyGuardPlugin\(\)/u);
  assert.match(vite, /server\.middlewares\.use\(artifactProxyGuard\)/u);
  assert.match(vite, /request\.method !== "POST" && request\.method !== "PUT"/u);
  assert.match(vite, /code:\s*"OUTCOME_UNKNOWN"/u);
  assert.match(vite, /changeOrigin:\s*false/u);
  assert.equal(packageJson.dependencies["lucide-react"], "catalog:shared",
    "the Vite alias target must be installed as a direct Explorer dependency");
  assert.match(vite, /"lucide-react": resolve\(appRoot, "node_modules\/lucide-react"\)/u);
});

test("artifact proxy guard admits exact canonical upload operations and artifact metadata reads", () => {
  const id = "d2af7b9b-5038-4b48-9d45-4f7a1c25d43e";
  const allowed = [
    ["POST", "/api/v1/artifacts/uploads"],
    ["GET", `/api/v1/artifacts/${id}`],
    ["GET", `/api/v1/artifacts/uploads/${id}`],
    ["PUT", `/api/v1/artifacts/uploads/${id}/chunks/0`],
    ["PUT", `/api/v1/artifacts/uploads/${id}/chunks/2147483647`],
    ["POST", `/api/v1/artifacts/uploads/${id}/complete`],
  ];
  for (const [method, path] of allowed) assert.equal(isAllowedArtifactProxyRequest(method, path), true, `${method} ${path}`);

  const rejected = [
    ["PATCH", "/api/v1/artifacts/uploads"],
    ["POST", `/api/v1/artifacts/${id}`],
    ["PUT", `/api/v1/artifacts/${id}`],
    ["GET", "/api/v1/artifacts/not-a-uuid"],
    ["GET", `/api/v1/artifacts/${id}%2fmetadata`],
    ["GET", `/api/v1/artifacts/${id}/metadata`],
    ["GET", `/api/v1/artifacts/${id}?include=bytes`],
    ["GET", "/api/v1/artifacts/../uploads"],
    ["GET", "/api/v1/artifacts/uploads"],
    ["POST", `/api/v1/artifacts/uploads/${id}`],
    ["GET", `/api/v1/artifacts/uploads/${id}/complete`],
    ["POST", `/api/v1/artifacts/uploads/${id}/complete/extra`],
    ["PUT", `/api/v1/artifacts/uploads/${id}/chunks/01`],
    ["PUT", `/api/v1/artifacts/uploads/${id}/chunks/2147483648`],
    ["GET", "/api/v1/artifacts/uploads/not-a-uuid"],
    ["GET", `/api/v1/artifacts/uploads/${id}%2fcomplete`],
    ["GET", `/api/v1/artifacts/uploads/${id}%5c..%5csecret`],
    ["GET", `/api/v1/artifacts/uploads/../${id}`],
    ["GET", `/api/v1/artifacts/uploads/${id}?anything=1`],
    ["POST", "/api/v1/artifacts/uploads/"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedArtifactProxyRequest(method, path), false, `${method} ${path}`);

  let calledNext = false;
  const rejectedResponse = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  artifactProxyGuard({ method: "GET", url: `/api/v1/artifacts/uploads/${id}/complete` }, rejectedResponse, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(rejectedResponse.statusCode, 404);
  assert.equal(rejectedResponse.headers["Cache-Control"], "no-store");
  const acceptedResponse = { setHeader() {}, end() {} };
  artifactProxyGuard({ method: "GET", url: `/api/v1/artifacts/uploads/${id}` }, acceptedResponse, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test("DEV_ONLY project proxy admits only exact context, policy, project, timeline edit, restore, and revision routes", () => {
  const project = "project-1:local";
  const revision = "revision-2";
  const allowed = [
    ["GET", "/dev/v1/context"],
    ["GET", "/dev/v1/artifact-upload-policy"],
    ["POST", "/dev/v1/projects"],
    ["GET", `/dev/v1/projects/${project}`],
    ["POST", `/dev/v1/projects/${project}/timelines`],
    ["POST", `/dev/v1/projects/${project}/timelines/timeline-main/edits`],
    ["POST", "/dev/v1/projects/project:local/timelines/timeline:main/edits"],
    ["POST", `/dev/v1/projects/${project}/restore`],
    ["GET", `/dev/v1/projects/${project}/revisions/${revision}`],
  ];
  for (const [method, path] of allowed) assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);

  const rejected = [
    ["POST", "/dev/v1/context"],
    ["PUT", "/dev/v1/artifact-upload-policy"],
    ["GET", "/dev/v1/artifact-upload-policy/"],
    ["GET", "/dev/v1/other"],
    ["PATCH", `/dev/v1/projects/${project}`],
    ["DELETE", `/dev/v1/projects/${project}`],
    ["GET", `/dev/v1/projects/${project}/timelines`],
    ["POST", `/dev/v1/projects/${project}/revisions/${revision}`],
    ["PUT", `/dev/v1/projects/${project}/timelines/timeline-main/edits`],
    ["POST", `/dev/v1/projects/${project}/timelines/timeline-main/edits/extra`],
    ["PUT", `/dev/v1/projects/${project}/restore`],
    ["POST", `/dev/v1/projects/${project}/restore/extra`],
    ["GET", "/dev/v1/projects/bad%2fpath"],
    ["GET", "/dev/v1/projects/../context"],
    ["GET", "/dev/v1/projects/project-1?include=private"],
    ["GET", "/dev/v1/projects/project-1/revisions/revision-2/extra"],
    ["GET", "/dev/v1/projects/project-1//revisions/revision-2"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);

  let calledNext = false;
  const rejectedResponse = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  artifactProxyGuard({ method: "GET", url: "/dev/v1/unlisted" }, rejectedResponse, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(rejectedResponse.statusCode, 404);
  assert.equal(rejectedResponse.headers["Cache-Control"], "no-store");
});
