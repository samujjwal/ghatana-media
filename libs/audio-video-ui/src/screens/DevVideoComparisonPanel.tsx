import React from "react";
import {
  DevVideoHostError, describeVideoFailure, formatDb, formatSigned, formatSsim, parseVideoComparisonDocument,
  type DevVideoHostResponse, type DevVideoPort, type VideoComparisonDocument,
} from "./devVideoComparison";
import { DevContentError, describeContentFailure, readVerifiedContent, type DevArtifactContentReader } from "./devArtifactContent";
import { VideoWipeComparison } from "./VideoWipeComparison";

export interface DevVideoComparisonPanelProps {
  readonly video: DevVideoPort;
  readonly locked?: boolean;
  /** Injectable for deterministic tests; must return a fresh opaque id per call. */
  readonly newRequestId?: () => string;
}

type Lane = "compare" | "reopen";
type Phase = { readonly kind: "idle" } | { readonly kind: "busy"; readonly text: string }
  | { readonly kind: "done"; readonly text: string } | { readonly kind: "failed"; readonly tone: string; readonly code: string; readonly text: string };
interface Loaded {
  readonly outputId: string;
  readonly sha256: string;
  readonly document: VideoComparisonDocument;
  readonly urls: Readonly<Record<string, string>>;
  readonly via: "created" | "replayed" | "reopened";
}

