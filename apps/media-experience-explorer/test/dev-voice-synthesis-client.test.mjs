import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const sourcePath = resolve(import.meta.dirname, "../src/dev-voice-synthesis-client.ts");
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$/u;

class FakeVoiceError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

class FakeTimelineError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function loadClient(targetFailure, requests) {
  let failed = false;
  const failOnce = (operation) => {
    if (!failed && targetFailure === operation) {
      failed = true;
      throw new FakeTimelineError("OUTCOME_UNKNOWN", 0, "The host committed but the response was lost.");
    }
  };
  class FakeTimelineClient {
    constructor() {}
    async getContext() {
      return { selectedAuthorizedWorkspaceId: "workspace-1" };
    }
    async createProject(request) {
      requests.createProject.push({ ...request });
      failOnce("createProject");
      return { project: { projectId: "project-1" }, initialRevision: { revisionId: "revision-0" } };
    }
    async createTimeline(projectId, request) {
      requests.createTimeline.push({ projectId, ...request });
      failOnce("createTimeline");
      return { revision: { revisionId: "revision-1" } };
    }
    async editTimeline(projectId, timelineId, request) {
      requests.editTimeline.push({ projectId, timelineId, ...request });
      failOnce("editTimeline");
      return { revision: { revisionId: "revision-2" } };
    }
    async getProject(projectId) {
      return {
        project: { projectId },
        currentRevision: { revisionId: "revision-2", timelines: [] },
      };
    }
  }

  const output = ts.transpileModule(await readFile(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const sandbox = {
    exports: {},
    require(specifier) {
      if (specifier === "@audio-video/ui/screens") return { DevVoiceHostError: FakeVoiceError };
      if (specifier === "@audio-video/client/dev-project-timeline") {
        return { MediaDevProjectTimelineClient: FakeTimelineClient, MediaDevProjectTimelineError: FakeTimelineError };
      }
      if (specifier === "./dev-artifact-content-client") return { createDevArtifactContentClient: () => ({}) };
      throw new Error(`Unexpected dependency ${specifier}`);
    },
    crypto: globalThis.crypto,
    TextEncoder,
    Uint8Array,
  };
  vm.runInNewContext(output, sandbox, { filename: sourcePath });
  return sandbox.exports.createDevVoiceSynthesisClient;
}

test("timeline mutation retries replay bounded request ids after ambiguous responses", async () => {
  for (const targetFailure of ["createProject", "createTimeline", "editTimeline"]) {
    const requests = { createProject: [], createTimeline: [], editTimeline: [] };
    const createClient = await loadClient(targetFailure, requests);
    const client = createClient({
      origin: "http://127.0.0.1:4173",
      bearerToken: () => "dev-token",
      fetch: async () => { throw new Error("Unexpected direct HTTP request in timeline fixture"); },
    });
    const request = {
      clipId: "voice-synthesis-request-1",
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      sha256: "a".repeat(64),
      durationMillis: 1000,
      sampleRate: 48000,
    };

    await assert.rejects(client.addToTimeline(request), (error) => error.code === "OUTCOME_UNKNOWN");
    const placement = await client.addToTimeline(request);
    assert.equal(placement.clipId, request.clipId);

    const repeatedIds = [
      requests.createProject.map(({ requestId }) => requestId),
      requests.createTimeline.map(({ requestId }) => requestId),
      requests.editTimeline.map(({ requestId }) => requestId),
    ];
    for (const ids of repeatedIds) {
      for (const requestId of ids) {
        assert.ok(REQUEST_ID.test(requestId), `valid bounded requestId: ${requestId}`);
        assert.ok(requestId.length <= 128);
      }
      if (ids.length > 1) assert.equal(new Set(ids).size, 1, `${targetFailure} retry reuses the same requestId`);
    }

    const firstEditId = requests.editTimeline[0]?.requestId;
    await client.addToTimeline({ ...request, clipId: "voice-synthesis-request-2" });
    assert.notEqual(requests.editTimeline.at(-1)?.requestId, firstEditId, "a different synthesis clip gets its own edit key");
  }
});
