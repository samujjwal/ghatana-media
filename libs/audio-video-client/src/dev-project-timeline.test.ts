import { describe, expect, it, vi } from "vitest";
import {
  MediaDevProjectTimelineClient,
  MediaDevProjectTimelineError,
} from "./dev-project-timeline.js";

const context = {
  tenantId: "tenant-dev",
  principalId: "principal-dev",
  selectedAuthorizedWorkspaceId: "dev-workspace.abc123",
  workspaceName: "Private DEV_ONLY workspace",
  authority: "synthetic-local-owner-scope; no Shared membership or production authority",
  capabilities: { artifactUpload: false, artifactRead: false },
  scope: "DEV_ONLY",
};

const artifactUploadPolicy = {
  schemaVersion: "media.dev.artifact-upload-policy.v1",
  scope: "DEV_ONLY",
  maxChunkBytes: 4 * 1024 * 1024,
};

const initialRevision = {
  tenantId: "tenant-dev",
  projectId: "project-1",
  revisionId: "revision-1",
  parentRevisionId: null,
  timelines: [],
};

const project = {
  tenantId: "tenant-dev",
  projectId: "project-1",
  workspaceId: context.selectedAuthorizedWorkspaceId,
  ownerPrincipalId: "principal-dev",
  title: "Local edit",
  headRevisionId: "revision-1",
};

