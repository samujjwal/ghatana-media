import { describe, expect, it, vi } from "vitest";
import {
  IndexedDbOfflineEditStore,
  IndexedDbOfflineEditStoreError,
} from "./indexeddb-offline-edit-store.js";

const scope = { tenantId: "tenant-a", projectId: "project-a" };

function failingFactory(mode: "blocked" | "error"): { factory: IDBFactory; open: ReturnType<typeof vi.fn> } {
  const open = vi.fn(() => {
    const request: Record<string, unknown> = { result: undefined, error: new Error("native detail") };
    queueMicrotask(() => {
      const handler = request[mode === "blocked" ? "onblocked" : "onerror"];
      if (typeof handler === "function") (handler as (event: Event) => void)(new Event(mode));
    });
    return request as unknown as IDBOpenDBRequest;
  });
  return { factory: { open } as unknown as IDBFactory, open };
}

describe("IndexedDbOfflineEditStore open lifecycle", () => {
  it.each([" app-a", "app-a ", "\u00a0app-a", "app-a\u00a0", " \t "])(
    "rejects a padded application database name instead of aliasing another scope: %j",
    (databaseName) => {
      const stub = failingFactory("error");

      expect(() => new IndexedDbOfflineEditStore({ indexedDB: stub.factory, databaseName }))
        .toThrow("databaseName must be canonical; whitespace normalization is not allowed.");
      expect(stub.open).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["blocked", "OPEN_BLOCKED"],
    ["error", "OPEN_FAILED"],
  ] as const)("allows a new open attempt after %s", async (mode, code) => {
    const stub = failingFactory(mode);
    const store = new IndexedDbOfflineEditStore({ indexedDB: stub.factory });

    await expect(store.list(scope)).rejects.toMatchObject({
      name: "IndexedDbOfflineEditStoreError",
      code,
    } satisfies Partial<IndexedDbOfflineEditStoreError>);
    await expect(store.list(scope)).rejects.toMatchObject({ code });
    expect(stub.open).toHaveBeenCalledTimes(2);
  });

  it("lets close reset a rejected open so a later operation retries", async () => {
    const stub = failingFactory("blocked");
    const store = new IndexedDbOfflineEditStore({ indexedDB: stub.factory });

    await expect(store.list(scope)).rejects.toMatchObject({ code: "OPEN_BLOCKED" });
    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.list(scope)).rejects.toMatchObject({ code: "OPEN_BLOCKED" });
    expect(stub.open).toHaveBeenCalledTimes(2);
  });
});
