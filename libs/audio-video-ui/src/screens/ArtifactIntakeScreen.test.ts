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

describe("ArtifactIntakeScreen protected projection", () => {
  it.each(["loading", "denied", "unknown"] as const)("hides artifact details while workspace access is %s", (accessState) => {
    render(React.createElement(ArtifactIntakeScreen, {
      ...baseProps,
      intake: {
        view: "browse-media",
        accessState,
        workspaceName: "Private workspace",
        projectName: "Private project",
        message: "Private status detail",
        artifacts: [{ id: "private-artifact-id", name: "Private source.wav", version: "v9", integrity: "verified" }],
      },
    }));

    expect(screen.getByText(accessState === "loading"
      ? "Checking current workspace access…"
      : accessState === "denied"
        ? "Workspace access is unavailable. Artifact data is hidden until access is granted."
        : "Workspace access could not be confirmed. Artifact data is hidden.").getAttribute("data-state")).toBe(accessState);
    expect(screen.queryByText("Private workspace")).toBeNull();
    expect(screen.queryByText("Private project")).toBeNull();
    expect(screen.queryByText("Private status detail")).toBeNull();
    expect(screen.queryByText("Private source.wav")).toBeNull();
    expect(screen.queryByText("private-artifact-id")).toBeNull();
  });

  it("shows protected artifact details only after the host resolves access", () => {
    render(React.createElement(ArtifactIntakeScreen, {
      ...baseProps,
      intake: {
        view: "browse-media",
        accessState: "resolved",
        workspaceName: "Authorized workspace",
        projectName: "Authorized project",
        artifacts: [{ id: "authorized-artifact-id", name: "Authorized source.wav", version: "v2", integrity: "verified" }],
      },
    }));

    expect(screen.getByText("Authorized workspace · Authorized project")).toBeTruthy();
    expect(screen.getByText("Authorized source.wav · v2")).toBeTruthy();
    expect(screen.getByText("Artifact ID: authorized-artifact-id")).toBeTruthy();
  });
});

type TestArtifactUploadSession = ArtifactUploadSession & { readonly retention: string };
const uploadSession = (overrides: Partial<TestArtifactUploadSession> = {}): TestArtifactUploadSession => ({
  uploadId: "upload-1", tenantId: "tenant-1", principalId: "principal-1", fileName: "source.wav",
  contentType: "audio/wav", expectedSizeBytes: 3, expectedSha256: "0".repeat(64), classification: "INTERNAL",
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  retention: "PT24H", metadata: {}, bytesReceived: 0, nextChunkIndex: 0, status: "OPEN", ...overrides,
});

