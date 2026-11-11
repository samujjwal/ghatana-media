import React from "react";
import type {
  CanonicalMediaArtifactObservation,
  CanonicalMediaUploadSessionObservation,
  CreateUploadSessionRequest,
  MediaOperationClient,
} from "@audio-video/client/operations";
import { MediaTaskScreen, type MediaTaskScreenProps } from "./MediaTaskScreen";
import { EmptyState, FileUpload } from "../foundations";

export type ArtifactIntakeView = "browse-media" | "import-media" | "job-status" | "inspect-media";
export type ArtifactUploadHostState = "idle" | "pending" | "reconciliation-required";

export interface ArtifactIntakeProjection {
  readonly view: ArtifactIntakeView;
  /** Host observation of current principal/workspace access for projected artifact data. */
  readonly accessState?: "resolved" | "denied" | "unknown" | "loading";
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
  /** Reports the exact artifact identity returned by the authenticated completion response. */
  readonly onArtifactCompleted?: (artifact: CanonicalMediaArtifactObservation) => void;
  /** Keeps the host informed when in-memory upload identity must remain available for reconciliation. */
  readonly onUploadStateChange?: (state: ArtifactUploadHostState) => void;
  /** Current authenticated SDK capability supplied by the product host. No capability means no upload dispatch. */
  readonly uploadCapability?: ArtifactUploadCapability;
}

export type ArtifactUploadSession = CanonicalMediaUploadSessionObservation;

export interface ArtifactUploadCapability {
  /** Host assertion that this route is currently admitted; source and policy checks remain host responsibilities. */
  readonly runtimeAdmission: "ADMITTED";
  readonly classification: CreateUploadSessionRequest["classification"];
  readonly retention: CreateUploadSessionRequest["retention"];
  /** Authenticated DEV_ONLY host policy; the screen still applies its smaller client resource cap. */
  readonly maxChunkBytes: number;
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
type BoundUploadRequest = Pick<CreateUploadSessionRequest,
  "fileName" | "contentType" | "expectedSizeBytes" | "expectedSha256" | "classification" | "retention" | "metadata">;
type ExistingUploadRecovery =
  | { readonly state: "idle" }
  | { readonly state: "hashing"; readonly capability: ArtifactUploadCapability }
  | { readonly state: "inspecting"; readonly capability: ArtifactUploadCapability }
  | { readonly state: "ready"; readonly upload: ActiveUpload }
  | { readonly state: "resuming"; readonly capability: ArtifactUploadCapability }
  | { readonly state: "failed"; readonly message: string };
type ActiveUpload = {
  readonly file: File;
  readonly capability: ArtifactUploadCapability;
  readonly request: BoundUploadRequest;
  readonly session: ArtifactUploadSession;
};
const MAX_CLIENT_UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;
// WebCrypto has no incremental digest API. This is only the fallback's one-shot
// allocation bound; PDP-1 declares a separate 2 GiB operation request limit.
const MAX_ONE_SHOT_HASH_BYTES = 64 * 1024 * 1024;
const MAX_UPLOAD_SIZE_BYTES = 2_147_483_648;
const OPAQUE_UPLOAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function hasValidUploadChunkLimit(capability: ArtifactUploadCapability): boolean {
  return Number.isSafeInteger(capability.maxChunkBytes) && capability.maxChunkBytes >= 1
    && capability.maxChunkBytes <= 32 * 1024 * 1024;
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((nested) => freezeJson(nested));
    Object.freeze(value);
  }
  return value;
}

function sessionBindsNonRetentionRequest(session: ArtifactUploadSession, request: BoundUploadRequest): boolean {
  return session.fileName === request.fileName && session.contentType === request.contentType
    && session.expectedSizeBytes === request.expectedSizeBytes && session.expectedSha256 === request.expectedSha256
    && session.classification === request.classification
    && canonicalJson(session.metadata) === canonicalJson(request.metadata ?? {});
}

function sessionBindsRequest(session: ArtifactUploadSession, request: BoundUploadRequest): boolean {
  return sessionBindsNonRetentionRequest(session, request) && retentionMatchesSession(session, request.retention);
}

function durationNanoseconds(value: string): bigint | undefined {
  // Compare exact elapsed durations. Calendar months/years are intentionally
  // rejected because they do not denote a fixed number of nanoseconds.
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d{1,9})?)S)?)?$/u.exec(value);
  if (!match || value === "P" || value.endsWith("T")
    || (!match[1] && !match[2] && !match[3] && !match[4])) return undefined;
  const seconds = BigInt(match[1] ?? 0) * 86_400n + BigInt(match[2] ?? 0) * 3_600n
    + BigInt(match[3] ?? 0) * 60n;
  const fractional = match[4] ?? "0";
  const [whole, fraction = ""] = fractional.split(".");
  const nanoseconds = (seconds + BigInt(whole ?? 0)) * 1_000_000_000n
    + BigInt((fraction + "000000000").slice(0, 9));
  return nanoseconds > 0n && nanoseconds <= 315_360_000_000_000_000n && nanoseconds % 1_000_000n === 0n
    ? nanoseconds : undefined;
}

