import React from "react";
import type {
  CanonicalMediaUploadSessionObservation,
  CreateUploadSessionRequest,
  MediaOperationClient,
} from "@audio-video/client/operations";
import { MediaTaskScreen, type MediaTaskScreenProps } from "./MediaTaskScreen";
import { EmptyState, FileUpload } from "../foundations";

export type ArtifactIntakeView = "browse-media" | "import-media" | "job-status" | "inspect-media";

export interface ArtifactIntakeProjection {
  readonly view: ArtifactIntakeView;
  readonly workspaceName?: string;
  readonly projectName?: string;
  readonly artifacts?: readonly {
    readonly id: string;
    readonly name: string;
    readonly version?: string;
    readonly integrity?: string;
    readonly availability?: string;
  }[];
  readonly sourceName?: string;
  readonly uploadId?: string;
  readonly acknowledgedTransfer?: string;
  readonly integrity?: string;
  readonly verificationJobId?: string;
  readonly verificationState?: string;
  readonly message?: string;
}

export interface ArtifactIntakeScreenProps extends Omit<MediaTaskScreenProps, "children"> {
  readonly intake: ArtifactIntakeProjection;
  /** Reports local selection to the host; admitted upload effects use the authenticated SDK capability below. */
  readonly onSourceFilesSelected?: (files: readonly File[]) => void;
  /** Current authenticated SDK capability supplied by the product host. No capability means no upload dispatch. */
  readonly uploadCapability?: ArtifactUploadCapability;
}

export type ArtifactUploadSession = CanonicalMediaUploadSessionObservation;

export interface ArtifactUploadCapability {
  /** Host assertion that this route is currently admitted; source and policy checks remain host responsibilities. */
  readonly runtimeAdmission: "ADMITTED";
  readonly classification: CreateUploadSessionRequest["classification"];
  readonly retention: CreateUploadSessionRequest["retention"];
  readonly metadata?: CreateUploadSessionRequest["metadata"];
  /** Optional host supplied incremental SHA-256 implementation for files above the bounded WebCrypto fallback. */
  readonly hashFile?: (file: File, signal: AbortSignal) => Promise<string>;
  readonly client: Pick<MediaOperationClient, "createUploadSession" | "uploadPart" | "completeUploadSession" | "getUploadSession">;
}

type IntakeTransfer = { readonly state: "idle" | "uploading" | "complete" | "denied" | "unknown" | "unavailable"; readonly code?: "HASHING_UNAVAILABLE"; readonly message: string };
type UploadInspection =
  | { readonly state: "loading" }
  | { readonly state: "observed"; readonly session: ArtifactUploadSession }
  | { readonly state: "failed" };
const UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;
// WebCrypto has no incremental digest API. This is only the fallback's one-shot
// allocation bound; the canonical SDK retains its 1 GiB request limit.
const MAX_ONE_SHOT_HASH_BYTES = 64 * 1024 * 1024;

