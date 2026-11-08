// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactIntakeScreen, type ArtifactUploadCapability, type ArtifactUploadSession } from "./ArtifactIntakeScreen";
import type { MediaActionPort, MediaContextPort, MediaDataPort } from "../ports";

const baseProps = {
  data: { currentProjection: { title: "Import media", description: "Select source files.", steps: [{ id: "select", title: "Select", description: "Choose files.", state: "current" as const }], currentStepId: "select" }, operationObservation: { state: "READY", progress: { kind: "none" as const } } } satisfies MediaDataPort,
  actions: [],
  actionPort: { invoke: vi.fn(async () => ({ status: "unavailable" as const, reason: "No action dispatched." })) } satisfies MediaActionPort,
  context: { locale: "en-US" } satisfies MediaContextPort,
  intake: { view: "import-media" as const },
};

describe("ArtifactIntakeScreen local source selection", () => {
  it("announces only a local file count without claiming transfer finality", () => {
    const onSourceFilesSelected = vi.fn();
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, onSourceFilesSelected }));

    const input = screen.getByLabelText("Choose source media") as HTMLInputElement;
    const files = [new File(["a"], "one.mp4"), new File(["b"], "two.wav")];
    fireEvent.change(input, { target: { files } });

    const announcement = screen.getByText("2 source files are selected locally.");
    expect(announcement.getAttribute("role")).toBe("status");
    expect(onSourceFilesSelected).toHaveBeenCalledWith(files);
  });

  it("reports a cleared local selection", () => {
    render(React.createElement(ArtifactIntakeScreen, baseProps));
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [] } });
    const announcement = screen.getByText("No source files are selected locally.");
    expect(announcement.getAttribute("role")).toBe("status");
  });
});

const uploadSession = (overrides: Partial<ArtifactUploadSession> = {}): ArtifactUploadSession => ({
  uploadId: "upload-1", tenantId: "tenant-1", principalId: "principal-1", fileName: "source.wav",
  contentType: "audio/wav", expectedSizeBytes: 3, expectedSha256: "a".repeat(64), classification: "INTERNAL",
  createdAt: "2026-11-07T00:00:00Z", expiresAt: "2026-11-08T00:00:00Z",
  metadata: {}, bytesReceived: 0, nextChunkIndex: 0, status: "OPEN", ...overrides,
});

function admittedCapability(overrides: Partial<ArtifactUploadCapability["client"]> = {}): ArtifactUploadCapability {
  return {
    runtimeAdmission: "ADMITTED", classification: "INTERNAL", retention: "PT24H",
    client: {
      createUploadSession: vi.fn(async () => uploadSession()),
      getUploadSession: vi.fn(async () => uploadSession()),
      uploadPart: vi.fn(async (_session, _index, _part) => uploadSession({ bytesReceived: 3, nextChunkIndex: 1 })),
      completeUploadSession: vi.fn(async () => ({ artifactId: "artifact-1" })),
      ...overrides,
    },
  };
}