function instantNanoseconds(value: string): bigint | undefined {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/u.exec(value);
  if (!match) return undefined;
  const millis = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(millis)) return undefined;
  const fraction = (match[2] ?? "").padEnd(9, "0");
  return BigInt(millis) * 1_000_000n + BigInt(fraction || "0");
}

function sessionIsUnexpired(session: ArtifactUploadSession): boolean {
  const expiry = instantNanoseconds(session.expiresAt);
  return expiry !== undefined && expiry > BigInt(Date.now()) * 1_000_000n;
}

function retentionMatchesSession(session: ArtifactUploadSession, retention: string): boolean {
  const expected = durationNanoseconds(retention);
  const observed = session.retention;
  const actual = typeof observed === "string" ? durationNanoseconds(observed) : undefined;
  return expected !== undefined && expected > 0n && actual === expected;
}

function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, nested]) => [key, normalize(nested)]));
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function hasConsistentChunkPosition(session: ArtifactUploadSession, fileSize: number): boolean {
  return Number.isSafeInteger(session.nextChunkIndex) && session.nextChunkIndex >= 0
    && Number.isSafeInteger(session.bytesReceived) && session.bytesReceived >= 0
    && session.bytesReceived <= fileSize
    && ((session.nextChunkIndex === 0) === (session.bytesReceived === 0))
    && session.nextChunkIndex <= session.bytesReceived;
}

function chunkReceiptBindsPosition(
  previous: ArtifactUploadSession,
  acknowledged: ArtifactUploadSession,
  fileSize: number,
  chunkSize: number,
): boolean {
  return acknowledged.nextChunkIndex === previous.nextChunkIndex + 1
    && acknowledged.bytesReceived === previous.bytesReceived + chunkSize
    && hasConsistentChunkPosition(acknowledged, fileSize);
}

