import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OFFLINE_WORKSPACE_KEY, readOfflineWorkspacePointer, restoredRevision, writeOfflineWorkspacePointer, type OfflineWorkspacePointer } from "../src/dev-offline-workspace";

const pointer: OfflineWorkspacePointer = {
  v: 1, principalId: "principal-a", timelineIds: ["main"],
  project: { tenantId: "tenant-a", projectId: "project-a", workspaceId: "w1", ownerPrincipalId: "principal-a", title: "T", headRevisionId: "rev-1" },
};
function memory(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [[OFFLINE_WORKSPACE_KEY, initial]]);
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, values };
}

describe("offline workspace pointer", () => {
  it("round-trips identifiers only and never anything token-like", () => {
    const storage = memory();
    writeOfflineWorkspacePointer(pointer, storage);
    expect(readOfflineWorkspacePointer(storage)).toEqual(pointer);
    expect(storage.values.get(OFFLINE_WORKSPACE_KEY)).not.toMatch(/eyJ|token|bearer/iu);
  });
  it.each([
    ["not json", "{"],
    ["wrong version", JSON.stringify({ ...pointer, v: 2 })],
    ["bad head id", JSON.stringify({ ...pointer, project: { ...pointer.project, headRevisionId: "../x" } })],
    ["bad timeline id", JSON.stringify({ ...pointer, timelineIds: ["ok", " "] })],
    ["missing principal", JSON.stringify({ ...pointer, principalId: "" })],
  ])("ignores a malformed pointer (%s)", (_name, raw) => {
    expect(readOfflineWorkspacePointer(memory(raw))).toBeNull();
  });
  it("tolerates unavailable storage", () => {
    expect(readOfflineWorkspacePointer({ getItem: () => { throw new Error("blocked"); } })).toBeNull();
    expect(() => writeOfflineWorkspacePointer(pointer, { setItem: () => { throw new Error("quota"); } })).not.toThrow();
  });
  it("restores a content-free revision stub for the draft panel", () => {
    const revision = restoredRevision(pointer);
    expect(revision).toMatchObject({ projectId: "project-a", revisionId: "rev-1", timelines: [{ graph: { timelineId: "main", scenes: [], tracks: [], clips: [] } }] });
  });
});

describe("offline app-shell worker", () => {
  const worker = readFileSync(new URL("../public/dev-offline-sw.js", import.meta.url), "utf8");
  it("never caches host routes and only serves cached copies when the network fails", () => {
    expect(worker).toMatch(/startsWith\("\/dev\/v1"\)/u);
    expect(worker).toMatch(/startsWith\("\/api\/"\)/u);
    expect(worker).toMatch(/request\.method !== "GET"/u);
    expect(worker.indexOf("await fetch(request)")).toBeLessThan(worker.indexOf("cache.match"));
  });
});
