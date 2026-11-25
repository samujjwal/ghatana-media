import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("project-list proxy accepts only the owner workspace and optional opaque cursor query", () => {
  for (const path of [
    "/dev/v1/projects?workspaceId=dev-workspace.abc123",
    "/dev/v1/projects?workspaceId=dev-workspace.abc123&pageToken=opaque.cursor-1",
    "/dev/v1/projects?pageToken=opaque%3Acursor&workspaceId=dev-workspace.abc123",
  ]) assert.equal(isAllowedDevProjectProxyRequest("GET", path), true, path);

  for (const [method, path] of [
    ["POST", "/dev/v1/projects?workspaceId=dev-workspace.abc123"],
    ["GET", "/dev/v1/projects"],
    ["GET", "/dev/v1/projects?workspaceId=dev-workspace.abc123&workspaceId=other"],
    ["GET", "/dev/v1/projects?workspaceId=dev-workspace.abc123&pageToken=one&pageToken=two"],
    ["GET", "/dev/v1/projects?tenantId=tenant-dev&workspaceId=dev-workspace.abc123"],
    ["GET", "/dev/v1/projects?workspaceId=dev-workspace.abc123&search=local"],
    ["GET", "/dev/v1/projects?workspaceId=bad%2Fworkspace"],
    ["GET", "/dev/v1/projects?workspaceId=dev-workspace.abc123&pageToken="],
    ["GET", "/dev/v1/projects?workspaceId=dev-workspace.abc123&pageToken=%ZZ"],
    ["GET", `/dev/v1/projects?workspaceId=dev-workspace.abc123&pageToken=${"a".repeat(8192)}`],
  ]) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
});

test("Find projects keeps search local and selects through the exact owner-scoped read", async () => {
  const [html, source] = await Promise.all([read("dev-project-timeline.html"), read("src/dev-project-timeline.ts")]);
  assert.match(html, /<h2 id="find-projects-heading">Find projects<\/h2>/u);
  assert.match(html, /<label for="project-search">Search projects<\/label>/u);
  assert.match(html, /never sent as a server query/u);
  assert.match(source, /client\.listProjects\(context\.selectedAuthorizedWorkspaceId, pageToken\)/u);
  assert.match(source, /Snapshot observed at \$\{projectListObservedAt\}; this is not a live currentness guarantee/u);
  assert.match(source, /Previously observed snapshot from \$\{projectListObservedAt\} remains displayed and is not current/u);
  assert.match(source, /if \(generation !== projectListGeneration\) return;/u);
  assert.match(source, /function clearObservedProjectList\(statusMessage: string\): void/u);
  assert.match(source, /More pages may contain a match/u);
  assert.match(source, /No matches in this observed snapshot/u);
  assert.match(source, /Head \$\{project\.headRevisionId\}/u);
  assert.match(source, /openExistingProject\(client, context, projectId\)/u);
  assert.match(source, /select\.addEventListener\("click", \(\) => \{ void openProjectFromOwnerScope\(project\.projectId, project\.headRevisionId\); \}\)/u);
  assert.match(source, /currentRevision\.revisionId === observedHeadRevisionId/u);
  assert.match(source, /observed snapshot version \$\{observedHeadRevisionId\} is no longer current/u);
  assert.doesNotMatch(source, /listProjects\([^\n]*search/u);
});
