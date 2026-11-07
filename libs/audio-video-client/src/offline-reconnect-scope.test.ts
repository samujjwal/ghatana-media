import { describe, expect, it } from "vitest";
import { OfflineReconnectCoordinator } from "./offline-reconnect.js";
import type { OfflineEditQueue, OfflineEditScope } from "./offline-edit-queue.js";

describe("OfflineReconnectCoordinator scope", () => {
  it.each([
    { tenantId: " tenant-1", projectId: "project-1" },
    { tenantId: "tenant-1", projectId: "project-1 " },
    { tenantId: "tenant-1\u0000alias", projectId: "project-1" },
    { tenantId: "tenant-1", projectId: "project-1\u0000alias" },
  ] satisfies OfflineEditScope[])("rejects a non-exact identity scope: %o", (scope) => {
    expect(() => new OfflineReconnectCoordinator({} as OfflineEditQueue, scope))
      .toThrow("Reconnect scope requires exact tenant and project identities.");
  });
});