function admittedCapability(overrides: Partial<ArtifactUploadCapability["client"]> = {}): ArtifactUploadCapability {
  return {
    runtimeAdmission: "ADMITTED", classification: "INTERNAL", retention: "PT24H", maxChunkBytes: 8 * 1024 * 1024,
    client: {
      createUploadSession: vi.fn(async (request) => uploadSession({
        fileName: request.fileName,
        contentType: request.contentType,
        expectedSizeBytes: request.expectedSizeBytes,
        expectedSha256: request.expectedSha256,
        classification: request.classification,
        metadata: request.metadata ?? {},
      })),
      getUploadSession: vi.fn(async () => uploadSession()),
      uploadPart: vi.fn(async (session, _index, part) => uploadSession({
        ...session, bytesReceived: session.bytesReceived + part.size, nextChunkIndex: session.nextChunkIndex + 1,
      })),
      completeUploadSession: vi.fn(async () => ({
        tenantId: "tenant-1", principalId: "principal-1", artifactId: "artifact-1",
        fileName: "source.wav", contentType: "audio/wav", sizeBytes: 3,
        sha256: "0".repeat(64), objectReference: "opaque-object-ref", classification: "INTERNAL" as const,
        createdAt: "2026-11-07T00:00:00Z", expiresAt: "2026-11-08T00:00:00Z", metadata: {},
      })),
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
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps upload unavailable without a host capability", () => {
    render(React.createElement(ArtifactIntakeScreen, baseProps));
    expect(screen.getByText("Upload is not admitted by the current host.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload selected source" })).toBeNull();
  });

  it("uploads one selected source through the authenticated SDK and completes only the exact acknowledged session", async () => {
    const capability = admittedCapability();
    const onArtifactCompleted = vi.fn();
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability, onArtifactCompleted }));
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
    expect(onArtifactCompleted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ artifactId: "artifact-1" }));
    expect(screen.getByText(/Availability, rights, consent, and downstream use are not established/)).toBeTruthy();
  });

  it("does not send the first chunk when the created session is already expired", async () => {
    const createUploadSession = vi.fn(async (request) => uploadSession({
      fileName: request.fileName, contentType: request.contentType, expectedSizeBytes: request.expectedSizeBytes,
      expectedSha256: request.expectedSha256, classification: request.classification, metadata: request.metadata ?? {},
      expiresAt: "2020-01-01T00:00:00Z",
    }));
    const capability = admittedCapability({ createUploadSession });
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), {
      target: { files: [new File(["abc"], "source.wav", { type: "audio/wav" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));

    expect(await screen.findByText(/upload session expired before the next command/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Inspect same upload" })).toBeTruthy();
    expect(capability.client.createUploadSession).toHaveBeenCalledTimes(1);
    expect(capability.client.uploadPart).not.toHaveBeenCalled();
    expect(capability.client.completeUploadSession).not.toHaveBeenCalled();
  });

  it("does not finalize when the session expires after the last chunk acknowledgement", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const uploadPart = vi.fn(async (session: ArtifactUploadSession, _index: number, part: Blob) => {
      now += 2_000;
      return uploadSession({ ...session, bytesReceived: session.bytesReceived + part.size, nextChunkIndex: session.nextChunkIndex + 1 });
    });
    const createUploadSession = vi.fn(async (request) => uploadSession({
      fileName: request.fileName, contentType: request.contentType, expectedSizeBytes: request.expectedSizeBytes,
      expectedSha256: request.expectedSha256, classification: request.classification, metadata: request.metadata ?? {},
      expiresAt: new Date(now + 1_000).toISOString(),
    }));
    const capability = admittedCapability({ createUploadSession, uploadPart });
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), {
      target: { files: [new File(["abc"], "source.wav", { type: "audio/wav" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));

    expect(await screen.findByText(/upload session expired before the next command/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Inspect same upload" })).toBeTruthy();
    expect(uploadPart).toHaveBeenCalledTimes(1);
    expect(capability.client.completeUploadSession).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", new File([], "empty.wav")],
    ["above-pdp-limit", Object.defineProperty(new File([new Uint8Array(1)], "large.wav"), "size", { value: 2_147_483_649 })],
  ])("rejects %s input at the screen boundary without dispatch", async (_label, file) => {
    const capability = admittedCapability();
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));
    await screen.findByText(/outside the authenticated SDK upload size limits/);
    expect(capability.client.createUploadSession).not.toHaveBeenCalled();
  });

  it("lets the PDP-1 size ceiling reach the authenticated route", async () => {
    const maxBytes = 2_147_483_648;
    const createUploadSession = vi.fn(async () => { throw Object.assign(new Error("fixture denial"), { statusCode: 403 }); });
    const capability = {
      ...admittedCapability({ createUploadSession }),
      hashFile: vi.fn(async () => "a".repeat(64)),
    };
    const file = new File([new Uint8Array(1)], "large.wav", { type: "audio/wav" });
    Object.defineProperty(file, "size", { value: maxBytes });
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));

    await screen.findByText(/Upload was denied by the current authenticated route/u);
    expect(capability.hashFile).toHaveBeenCalledWith(file, expect.any(AbortSignal));
    expect(createUploadSession).toHaveBeenCalledWith(expect.objectContaining({ expectedSizeBytes: maxBytes }), expect.any(AbortSignal));
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
    expect(screen.getByText("upload-1", { selector: "code" })).toBeTruthy();
    expect(screen.getByText("11111111-1111-4111-8111-111111111111", { selector: "code" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [new File(["abc"], "replacement.wav")] } });
    expect(capability.client.createUploadSession).toHaveBeenCalledTimes(1);
  });

  it("inspects the same caller-scoped upload after UNKNOWN without replaying mutations", async () => {
    const capability = admittedCapability({
      uploadPart: vi.fn(async () => { throw new Error("lost acknowledgement"); }),
      getUploadSession: vi.fn(async () => uploadSession({ contentType: "application/octet-stream", status: "OPEN", bytesReceived: 3, nextChunkIndex: 1 })),
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
    expect(screen.getByRole("button", { name: "Resume from observed upload" })).toBeTruthy();
  });

  it("does not offer same-page UNKNOWN resume when persisted retention differs", async () => {
    const capability = admittedCapability({
      uploadPart: vi.fn(async () => { throw new Error("lost acknowledgement"); }),
      getUploadSession: vi.fn(async () => uploadSession({
        contentType: "application/octet-stream", retention: "P48H", status: "OPEN", bytesReceived: 3, nextChunkIndex: 1,
      })),
    });
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [new File(["abc"], "source.wav")] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));
    await screen.findByText(/Upload outcome is unknown/);
    fireEvent.click(screen.getByRole("button", { name: "Inspect same upload" }));

    await screen.findByText(/Upload inspection failed or was concealed/);
    expect(capability.client.getUploadSession).toHaveBeenCalledTimes(1);
    expect(capability.client.createUploadSession).toHaveBeenCalledTimes(1);
    expect(capability.client.uploadPart).toHaveBeenCalledTimes(1);
    expect(capability.client.completeUploadSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Resume from observed upload" })).toBeNull();
  });

  it("does not offer same-page UNKNOWN resume when the inspected session is expired", async () => {
    const capability = admittedCapability({
      uploadPart: vi.fn(async () => { throw new Error("lost acknowledgement"); }),
      getUploadSession: vi.fn(async () => uploadSession({
        contentType: "application/octet-stream", expiresAt: "2020-01-01T00:00:00Z",
        status: "OPEN", bytesReceived: 3, nextChunkIndex: 1,
      })),
    });
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [new File(["abc"], "source.wav")] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));
    await screen.findByText(/Upload outcome is unknown/);
    fireEvent.click(screen.getByRole("button", { name: "Inspect same upload" }));

    await screen.findByText(/Upload inspection failed or was concealed/);
    expect(capability.client.uploadPart).toHaveBeenCalledTimes(1);
    expect(capability.client.completeUploadSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Resume from observed upload" })).toBeNull();
  });

  it("rechecks expiry at same-page resume confirmation before sending another chunk", async () => {
    const now = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    const capability = admittedCapability({
      uploadPart: vi.fn(async () => { throw new Error("lost acknowledgement"); }),
      getUploadSession: vi.fn(async () => uploadSession({
        contentType: "application/octet-stream", expiresAt: new Date(now + 1_000).toISOString(),
        status: "OPEN", bytesReceived: 2, nextChunkIndex: 1,
      })),
    });
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [new File(["abc"], "source.wav")] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));
    await screen.findByText(/Upload outcome is unknown/);
    fireEvent.click(screen.getByRole("button", { name: "Inspect same upload" }));
    const resume = await screen.findByRole("button", { name: "Resume from observed upload" });
    dateNow.mockReturnValue(now + 1_001);

    fireEvent.click(resume);
    expect(await screen.findByText(/Upload inspection failed or was concealed/)).toBeTruthy();
    expect(capability.client.uploadPart).toHaveBeenCalledTimes(1);
    expect(capability.client.completeUploadSession).not.toHaveBeenCalled();
  });

  it("resumes only after inspection and starts from the server-acknowledged next chunk", async () => {
    const uploadPart = vi.fn(async () => { throw new Error("lost acknowledgement"); });
    const capability = admittedCapability({
      uploadPart,
      getUploadSession: vi.fn(async () => uploadSession({
        contentType: "application/octet-stream", status: "OPEN", bytesReceived: 3, nextChunkIndex: 1,
      })),
    });
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [new File(["abc"], "source.wav")] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));
    await screen.findByText(/Upload outcome is unknown/);
    fireEvent.click(screen.getByRole("button", { name: "Inspect same upload" }));
    await screen.findByRole("button", { name: "Resume from observed upload" });
    expect(uploadPart).toHaveBeenCalledTimes(1);
    expect(capability.client.completeUploadSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Resume from observed upload" }));
    await screen.findByText(/Upload completion acknowledged for artifact artifact-1/);
    expect(uploadPart).toHaveBeenCalledTimes(1);
    expect(capability.client.completeUploadSession).toHaveBeenCalledTimes(1);
  });

  it("replays only the exact retained completion session after observing COMPLETED", async () => {
    const complete = vi.fn()
      .mockRejectedValueOnce(new Error("lost completion acknowledgement"))
      .mockResolvedValueOnce({
        tenantId: "tenant-1", principalId: "principal-1", artifactId: "artifact-1",
        fileName: "source.wav", contentType: "audio/wav", sizeBytes: 3,
        sha256: "0".repeat(64), objectReference: "opaque-object-ref", classification: "INTERNAL" as const,
        createdAt: "2026-11-07T00:00:00Z", expiresAt: "2026-11-08T00:00:00Z", metadata: {},
      });
    const capability = admittedCapability({
      completeUploadSession: complete,
      getUploadSession: vi.fn(async () => uploadSession({ status: "COMPLETED", bytesReceived: 3, nextChunkIndex: 1 })),
    });
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), {
      target: { files: [new File(["abc"], "source.wav", { type: "audio/wav" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));
    await screen.findByText(/Upload outcome is unknown/);
    fireEvent.click(screen.getByRole("button", { name: "Inspect same upload" }));
    await screen.findByRole("button", { name: "Replay exact completion request" });
    expect(complete).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Replay exact completion request" }));
    await screen.findByText(/Upload completion acknowledged for artifact artifact-1/);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]![0]).toBe(complete.mock.calls[0]![0]);
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
    const onUploadStateChange = vi.fn();
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability, onUploadStateChange }));
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [new File(["abc"], "source.wav")] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));
    expect(await screen.findByText(/Begin-upload outcome is unknown and no upload ID was acknowledged/)).toBeTruthy();
    expect(onUploadStateChange).toHaveBeenCalledWith("pending");
    expect(onUploadStateChange).toHaveBeenCalledWith("reconciliation-required");
    expect(screen.queryByRole("button", { name: "Inspect same upload" })).toBeNull();
    expect(screen.getByText("11111111-1111-4111-8111-111111111111", { selector: "code" })).toBeTruthy();
    expect(capability.client.getUploadSession).not.toHaveBeenCalled();
    expect(capability.client.uploadPart).not.toHaveBeenCalled();
    expect(capability.client.completeUploadSession).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [new File(["abc"], "replacement.wav")] } });
    expect(capability.client.createUploadSession).toHaveBeenCalledTimes(1);
  });

  it("reconciles an unknown begin only on explicit user action with the exact retained request and key", async () => {
    const createUploadSession = vi.fn()
      .mockRejectedValueOnce(new Error("lost begin acknowledgement"))
      .mockResolvedValueOnce(uploadSession());
    const capability = admittedCapability({ createUploadSession });
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), {
      target: { files: [new File(["abc"], "source.wav", { type: "audio/wav" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));
    await screen.findByRole("button", { name: "Reconcile begin upload with same request" });

    expect(createUploadSession).toHaveBeenCalledTimes(1);
    expect(capability.client.uploadPart).not.toHaveBeenCalled();
    const originalRequest = createUploadSession.mock.calls[0]![0];
    expect(originalRequest).toMatchObject({
      fileName: "source.wav", contentType: "audio/wav", expectedSizeBytes: 3,
      expectedSha256: "0".repeat(64), idempotencyKey: "11111111-1111-4111-8111-111111111111",
    });

    fireEvent.click(screen.getByRole("button", { name: "Reconcile begin upload with same request" }));
    await screen.findByText(/Upload completion acknowledged for artifact artifact-1/);
    expect(createUploadSession).toHaveBeenCalledTimes(2);
    expect(createUploadSession.mock.calls[1]![0]).toBe(originalRequest);
    expect(createUploadSession.mock.calls[1]![0].idempotencyKey).toBe(originalRequest.idempotencyKey);
    expect(capability.client.uploadPart).toHaveBeenCalledTimes(1);
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
    acknowledge(uploadSession({ contentType: "application/octet-stream", bytesReceived: 3, nextChunkIndex: 1 }));
    await screen.findByText(/Upload completion acknowledged/);
    expect(screen.getByRole("progressbar", { name: "Server-acknowledged upload progress" }))
      .toHaveProperty("value", 3);
  });

  it("stops before the next chunk when the host withdraws upload admission", async () => {
    let acknowledgeFirstChunk!: (session: ArtifactUploadSession) => void;
    const capability = admittedCapability({
      uploadPart: vi.fn(() => new Promise<ArtifactUploadSession>((resolve) => { acknowledgeFirstChunk = resolve; })),
    });
    const view = render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    const file = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large-source.wav", { type: "audio/wav" });
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));
    await waitFor(() => expect(capability.client.uploadPart).toHaveBeenCalledTimes(1));

    view.rerender(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: undefined }));
    acknowledgeFirstChunk(uploadSession({ fileName: "large-source.wav", expectedSizeBytes: 5 * 1024 * 1024 + 1, bytesReceived: 5 * 1024 * 1024, nextChunkIndex: 1 }));

    await screen.findByText(/Upload stopped because the current host no longer admits the route/);
    expect(capability.client.uploadPart).toHaveBeenCalledTimes(1);
    expect(capability.client.completeUploadSession).not.toHaveBeenCalled();
  });

  it("uses the authenticated host chunk policy while keeping the five MiB client cap", async () => {
    const partSizes: number[] = [];
    const capability = {
      ...admittedCapability({
        uploadPart: vi.fn(async (session, _index, part) => {
          partSizes.push(part.size);
          return uploadSession({ ...session, bytesReceived: session.bytesReceived + part.size, nextChunkIndex: session.nextChunkIndex + 1 });
        }),
      }),
      maxChunkBytes: 4 * 1024 * 1024,
    };
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), {
      target: { files: [new File([new Uint8Array(4 * 1024 * 1024 + 1)], "policy-source.bin")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));

    await screen.findByText(/Upload completion acknowledged for artifact artifact-1/);
    expect(partSizes).toEqual([4 * 1024 * 1024, 1]);
  });

  it.each([0, 32 * 1024 * 1024 + 1, Number.MAX_SAFE_INTEGER])("rejects invalid injected host chunk policy %s before any upload request", async (maxChunkBytes) => {
    const capability = { ...admittedCapability(), maxChunkBytes };
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), {
      target: { files: [new File(["abc"], "invalid-policy.bin")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));

    await screen.findByText(/did not provide a valid upload chunk limit/);
    expect(capability.client.createUploadSession).not.toHaveBeenCalled();
    expect(capability.client.uploadPart).not.toHaveBeenCalled();
  });

  it("resumes from observed bytes and chunk index after the host chunk policy changes", async () => {
    const fileSize = 6 * 1024 * 1024;
    const partCalls: Array<{ index: number; size: number }> = [];
    const uploadCapability = {
      ...admittedCapability({
        uploadPart: vi.fn(async (session, index, part) => {
          partCalls.push({ index, size: part.size });
          if (partCalls.length === 1) throw new Error("lost chunk acknowledgement");
          return uploadSession({ ...session, bytesReceived: session.bytesReceived + part.size, nextChunkIndex: session.nextChunkIndex + 1 });
        }),
        getUploadSession: vi.fn(async () => uploadSession({
          fileName: "changing-policy.bin", contentType: "application/octet-stream", expectedSizeBytes: fileSize,
          expectedSha256: "0".repeat(64), classification: "INTERNAL", metadata: {},
          bytesReceived: 2 * 1024 * 1024, nextChunkIndex: 1,
        })),
      }),
      maxChunkBytes: 2 * 1024 * 1024,
    };
    const view = render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability }));
    fireEvent.change(screen.getByLabelText("Choose source media"), {
      target: { files: [new File([new Uint8Array(fileSize)], "changing-policy.bin")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected source" }));
    await screen.findByText(/Upload outcome is unknown/);
    fireEvent.click(screen.getByRole("button", { name: "Inspect same upload" }));
    await screen.findByRole("button", { name: "Resume from observed upload" });

    view.rerender(React.createElement(ArtifactIntakeScreen, {
      ...baseProps,
      uploadCapability: { ...uploadCapability, maxChunkBytes: 1024 * 1024 },
    }));
    fireEvent.click(screen.getByRole("button", { name: "Resume from observed upload" }));
    await screen.findByText(/Upload completion acknowledged for artifact artifact-1/);
    expect(partCalls).toEqual([
      { index: 0, size: 2 * 1024 * 1024 },
      { index: 1, size: 1024 * 1024 },
      { index: 2, size: 1024 * 1024 },
      { index: 3, size: 1024 * 1024 },
      { index: 4, size: 1024 * 1024 },
    ]);
  });

  const recoveryMetadata = { purpose: "dev-recovery" };
  const recoveryDigest = "a".repeat(64);
  const recoverySession = (overrides: Partial<TestArtifactUploadSession> = {}): TestArtifactUploadSession => {
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 3_540_000).toISOString();
    return uploadSession({
      fileName: "source.wav", contentType: "audio/wav", expectedSizeBytes: 6,
      expectedSha256: recoveryDigest, classification: "INTERNAL", retention: "PT1H",
      createdAt, expiresAt, metadata: recoveryMetadata, bytesReceived: 2, nextChunkIndex: 1,
      ...overrides,
    });
  };
  const recoveryCapability = (
    session: TestArtifactUploadSession,
    overrides: Partial<ArtifactUploadCapability> = {},
    clientOverrides: Partial<ArtifactUploadCapability["client"]> = {},
  ): ArtifactUploadCapability => ({
    ...admittedCapability({
      getUploadSession: vi.fn(async () => session),
      uploadPart: vi.fn(async (observed, _index, part) => uploadSession({
        ...observed, bytesReceived: observed.bytesReceived + part.size,
        nextChunkIndex: observed.nextChunkIndex + 1,
      })),
      ...clientOverrides,
    }),
    retention: "PT1H",
    metadata: recoveryMetadata,
    hashFile: vi.fn(async () => recoveryDigest),
    ...overrides,
  });
  const prepareRecovery = async (capability: ArtifactUploadCapability): Promise<File> => {
    const file = new File(["abcdef"], "source.wav", { type: "audio/wav" });
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Existing upload ID to recover"), { target: { value: "upload-1" } });
    fireEvent.change(screen.getByLabelText("Choose source file for recovery"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Inspect existing upload" }));
    return file;
  };

  it("reconciles the exact caller-scoped upload after a fresh screen and requires one explicit resume confirmation", async () => {
    const session = recoverySession({ retention: "P1D" });
    const getUploadSession = vi.fn(async () => session);
    const uploadPart = vi.fn(async (observed: ArtifactUploadSession, _index: number, part: Blob) => uploadSession({
      ...observed, bytesReceived: observed.bytesReceived + part.size,
      nextChunkIndex: observed.nextChunkIndex + 1,
    }));
    const completeUploadSession = vi.fn(async () => ({
      tenantId: "tenant-1", principalId: "principal-1", artifactId: "artifact-1",
      fileName: "source.wav", contentType: "audio/wav", sizeBytes: 6,
      sha256: recoveryDigest, objectReference: "opaque-object-ref", classification: "INTERNAL" as const,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), metadata: recoveryMetadata,
    }));
    const capability = recoveryCapability(session, { retention: "PT24H" }, {
      getUploadSession, uploadPart, completeUploadSession,
    });
    const file = await prepareRecovery(capability);

    await screen.findByText(/The same caller-scoped upload, file digest, metadata, retention, unexpired session/);
    expect(getUploadSession).toHaveBeenCalledWith("upload-1", expect.any(AbortSignal));
    expect(capability.hashFile).toHaveBeenCalledWith(file, expect.any(AbortSignal));
    expect(capability.client.createUploadSession).not.toHaveBeenCalled();
    expect(uploadPart).not.toHaveBeenCalled();
    expect(completeUploadSession).not.toHaveBeenCalled();

    const resume = screen.getByRole("button", { name: "Resume from observed upload" });
    fireEvent.click(resume);
    fireEvent.click(resume);
    await screen.findByText(/Upload completion acknowledged for artifact artifact-1/);
    expect(uploadPart).toHaveBeenCalledTimes(1);
    expect(uploadPart).toHaveBeenCalledWith(session, 1, expect.any(Blob), { signal: expect.any(AbortSignal) });
    expect((uploadPart.mock.calls[0]?.[2] as Blob).size).toBe(4);
    expect(completeUploadSession).toHaveBeenCalledTimes(1);
    expect(capability.client.createUploadSession).not.toHaveBeenCalled();
  });

  it.each([0, Number.NaN, 32 * 1024 * 1024 + 1])("does not inspect or resume an existing upload with invalid chunk limit %s", async (maxChunkBytes) => {
    const getUploadSession = vi.fn(async () => recoverySession());
    const uploadPart = vi.fn();
    const completeUploadSession = vi.fn();
    const capability = recoveryCapability(recoverySession(), { maxChunkBytes }, {
      getUploadSession, uploadPart, completeUploadSession,
    });

    await prepareRecovery(capability);

    await screen.findByText(/verified host did not provide a valid upload chunk limit\. No recovery request was sent/);
    expect(getUploadSession).not.toHaveBeenCalled();
    expect(capability.client.createUploadSession).not.toHaveBeenCalled();
    expect(uploadPart).not.toHaveBeenCalled();
    expect(completeUploadSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Resume from observed upload" })).toBeNull();
  });

  it.each([
    ["digest", recoverySession({ expectedSha256: "b".repeat(64) }), "PT1H", recoveryMetadata],
    ["metadata", recoverySession({ metadata: { purpose: "different" } }), "PT1H", recoveryMetadata],
    ["retention", recoverySession({ retention: "P7D" }), "PT1H", recoveryMetadata],
  ] as const)("does not authorize recovery when the observed %s differs", async (_field, session, retention, metadata) => {
    const capability = recoveryCapability(session, { retention, metadata });
    await prepareRecovery(capability);
    await screen.findByText(/No mutation is authorized/);
    expect(capability.client.getUploadSession).toHaveBeenCalledTimes(1);
    expect(capability.client.createUploadSession).not.toHaveBeenCalled();
    expect(capability.client.uploadPart).not.toHaveBeenCalled();
    expect(capability.client.completeUploadSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Resume from observed upload" })).toBeNull();
  });

  it.each([
    ["unknown read", vi.fn(async () => { throw new Error("unavailable"); })],
    ["wrong scope", vi.fn(async () => { throw new TypeError("session is outside the authenticated tenant/principal scope"); })],
  ] as const)("fails closed after an %s", async (_case, getUploadSession) => {
    const capability = recoveryCapability(recoverySession(), {}, { getUploadSession });
    await prepareRecovery(capability);
    await screen.findByText(/outcome remains unknown; no mutation is authorized/);
    expect(capability.client.createUploadSession).not.toHaveBeenCalled();
    expect(capability.client.uploadPart).not.toHaveBeenCalled();
    expect(capability.client.completeUploadSession).not.toHaveBeenCalled();
  });

  it.each(["COMPLETED", "EXPIRED", "FINALIZING"] as const)("does not offer recovery for a non-OPEN %s upload", async (status) => {
    const capability = recoveryCapability(recoverySession({ status }));
    await prepareRecovery(capability);
    await screen.findByText(new RegExp(`observed upload is ${status}`));
    expect(capability.client.createUploadSession).not.toHaveBeenCalled();
    expect(capability.client.uploadPart).not.toHaveBeenCalled();
    expect(capability.client.completeUploadSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Resume from observed upload" })).toBeNull();
  });

  it("fails closed with the exact DTO limitation when retention is absent", async () => {
    const { retention: _omittedRetention, ...sessionWithoutRetention } = recoverySession();
    const capability = recoveryCapability(sessionWithoutRetention as unknown as TestArtifactUploadSession);
    await prepareRecovery(capability);
    await screen.findByText(/canonical session DTO must include retention; expiry is a separate upload-session limit/);
    expect(capability.client.createUploadSession).not.toHaveBeenCalled();
    expect(capability.client.uploadPart).not.toHaveBeenCalled();
    expect(capability.client.completeUploadSession).not.toHaveBeenCalled();
  });

  it("does not resume an upload whose separate session expiry is no longer in the future", async () => {
    const capability = recoveryCapability(recoverySession({ expiresAt: "2020-01-01T00:00:00Z" }));
    await prepareRecovery(capability);
    await screen.findByText(/session has expired or has an invalid expiry/);
    expect(capability.client.createUploadSession).not.toHaveBeenCalled();
    expect(capability.client.uploadPart).not.toHaveBeenCalled();
    expect(capability.client.completeUploadSession).not.toHaveBeenCalled();
  });

  it("clears and aborts in-flight recovery inspection when the host capability changes", async () => {
    let finishRead!: (session: TestArtifactUploadSession) => void;
    let requestSignal!: AbortSignal;
    const capability = recoveryCapability(recoverySession(), {}, {
      getUploadSession: vi.fn((_uploadId: string, signal?: AbortSignal) => {
        requestSignal = signal!;
        return new Promise<TestArtifactUploadSession>((resolve) => { finishRead = resolve; });
      }),
    });
    const view = render(React.createElement(ArtifactIntakeScreen, { ...baseProps, uploadCapability: capability }));
    fireEvent.change(screen.getByLabelText("Existing upload ID to recover"), { target: { value: "upload-1" } });
    fireEvent.change(screen.getByLabelText("Choose source file for recovery"), {
      target: { files: [new File(["abcdef"], "source.wav", { type: "audio/wav" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Inspect existing upload" }));
    await screen.findByText(/Inspecting this upload ID under current caller scope/);

    view.rerender(React.createElement(ArtifactIntakeScreen, {
      ...baseProps,
      uploadCapability: { ...capability, maxChunkBytes: capability.maxChunkBytes - 1 },
    }));

    await screen.findByText("Enter an existing upload ID and reselect one source file before inspection is available.");
    expect(requestSignal.aborted).toBe(true);
    finishRead(recoverySession());
    await waitFor(() => expect(screen.queryByText(/Inspecting this upload ID under current caller scope/)).toBeNull());
  });
});