/** Candidate J-02 screen body. Host-injected uploads use the authenticated SDK and report only receipts. */
export function ArtifactIntakeScreen({ intake, onSourceFilesSelected, onArtifactCompleted, onUploadStateChange, uploadCapability, ...flow }: ArtifactIntakeScreenProps): React.ReactElement {
  const [selectedFileCount, setSelectedFileCount] = React.useState<number | undefined>(undefined);
  const [selectedFile, setSelectedFile] = React.useState<File | undefined>(undefined);
  const [transfer, setTransfer] = React.useState<IntakeTransfer | undefined>(undefined);
  const [acknowledgedBytes, setAcknowledgedBytes] = React.useState(0);
  const [uploadId, setUploadId] = React.useState<string | undefined>(undefined);
  const [requestKey, setRequestKey] = React.useState<string | undefined>(undefined);
  const [beginReconciliation, setBeginReconciliation] = React.useState<{
    readonly request: CreateUploadSessionRequest;
    readonly capability: ArtifactUploadCapability;
  } | undefined>(undefined);
  const [activeUpload, setActiveUpload] = React.useState<ActiveUpload | undefined>(undefined);
  const [completionReplay, setCompletionReplay] = React.useState<ActiveUpload | undefined>(undefined);
  const [inspection, setInspection] = React.useState<UploadInspection | undefined>(undefined);
  const [recoveryUploadId, setRecoveryUploadId] = React.useState("");
  const [recoveryFile, setRecoveryFile] = React.useState<File | undefined>(undefined);
  const [recovery, setRecovery] = React.useState<ExistingUploadRecovery>({ state: "idle" });
  const [locked, setLocked] = React.useState(false);
  const controller = React.useRef<AbortController | undefined>(undefined);
  const uploadCapabilityRef = React.useRef(uploadCapability);
  React.useLayoutEffect(() => { uploadCapabilityRef.current = uploadCapability; }, [uploadCapability]);
  React.useEffect(() => () => controller.current?.abort(), []);
  React.useEffect(() => {
    const hostState: ArtifactUploadHostState = transfer?.state === "uploading" ? "pending"
      : transfer?.state === "unknown" ? "reconciliation-required" : "idle";
    onUploadStateChange?.(hostState);
  }, [transfer?.state, onUploadStateChange]);
  React.useEffect(() => {
    setRecovery((current) => {
      const activeCapability = current.state === "ready" ? current.upload.capability
        : current.state === "hashing" || current.state === "inspecting" || current.state === "resuming"
          ? current.capability : undefined;
      const capabilityChanged = activeCapability !== undefined && activeCapability !== uploadCapability;
      const admissionWithdrawn = uploadCapability?.runtimeAdmission !== "ADMITTED";
      if (capabilityChanged || admissionWithdrawn) {
        if (current.state === "hashing" || current.state === "inspecting" || current.state === "resuming") {
          controller.current?.abort();
        }
        return { state: "idle" };
      }
      return current;
    });
    if (uploadCapability?.runtimeAdmission !== "ADMITTED") {
      setRecoveryUploadId("");
      setRecoveryFile(undefined);
    }
  }, [uploadCapability]);

  const startUpload = async (reconcileBegin = false): Promise<void> => {
    if (!uploadCapability || uploadCapability.runtimeAdmission !== "ADMITTED" || !selectedFile || (locked && !reconcileBegin)) return;
    if (!hasValidUploadChunkLimit(uploadCapability)) {
      setTransfer({ state: "unavailable", message: "The verified host did not provide a valid upload chunk limit." });
      return;
    }
    const retainedBegin = reconcileBegin ? beginReconciliation : undefined;
    if (reconcileBegin && (!retainedBegin || retainedBegin.capability.client !== uploadCapability.client
      || retainedBegin.request.idempotencyKey !== requestKey || transfer?.state !== "unknown" || uploadId)) return;
    if (controller.current) return;
    const hasCurrentAdmission = (): boolean => {
      const current = uploadCapabilityRef.current;
      return current === uploadCapability && current?.runtimeAdmission === "ADMITTED";
    };
    const hashFile = uploadCapability.hashFile;
    const subtleCrypto = globalThis.crypto?.subtle;
    if (selectedFile.size < 1 || selectedFile.size > MAX_UPLOAD_SIZE_BYTES) {
      setTransfer({ state: "denied", message: "This source is outside the authenticated SDK upload size limits." });
      return;
    }
    if (!retainedBegin && !globalThis.crypto?.randomUUID) {
      setTransfer({ state: "denied", message: "Secure upload request identity is unavailable in this browser." });
      return;
    }
    if (!retainedBegin && !hashFile && selectedFile.size > MAX_ONE_SHOT_HASH_BYTES) {
      setTransfer({ state: "unavailable", code: "HASHING_UNAVAILABLE", message: "A bounded SHA-256 provider is required for this file size. No upload request was sent." });
      return;
    }
    if (!retainedBegin && !hashFile && !subtleCrypto) {
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
      const computedSha256 = retainedBegin ? undefined : hashFile
        ? await hashFile(selectedFile, abortController.signal)
        : Array.from(new Uint8Array(await subtleCrypto!.digest("SHA-256", await selectedFile.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");
      // A host hash provider may resolve after the screen was unmounted and its
      // signal aborted. Never begin a server mutation after that cancellation.
      if (abortController.signal.aborted) return;
      if (!retainedBegin && !/^[a-fA-F0-9]{64}$/u.test(computedSha256!)) {
        setTransfer({ state: "unavailable", code: "HASHING_UNAVAILABLE", message: "The bounded SHA-256 provider did not return a valid digest. No upload request was sent." });
        setLocked(false);
        return;
      }
      // The runtime normalizes internal digests, but the canonical wire form is lowercase.
      const sha256 = retainedBegin?.request.expectedSha256 ?? computedSha256!.toLowerCase();
      if (!hasCurrentAdmission()) {
        throw Object.assign(new Error("The host upload capability was withdrawn."), { hostAdmissionWithdrawn: true });
      }
      const request = retainedBegin?.request ?? Object.freeze({
        fileName: selectedFile.name,
        contentType: selectedFile.type || "application/octet-stream",
        expectedSizeBytes: selectedFile.size,
        expectedSha256: sha256,
        classification: uploadCapability.classification,
        retention: uploadCapability.retention,
        metadata: freezeJson(JSON.parse(JSON.stringify(uploadCapability.metadata ?? {}))) as CreateUploadSessionRequest["metadata"],
        idempotencyKey: globalThis.crypto.randomUUID(),
      });
      if (!retainedBegin) {
        setRequestKey(request.idempotencyKey);
        setBeginReconciliation({ request, capability: uploadCapability });
      }
      phase = "begin";
      let session = await uploadCapability.client.createUploadSession(request, abortController.signal);
      if (!sessionBindsRequest(session, request)) {
        throw new TypeError("Upload-session receipt does not bind to the retained immutable begin request.");
      }
      confirmedUploadId = session.uploadId;
      setActiveUpload({ file: selectedFile, capability: uploadCapability, request, session });
      setUploadId(session.uploadId);
      setAcknowledgedBytes(session.bytesReceived);
      if (session.status !== "OPEN" || session.bytesReceived !== 0 || session.nextChunkIndex !== 0) {
        throw new Error("Upload session requires same-identity inspection before any transfer command.");
      }
      phase = "chunks";
      const chunkBytes = Math.min(uploadCapability.maxChunkBytes, MAX_CLIENT_UPLOAD_CHUNK_BYTES);
      while (session.bytesReceived < selectedFile.size) {
        if (!hasCurrentAdmission()) {
          throw Object.assign(new Error("The host upload capability was withdrawn."), { hostAdmissionWithdrawn: true });
        }
        if (!sessionIsUnexpired(session)) {
          throw Object.assign(new Error("The upload session expired before the next transfer command."), { uploadSessionExpired: true });
        }
        const previous = session;
        const offset = previous.bytesReceived;
        const part = selectedFile.slice(offset, Math.min(offset + chunkBytes, selectedFile.size));
        session = await uploadCapability.client.uploadPart(previous, previous.nextChunkIndex, part, { signal: abortController.signal });
        if (!sessionBindsRequest(session, request)
          || !chunkReceiptBindsPosition(previous, session, selectedFile.size, part.size)) {
          throw new TypeError("Chunk receipt does not bind to the exact upload and expected chunk position.");
        }
        setActiveUpload({ file: selectedFile, capability: uploadCapability, request, session });
        setAcknowledgedBytes(session.bytesReceived);
      }
      if (!hasCurrentAdmission()) {
        throw Object.assign(new Error("The host upload capability was withdrawn."), { hostAdmissionWithdrawn: true });
      }
      if (!sessionIsUnexpired(session)) {
        throw Object.assign(new Error("The upload session expired before completion."), { uploadSessionExpired: true });
      }
      phase = "complete";
      const pendingCompletion = { file: selectedFile, capability: uploadCapability, request, session };
      setCompletionReplay(pendingCompletion);
      const artifact = await uploadCapability.client.completeUploadSession(session, abortController.signal);
      setCompletionReplay(undefined);
      setTransfer({ state: "complete", message: `Upload completion acknowledged for artifact ${artifact.artifactId}. Availability, rights, consent, and downstream use are not established.` });
      try { onArtifactCompleted?.(artifact); } catch { /* Host observation cannot change the server receipt outcome. */ }
    } catch (error) {
      const status = error && typeof error === "object" && "statusCode" in error ? (error as { statusCode?: unknown }).statusCode : undefined;
      const hostAdmissionWithdrawn = error && typeof error === "object" && "hostAdmissionWithdrawn" in error;
      const uploadSessionExpired = error && typeof error === "object" && "uploadSessionExpired" in error;
      if (phase === "hashing") {
        setTransfer({ state: "unavailable", code: "HASHING_UNAVAILABLE", message: "Source hashing failed before upload began. No upload request was sent." });
        setLocked(false);
      } else if (hostAdmissionWithdrawn) {
        setTransfer({ state: "denied", message: "Upload stopped because the current host no longer admits the route. No further request was sent." });
      } else if (uploadSessionExpired) {
        setTransfer({ state: "unknown", message: "The upload session expired before the next command. No further request was sent; inspect the same upload identity before any retry." });
      } else if (status === 400 || status === 401 || status === 403) {
        setTransfer({ state: "denied", message: "Upload was denied by the current authenticated route. No retry was attempted." });
      } else {
        setTransfer({ state: "unknown", message: confirmedUploadId
          ? "Upload outcome is unknown. Inspect the same upload identity before any further command; no automatic retry was attempted."
          : "Begin-upload outcome is unknown and no upload ID was acknowledged. Keep the same request identity for reconciliation; no new upload was started." });
      }
      setLocked(true);
    } finally {
      controller.current = undefined;
    }
  };

  const inspectUnknownUpload = async (): Promise<void> => {
    const currentUpload = activeUpload;
    if (!uploadCapability || uploadCapability.runtimeAdmission !== "ADMITTED" || !uploadId || !currentUpload
      || currentUpload.capability.client !== uploadCapability.client || currentUpload.session.uploadId !== uploadId
      || transfer?.state !== "unknown" || inspection?.state === "loading") return;
    const abortController = new AbortController();
    controller.current = abortController;
    setInspection({ state: "loading" });
    try {
      const session = await uploadCapability.client.getUploadSession(uploadId, abortController.signal);
      if (session.uploadId !== uploadId || session.tenantId !== currentUpload.session.tenantId
        || session.principalId !== currentUpload.session.principalId || !sessionBindsRequest(session, currentUpload.request)
        || !hasConsistentChunkPosition(session, currentUpload.file.size) || !sessionIsUnexpired(session)) {
        throw new TypeError("Upload inspection does not bind to the exact caller-scoped request, chunk position, and unexpired session.");
      }
      setActiveUpload({ ...currentUpload, session });
      setAcknowledgedBytes(session.bytesReceived);
      setInspection({ state: "observed", session });
    } catch {
      setInspection({ state: "failed" });
    } finally {
      controller.current = undefined;
    }
  };
  const resumeObservedUpload = async (): Promise<void> => {
    const current = activeUpload;
    const observed = inspection?.state === "observed" ? inspection.session : undefined;
    if (!current || !uploadCapability || current.capability.client !== uploadCapability.client || uploadCapability.runtimeAdmission !== "ADMITTED"
      || transfer?.state !== "unknown" || !observed || observed.status !== "OPEN"
      || observed.uploadId !== current.session.uploadId || !sessionBindsRequest(observed, current.request)
      || !hasConsistentChunkPosition(observed, current.file.size) || !sessionIsUnexpired(observed) || controller.current) {
      if (current && observed && !sessionIsUnexpired(observed)) setInspection({ state: "failed" });
      return;
    }
    await continueObservedUpload(current, observed, false);
  };

  const inspectExistingUpload = async (): Promise<void> => {
    const capability = uploadCapability;
    const file = recoveryFile;
    const uploadIdToInspect = recoveryUploadId;
    if (!capability || capability.runtimeAdmission !== "ADMITTED" || !file || !uploadIdToInspect
      || controller.current || !capability.client.getUploadSession) return;
    if (!hasValidUploadChunkLimit(capability)) {
      setRecovery({ state: "failed", message: "The verified host did not provide a valid upload chunk limit. No recovery request was sent." });
      return;
    }
    if (!OPAQUE_UPLOAD_ID.test(uploadIdToInspect)) {
      setRecovery({ state: "failed", message: "Enter the exact canonical upload ID without surrounding whitespace or path characters. No request was sent." });
      return;
    }
    if (file.size < 1 || file.size > MAX_UPLOAD_SIZE_BYTES) {
      setRecovery({ state: "failed", message: "The reselected file is outside the authenticated SDK upload size limits. No request was sent." });
      return;
    }
    const duration = durationNanoseconds(capability.retention);
    if (duration === undefined) {
      setRecovery({ state: "failed", message: "The selected retention duration cannot be compared exactly. No recovery request was sent." });
      return;
    }
    const hashFile = capability.hashFile;
    const subtleCrypto = globalThis.crypto?.subtle;
    if (!hashFile && file.size > MAX_ONE_SHOT_HASH_BYTES) {
      setRecovery({ state: "failed", message: "A bounded SHA-256 provider is required for this file size. No recovery request was sent." });
      return;
    }
    if (!hashFile && !subtleCrypto) {
      setRecovery({ state: "failed", message: "Browser SHA-256 is unavailable. No recovery request was sent." });
      return;
    }
    const abortController = new AbortController();
    controller.current = abortController;
    setRecovery({ state: "hashing", capability });
    try {
      const digest = hashFile
        ? await hashFile(file, abortController.signal)
        : Array.from(new Uint8Array(await subtleCrypto!.digest("SHA-256", await file.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (abortController.signal.aborted || uploadCapabilityRef.current !== capability
        || uploadCapabilityRef.current?.runtimeAdmission !== "ADMITTED") return;
      if (!/^[a-fA-F0-9]{64}$/u.test(digest)) {
        setRecovery({ state: "failed", message: "The bounded SHA-256 provider returned an invalid digest. No upload request was sent." });
        return;
      }
      const request: BoundUploadRequest = Object.freeze({
        fileName: file.name,
        contentType: file.type || "application/octet-stream",
        expectedSizeBytes: file.size,
        expectedSha256: digest.toLowerCase(),
        classification: capability.classification,
        retention: capability.retention,
        metadata: freezeJson(JSON.parse(JSON.stringify(capability.metadata ?? {}))) as CreateUploadSessionRequest["metadata"],
      });
      setRecovery({ state: "inspecting", capability });
      const session = await capability.client.getUploadSession(uploadIdToInspect, abortController.signal);
      if (abortController.signal.aborted || uploadCapabilityRef.current !== capability
        || uploadCapabilityRef.current?.runtimeAdmission !== "ADMITTED") return;
      if (session.uploadId !== uploadIdToInspect || !session.tenantId || !session.principalId
        || !sessionBindsNonRetentionRequest(session, request)) {
        setRecovery({ state: "failed", message: "The observed upload does not match this caller-scoped file, classification, and metadata. No mutation is authorized." });
        return;
      }
      if (!retentionMatchesSession(session, capability.retention)) {
        setRecovery({ state: "failed", message: "The upload-session response does not expose a retention value matching the selected request. The canonical session DTO must include retention; expiry is a separate upload-session limit and is not used to infer retention. No mutation is authorized." });
        return;
      }
      if (!sessionIsUnexpired(session)) {
        setRecovery({ state: "failed", message: "The exact observed upload session has expired or has an invalid expiry. No mutation is authorized." });
        return;
      }
      if (!hasConsistentChunkPosition(session, file.size)) {
        setRecovery({ state: "failed", message: "The observed upload chunk position is inconsistent with the reselected file. No mutation is authorized." });
        return;
      }
      if (session.status !== "OPEN") {
        setRecovery({ state: "failed", message: `The observed upload is ${session.status}; only an OPEN session can be resumed. No mutation is authorized.` });
        return;
      }
      const active: ActiveUpload = { file, capability, request, session };
      setRecovery({ state: "ready", upload: active });
    } catch (error) {
      const status = error && typeof error === "object" && "statusCode" in error ? (error as { statusCode?: unknown }).statusCode : undefined;
      setRecovery({ state: "failed", message: status === 401 || status === 403
        ? "The same upload is denied under the current caller scope. No mutation is authorized."
        : "The same upload could not be confirmed under the current caller scope. The outcome remains unknown; no mutation is authorized." });
    } finally {
      if (controller.current === abortController) controller.current = undefined;
    }
  };

  const resumeExistingUpload = async (): Promise<void> => {
    const current = recovery.state === "ready" ? recovery.upload : undefined;
    if (!current || current.session.uploadId !== recoveryUploadId
      || current.file !== recoveryFile || current.capability !== uploadCapability || controller.current) return;
    setRecovery({ state: "resuming", capability: current.capability });
    await continueObservedUpload(current, current.session, true);
  };

  async function continueObservedUpload(current: ActiveUpload, observed: ArtifactUploadSession, isRecovery: boolean): Promise<void> {
    const capability = uploadCapability;
    if (!capability || current.capability.client !== capability.client || capability.runtimeAdmission !== "ADMITTED"
      || !hasValidUploadChunkLimit(capability)
      || current.request.classification !== capability.classification
      || current.request.retention !== capability.retention
      || canonicalJson(current.request.metadata ?? {}) !== canonicalJson(capability.metadata ?? {})
      || observed.status !== "OPEN" || !sessionBindsRequest(observed, current.request)
      || !hasConsistentChunkPosition(observed, current.file.size) || !sessionIsUnexpired(observed) || controller.current) {
      if (isRecovery) {
        setRecovery({ state: "failed", message: "The upload session expired or changed before confirmation. Inspect the same upload ID again; no mutation was sent." });
      } else {
        setInspection({ state: "failed" });
      }
      return;
    }
    setLocked(true);
    setTransfer({ state: "uploading", message: "Resuming only the remaining contiguous bytes from the same upload position observed from the server." });
    setInspection(undefined);
    const abortController = new AbortController();
    controller.current = abortController;
    let session = observed;
    try {
      setActiveUpload({ ...current, session });
      setUploadId(session.uploadId);
      setAcknowledgedBytes(session.bytesReceived);
      const chunkBytes = Math.min(capability.maxChunkBytes, MAX_CLIENT_UPLOAD_CHUNK_BYTES);
      while (session.bytesReceived < current.file.size) {
        if (abortController.signal.aborted || uploadCapabilityRef.current !== capability
          || uploadCapabilityRef.current?.runtimeAdmission !== "ADMITTED") {
          throw Object.assign(new Error("The host upload capability was withdrawn."), { hostAdmissionWithdrawn: true });
        }
        if (!sessionIsUnexpired(session)) {
          throw Object.assign(new Error("The upload session expired before the next transfer command."), { uploadSessionExpired: true });
        }
        const previous = session;
        const offset = previous.bytesReceived;
        const part = current.file.slice(offset, Math.min(offset + chunkBytes, current.file.size));
        session = await capability.client.uploadPart(previous, previous.nextChunkIndex, part, { signal: abortController.signal });
        if (session.tenantId !== current.session.tenantId || session.principalId !== current.session.principalId
          || !sessionBindsRequest(session, current.request)
          || !chunkReceiptBindsPosition(previous, session, current.file.size, part.size)) {
          throw new TypeError("Chunk receipt does not bind to the exact upload and expected chunk position.");
        }
        setActiveUpload({ ...current, session });
        setAcknowledgedBytes(session.bytesReceived);
      }
      if (session.bytesReceived !== current.file.size || session.status !== "OPEN") {
        throw new TypeError("Observed upload is not complete and OPEN for finalization.");
      }
      if (!sessionIsUnexpired(session)) {
        throw Object.assign(new Error("The upload session expired before completion."), { uploadSessionExpired: true });
      }
      const pending = { ...current, session };
      setCompletionReplay(pending);
      const artifact = await capability.client.completeUploadSession(session, abortController.signal);
      setCompletionReplay(undefined);
      setTransfer({ state: "complete", message: `Upload completion acknowledged for artifact ${artifact.artifactId}. Availability, rights, consent, and downstream use are not established.` });
      if (isRecovery) {
        setRecovery({ state: "idle" });
        setLocked(false);
      }
      try { onArtifactCompleted?.(artifact); } catch { /* Host observation cannot change the server receipt outcome. */ }
    } catch (error) {
      const status = error && typeof error === "object" && "statusCode" in error ? (error as { statusCode?: unknown }).statusCode : undefined;
      const expired = error && typeof error === "object" && "uploadSessionExpired" in error;
      const message = expired
        ? "The upload session expired before the next command. No further request was sent; inspect the same upload identity again."
        : status === 400 || status === 401 || status === 403
        ? "Upload was denied by the current authenticated route. No retry was attempted."
        : "Upload outcome is unknown. Inspect the same upload identity before any further command; no automatic retry was attempted.";
      if (isRecovery) setRecovery({ state: "failed", message });
      setTransfer(expired ? { state: "unknown", message }
        : status === 400 || status === 401 || status === 403 ? { state: "denied", message } : { state: "unknown", message });
    } finally {
      if (controller.current === abortController) controller.current = undefined;
    }
  }
  const replayUnknownCompletion = async (): Promise<void> => {
    const retained = completionReplay;
    const observed = inspection?.state === "observed" ? inspection.session : undefined;
    if (!retained || !uploadCapability || retained.capability.client !== uploadCapability.client || uploadCapability.runtimeAdmission !== "ADMITTED"
      || transfer?.state !== "unknown" || !observed || observed.status !== "COMPLETED"
      || observed.uploadId !== retained.session.uploadId || !sessionBindsRequest(observed, retained.request) || controller.current) return;
    setLocked(true);
    setInspection(undefined);
    setTransfer({ state: "uploading", message: "Replaying the exact completion request after observing the same upload as completed." });
    const abortController = new AbortController();
    controller.current = abortController;
    try {
      const artifact = await uploadCapability.client.completeUploadSession(retained.session, abortController.signal);
      setCompletionReplay(undefined);
      setTransfer({ state: "complete", message: `Upload completion acknowledged for artifact ${artifact.artifactId}. Availability, rights, consent, and downstream use are not established.` });
      try { onArtifactCompleted?.(artifact); } catch { /* Host observation cannot change the server receipt outcome. */ }
    } catch (error) {
      const status = error && typeof error === "object" && "statusCode" in error ? (error as { statusCode?: unknown }).statusCode : undefined;
      setTransfer(status === 400 || status === 401 || status === 403
        ? { state: "denied", message: "Upload was denied by the current authenticated route. No retry was attempted." }
        : { state: "unknown", message: "Completion outcome is unknown. Inspect the same upload identity before any further command; no automatic retry was attempted." });
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
  const accessState = intake.accessState ?? "unknown";
  const mayShowProjectedData = accessState === "resolved";
  const accessMessage = accessState === "resolved" ? undefined : accessState === "loading"
    ? "Checking current workspace access…"
    : accessState === "denied"
      ? "Workspace access is unavailable. Artifact data is hidden until access is granted."
      : "Workspace access could not be confirmed. Artifact data is hidden.";
  return <MediaTaskScreen {...flow}>
    <section className="media-screen-body" aria-labelledby="artifact-intake-title">
      <header>
        <h3 id="artifact-intake-title">{heading}</h3>
        {mayShowProjectedData && <p>
          {[intake.workspaceName, intake.projectName].filter(Boolean).join(" · ")}
        </p>}
      </header>
      {accessMessage && <p role="status" aria-live="polite" aria-atomic="true" data-state={accessState}>{accessMessage}</p>}
      {mayShowProjectedData && intake.message && <p role="status">{intake.message}</p>}
      {intake.view === "import-media" && <div>
        <FileUpload id="media-source-files" label="Choose source media" dragAndDrop={false} showPreview={false}
          helperText="The host requires a recognized format claim to match the file signature; unsupported or mismatched formats are rejected. Only server-acknowledged transfer and recorded integrity results are shown as confirmed."
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
            if (locked && (transfer?.state === "uploading" || transfer?.state === "unknown")) {
              event.currentTarget.value = "";
              return;
            }
            const files: File[] = Array.from(event.currentTarget.files ?? []);
            setSelectedFileCount(files.length);
            setSelectedFile(files.length === 1 ? files[0] : undefined);
            setTransfer(undefined);
            setAcknowledgedBytes(0);
            setUploadId(undefined);
            setRequestKey(undefined);
            setBeginReconciliation(undefined);
            setActiveUpload(undefined);
            setCompletionReplay(undefined);
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
        {transfer?.state === "unknown" && !uploadId && beginReconciliation
          && uploadCapability?.client === beginReconciliation.capability.client && <button type="button"
            onClick={() => { setLocked(false); void startUpload(true); }}>
          Reconcile begin upload with same request
        </button>}
        {transfer && <p role="status" aria-live="polite" aria-atomic="true">{transfer.message}</p>}
        {selectedFile && (transfer?.state === "uploading" || transfer?.state === "complete") && <>
          <p>Server-acknowledged transfer: {acknowledgedBytes} of {selectedFile.size} bytes.</p>
          <progress aria-label="Server-acknowledged upload progress" max={selectedFile.size} value={acknowledgedBytes} />
        </>}
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
        {inspection?.state === "observed" && inspection.session.status === "OPEN" && activeUpload
          && <button type="button" onClick={() => { void resumeObservedUpload(); }}>Resume from observed upload</button>}
        {inspection?.state === "observed" && inspection.session.status === "COMPLETED" && completionReplay
          && <button type="button" onClick={() => { void replayUnknownCompletion(); }}>Replay exact completion request</button>}
        {inspection?.state === "observed" && <p>Read-only upload-session observation; this does not establish artifact availability, rights, consent, or authorize another command.</p>}
        <section aria-labelledby="existing-upload-recovery-title">
          <h4 id="existing-upload-recovery-title">Recover an interrupted upload</h4>
          <p>After reopening this page, enter the existing upload ID and reselect the same file. The file and ID stay in page memory only. Inspection is read-only; a separate confirmation is required before any remaining bytes are sent.</p>
          <label htmlFor="existing-upload-id">Existing upload ID to recover</label>
          <input id="existing-upload-id" name="existingUploadId" autoComplete="off" required aria-required="true" value={recoveryUploadId}
            onChange={(event) => { setRecoveryUploadId(event.currentTarget.value); setRecovery({ state: "idle" }); }} />
          <FileUpload id="existing-upload-source" label="Choose source file for recovery" dragAndDrop={false} showPreview={false}
            helperText="Select exactly one file. Its digest and request metadata must match the caller-scoped upload observation."
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
              const files: File[] = Array.from(event.currentTarget.files ?? []);
              setRecoveryFile(files.length === 1 ? files[0] : undefined);
              setRecovery({ state: "idle" });
            }} />
          {recoveryFile && <p role="status" aria-live="polite">Reselected file: {recoveryFile.name} ({recoveryFile.size} bytes).</p>}
          <button type="button" onClick={() => { void inspectExistingUpload(); }}
            disabled={!uploadCapability || uploadCapability.runtimeAdmission !== "ADMITTED"
              || !recoveryUploadId.trim() || !recoveryFile || recovery.state === "hashing" || recovery.state === "inspecting"
              || recovery.state === "resuming" || locked}>
            Inspect existing upload
          </button>
          {recovery.state === "hashing" && <p role="status" aria-live="polite">Hashing the reselected file with the bounded local provider…</p>}
          {recovery.state === "inspecting" && <p role="status" aria-live="polite">Inspecting this upload ID under current caller scope…</p>}
          {recovery.state === "failed" && <p role="status" aria-live="polite">{recovery.message}</p>}
          {recovery.state === "ready" && <>
            <p role="status" aria-live="polite">The same caller-scoped upload, file digest, metadata, retention, unexpired session, and contiguous OPEN position were observed. No bytes have been sent yet.</p>
            <dl aria-label="Observed upload available for recovery">
              <div><dt>Upload ID</dt><dd><code>{recovery.upload.session.uploadId}</code></dd></div>
              <div><dt>Observed upload status</dt><dd>{recovery.upload.session.status}</dd></div>
              <div><dt>Server-acknowledged bytes</dt><dd>{recovery.upload.session.bytesReceived}</dd></div>
              <div><dt>Next chunk index</dt><dd>{recovery.upload.session.nextChunkIndex}</dd></div>
            </dl>
            <p>Confirm once to append only the remaining contiguous bytes to this same upload, then complete this same session if the host confirms the exact final size.</p>
            <button type="button" onClick={() => { void resumeExistingUpload(); }}>Resume from observed upload</button>
          </>}
          {recovery.state === "resuming" && <p role="status" aria-live="polite">Resuming only the remaining acknowledged prefix for this same upload identity…</p>}
          {!uploadCapability || uploadCapability.runtimeAdmission !== "ADMITTED"
            ? <p role="status">Upload recovery is not admitted by the current host.</p>
            : recovery.state === "idle" && <p role="status">Enter an existing upload ID and reselect one source file before inspection is available.</p>}
        </section>
        {mayShowProjectedData && intake.sourceName && <p>Selected source: <strong>{intake.sourceName}</strong></p>}
        {mayShowProjectedData && intake.uploadId && <p>Upload ID: <code>{intake.uploadId}</code></p>}
        {mayShowProjectedData && intake.acknowledgedTransfer && <p>Server-acknowledged transfer: {intake.acknowledgedTransfer}</p>}
        {mayShowProjectedData && intake.integrity && <p>Integrity: {intake.integrity}</p>}
      </div>}
      {mayShowProjectedData && intake.view === "job-status" && <dl>
        <div><dt>Verification job</dt><dd>{intake.verificationJobId ?? "Not available"}</dd></div>
        <div><dt>Observed state</dt><dd role="status">{intake.verificationState ?? "Outcome not yet observed"}</dd></div>
      </dl>}
      {mayShowProjectedData && (intake.view === "browse-media" || intake.view === "inspect-media") && <>
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