let counter = 0;
const defaultRequestId = (): string => {
  const random = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${(counter++).toString(36)}`;
  return `ui-${random}`;
};

const VERSION = /^sha256:[0-9a-f]{64}$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

interface OutputView {
  readonly outputId: string;
  readonly artifact: { readonly artifactVersionId: string; readonly sha256: string; readonly sizeBytes: number; readonly contentType: string };
  readonly sources: readonly string[];
}

function parseOutputView(body: unknown): OutputView {
  const fail = (): never => { throw new DevVideoHostError("INVALID_RESPONSE", 200, "The host returned an unreadable comparison view."); };
  if (body === null || typeof body !== "object") return fail();
  const view = body as Record<string, unknown>;
  const artifact = view.artifact as Record<string, unknown> | undefined;
  const lineage = view.lineage as Record<string, unknown> | undefined;
  if (view.scope !== "DEV_ONLY" || typeof view.outputId !== "string" || !artifact || !lineage
    || typeof artifact.artifactVersionId !== "string" || typeof artifact.sha256 !== "string" || typeof artifact.sizeBytes !== "number"
    || artifact.contentType !== "application/json" || lineage.kind !== "VIDEO_QUALITY_COMPARISON" || !Array.isArray(lineage.sources)) return fail();
  const sources = (lineage.sources as unknown[]).map((entry) => (entry as { sha256?: unknown } | null)?.sha256);
  if (sources.some((entry) => typeof entry !== "string")) return fail();
  return { outputId: view.outputId, artifact: { artifactVersionId: artifact.artifactVersionId, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes, contentType: artifact.contentType }, sources: sources as string[] };
}

/**
 * DEV_ONLY comparison page section: measure one or two video versions against an optional clean reference, or reopen
 * a registered comparison by id. The comparison document and every video are shown only after their bytes verify
 * against the registered SHA-256, and the document's subject digests must equal its registered lineage. Numbers are
 * luma PSNR/SSIM and no-reference estimates; a regression is reported exactly like an improvement.
 */
export function DevVideoComparisonPanel({ video, locked = false, newRequestId = defaultRequestId }: DevVideoComparisonPanelProps): React.ReactElement {
  const [form, setForm] = React.useState({ referenceId: "", referenceVersion: "", baselineId: "", baselineVersion: "", candidateId: "", candidateVersion: "" });
  const [reopenId, setReopenId] = React.useState("");
  const [phase, setPhase] = React.useState<Record<Lane, Phase>>({ compare: { kind: "idle" }, reopen: { kind: "idle" } });
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [pending, setPending] = React.useState(false);
  const attempt = React.useRef<{ readonly fingerprint: string; readonly requestId: string } | null>(null);
  const urlsRef = React.useRef<readonly string[]>([]);
  const reader: DevArtifactContentReader | null = video.readArtifactContent ? { readArtifactContent: video.readArtifactContent.bind(video) } : null;
  const disabled = locked || pending;

  React.useEffect(() => () => { for (const url of urlsRef.current) URL.revokeObjectURL(url); }, []);
  const setLane = (lane: Lane, next: Phase): void => setPhase((current) => ({ ...current, [lane]: next }));

  async function load(response: DevVideoHostResponse, via: Loaded["via"], lane: Lane): Promise<void> {
    const view = parseOutputView(response.body);
    if (!reader) throw new DevContentError("CONTENT_UNAVAILABLE", 0, "This host exposes no DEV_ONLY content route to this page, so the comparison and the videos cannot be verified or shown.");
    setLane(lane, { kind: "busy", text: "Verifying the registered comparison bytes…" });
    const output = await readVerifiedContent(reader, { artifactId: view.outputId, artifactVersionId: view.artifact.artifactVersionId, contentType: view.artifact.contentType, sizeBytes: view.artifact.sizeBytes, sha256: view.artifact.sha256 });
    let document: VideoComparisonDocument;
    try {
      document = parseVideoComparisonDocument(JSON.parse(new TextDecoder().decode(output.bytes)));
    } catch (error) {
      throw new DevVideoHostError("COMPARISON_DOCUMENT_INVALID", 200, error instanceof Error ? error.message : "The comparison document is invalid.");
    }
    const documentDigests = document.subjects.map((subject) => subject.source.sha256);
    if (documentDigests.length !== view.sources.length || documentDigests.some((digest, index) => digest !== view.sources[index])) {
      throw new DevVideoHostError("COMPARISON_LINEAGE_MISMATCH", 200, "The comparison document names different source digests than its registered lineage.");
    }
    const urls: Record<string, string> = {};
    const created: string[] = [];
    try {
      for (const subject of document.subjects.slice(0, 2)) {
        setLane(lane, { kind: "busy", text: `Verifying the exact bytes of ${subject.label}…` });
        const bytes = await readVerifiedContent(reader, { artifactId: subject.source.artifactId, artifactVersionId: subject.source.artifactVersionId, contentType: subject.source.contentType, sizeBytes: null, sha256: subject.source.sha256 });
        const copy = new Uint8Array(bytes.bytes.byteLength);
        copy.set(bytes.bytes);
        const url = URL.createObjectURL(new Blob([copy], { type: subject.source.contentType }));
        created.push(url);
        urls[subject.label] = url;
      }
    } catch (error) {
      for (const url of created) URL.revokeObjectURL(url);
      throw error;
    }
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = created;
    setLoaded({ outputId: view.outputId, sha256: view.artifact.sha256, document, urls, via });
    setLane(lane, { kind: "done", text: `${via === "created" ? "Measured (HTTP 201)" : via === "replayed" ? "Replayed (HTTP 200)" : `Reopened comparison ${view.outputId}`}: comparison and videos verified against their registered SHA-256.` });
  }

  const fail = (lane: Lane, error: unknown): void => {
    const described = error instanceof DevContentError ? { ...describeContentFailure(error), tone: "refused" } : describeVideoFailure(error);
    setLane(lane, { kind: "failed", tone: described.tone, code: described.code, text: `${described.code}: ${described.text}` });
  };

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const t = (value: string): string => value.trim();
    const hasReference = t(form.referenceId) !== "" || t(form.referenceVersion) !== "";
    const subjects = [
      { label: "baseline", id: t(form.baselineId), version: t(form.baselineVersion) },
      { label: "candidate", id: t(form.candidateId), version: t(form.candidateVersion) },
    ];
    const invalid = subjects.some((s) => !OPAQUE.test(s.id) || !VERSION.test(s.version))
      || (hasReference && (!OPAQUE.test(t(form.referenceId)) || !VERSION.test(t(form.referenceVersion))));
    if (invalid) {
      setLane("compare", { kind: "failed", tone: "refused", code: "INVALID_REQUEST", text: "INVALID_REQUEST: enter the baseline and candidate artifact ids with their exact versions (sha256:…); a reference needs both fields. Nothing was sent." });
      return;
    }
    const fingerprint = JSON.stringify([form.referenceId, form.referenceVersion, subjects]);
    // The same inputs reuse one request id, so a retry after an unknown outcome cannot register twice.
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, requestId: newRequestId() };
    setPending(true);
    setLane("compare", { kind: "busy", text: "Measuring every frame of the exact versions…" });
    try {
      const response = await video.compare({
        requestId: attempt.current.requestId,
        ...(hasReference ? { reference: { artifactId: t(form.referenceId), artifactVersionId: t(form.referenceVersion) } } : {}),
        subjects: subjects.map((s) => ({ label: s.label, artifactId: s.id, artifactVersionId: s.version })),
      });
      await load(response, response.status === 200 ? "replayed" : "created", "compare");
    } catch (error) {
      fail("compare", error);
    } finally {
      setPending(false);
    }
  }

  async function reopen(): Promise<void> {
    const id = reopenId.trim();
    if (!OPAQUE.test(id)) {
      setLane("reopen", { kind: "failed", tone: "refused", code: "INVALID_REQUEST", text: "INVALID_REQUEST: enter a valid output id. Nothing was requested." });
      return;
    }
    setPending(true);
    setLane("reopen", { kind: "busy", text: "Reopening the registered comparison from the host…" });
    try {
      await load(await video.getComparison(id), "reopened", "reopen");
    } catch (error) {
      fail("reopen", error);
    } finally {
      setPending(false);
    }
  }

  const statusOf = (lane: Lane): React.ReactElement => {
    const state = phase[lane];
    return <p id={`video-${lane}-status`} role={state.kind === "failed" ? "alert" : "status"} aria-live="polite" aria-atomic="true" aria-busy={state.kind === "busy"}
      data-state={state.kind} data-tone={state.kind === "failed" ? state.tone : undefined} data-failure={state.kind === "failed" ? state.code : undefined}>
      {state.kind === "idle" ? "Nothing requested." : state.text}
    </p>;
  };

  const field = (id: string, label: string, key: keyof typeof form): React.ReactElement =>
    <><label htmlFor={id}>{label}</label>
      <input id={id} type="text" value={form[key]} disabled={disabled} onChange={(event) => setForm({ ...form, [key]: event.currentTarget.value })} /></>;

  return <div className="dev-video-comparison">
    <h2>Video comparison · DEV_ONLY</h2>
    <p role="note">Luma PSNR and SSIM per frame against a clean reference (frames paired by exact presentation time) plus no-reference noise and sharpness estimates, computed by the host independently of the encoder. A regression is shown like any other result. This is not a perceptual, rights, approval or production claim.</p>
    <section aria-labelledby="video-compare-heading">
      <h3 id="video-compare-heading">Measure two versions</h3>
      <form onSubmit={(event) => void submit(event)}>
        {field("video-reference-id", "Clean reference artifact ID (optional)", "referenceId")}
        {field("video-reference-version", "Clean reference exact version (optional)", "referenceVersion")}
        {field("video-baseline-id", "Baseline artifact ID", "baselineId")}
        {field("video-baseline-version", "Baseline exact version", "baselineVersion")}
        {field("video-candidate-id", "Candidate artifact ID", "candidateId")}
        {field("video-candidate-version", "Candidate exact version", "candidateVersion")}
        <button type="submit" disabled={disabled}>Measure exact versions</button>
      </form>
      {statusOf("compare")}
    </section>
    <section aria-labelledby="video-reopen-heading">
      <h3 id="video-reopen-heading">Reopen a comparison</h3>
      <label htmlFor="video-output-id">Output ID</label>
      <input id="video-output-id" type="text" value={reopenId} disabled={disabled} onChange={(event) => setReopenId(event.currentTarget.value)} />
      <button type="button" disabled={disabled} onClick={() => void reopen()}>Reopen comparison from the host</button>
      {statusOf("reopen")}
    </section>
    {loaded && <section id="video-result" aria-label="Comparison result" data-output-id={loaded.outputId} data-via={loaded.via}>
      <dl>
        <dt>Comparison artifact</dt><dd>{loaded.outputId}</dd>
        <dt>SHA-256</dt><dd>{loaded.sha256}</dd>
        <dt>Reference</dt><dd>{loaded.document.reference ? `${loaded.document.reference.artifactId} (${loaded.document.reference.sha256})` : "none (no-reference estimates only)"}</dd>
      </dl>
      <table aria-label="Measured aggregates">
        <thead><tr><th scope="col">Subject</th><th scope="col">Aligned frames</th><th scope="col">Mean PSNR</th><th scope="col">Mean SSIM</th><th scope="col">Noise sigma</th><th scope="col">Laplacian variance</th></tr></thead>
        <tbody>{loaded.document.subjects.map((subject) => <tr key={subject.label} data-subject={subject.label}>
          <th scope="row">{subject.label}</th>
          <td>{subject.againstReference ? `${subject.againstReference.alignedFrames} of ${subject.video.frameCount}${subject.againstReference.fullyAligned ? "" : " (not all aligned)"}` : "n/a"}</td>
          <td>{formatDb(subject.againstReference?.meanPsnrY ?? null)}</td><td>{formatSsim(subject.againstReference?.meanSsimY ?? null)}</td>
          <td>{subject.noReference.meanNoiseSigmaY.toFixed(2)}</td><td>{subject.noReference.meanLaplacianVarianceY.toFixed(1)}</td>
        </tr>)}</tbody>
      </table>
      {loaded.document.comparisons.map((delta) => <p key={delta.subject} data-verdict={delta.verdict} className="video-delta">
        {`${delta.subject} vs ${delta.baseline}: ${delta.verdict}${delta.meanPsnrYDeltaDb !== null ? `, PSNR ${formatSigned(delta.meanPsnrYDeltaDb, 2, " dB")}, SSIM ${formatSigned(delta.meanSsimYDelta, 4, "")}` : ""}`}
      </p>)}
      <VideoWipeComparison document={loaded.document} videoUrls={loaded.urls} />
    </section>}
  </div>;
}
