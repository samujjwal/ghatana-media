import React from "react";
import {
  DevVisionHostError, describeVisionFailure, parseVisionTracksDocument,
  type DevVisionHostResponse, type DevVisionPort, type VisionTracksDocument,
} from "./devVisionTracks";
import { DevContentError, describeContentFailure, readVerifiedContent, type DevArtifactContentReader } from "./devArtifactContent";
import { VisionTrackOverlay } from "./VisionTrackOverlay";

export interface DevVisionTracksPanelProps {
  readonly vision: DevVisionPort;
  readonly locked?: boolean;
  /** Injectable for deterministic tests; must return a fresh opaque id per call. */
  readonly newRequestId?: () => string;
}

interface OutputView {
  readonly outputId: string;
  readonly replayed: boolean;
  readonly artifact: { readonly artifactVersionId: string; readonly sha256: string; readonly sizeBytes: number; readonly contentType: string };
  readonly sourceSha256: string;
}
type Phase = { readonly kind: "idle" } | { readonly kind: "busy"; readonly text: string }
  | { readonly kind: "done"; readonly text: string } | { readonly kind: "failed"; readonly tone: string; readonly code: string; readonly text: string };
interface Loaded {
  readonly view: OutputView;
  readonly document: VisionTracksDocument;
  readonly videoUrl: string;
  readonly via: "created" | "replayed" | "reopened";
}