const clip = {
  clipId: "clip-main",
  sceneId: "scene-main",
  trackId: "video-main",
  source: { artifactId: "artifact-main", artifactVersionId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  sourceIn: { ticks: "9007199254740993", rateNumerator: "30000", rateDenominator: "1001", clock: "SOURCE_PRESENTATION" as const },
  sourceOut: { ticks: "9007199254743993", rateNumerator: "30000", rateDenominator: "1001", clock: "SOURCE_PRESENTATION" as const },
  storyStart: { ticks: "0", rateNumerator: "24", rateDenominator: "1", clock: "STORY" as const },
  storyDuration: { ticks: "240", rateNumerator: "24", rateDenominator: "1", clock: "STORY" as const },
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("Media DEV_ONLY project timeline client", () => {
  it.each([
    "https://media.example",
    "http://user:password@127.0.0.1:8093",
    "http://127.0.0.1:8093/api/v1",
    "file:///tmp/media",
  ])("refuses to send the token to non-loopback or ambiguous origin %s", (baseUrl) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() => new MediaDevProjectTimelineClient({ baseUrl, bearerToken: "secret-token", fetch: fetcher }))
      .toThrowError(MediaDevProjectTimelineError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reads only a DEV_ONLY host context and sends credentials to loopback with safe fetch settings", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(context));
    const client = new MediaDevProjectTimelineClient({
      baseUrl: "http://127.0.0.1:8093",
      bearerToken: () => "signed-dev-token",
      fetch: fetcher,
    });
    await expect(client.getContext()).resolves.toEqual(context);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8093/dev/v1/context");
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", cache: "no-store" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer signed-dev-token");
  });

  it("reads the strict DEV_ONLY artifact upload policy from the exact host route", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(artifactUploadPolicy));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });
    await expect(client.getArtifactUploadPolicy()).resolves.toEqual(artifactUploadPolicy);
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8093/dev/v1/artifact-upload-policy");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", cache: "no-store" });
  });

  it("reads an exact principal-owned artifact and derives its immutable sha256 version", async () => {
    const digest = "a".repeat(64);
    const readableContext = { ...context, capabilities: { artifactUpload: false, artifactRead: true } };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(readableContext))
      .mockResolvedValueOnce(jsonResponse({
        tenantId: context.tenantId, principalId: context.principalId, artifactId: "artifact-main",
        fileName: "source.mov", contentType: "video/quicktime", sha256: digest,
      }));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });

    await expect(client.getOwnedArtifact("artifact-main")).resolves.toMatchObject({
      tenantId: context.tenantId, principalId: context.principalId, artifactId: "artifact-main",
      artifactVersionId: `sha256:${digest}`,
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:8093/dev/v1/context",
      "http://127.0.0.1:8093/api/v1/artifacts/artifact-main",
    ]);
  });

  it("does not inspect an artifact when the host denies DEV_ONLY artifact read capability", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(context));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });
    await expect(client.getOwnedArtifact("artifact-main")).rejects.toMatchObject({
      code: "ARTIFACT_READ_PERMISSION_REQUIRED", status: 403,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8093/dev/v1/context");
  });

  it.each([
    { ...artifactUploadPolicy, scope: "PRODUCTION" },
    { ...artifactUploadPolicy, maxChunkBytes: 0 },
    { ...artifactUploadPolicy, maxChunkBytes: 1.5 },
    { ...artifactUploadPolicy, maxChunkBytes: 32 * 1024 * 1024 + 1 },
    { ...artifactUploadPolicy, unexpected: true },
  ])("rejects malformed or out-of-scope upload policies %o", async (policy) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(policy));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });
    await expect(client.getArtifactUploadPolicy()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([
    [{ artifactUpload: true, artifactRead: true }, { artifactUpload: true, artifactRead: true }],
    [{ artifactUpload: false, artifactRead: true }, { artifactUpload: false, artifactRead: true }],
    [{ artifactUpload: false, artifactRead: false }, { artifactUpload: false, artifactRead: false }],
  ])("validates and returns host-projected artifact capabilities %o", async (capabilities, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ...context, capabilities }));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });
    await expect(client.getContext()).resolves.toMatchObject({ capabilities: expected });
  });

  it.each([
    undefined,
    {},
    { artifactUpload: true },
    { artifactUpload: "true", artifactRead: false },
  ])("rejects malformed capability projections %o", async (capabilities) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ...context, capabilities }));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });
    await expect(client.getContext()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("creates an empty project using the host-selected DEV_ONLY workspace and stable request id", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      project,
      initialRevision,
      createdNow: true,
      scope: "DEV_ONLY",
    }, 201));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://localhost:8093", bearerToken: "token", fetch: fetcher });
    await expect(client.createProject({
      selectedAuthorizedWorkspaceId: context.selectedAuthorizedWorkspaceId,
      title: "Local edit",
      requestId: "create-1",
    })).resolves.toMatchObject({ createdNow: true, initialRevision: { timelines: [] }, scope: "DEV_ONLY" });
    expect(fetcher.mock.calls[0]![1]?.body).toBe(JSON.stringify({
      selectedAuthorizedWorkspaceId: context.selectedAuthorizedWorkspaceId,
      title: "Local edit",
      requestId: "create-1",
    }));
  });

  it("rejects a project create response whose initial revision is not empty", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      project,
      initialRevision: {
        ...initialRevision,
        timelines: [{ semanticVersionId: "unexpected", graph: { timelineId: "unexpected", scenes: [], tracks: [], clips: [] } }],
      },
      createdNow: true,
      scope: "DEV_ONLY",
    }, 201));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });
    await expect(client.createProject({
      selectedAuthorizedWorkspaceId: context.selectedAuthorizedWorkspaceId,
      title: "Local edit",
      requestId: "create-1",
    })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("reopens the exact current and historical revisions and creates an empty timeline snapshot", async () => {
    const timelineRevision = {
      tenantId: project.tenantId,
      projectId: project.projectId,
      revisionId: "revision-2",
      parentRevisionId: "revision-1",
      timelines: [{
        semanticVersionId: "timeline-version-1",
        graph: { timelineId: "timeline-main", scenes: [], tracks: [], clips: [] },
      }],
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ project, currentRevision: initialRevision, scope: "DEV_ONLY" }))
      .mockResolvedValueOnce(jsonResponse({ revision: initialRevision, scope: "DEV_ONLY" }))
      .mockResolvedValueOnce(jsonResponse({ revision: timelineRevision, scope: "DEV_ONLY" }, 201));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });

    await expect(client.getProject("project-1")).resolves.toMatchObject({
      project: { headRevisionId: "revision-1" }, currentRevision: { revisionId: "revision-1" }, scope: "DEV_ONLY",
    });
    await expect(client.getRevision("project-1", "revision-1")).resolves.toMatchObject({
      revision: { timelines: [] }, scope: "DEV_ONLY",
    });
    await expect(client.createTimeline("project-1", {
      expectedHeadRevisionId: "revision-1",
      timelineId: "timeline-main",
    })).resolves.toMatchObject({ revision: { revisionId: "revision-2" }, scope: "DEV_ONLY" });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:8093/dev/v1/projects/project-1",
      "http://127.0.0.1:8093/dev/v1/projects/project-1/revisions/revision-1",
      "http://127.0.0.1:8093/dev/v1/projects/project-1/timelines",
    ]);
  });

  it("commits typed scene and track edits from one exact project head", async () => {
    const editedRevision = {
      tenantId: project.tenantId,
      projectId: project.projectId,
      revisionId: "revision-3",
      parentRevisionId: "revision-2",
      timelines: [{
        semanticVersionId: "timeline-version-2",
        graph: {
          timelineId: "timeline-main",
          scenes: [{ sceneId: "scene-main", order: 0 }],
          tracks: [{ trackId: "video-main", sceneId: "scene-main", kind: "VIDEO", order: 0 }],
          clips: [],
        },
      }],
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      revision: editedRevision,
      scope: "DEV_ONLY",
    }, 201));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });
    const request = {
      expectedHeadRevisionId: "revision-2",
      edits: [
        { type: "addScene" as const, sceneId: "scene-main", order: 0 },
        { type: "addTrack" as const, trackId: "video-main", sceneId: "scene-main", trackKind: "VIDEO" as const, order: 0 },
      ],
    };
    await expect(client.editTimeline("project-1", "timeline-main", request)).resolves.toMatchObject({
      scope: "DEV_ONLY",
      revision: { revisionId: "revision-3", parentRevisionId: "revision-2" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe("http://127.0.0.1:8093/dev/v1/projects/project-1/timelines/timeline-main/edits");
    expect(fetcher.mock.calls[0]![1]?.body).toBe(JSON.stringify(request));
  });

  it("commits track and scene removals through the same exact-head edit route", async () => {
    const request = {
      expectedHeadRevisionId: "revision-with-graph",
      edits: [
        { type: "removeTrack" as const, trackId: "video-main" },
        { type: "removeScene" as const, sceneId: "scene-main" },
      ],
    };
    const revision = {
      tenantId: project.tenantId,
      projectId: project.projectId,
      revisionId: "revision-empty",
      parentRevisionId: request.expectedHeadRevisionId,
      timelines: [{
        semanticVersionId: "timeline-version-empty",
        graph: { timelineId: "timeline-main", scenes: [], tracks: [], clips: [] },
      }],
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      scope: "DEV_ONLY",
      revision,
    }, 201));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });

    await expect(client.editTimeline("project-1", "timeline-main", request)).resolves.toMatchObject({
      scope: "DEV_ONLY",
      revision: { revisionId: "revision-empty", parentRevisionId: "revision-with-graph" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:8093/dev/v1/projects/project-1/timelines/timeline-main/edits",
    );
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(request));
  });

  it("commits and removes an exact-version clip with lossless rational wire values", async () => {
    const revision = {
      tenantId: project.tenantId,
      projectId: project.projectId,
      revisionId: "revision-clip",
      parentRevisionId: "revision-head",
      timelines: [{
        semanticVersionId: "timeline-version-clip",
        graph: {
          timelineId: "timeline-main",
          scenes: [{ sceneId: "scene-main", order: 0 }],
          tracks: [{ trackId: "video-main", sceneId: "scene-main", kind: "VIDEO", order: 0 }],
          clips: [clip],
        },
      }],
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ scope: "DEV_ONLY", revision }, 201));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });
    const request = { expectedHeadRevisionId: "revision-head", edits: [{ type: "putClip" as const, clip }] };

    await expect(client.editTimeline("project-1", "timeline-main", request)).resolves.toMatchObject({
      revision: { timelines: [{ graph: { clips: [{ clipId: "clip-main", sourceIn: { ticks: "9007199254740993" } }] } }] },
    });
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(request));
  });

  it("confirms a removeClip edit leaves the stable clip identity absent", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ scope: "DEV_ONLY", revision: {
      tenantId: project.tenantId, projectId: project.projectId, revisionId: "revision-removed",
      parentRevisionId: "revision-with-clip", timelines: [{ semanticVersionId: "timeline-version-removed", graph: {
        timelineId: "timeline-main", scenes: [{ sceneId: "scene-main", order: 0 }],
        tracks: [{ trackId: "video-main", sceneId: "scene-main", kind: "VIDEO", order: 0 }], clips: [],
      } }],
    } }, 201));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });
    await expect(client.editTimeline("project-1", "timeline-main", {
      expectedHeadRevisionId: "revision-with-clip", edits: [{ type: "removeClip", clipId: "clip-main" }],
    })).resolves.toMatchObject({ revision: { revisionId: "revision-removed" } });
  });

  it("keeps valid colon-bearing opaque IDs canonical for the loopback proxy", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      scope: "DEV_ONLY",
      revision: {
        tenantId: project.tenantId,
        projectId: "project:local",
        revisionId: "revision-next",
        parentRevisionId: "revision-head",
        timelines: [{
          semanticVersionId: "timeline-version-next",
          graph: { timelineId: "timeline:main", scenes: [], tracks: [], clips: [] },
        }],
      },
    }, 201));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });
    await client.editTimeline("project:local", "timeline:main", {
      expectedHeadRevisionId: "revision-head",
      edits: [{ type: "addScene", sceneId: "scene-main", order: 0 }],
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:8093/dev/v1/projects/project:local/timelines/timeline:main/edits",
    );
  });

  it.each([
    { edits: [] },
    { edits: [{ type: "addScene", sceneId: "scene-1", order: -1 }] },
    { edits: [{ type: "addTrack", trackId: "track-1", sceneId: "scene-1", trackKind: "UNKNOWN", order: 0 }] },
    { edits: [{ type: "addScene", sceneId: "scene-1", order: 0, arbitrary: true }] },
    { edits: [{ type: "removeTrack", trackId: "track-1", arbitrary: true }] },
    { edits: [{ type: "putClip", clip: { ...clip, extra: true } }] },
    { edits: [{ type: "putClip", clip: { ...clip, sourceIn: { ...clip.sourceIn, clock: "STORY" } } }] },
    { edits: [{ type: "removeClip", clipId: "clip-1", arbitrary: true }] },
  ])("rejects malformed timeline edits before dispatch (%j)", async (override) => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });
    await expect(client.editTimeline("project-1", "timeline-main", {
      expectedHeadRevisionId: "revision-2",
      ...override,
    } as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a clip response that changes its immutable source version", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ scope: "DEV_ONLY", revision: {
      tenantId: project.tenantId, projectId: project.projectId, revisionId: "revision-clip",
      parentRevisionId: "revision-head", timelines: [{ semanticVersionId: "timeline-version-clip", graph: {
        timelineId: "timeline-main", scenes: [{ sceneId: "scene-main", order: 0 }],
        tracks: [{ trackId: "video-main", sceneId: "scene-main", kind: "VIDEO", order: 0 }],
        clips: [{ ...clip, source: { ...clip.source, artifactVersionId: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } }],
      } }],
    } }, 201));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });
    await expect(client.editTimeline("project-1", "timeline-main", {
      expectedHeadRevisionId: "revision-head", edits: [{ type: "putClip", clip }],
    })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("does not retry a timeline edit after a revision conflict", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: { code: "REVISION_CONFLICT", message: "Project head changed", details: { currentHeadRevisionId: "revision-3" } },
    }, 409));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });
    await expect(client.editTimeline("project-1", "timeline-main", {
      expectedHeadRevisionId: "revision-2",
      edits: [{ type: "addScene", sceneId: "scene-main", order: 0 }],
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT", status: 409 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["wrong project", { projectId: "another-project" }],
    ["wrong parent head", { parentRevisionId: "revision-older" }],
    ["non-empty graph", { timelines: [{
      semanticVersionId: "timeline-version-1",
      graph: { timelineId: "timeline-main", scenes: [{ id: "scene-1" }], tracks: [], clips: [] },
    }] }],
    ["duplicate requested timeline", { timelines: [
      { semanticVersionId: "timeline-version-1", graph: { timelineId: "timeline-main", scenes: [], tracks: [], clips: [] } },
      { semanticVersionId: "timeline-version-2", graph: { timelineId: "timeline-main", scenes: [], tracks: [], clips: [] } },
    ] }],
  ])("rejects a timeline response with %s", async (_label, override) => {
    const validTimelineRevision = {
      tenantId: project.tenantId,
      projectId: project.projectId,
      revisionId: "revision-2",
      parentRevisionId: "revision-1",
      timelines: [{
        semanticVersionId: "timeline-version-1",
        graph: { timelineId: "timeline-main", scenes: [], tracks: [], clips: [] },
      }],
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      scope: "DEV_ONLY",
      revision: { ...validTimelineRevision, ...override },
    }, 201));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });
    await expect(client.createTimeline("project-1", {
      expectedHeadRevisionId: "revision-1",
      timelineId: "timeline-main",
    })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("preserves server revision conflicts and never retries a mutation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: {
        code: "REVISION_CONFLICT",
        message: "Project head changed; re-read before retrying",
        details: { currentHeadRevisionId: "revision-2" },
      },
    }, 409));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });
    await expect(client.createTimeline("project-1", {
      expectedHeadRevisionId: "revision-1",
      timelineId: "timeline-main",
    })).rejects.toMatchObject({
      name: "MediaDevProjectTimelineError",
      code: "REVISION_CONFLICT",
      status: 409,
      details: { currentHeadRevisionId: "revision-2" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("restores the exact pre-read revision graph while accepting new semantic version identities", async () => {
    const targetRevision = {
      tenantId: project.tenantId,
      projectId: project.projectId,
      revisionId: "revision-target",
      parentRevisionId: "revision-previous",
      timelines: [{
        semanticVersionId: "timeline-version-target",
        graph: {
          timelineId: "timeline-main",
          scenes: [{ sceneId: "scene-main", order: 0 }],
          tracks: [{ trackId: "video-main", sceneId: "scene-main", kind: "VIDEO", order: 0 }],
          clips: [],
        },
      }],
    };
    const restoredRevision = {
      ...targetRevision,
      revisionId: "revision-restored",
      parentRevisionId: "revision-head",
      timelines: targetRevision.timelines.map((snapshot) => ({
        ...snapshot,
        semanticVersionId: "timeline-version-restored",
        graph: {
          clips: [],
          tracks: [{ order: 0, kind: "VIDEO", sceneId: "scene-main", trackId: "video-main" }],
          scenes: [{ order: 0, sceneId: "scene-main" }],
          timelineId: "timeline-main",
        },
      })),
    };
    const request = { expectedHeadRevisionId: "revision-head", targetRevisionId: "revision-target" };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ revision: targetRevision, scope: "DEV_ONLY" }))
      .mockResolvedValueOnce(jsonResponse({ revision: restoredRevision, scope: "DEV_ONLY" }, 201));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });

    await expect(client.restoreRevision("project-1", request)).resolves.toMatchObject({
      scope: "DEV_ONLY",
      revision: { revisionId: "revision-restored", parentRevisionId: "revision-head", timelines: [{ semanticVersionId: "timeline-version-restored" }] },
    });
    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["http://127.0.0.1:8093/dev/v1/projects/project-1/revisions/revision-target", "GET"],
      ["http://127.0.0.1:8093/dev/v1/projects/project-1/restore", "POST"],
    ]);
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(request));
  });

  it.each([
    ["missing target revision", { expectedHeadRevisionId: "revision-head" }],
    ["unexpected field", { expectedHeadRevisionId: "revision-head", targetRevisionId: "revision-target", extra: true }],
    ["invalid target identity", { expectedHeadRevisionId: "revision-head", targetRevisionId: "bad/id" }],
  ])("rejects a malformed exact restore request before network access (%s)", async (_label, request) => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });
    await expect(client.restoreRevision("project-1", request as never))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a restore response whose graph differs from the exact pre-read target", async () => {
    const targetRevision = {
      tenantId: project.tenantId,
      projectId: project.projectId,
      revisionId: "revision-target",
      parentRevisionId: "revision-previous",
      timelines: [{
        semanticVersionId: "timeline-version-target",
        graph: { timelineId: "timeline-main", scenes: [], tracks: [], clips: [] },
      }],
    };
    const mismatchedRevision = {
      ...targetRevision,
      revisionId: "revision-restored",
      parentRevisionId: "revision-head",
      timelines: [{
        ...targetRevision.timelines[0],
        semanticVersionId: "timeline-version-restored",
        graph: { ...targetRevision.timelines[0].graph, scenes: [{ sceneId: "unexpected", order: 0 }] },
      }],
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ revision: targetRevision, scope: "DEV_ONLY" }))
      .mockResolvedValueOnce(jsonResponse({ revision: mismatchedRevision, scope: "DEV_ONLY" }, 201));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });

    await expect(client.restoreRevision("project-1", {
      expectedHeadRevisionId: "revision-head",
      targetRevisionId: "revision-target",
    })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a restore response that changes the exact target tenant", async () => {
    const targetRevision = {
      tenantId: project.tenantId,
      projectId: project.projectId,
      revisionId: "revision-target",
      parentRevisionId: "revision-previous",
      timelines: [],
    };
    const restoredRevision = {
      ...targetRevision,
      tenantId: "another-tenant",
      revisionId: "revision-restored",
      parentRevisionId: "revision-head",
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ revision: targetRevision, scope: "DEV_ONLY" }))
      .mockResolvedValueOnce(jsonResponse({ revision: restoredRevision, scope: "DEV_ONLY" }, 201));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });

    await expect(client.restoreRevision("project-1", {
      expectedHeadRevisionId: "revision-head",
      targetRevisionId: "revision-target",
    })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves a definite restore revision conflict without retrying", async () => {
    const targetRevision = {
      tenantId: project.tenantId,
      projectId: project.projectId,
      revisionId: "revision-target",
      parentRevisionId: null,
      timelines: [],
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ revision: targetRevision, scope: "DEV_ONLY" }))
      .mockResolvedValueOnce(jsonResponse({
        error: { code: "REVISION_CONFLICT", message: "Project head changed", details: { currentHeadRevisionId: "revision-new-head" } },
      }, 409));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });

    await expect(client.restoreRevision("project-1", {
      expectedHeadRevisionId: "revision-head",
      targetRevisionId: "revision-target",
    })).rejects.toMatchObject({
      name: "MediaDevProjectTimelineError",
      code: "REVISION_CONFLICT",
      status: 409,
      details: { currentHeadRevisionId: "revision-new-head" },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe("POST");
  });

  it("classifies a mutation 5xx response as unknown even when its error body is valid JSON", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: { code: "HOST_FAILURE", message: "Failure after request handling." },
    }, 503));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });
    await expect(client.editTimeline("project-1", "timeline-main", {
      expectedHeadRevisionId: "revision-2",
      edits: [{ type: "addScene", sceneId: "scene-main", order: 0 }],
    })).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      status: 503,
      details: { responseCode: "HOST_FAILURE" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("classifies an unreadable successful mutation response as unknown", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{", {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });
    await expect(client.editTimeline("project-1", "timeline-main", {
      expectedHeadRevisionId: "revision-2",
      edits: [{ type: "addScene", sceneId: "scene-main", order: 0 }],
    })).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", status: 201 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("maps ambiguous mutation transport failure to OUTCOME_UNKNOWN with the original request id", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("socket closed"));
    const client = new MediaDevProjectTimelineClient({ baseUrl: "http://127.0.0.1:8093", bearerToken: "token", fetch: fetcher });
    await expect(client.createProject({
      selectedAuthorizedWorkspaceId: context.selectedAuthorizedWorkspaceId,
      title: "Local edit",
      requestId: "create-1",
    })).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", details: { requestId: "create-1" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
