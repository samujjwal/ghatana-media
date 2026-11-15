// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevErasurePanel } from "./DevErasurePanel";
import {
  DevErasureHostError, describeErasureFailure, parseErasurePlanView, parseErasureReceiptView, parseLegalHoldView, treeRows,
  type DevErasurePort,
} from "./devErasure";

afterEach(cleanup);

const d = (n: number): string => n.toString(16).padStart(64, "0");
const node = (artifactId: string, kind: string, n: number, derivedFrom: string[] = []) =>
  ({ artifactId, kind, contentType: "audio/wav", sha256: d(n), sizeBytes: 100 + n, derivedFrom });
const holdBody = (over: Record<string, unknown> = {}) => ({
  holdId: "hold-1", rootArtifactId: "root", state: "ACTIVE", reason: "TEST litigation hold", placedBy: "test-principal-owner",
  placedIdentityAssurance: "DEV_ISSUED", placedAt: "2026-11-14T10:00:00Z", releasedBy: null, releaseReason: null, releasedAt: null,
  replayed: false, scope: "DEV_ONLY", ...over,
});
const planBody = (over: Record<string, unknown> = {}) => ({
  rootArtifactId: "root", scope: "DEV_ONLY",
  artifacts: [node("root", "SYNTHESIZED_AUDIO", 1), node("tr", "TRANSCRIPT", 2, ["root"]), node("cap", "CAPTION_VERSION", 3, ["tr"]), node("mp4", "RENDER", 4, ["cap"])],
  artifactCount: 4, dependentRecords: { DELIVERY_RECORD: 1, REQUEST_LEDGER_ROW: 3 }, blockingHolds: [], erasable: true, ...over,
});
const receiptBody = (over: Record<string, unknown> = {}) => ({
  erasureId: "ui-1", rootArtifactId: "root", phase: "COMPLETED", complete: true, requestedBy: "test-principal-owner",
  requestedAt: "2026-11-14T10:00:00Z", completedAt: "2026-11-14T10:00:02Z",
  items: [{ kind: "TRANSCRIPT", count: 1, digests: [d(2)] }, { kind: "RENDER", count: 1, digests: [d(4)] }, { kind: "DELIVERY_RECORD", count: 1, digests: [] }],
  totalRemoved: 3, contentDisclosed: "none", scope: "DEV_ONLY", ...over,
});

function port(over: Partial<DevErasurePort> = {}): { [K in keyof DevErasurePort]-?: ReturnType<typeof vi.fn> } {
  return {
    plan: vi.fn(() => Promise.resolve({ status: 200, body: planBody() })),
    erase: vi.fn(() => Promise.resolve({ status: 201, body: receiptBody() })),
    receipt: vi.fn(() => Promise.resolve({ status: 200, body: receiptBody() })),
    placeHold: vi.fn(() => Promise.resolve({ status: 201, body: holdBody() })),
    releaseHold: vi.fn(() => Promise.resolve({ status: 200, body: holdBody({ state: "RELEASED", releasedBy: "test-principal-owner", releaseReason: "matter closed", releasedAt: "2026-11-14T11:00:00Z" }) })),
    ...over,
  } as never;
}

async function review(p = port()) {
  render(React.createElement(DevErasurePanel, { erasure: p as never, newRequestId: () => "ui-1" }));
  fireEvent.change(screen.getByLabelText("Root artifact ID"), { target: { value: "root" } });
  fireEvent.click(screen.getByRole("button", { name: "Review tree" }));
  await screen.findByRole("table", { name: "Artifacts that will be erased" });
  return p;
}