/** Candidate J-02 screen body. Host-injected uploads use the authenticated SDK and report only receipts. */
export function ArtifactIntakeScreen({ intake, onSourceFilesSelected, uploadCapability, ...flow }: ArtifactIntakeScreenProps): React.ReactElement {
  const [selectedFileCount, setSelectedFileCount] = React.useState<number | undefined>();
  const [selectedFile, setSelectedFile] = React.useState<File | undefined>();
  const [transfer, setTransfer] = React.useState<IntakeTransfer | undefined>();
  const [acknowledgedBytes, setAcknowledgedBytes] = React.useState(0);
  const [uploadId, setUploadId] = React.useState<string | undefined>();
  const [requestKey, setRequestKey] = React.useState<string | undefined>();
  const [inspection, setInspection] = React.useState<UploadInspection | undefined>();
  const [locked, setLocked] = React.useState(false);
  const controller = React.useRef<AbortController | undefined>();
  React.useEffect(() => () => controller.current?.abort(), []);

  const startUpload = async (): Promise<void> => {
    if (!uploadCapability || uploadCapability.runtimeAdmission !== "ADMITTED" || !selectedFile || locked) return;
    const hashFile = uploadCapability.hashFile;
    const subtleCrypto = globalThis.crypto?.subtle;
    if (selectedFile.size < 1 || selectedFile.size > 1_073_741_824) {
      setTransfer({ state: "denied", message: "This source is outside the authenticated SDK upload size limits." });
      return;
    }
    if (!globalThis.crypto?.randomUUID) {
      setTransfer({ state: "denied", message: "Secure upload request identity is unavailable in this browser." });
      return;
    }
    if (!hashFile && selectedFile.size > MAX_ONE_SHOT_HASH_BYTES) {
      setTransfer({ state: "unavailable", code: "HASHING_UNAVAILABLE", message: "A bounded SHA-256 provider is required for this file size. No upload request was sent." });
      return;
    }
    if (!hashFile && !subtleCrypto) {
      setTransfer({ state: "unavailable", code: "HASHING_UNAVAILABLE", message: "Browser SHA-256 is unavailable. No upload request was sent." });
      return;
    }
    setLocked(true);
    setTransfer({ state: "uploading", message: "Preparing the selected source for the admitted upload route." });
    const abortController = new AbortController();
    controller.current = abortController;
    let phase: "hashing" | "begin" | "chunks" | "complete" = "hashing";
    let confirmedUploadId: string | undefined;
    try {
      const computedSha256 = hashFile
        ? await hashFile(selectedFile, abortController.signal)
        : Array.from(new Uint8Array(await subtleCrypto!.digest("SHA-256", await selectedFile.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");
      // A host hash provider may resolve after the screen was unmounted and its
      // signal aborted. Never begin a server mutation after that cancellation.
      if (abortController.signal.aborted) return;
      if (!/^[a-fA-F0-9]{64}$/u.test(computedSha256)) {
        setTransfer({ state: "unavailable", code: "HASHING_UNAVAILABLE", message: "The bounded SHA-256 provider did not return a valid digest. No upload request was sent." });
        setLocked(false);
        return;
      }
      // The runtime normalizes internal digests, but the canonical wire form is lowercase.
      const sha256 = computedSha256.toLowerCase();
      const idempotencyKey = globalThis.crypto.randomUUID();
      setRequestKey(idempotencyKey);
      phase = "begin";
      let session = await uploadCapability.client.createUploadSession({
        fileName: selectedFile.name,
        contentType: selectedFile.type || "application/octet-stream",
        expectedSizeBytes: selectedFile.size,
        expectedSha256: sha256,
        classification: uploadCapability.classification,
        retention: uploadCapability.retention,
        metadata: uploadCapability.metadata,
        idempotencyKey,
      }, abortController.signal);
      confirmedUploadId = session.uploadId;
      setUploadId(session.uploadId);
      setAcknowledgedBytes(session.bytesReceived);
      if (session.status !== "OPEN" || session.bytesReceived !== 0 || session.nextChunkIndex !== 0) {
        throw new Error("Upload session requires same-identity inspection before any transfer command.");
      }
      phase = "chunks";
      for (let offset = 0; offset < selectedFile.size; offset += UPLOAD_CHUNK_BYTES) {
        const part = selectedFile.slice(offset, Math.min(offset + UPLOAD_CHUNK_BYTES, selectedFile.size));
        session = await uploadCapability.client.uploadPart(session, session.nextChunkIndex, part, { signal: abortController.signal });
        setAcknowledgedBytes(session.bytesReceived);
      }
      phase = "complete";
      const artifact = await uploadCapability.client.completeUploadSession(session, abortController.signal);
      setTransfer({ state: "complete", message: `Upload completion acknowledged for artifact ${artifact.artifactId}. Availability, rights, consent, and downstream use are not established.` });
    } catch (error) {
      const status = error && typeof error === "object" && "statusCode" in error ? (error as { statusCode?: unknown }).statusCode : undefined;
      if (phase === "hashing") {
        setTransfer({ state: "unavailable", code: "HASHING_UNAVAILABLE", message: "Source hashing failed before upload began. No upload request was sent." });
        setLocked(false);
      } else if (status === 400 || status === 401 || status === 403) {
        setTransfer({ state: "denied", message: "Upload was denied by the current authenticated route. No retry was attempted." });
      } else {
        setTransfer({ state: "unknown", message: confirmedUploadId
          ? "Upload outcome is unknown. Inspect this same upload before any further command; no automatic retry was attempted."
          : "Begin-upload outcome is unknown and no upload ID was acknowledged. Keep the same request identity for reconciliation; no new upload was started." });
      }
      setLocked(true);
    } finally {
      controller.current = undefined;
    }
  };

  const inspectUnknownUpload = async (): Promise<void> => {
    if (!uploadCapability || uploadCapability.runtimeAdmission !== "ADMITTED" || !uploadId
      || transfer?.state !== "unknown" || inspection?.state === "loading") return;
    const abortController = new AbortController();
    controller.current = abortController;
    setInspection({ state: "loading" });
    try {
      const session = await uploadCapability.client.getUploadSession(uploadId, abortController.signal);
      if (session.uploadId !== uploadId) throw new TypeError("Upload inspection returned a different identity.");
      setInspection({ state: "observed", session });
    } catch {
      setInspection({ state: "failed" });
    } finally {
      controller.current = undefined;
    }
  };
  const heading = {
    "browse-media": "Media library",
    "import-media": "Import media",
    "job-status": "Verification status",
    "inspect-media": "Artifact details",
  }[intake.view];
  return <MediaTaskScreen {...flow}>
    <section className="media-screen-body" aria-labelledby="artifact-intake-title">
      <header>
        <h3 id="artifact-intake-title">{heading}</h3>
        <p>
          {[intake.workspaceName, intake.projectName].filter(Boolean).join(" · ")}
        </p>
      </header>
      {intake.message && <p role="status">{intake.message}</p>}
      {intake.view === "import-media" && <div>
        <FileUpload id="media-source-files" label="Choose source media" multiple dragAndDrop={false} showPreview={false}
          helperText="Only server-acknowledged transfer and recorded integrity results are shown as confirmed."
          onChange={(event) => {
            if (locked && (transfer?.state === "uploading" || transfer?.state === "unknown")) {
              event.currentTarget.value = "";
              return;
            }
            const files = Array.from(event.currentTarget.files ?? []);
            setSelectedFileCount(files.length);
            setSelectedFile(files.length === 1 ? files[0] : undefined);
            setTransfer(undefined);
            setAcknowledgedBytes(0);
            setUploadId(undefined);
            setRequestKey(undefined);
            setInspection(undefined);
            setLocked(false);
            onSourceFilesSelected?.(files);
          }}
          />
        {selectedFileCount !== undefined && <p role="status" aria-live="polite" aria-atomic="true">
          {selectedFileCount === 0
            ? "No source files are selected locally."
            : selectedFileCount === 1 ? "1 source file is selected locally." : `${selectedFileCount} source files are selected locally.`}
        </p>}
        {uploadCapability?.runtimeAdmission === "ADMITTED" ? <button type="button" disabled={!selectedFile || locked || transfer?.state === "uploading"} onClick={() => { void startUpload(); }}>
          Upload selected source
        </button> : <p role="status">Upload is not admitted by the current host.</p>}
        {transfer && <p role="status" aria-live="polite" aria-atomic="true">{transfer.message}</p>}
        {selectedFile && (transfer?.state === "uploading" || transfer?.state === "complete") && <p>Server-acknowledged transfer: {acknowledgedBytes} of {selectedFile.size} bytes.</p>}
        {uploadId && <p>Upload ID: <code>{uploadId}</code></p>}
        {requestKey && <p>Upload request identity: <code>{requestKey}</code></p>}
        {transfer?.state === "unknown" && uploadId && <button type="button" disabled={inspection?.state === "loading"} onClick={() => { void inspectUnknownUpload(); }}>
          Inspect same upload
        </button>}
        {inspection?.state === "loading" && <p role="status">Inspecting the same upload under current caller scope…</p>}
        {inspection?.state === "failed" && <p role="status">Upload inspection failed or was concealed. This does not establish absence or authorize another command.</p>}
        {inspection?.state === "observed" && <dl aria-label="Scoped upload observation">
          <div><dt>Observed upload status</dt><dd>{inspection.session.status}</dd></div>
          <div><dt>Server-acknowledged bytes</dt><dd>{inspection.session.bytesReceived}</dd></div>
          <div><dt>Next chunk index</dt><dd>{inspection.session.nextChunkIndex}</dd></div>
        </dl>}
        {inspection?.state === "observed" && <p>Read-only upload-session observation; this does not establish artifact availability, rights, consent, or authorize another command.</p>}
        {intake.sourceName && <p>Selected source: <strong>{intake.sourceName}</strong></p>}
        {intake.uploadId && <p>Upload ID: <code>{intake.uploadId}</code></p>}
        {intake.acknowledgedTransfer && <p>Server-acknowledged transfer: {intake.acknowledgedTransfer}</p>}
        {intake.integrity && <p>Integrity: {intake.integrity}</p>}
      </div>}
      {intake.view === "job-status" && <dl>
        <div><dt>Verification job</dt><dd>{intake.verificationJobId ?? "Not available"}</dd></div>
        <div><dt>Observed state</dt><dd role="status">{intake.verificationState ?? "Outcome not yet observed"}</dd></div>
      </dl>}
      {(intake.view === "browse-media" || intake.view === "inspect-media") && <>
        {intake.artifacts?.length ? <ul aria-label="Media artifacts">
          {intake.artifacts.map((artifact) => <li key={artifact.id}>
            <p>{artifact.name}{artifact.version ? ` · ${artifact.version}` : ""}</p>
            <p>Artifact ID: {artifact.id}</p>
            {(artifact.integrity || artifact.availability) && <p>{[artifact.integrity, artifact.availability].filter(Boolean).join(" · ")}</p>}
          </li>)}
        </ul> : <EmptyState className="gh-empty-state--panel" title="No artifact records are available in this projection." />}
      </>}
    </section>
  </MediaTaskScreen>;
}