let counter = 0;
const defaultRequestId = (): string => {
  const random = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${(counter++).toString(36)}`;
  return `ui-${random}`;
};

function parseOutputView(body: unknown): OutputView {
  const fail = (): never => { throw new DevVisionHostError("INVALID_RESPONSE", 200, "The host returned an unreadable vision output view."); };
  if (body === null || typeof body !== "object") return fail();
  const view = body as Record<string, unknown>;
  const artifact = view.artifact as Record<string, unknown> | undefined;
  const lineage = view.lineage as Record<string, unknown> | undefined;
  const source = lineage?.source as Record<string, unknown> | undefined;
  if (view.scope !== "DEV_ONLY" || typeof view.outputId !== "string" || !artifact || !source
    || typeof artifact.artifactVersionId !== "string" || typeof artifact.sha256 !== "string" || typeof artifact.sizeBytes !== "number"
    || artifact.contentType !== "application/json" || typeof source.sha256 !== "string" || lineage?.kind !== "LOCAL_VISION_TRACKS") return fail();
  return {
    outputId: view.outputId, replayed: view.replayed === true,
    artifact: { artifactVersionId: artifact.artifactVersionId, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes, contentType: artifact.contentType },
    sourceSha256: source.sha256,
  };
}

/**
 * DEV_ONLY video tracking page section: track an exact source video version, or reopen a registered tracks output by id.
 * The tracks document and the source video are shown only after their bytes verify against the registered SHA-256, and
 * the document's own source digest must equal the lineage's. Nothing here claims accuracy, rights or approval.
 */
export function DevVisionTracksPanel({ vision, locked = false, newRequestId = defaultRequestId }: DevVisionTracksPanelProps): React.ReactElement {
  const [form, setForm] = React.useState({ artifactId: "", artifactVersionId: "", maxFrames: "16" });
  const [reopenId, setReopenId] = React.useState("");
  const [phase, setPhase] = React.useState<Record<"track" | "reopen", Phase>>({ track: { kind: "idle" }, reopen: { kind: "idle" } });
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [pending, setPending] = React.useState(false);
  const attempt = React.useRef<{ readonly fingerprint: string; readonly requestId: string } | null>(null);
  const urlRef = React.useRef<string | null>(null);
  const reader: DevArtifactContentReader | null = vision.readArtifactContent ? { readArtifactContent: vision.readArtifactContent.bind(vision) } : null;
  const disabled = locked || pending;

  React.useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const setLane = (lane: "track" | "reopen", next: Phase): void => setPhase((current) => ({ ...current, [lane]: next }));

  async function load(response: DevVisionHostResponse, via: Loaded["via"], lane: "track" | "reopen"): Promise<void> {
    const view = parseOutputView(response.body);
    if (!reader) throw new DevContentError("CONTENT_UNAVAILABLE", 0, "This host exposes no DEV_ONLY content route to this page, so the tracks and the video cannot be verified or shown.");
    setLane(lane, { kind: "busy", text: "Verifying the registered tracks bytes…" });
    const output = await readVerifiedContent(reader, { artifactId: view.outputId, artifactVersionId: view.artifact.artifactVersionId, contentType: view.artifact.contentType, sizeBytes: view.artifact.sizeBytes, sha256: view.artifact.sha256 });
    let document: VisionTracksDocument;
    try {
      document = parseVisionTracksDocument(JSON.parse(new TextDecoder().decode(output.bytes)));
    } catch (error) {
      throw new DevVisionHostError("TRACKS_DOCUMENT_INVALID", 200, error instanceof Error ? error.message : "The tracks document is invalid.");
    }
    if (document.source.sha256 !== view.sourceSha256) {
      throw new DevVisionHostError("TRACKS_LINEAGE_MISMATCH", 200, "The tracks document names a different source digest than its registered lineage.");
    }
    setLane(lane, { kind: "busy", text: "Verifying the exact source video bytes…" });
    const video = await readVerifiedContent(reader, { artifactId: document.source.artifactId, artifactVersionId: document.source.artifactVersionId, contentType: document.source.contentType, sizeBytes: null, sha256: document.source.sha256 });
    const videoCopy = new Uint8Array(video.bytes.byteLength);
    videoCopy.set(video.bytes);
    const url = URL.createObjectURL(new Blob([videoCopy], { type: document.source.contentType }));
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = url;
    setLoaded({ view, document, videoUrl: url, via });
    setLane(lane, { kind: "done", text: `${via === "created" ? "Created (HTTP 201)" : via === "replayed" ? "Replayed (HTTP 200)" : `Reopened output ${view.outputId}`}: tracks and source video verified against their registered SHA-256.` });
  }

  const fail = (lane: "track" | "reopen", error: unknown): void => {
    const described = error instanceof DevContentError ? { ...describeContentFailure(error), tone: "refused" } : describeVisionFailure(error);
    setLane(lane, { kind: "failed", tone: described.tone, code: described.code, text: `${described.code}: ${described.text}` });
  };

  async function submitTrack(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const maxFrames = Number(form.maxFrames);
    if (!form.artifactId.trim() || !/^sha256:[0-9a-f]{64}$/u.test(form.artifactVersionId.trim()) || !Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > 64) {
      setLane("track", { kind: "failed", tone: "refused", code: "INVALID_REQUEST", text: "INVALID_REQUEST: enter the source artifact id, its exact version (sha256:…) and 1 to 64 frames. Nothing was sent." });
      return;
    }
    const fingerprint = `${form.artifactId.trim()}\u0000${form.artifactVersionId.trim()}\u0000${maxFrames}`;
    // The same inputs reuse one request id, so a retry after an unknown outcome cannot register twice.
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, requestId: newRequestId() };
    setPending(true);
    setLane("track", { kind: "busy", text: "Tracking the exact source version with the local model…" });
    try {
      const response = await vision.track({ requestId: attempt.current.requestId, artifactId: form.artifactId.trim(), artifactVersionId: form.artifactVersionId.trim(), maxFrames });
      await load(response, response.status === 200 ? "replayed" : "created", "track");
    } catch (error) {
      fail("track", error);
    } finally {
      setPending(false);
    }
  }

  async function reopen(): Promise<void> {
    const id = reopenId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) {
      setLane("reopen", { kind: "failed", tone: "refused", code: "INVALID_REQUEST", text: "INVALID_REQUEST: enter a valid output id. Nothing was requested." });
      return;
    }
    setPending(true);
    setLane("reopen", { kind: "busy", text: "Reopening the registered output from the host…" });
    try {
      await load(await vision.getOutput(id), "reopened", "reopen");
    } catch (error) {
      fail("reopen", error);
    } finally {
      setPending(false);
    }
  }

  const statusOf = (lane: "track" | "reopen"): React.ReactElement => {
    const state = phase[lane];
    return <p id={`vision-${lane}-status`} role={state.kind === "failed" ? "alert" : "status"} aria-live="polite" aria-atomic="true" aria-busy={state.kind === "busy"}
      data-state={state.kind} data-tone={state.kind === "failed" ? state.tone : undefined} data-failure={state.kind === "failed" ? state.code : undefined}>
      {state.kind === "idle" ? "Nothing requested." : state.text}
    </p>;
  };

  return <div className="dev-vision-tracks">
    <h2>Video tracking · DEV_ONLY</h2>
    <p role="note">Local Florence-2 detections on exact source frames, linked into tracks by a deterministic IoU-and-label matcher. Boxes are source-pixel coordinates bound to each frame&apos;s exact source PTS. This is not an accuracy, rights or approval claim.</p>
    <section aria-labelledby="vision-track-heading">
      <h3 id="vision-track-heading">Track a video</h3>
      <form onSubmit={(event) => void submitTrack(event)}>
        <label htmlFor="vision-artifact-id">Source artifact ID</label>
        <input id="vision-artifact-id" type="text" value={form.artifactId} disabled={disabled} onChange={(event) => setForm({ ...form, artifactId: event.currentTarget.value })} />
        <label htmlFor="vision-artifact-version">Exact source artifact version</label>
        <input id="vision-artifact-version" type="text" value={form.artifactVersionId} disabled={disabled} onChange={(event) => setForm({ ...form, artifactVersionId: event.currentTarget.value })} />
        <label htmlFor="vision-max-frames">Frames to sample (1 to 64)</label>
        <input id="vision-max-frames" type="text" inputMode="numeric" value={form.maxFrames} disabled={disabled} onChange={(event) => setForm({ ...form, maxFrames: event.currentTarget.value })} />
        <button type="submit" disabled={disabled}>Track exact source version</button>
      </form>
      {statusOf("track")}
    </section>
    <section aria-labelledby="vision-reopen-heading">
      <h3 id="vision-reopen-heading">Reopen tracks</h3>
      <label htmlFor="vision-output-id">Output ID</label>
      <input id="vision-output-id" type="text" value={reopenId} disabled={disabled} onChange={(event) => setReopenId(event.currentTarget.value)} />
      <button type="button" disabled={disabled} onClick={() => void reopen()}>Reopen tracks from the host</button>
      {statusOf("reopen")}
    </section>
    {loaded && <section id="vision-result" aria-label="Tracking result" data-output-id={loaded.view.outputId} data-via={loaded.via}>
      <dl>
        <dt>Output artifact</dt><dd>{loaded.view.outputId}</dd>
        <dt>SHA-256</dt><dd>{loaded.view.artifact.sha256}</dd>
        <dt>Source artifact</dt><dd>{loaded.document.source.artifactId}</dd>
        <dt>Source SHA-256</dt><dd>{loaded.document.source.sha256}</dd>
        <dt>Time base</dt><dd>{`${loaded.document.video.timeBase.num}/${loaded.document.video.timeBase.den}${loaded.document.video.variableFrameRate ? " (variable frame rate)" : ""}`}</dd>
        <dt>Sampled frames</dt><dd>{loaded.document.frames.length}</dd>
      </dl>
      <VisionTrackOverlay document={loaded.document} videoSrc={loaded.videoUrl} videoLabel={`Source video ${loaded.document.source.artifactId} with tracked object boxes`} />
    </section>}
  </div>;
}