describe("ArtifactIntakeScreen admitted upload capability", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", {
      subtle: { digest: vi.fn(async () => new Uint8Array(32).buffer) },
      randomUUID: vi.fn(() => "11111111-1111-4111-8111-111111111111"),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps upload unavailable without a host capability", () => {
    render(React.createElement(ArtifactIntakeScreen, baseProps));
    expect(screen.getByText("Upload is not admitted by the current host.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload selected source" })).toBeNull();
  });

  it("uploads one selected source through the authenticated SDK and completes only the exact acknowledged session", async () => {
    const capability = admittedCapability();
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), {
      target: { files: [new File(["abc"], "source.wav", { type: "audio/wav" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));

    await screen.findByText(/Upload completion acknowledged for artifact artifact-1/);
    expect(capability.client.createUploadSession).toHaveBeenCalledWith(expect.objectContaining({
      fileName: "source.wav", contentType: "audio/wav", expectedSizeBytes: 3,
      expectedSha256: expect.stringMatching(/^[a-f0-9]{64}$/u), classification: "INTERNAL", retention: "PT24H",
    }), expect.any(AbortSignal));
    expect(capability.client.uploadPart).toHaveBeenCalledWith(expect.objectContaining({ uploadId: "upload-1" }), 0, expect.any(Blob), { signal: expect.any(AbortSignal) });
    expect(capability.client.completeUploadSession).toHaveBeenCalledWith(expect.objectContaining({ bytesReceived: 3, nextChunkIndex: 1 }), expect.any(AbortSignal));
    expect(screen.getByText(/Availability, rights, consent, and downstream use are not established/)).toBeTruthy();
  });

  it.each([
    ["empty", new File([], "empty.wav")],
    ["over-sdk-limit", Object.defineProperty(new File([new Uint8Array(1)], "large.wav"), "size", { value: 1_073_741_825 })],
  ])("rejects %s input at the screen boundary without dispatch", async (_label, file) => {
    const capability = admittedCapability();
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));
    await screen.findByText(/outside the authenticated SDK upload size limits/);
    expect(capability.client.createUploadSession).not.toHaveBeenCalled();
  });

  it("returns HASHING_UNAVAILABLE for large files before allocating or dispatching", async () => {
    const capability = admittedCapability();
    const file = new File([new Uint8Array(1)], "large.wav");
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    Object.defineProperties(file, { size: { value: 64 * 1024 * 1024 + 1 }, arrayBuffer: { value: arrayBuffer } });
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));
    await screen.findByText(/A bounded SHA-256 provider is required/);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(capability.client.createUploadSession).not.toHaveBeenCalled();
    expect(capability.client.uploadPart).not.toHaveBeenCalled();
  });

  it("uses the host's bounded SHA-256 provider above the WebCrypto fallback bound", async () => {
    const capability = admittedCapability({ createUploadSession: vi.fn(async () => {
      throw Object.assign(new Error("denied after digest"), { statusCode: 403 });
    }) });
    const hashFile = vi.fn(async () => "B".repeat(64));
    const file = new File([new Uint8Array(1)], "large.wav");
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    Object.defineProperties(file, { size: { value: 64 * 1024 * 1024 + 1 }, arrayBuffer: { value: arrayBuffer } });
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: { ...capability, hashFile } }));
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));
    await screen.findByText(/Upload was denied/);
    expect(hashFile).toHaveBeenCalledWith(file, expect.any(AbortSignal));
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(capability.client.createUploadSession).toHaveBeenCalledWith(expect.objectContaining({ expectedSha256: "b".repeat(64) }), expect.any(AbortSignal));
  });

  it("does not begin an upload if the screen is unmounted while host hashing is pending", async () => {
    let finishHash!: (digest: string) => void;
    const capability = admittedCapability();
    const hashFile = vi.fn((_file: File, _signal: AbortSignal) => new Promise<string>((resolve) => { finishHash = resolve; }));
    const file = new File([new Uint8Array(1)], "large.wav");
    Object.defineProperty(file, "size", { value: 64 * 1024 * 1024 + 1 });
    const view = render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: { ...capability, hashFile } }));
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));
    await waitFor(() => expect(hashFile).toHaveBeenCalledTimes(1));

    const signal = hashFile.mock.calls[0]![1];
    view.unmount();
    expect(signal.aborted).toBe(true);
    finishHash("c".repeat(64));
    await Promise.resolve();

    expect(capability.client.createUploadSession).not.toHaveBeenCalled();
    expect(capability.client.uploadPart).not.toHaveBeenCalled();
  });

  it("reports authorization denial without retrying or completing", async () => {
    const capability = admittedCapability({ createUploadSession: vi.fn(async () => {
      throw Object.assign(new Error("private transport text"), { statusCode: 403 });
    }) });
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [new File(["abc"], "source.wav")] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));
    await screen.findByText(/Upload was denied by the current authenticated route/);
    expect(capability.client.createUploadSession).toHaveBeenCalledTimes(1);
    expect(capability.client.uploadPart).not.toHaveBeenCalled();
    expect(capability.client.completeUploadSession).not.toHaveBeenCalled();
    expect(screen.queryByText(/private transport text/)).toBeNull();
  });

  it("keeps a lost chunk acknowledgement UNKNOWN and does not replay or complete", async () => {
    const capability = admittedCapability({ uploadPart: vi.fn(async () => { throw new Error("ambiguous"); }) });
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [new File(["abc"], "source.wav")] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));
    await screen.findByText(/Upload outcome is unknown/);
    expect(capability.client.uploadPart).toHaveBeenCalledTimes(1);
    expect(capability.client.completeUploadSession).not.toHaveBeenCalled();
    expect(screen.getByText(/Inspect the same upload identity before any further command/)).toBeTruthy();
    expect(screen.getByText("Upload ID: upload-1")).toBeTruthy();
    expect(screen.getByText("Upload request identity: 11111111-1111-4111-8111-111111111111")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [new File(["abc"], "replacement.wav")] } });
    expect(capability.client.createUploadSession).toHaveBeenCalledTimes(1);
  });

  it("inspects the same caller-scoped upload after UNKNOWN without replaying mutations", async () => {
    const capability = admittedCapability({
      uploadPart: vi.fn(async () => { throw new Error("lost acknowledgement"); }),
      getUploadSession: vi.fn(async () => uploadSession({ status: "OPEN", bytesReceived: 3, nextChunkIndex: 1 })),
    });
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [new File(["abc"], "source.wav")] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));
    await screen.findByText(/Upload outcome is unknown/);
    fireEvent.click(screen.getByRole("button", { name: "Inspect same upload" }));

    expect(await screen.findByText("OPEN")).toBeTruthy();
    expect(screen.getByText("3", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText("Next chunk index").nextSibling?.textContent).toBe("1");
    expect(capability.client.getUploadSession).toHaveBeenCalledTimes(1);
    expect(capability.client.getUploadSession).toHaveBeenCalledWith("upload-1", expect.any(AbortSignal));
    expect(capability.client.uploadPart).toHaveBeenCalledTimes(1);
    expect(capability.client.completeUploadSession).not.toHaveBeenCalled();
    expect(capability.client.createUploadSession).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Inspect same upload" })).toBeTruthy();
  });

  it("sanitizes a concealed or failed same-upload inspection and keeps the mutation lock", async () => {
    const capability = admittedCapability({
      uploadPart: vi.fn(async () => { throw new Error("lost acknowledgement"); }),
      getUploadSession: vi.fn(async () => { throw Object.assign(new Error("private not-found detail"), { statusCode: 404 }); }),
    });
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [new File(["abc"], "source.wav")] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));
    await screen.findByText(/Upload outcome is unknown/);
    fireEvent.click(screen.getByRole("button", { name: "Inspect same upload" }));
    expect(await screen.findByText(/Upload inspection failed or was concealed/)).toBeTruthy();
    expect(screen.queryByText(/private not-found detail/)).toBeNull();
    expect(capability.client.getUploadSession).toHaveBeenCalledTimes(1);
    expect(capability.client.uploadPart).toHaveBeenCalledTimes(1);
    expect(capability.client.completeUploadSession).not.toHaveBeenCalled();
    expect(capability.client.createUploadSession).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Inspect same upload" })).toBeTruthy();
  });

  it("keeps ambiguous begin locked to its request identity when no upload ID was received", async () => {
    const capability = admittedCapability({ createUploadSession: vi.fn(async () => { throw new Error("lost begin acknowledgement"); }) });
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [new File(["abc"], "source.wav")] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));
    expect(await screen.findByText(/Begin-upload outcome is unknown and no upload ID was acknowledged/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Inspect same upload" })).toBeNull();
    expect(screen.getByText("Upload request identity: 11111111-1111-4111-8111-111111111111")).toBeTruthy();
    expect(capability.client.getUploadSession).not.toHaveBeenCalled();
    expect(capability.client.uploadPart).not.toHaveBeenCalled();
    expect(capability.client.completeUploadSession).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [new File(["abc"], "replacement.wav")] } });
    expect(capability.client.createUploadSession).toHaveBeenCalledTimes(1);
  });

  it("does not report buffered bytes as acknowledged while a chunk receipt is pending", async () => {
    let acknowledge!: (session: ArtifactUploadSession) => void;
    const capability = admittedCapability({ uploadPart: vi.fn(() => new Promise<ArtifactUploadSession>((resolve) => { acknowledge = resolve; })) });
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [new File(["abc"], "source.wav")] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));
    await waitFor(() => expect(capability.client.uploadPart).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Server-acknowledged transfer: 0 of 3 bytes.")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Server-acknowledged upload progress" }))
      .toHaveProperty("value", 0);
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [new File(["xyz"], "replacement.wav")] } });
    expect(capability.client.createUploadSession).toHaveBeenCalledTimes(1);
    acknowledge(uploadSession({ bytesReceived: 3, nextChunkIndex: 1 }));
    await screen.findByText(/Upload completion acknowledged/);
    expect(screen.getByRole("progressbar", { name: "Server-acknowledged upload progress" }))
      .toHaveProperty("value", 3);
  });
});
