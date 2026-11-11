import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appRoot = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, appRoot), "utf8");

test("DEV_ONLY page exposes the local project/timeline lifecycle and accessible credential controls", async () => {
  const html = await read("dev-project-timeline.html");
  const source = await read("src/dev-project-timeline.ts");
  const reactMount = await read("src/dev-project-timeline-react.tsx");
  const workspace = await read("../../libs/audio-video-ui/src/screens/DevProjectTimelineWorkspaceScreen.tsx");
  assert.match(html, /id="dev-token"[^>]*type="password"[^>]*autocomplete="off"/u);
  assert.match(html, /<link rel="stylesheet" href="\/src\/dev-project-timeline\.css"/u);
  assert.doesNotMatch(source, /dev-project-timeline\.css/u,
    "strict-CSP page styles must be loaded as an external stylesheet, not Vite-injected inline CSS");
  assert.match(html, /id="timeline-workspace-root"/u);
  assert.match(reactMount, /MediaProductRenderer/u);
  assert.match(reactMount, /kind:\s*"dev-project-timeline"/u);
  assert.match(source, /media-dev-project-timeline/u);
  const encodedIdPattern = workspace.match(/const ID_PATTERN = ("(?:[^"\\]|\\.)*");/u)?.[1];
  assert.ok(encodedIdPattern, "the timeline ID must retain its owner-defined form constraint");
  const idPattern = JSON.parse(encodedIdPattern);
  let timelineIdPattern;
  assert.doesNotThrow(() => { timelineIdPattern = new RegExp(`^(?:${idPattern})$`, "v"); },
    "the opaque timeline ID alphabet must be valid under the HTML pattern Unicode-sets grammar");
  for (const valid of ["main-cut", "a", "A_1", "namespace:revision.v2"]) {
    assert.equal(timelineIdPattern.test(valid), true, `the owner ID alphabet must accept ${valid}`);
  }
  for (const invalid of ["", "-leading", "contains/slash", "has space", "x".repeat(129)]) {
    assert.equal(timelineIdPattern.test(invalid), false, `the owner ID alphabet must reject ${invalid}`);
  }
  assert.match(workspace, /aria-live="polite"/u);
  for (const action of ["Read host context", "Create project", "Replay same create request"]) {
    assert.ok(html.includes(action), `missing host action: ${action}`);
  }
  for (const action of ["Create timeline", "Add scene", "Add track", "Remove scene", "Remove track", "Reopen current project", "Read exact revision", "Compare with displayed revision", "Restore as new project head"]) {
    assert.ok(workspace.includes(action), `missing reusable workspace action: ${action}`);
  }
  for (const method of ["getContext", "createProject", "getRevision"]) {
    assert.match(source, new RegExp(`\\.${method}\\(`, "u"), `missing host SDK call: ${method}`);
  }
  for (const method of ["getProject", "createTimeline", "editTimeline", "getRevision", "restoreRevision"]) {
    assert.match(workspace, new RegExp(`\\.${method}\\(`, "u"), `missing workspace SDK call: ${method}`);
  }
  assert.match(source, /selectedAuthorizedWorkspaceId:\s*context\.selectedAuthorizedWorkspaceId/u);
  assert.match(workspace, /expectedHeadRevisionId:\s*pending\.baseRevisionId/u);
  assert.match(source, /bearerToken:\s*\(\)\s*=>\s*bearerToken/u);
  assert.match(source, /bearerToken\s*=\s*null/u);
  assert.match(source, /const title = projectTitleInput\.value;/u);
  assert.match(source, /\[\.\.\.title\]\.length > 200/u);
  assert.doesNotMatch(html, /id="project-title"[^>]*maxlength=/u);
  assert.match(source, /let createAcknowledged = false;[\s\S]*?createAcknowledged = true;[\s\S]*?unresolvedProjectCreate = createAcknowledged \|\| \(error instanceof MediaDevProjectTimelineError/u);
  assert.match(source, /Project creation was acknowledged, but its exact initial revision could not be reopened/u);
  assert.match(source, /Replay the exact saved request before starting another create/u);
  assert.match(workspace, /kind:\s*"restore"[\s\S]*?OUTCOME_UNKNOWN/u);
  assert.match(workspace, /Reconcile timeline outcome/u);
  assert.match(workspace, /Scene ID .* still owns tracks[\s\S]*?no mutation was sent/u);
  assert.match(workspace, /Track ID .* still owns clips[\s\S]*?no mutation was sent/u);
  for (const label of ["Scene ID to remove", "Track ID to remove", "Remove scene", "Remove track"]) {
    assert.ok(workspace.includes(label), `missing workspace control label: ${label}`);
  }
  assert.match(workspace, /DEV_ONLY · NOT_ADMITTED/u);
  assert.match(workspace, /readbackRecord\?\.scopeKey === scopeKey/u);
});

test("DEV_ONLY browser transport is fixed to loopback Vite proxy and never persists its token", async () => {
  const vite = await read("vite.config.mjs");
  const source = await read("src/dev-project-timeline.ts");
  assert.match(vite, /host:\s*"127\.0\.0\.1"/u);
  assert.match(vite, /Number\(process\.env\.MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT \?\? "8093"\)/u);
  assert.match(vite, /target:\s*`http:\/\/127\.0\.0\.1:\$\{devProjectTimelineProxyPort\}`/u);
  assert.match(vite, /devProjectTimelineProxyPort < 1 \|\| devProjectTimelineProxyPort > 65535/u);
  assert.match(vite, /proxy\.on\("error"/u);
  assert.match(vite, /request\.method !== "POST" \|\| response\.destroyed \|\| response\.headersSent/u);
  assert.match(vite, /code:\s*"OUTCOME_UNKNOWN"/u);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/u);
  assert.doesNotMatch(source, /fetch\s*\(/u);
  assert.match(source, /baseUrl:\s*origin/u);
});
