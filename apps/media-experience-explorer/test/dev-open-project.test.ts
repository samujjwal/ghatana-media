import { describe, expect, it, vi } from "vitest";
import { MediaDevProjectTimelineError, type DevProjectRead } from "@audio-video/client/dev-project-timeline";
import { describeOpenProjectFailure, openExistingProject } from "../src/dev-open-project.js";

const read = (over: Partial<DevProjectRead> = {}): DevProjectRead => ({
  scope: "DEV_ONLY",
  project: { tenantId: "t1", projectId: "project-1", workspaceId: "w1", ownerPrincipalId: "o", title: "P", headRevisionId: "rev-3" },
  currentRevision: { tenantId: "t1", projectId: "project-1", revisionId: "rev-3", parentRevisionId: "rev-2", timelines: [] },
  ...over,
});
const context = { tenantId: "t1" };
const clientOf = (impl: () => Promise<DevProjectRead>) => ({ getProject: vi.fn(impl) });

describe("open existing project", () => {
  it("reads the project by trimmed id and returns its head revision", async () => {
    const client = clientOf(async () => read());
    const result = await openExistingProject(client as never, context, "  project-1 ");
    expect(client.getProject).toHaveBeenCalledWith("project-1");
    expect(result).toEqual({ ok: true, read: read() });
  });

  it("rejects an invalid id without calling the host", async () => {
    const client = clientOf(async () => read());
    for (const bad of ["", "  ", "../x", "a/b", "-lead", "x".repeat(129)]) {
      const result = await openExistingProject(client as never, context, bad);
      expect(result).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    }
    expect(client.getProject).not.toHaveBeenCalled();
  });

  it("maps typed 404 and 403 without opening anything", async () => {
    const notFound = await openExistingProject(clientOf(async () => { throw new MediaDevProjectTimelineError("PROJECT_NOT_FOUND", 404, "x"); }) as never, context, "project-1");
    expect(notFound).toMatchObject({ ok: false, code: "PROJECT_NOT_FOUND" });
    expect((notFound as { message: string }).message).toContain("owner scope");
    const denied = await openExistingProject(clientOf(async () => { throw new MediaDevProjectTimelineError("PROJECT_ACCESS_DENIED", 403, "x"); }) as never, context, "project-1");
    expect(denied).toMatchObject({ ok: false, code: "PROJECT_ACCESS_DENIED" });
    expect((denied as { message: string }).message).toContain("not authorized");
  });

  it("reports an unknown transport outcome and does not open", async () => {
    const result = await openExistingProject(clientOf(async () => { throw new MediaDevProjectTimelineError("OUTCOME_UNKNOWN", 0, "x"); }) as never, context, "project-1");
    expect(result).toMatchObject({ ok: false, code: "OUTCOME_UNKNOWN" });
  });

  it("refuses a read for another tenant, another project, or a non-head revision", async () => {
    const other = read({ project: { ...read().project, tenantId: "t2" }, currentRevision: { ...read().currentRevision, tenantId: "t2" } });
    expect(await openExistingProject(clientOf(async () => other) as never, context, "project-1")).toMatchObject({ ok: false, code: "INVALID_RESPONSE" });
    expect(await openExistingProject(clientOf(async () => read()) as never, context, "project-2")).toMatchObject({ ok: false, code: "INVALID_RESPONSE" });
    const skewed = read({ currentRevision: { ...read().currentRevision, revisionId: "rev-9" } });
    expect(await openExistingProject(clientOf(async () => skewed) as never, context, "project-1")).toMatchObject({ ok: false, code: "INVALID_RESPONSE" });
  });

  it("describes non-client errors", () => {
    expect(describeOpenProjectFailure(new Error("boom")).message).toBe("boom");
  });
});