describe("DevErasurePanel", () => {
  it("shows the tree to be erased with kinds, digests and dependent records before anything is erased", async () => {
    const p = await review();
    const table = screen.getByRole("table", { name: "Artifacts that will be erased" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.getAttribute("data-artifact-id"))).toEqual(["root", "tr", "cap", "mp4"]);
    expect(rows.map((row) => row.getAttribute("data-depth"))).toEqual(["0", "1", "2", "3"]);
    expect(within(rows[3]!).getByText("Render or dub")).toBeTruthy();
    expect(screen.getByLabelText("Dependent records").textContent).toContain("Delivery record: 1");
    expect(screen.getByRole("status").textContent).toContain("4 artifacts would be erased");
    expect(p.erase).not.toHaveBeenCalled();
  });

  it("requires an explicit confirmation: the checkbox and the typed root id both gate the erase, and Escape cancels", async () => {
    const p = await review();
    const open = screen.getByRole("button", { name: "Erase this tree…" });
    fireEvent.click(open);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    const heading = within(dialog).getByRole("heading", { name: "Confirm permanent erasure" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const erase = within(dialog).getByRole("button", { name: "Erase permanently" }) as HTMLButtonElement;
    expect(erase.disabled).toBe(true);
    fireEvent.click(within(dialog).getByLabelText("I understand this is permanent"));
    expect(erase.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Type the root artifact ID to confirm"), { target: { value: "roo" } });
    expect(erase.disabled).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(open);
    expect(p.erase).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Nothing was changed");
  });

  it("erases with the exact reviewed tree size and shows a content-free receipt of kinds, counts and digests", async () => {
    const p = await review();
    fireEvent.click(screen.getByRole("button", { name: "Erase this tree…" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByLabelText("I understand this is permanent"));
    fireEvent.change(within(dialog).getByLabelText("Type the root artifact ID to confirm"), { target: { value: "root" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Erase permanently" }));
    const receipt = await screen.findByRole("table", { name: "What was erased" });
    expect(p.erase).toHaveBeenCalledWith({ erasureId: "ui-1", artifactId: "root", confirm: true, expectedArtifactCount: 4 });
    const rows = within(receipt).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.getAttribute("data-kind"))).toEqual(["TRANSCRIPT", "RENDER", "DELIVERY_RECORD"]);
    expect(within(rows[0]!).getByTitle(d(2))).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Erasure receipt · complete/u })).toBeTruthy();
    expect(screen.getByText(/No content is shown/u)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("table", { name: "Artifacts that will be erased" })).toBeNull();
  });

  it("a legal hold blocks the erase control, names who placed it, and release records a reason", async () => {
    const held = port({ plan: vi.fn(() => Promise.resolve({ status: 200, body: planBody({ erasable: false, blockingHolds: [holdBody()] }) })) });
    await review(held);
    expect((screen.getByRole("button", { name: "Erase this tree…" }) as HTMLButtonElement).disabled).toBe(true);
    const list = screen.getByRole("list", { name: "Active legal holds" });
    expect(list.textContent).toContain("test-principal-owner");
    expect(list.textContent).toContain("DEV_ISSUED");
    const release = within(list).getByRole("button", { name: "Release hold" }) as HTMLButtonElement;
    expect(release.disabled).toBe(true);
    fireEvent.change(within(list).getByLabelText("Reason for releasing hold hold-1"), { target: { value: "matter closed" } });
    held.plan.mockImplementation(() => Promise.resolve({ status: 200, body: planBody() }));
    fireEvent.click(release);
    await waitFor(() => expect(held.releaseHold).toHaveBeenCalledWith("hold-1", "matter closed"));
    await waitFor(() => expect((screen.getByRole("button", { name: "Erase this tree…" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole("status").textContent).toContain("released by test-principal-owner");
  });

  it("places a hold with a reason and refreshes the plan", async () => {
    const p = await review();
    p.plan.mockImplementation(() => Promise.resolve({ status: 200, body: planBody({ erasable: false, blockingHolds: [holdBody()] }) }));
    fireEvent.change(screen.getByLabelText(/Reason for a new legal hold/u), { target: { value: "TEST litigation hold" } });
    fireEvent.click(screen.getByRole("button", { name: "Place legal hold" }));
    await waitFor(() => expect(p.placeHold).toHaveBeenCalledWith({ requestId: "ui-1", artifactId: "root", reason: "TEST litigation hold" }));
    await screen.findByRole("list", { name: "Active legal holds" });
    expect(screen.getByRole("status").textContent).toContain("Erasure is blocked until it is released");
  });

  it("a refused erase shows the typed reason, keeps the same erasure identity for the retry and never shows a receipt", async () => {
    const erase = vi.fn()
      .mockRejectedValueOnce(new DevErasureHostError("OUTCOME_UNKNOWN", 0, "no response"))
      .mockResolvedValueOnce({ status: 201, body: receiptBody() });
    await review(port({ erase }));
    const confirm = async (): Promise<void> => {
      if (!screen.queryByRole("alertdialog")) fireEvent.click(screen.getByRole("button", { name: "Erase this tree…" }));
      const dialog = screen.getByRole("alertdialog");
      const understood = within(dialog).getByLabelText("I understand this is permanent") as HTMLInputElement;
      if (!understood.checked) fireEvent.click(understood);
      fireEvent.change(within(dialog).getByLabelText("Type the root artifact ID to confirm"), { target: { value: "root" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Erase permanently" }));
    };
    await confirm();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("OUTCOME_UNKNOWN");
    expect(alert.textContent).toContain("Nothing is shown as erased");
    expect(screen.queryByRole("table", { name: "What was erased" })).toBeNull();
    await confirm();
    await screen.findByRole("table", { name: "What was erased" });
    expect(erase.mock.calls[0]![0].erasureId).toBe(erase.mock.calls[1]![0].erasureId);
  });

  it("shows a typed hold refusal and a gone artifact without inventing a receipt", async () => {
    const erase = vi.fn().mockRejectedValue(new DevErasureHostError("LEGAL_HOLD_ACTIVE", 409, "held"));
    await review(port({ erase }));
    fireEvent.click(screen.getByRole("button", { name: "Erase this tree…" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByLabelText("I understand this is permanent"));
    fireEvent.change(within(dialog).getByLabelText("Type the root artifact ID to confirm"), { target: { value: "root" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Erase permanently" }));
    expect((await screen.findByRole("alert")).textContent).toContain("A legal hold covers part of this tree");
    cleanup();
    const gone = port({ plan: vi.fn(() => Promise.reject(new DevErasureHostError("ARTIFACT_ERASED", 410, "erased"))) });
    render(React.createElement(DevErasurePanel, { erasure: gone as never }));
    fireEvent.change(screen.getByLabelText("Root artifact ID"), { target: { value: "root" } });
    fireEvent.click(screen.getByRole("button", { name: "Review tree" }));
    expect((await screen.findByRole("alert")).textContent).toContain("already erased");
  });

  it("reopens a receipt by id and refuses a receipt for another erasure", async () => {
    const p = port({ receipt: vi.fn(() => Promise.resolve({ status: 200, body: receiptBody({ erasureId: "other" }) })) });
    render(React.createElement(DevErasurePanel, { erasure: p as never }));
    fireEvent.change(screen.getByLabelText("Reopen receipt by erasure ID"), { target: { value: "ui-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Reopen receipt" }));
    expect((await screen.findByRole("alert")).textContent).toContain("INVALID_RESPONSE");
    p.receipt.mockImplementation(() => Promise.resolve({ status: 200, body: receiptBody() }));
    fireEvent.click(screen.getByRole("button", { name: "Reopen receipt" }));
    await screen.findByRole("table", { name: "What was erased" });
  });

  it("is locked while a request is pending or when locked", async () => {
    render(React.createElement(DevErasurePanel, { erasure: port() as never, locked: true }));
    expect((screen.getByRole("button", { name: "Review tree" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Root artifact ID") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("erasure view parsing", () => {
  it("rejects a plan that is not DEV_ONLY, miscounts its tree, lacks its root or disagrees about erasable", () => {
    expect(() => parseErasurePlanView({ ...planBody(), scope: "PROD" })).toThrow(DevErasureHostError);
    expect(() => parseErasurePlanView({ ...planBody(), artifactCount: 3 })).toThrow(/count/u);
    expect(() => parseErasurePlanView({ ...planBody(), rootArtifactId: "elsewhere" }, { rootArtifactId: "root" })).toThrow(/another artifact/u);
    expect(() => parseErasurePlanView({ ...planBody(), erasable: false })).toThrow(/erasable/u);
    expect(() => parseErasurePlanView({ ...planBody(), artifacts: [node("tr", "TRANSCRIPT", 2)], artifactCount: 1 })).toThrow(/root/u);
    expect(() => parseErasurePlanView({ ...planBody(), artifacts: [{ ...node("root", "X", 1), sha256: "short" }], artifactCount: 1 })).toThrow(/digest/u);
  });

  it("rejects a receipt that claims content was disclosed, miscounts, or carries a non-digest", () => {
    expect(() => parseErasureReceiptView({ ...receiptBody(), contentDisclosed: "partial" })).toThrow(/no content/u);
    expect(() => parseErasureReceiptView({ ...receiptBody(), totalRemoved: 99 })).toThrow(/total/u);
    expect(() => parseErasureReceiptView({ ...receiptBody(), items: [{ kind: "RENDER", count: 1, digests: ["not-a-digest"] }], totalRemoved: 1 })).toThrow(/digest/u);
    expect(() => parseErasureReceiptView({ ...receiptBody(), scope: "x" })).toThrow(/DEV_ONLY/u);
    expect(parseErasureReceiptView(receiptBody({ phase: "OBJECTS_ERASED", complete: true })).complete).toBe(false);
  });

  it("requires a released hold to name who released it", () => {
    expect(() => parseLegalHoldView(holdBody({ state: "RELEASED" }))).toThrow(/who released/u);
    expect(parseLegalHoldView(holdBody({ state: "RELEASED", releasedBy: "p", releaseReason: "r", releasedAt: "t" })).state).toBe("RELEASED");
  });

  it("orders tree rows by derivation depth and still lists a node with an unknown parent", () => {
    const plan = parseErasurePlanView(planBody({ artifacts: [node("root", "SOURCE_ARTIFACT", 1), node("a", "TRANSCRIPT", 2, ["root"]), node("b", "RENDER", 3, ["a", "root"]), node("orphan", "WEBVTT", 4, ["missing"])], artifactCount: 4 }));
    expect(treeRows(plan).map((row) => [row.node.artifactId, row.depth])).toEqual([["root", 0], ["a", 1], ["b", 2], ["orphan", 1]]);
  });

  it("maps host failures to plain outcomes", () => {
    expect(describeErasureFailure(new DevErasureHostError("OUTCOME_UNKNOWN", 0, "m")).tone).toBe("unknown");
    expect(describeErasureFailure(new DevErasureHostError("LEGAL_HOLD_ACTIVE", 409, "m")).tone).toBe("held");
    expect(describeErasureFailure(new DevErasureHostError("IDENTITY_ASSURANCE_REQUIRED", 403, "m")).text).toContain("identity-provider verified");
    expect(describeErasureFailure(new DevErasureHostError("ARTIFACT_NOT_FOUND", 404, "m")).tone).toBe("denied");
    expect(describeErasureFailure(new DevErasureHostError("ERASURE_TREE_CHANGED", 409, "m")).text).toContain("Nothing was erased");
  });
});
