/**
 * Host-wired CAMERA capture adapter. Browser/device access is injected through
 * explicit ports; this module never calls navigator.mediaDevices itself.
 * Fresh exact-source/purpose consent is checked before opening a device and
 * again around every asynchronous frame read. Device frames are detached,
 * bounded and timestamped on an injected epoch clock.
 */
import {
  MAX_CAPTURED_FRAME_BYTES,
  type CameraAudioSampleTime,
  type CameraPositiveRational,
  type CameraCaptureMetadata,
  type CameraClockMappingUncertainty,
  type CameraDiscontinuity,
  type CameraSignal,
  type CameraSourcePresentationTime,
  type CaptureRequest,
  type CapturedFrame,
  type CaptureSourceAdapter,
} from "./capture-adapters.js";
import { PositiveRationalSchema, SignedInt64DecimalSchema, VersionRefSchema } from "@audio-video/types/production";

export type CameraPermissionDisposition = "GRANTED" | "DENIED" | "REVOKED" | "UNKNOWN";

export interface CameraPermissionDecision {
  readonly disposition: CameraPermissionDisposition;
  readonly sourceIdentity: string;
  readonly purposeRef: string;
  readonly exactRightsScope: string;
  readonly sourceVersionRef: string;
  readonly allowedSignals?: readonly CameraSignal[];
  readonly selectedSignals?: readonly CameraSignal[];
  readonly syncPolicyRef?: string;
  readonly codecProfileRef?: string;
  readonly decisionRef: string;
  readonly checkedAtEpochMillis: number;
  readonly expiresAtEpochMillis: number;
}

/** Trusted policy/consent read port. It must return evidence from the owning authority. */
export interface CameraConsentPort {
  checkFresh(request: CaptureRequest, nowEpochMillis: number): Promise<CameraPermissionDecision>;
  /** Notify on revocation/expiry; return an idempotent listener removal function. */
  subscribe(request: CaptureRequest, onChange: (disposition: CameraPermissionDisposition) => void): () => void;
}

export interface CameraTrack {
  /** One encoded/raw frame; null means end of stream. Must observe abort when possible. */
  nextFrame(signal: AbortSignal): Promise<Uint8Array | CameraFrameRead | null>;
  /** Exact host-reported source, signal, codec and source-clock declaration. Missing is unavailable. */
  readonly sourceMetadata?: CameraTrackSourceMetadata | null;
  /** Stop every camera/media track owned by this source. */
  stopTracks(): Promise<void> | void;
}

export interface CameraTrackSourceMetadata {
  readonly sourceIdentity: string;
  readonly sourceVersionRef: string;
  readonly allowedSignals: readonly CameraSignal[];
  readonly selectedSignals: readonly CameraSignal[];
  readonly syncPolicyRef: string;
  readonly codecDisposition: "AVAILABLE" | "UNSUPPORTED" | "UNKNOWN";
  readonly codecProfileRef?: string;
  readonly codecId?: string;
  readonly mimeType?: string;
  readonly width?: number;
  readonly height?: number;
  readonly sourceClockRef?: string | null;
  readonly sourceStreamRef?: string | null;
  readonly sourceOriginRef?: string | null;
  readonly sourceTimeBase?: CameraPositiveRational | null;
}

export interface CameraFrameRead {
  readonly bytes: Uint8Array;
  /** Source presentation ticks supplied by the source; never derived from the host capture clock. */
  readonly presentationTicks?: string;
  readonly discontinuity?: CameraDiscontinuity;
  /** Source-provided audio sample clock for a synchronized multiplexed camera read. */
  readonly audioSample?: CameraAudioSampleObservation;
}

export interface CameraAudioSampleObservation {
  readonly sampleIndex: string;
  readonly sampleRate: CameraPositiveRational;
  readonly sourceStreamRef: string;
}

/** Host implementation may use getUserMedia or a native camera bridge. */
export interface CameraMediaDevicePort {
  open(request: CaptureRequest, signal: AbortSignal): Promise<CameraTrack>;
}

export interface CameraFrameClockPort {
  nowEpochMillis(): number;
  /** Start a new unique PTS epoch for a newly opened source/device. */
  beginEpoch(request: CaptureRequest): string;
  /** Monotonic frame PTS within the supplied epoch, in nanoseconds. */
  readPtsNanos(epochRef: string): bigint | number;
}

export interface CameraCaptureAdapterOptions {
  readonly mediaDevices: CameraMediaDevicePort;
  readonly consent: CameraConsentPort;
  readonly frameClock: CameraFrameClockPort;
  readonly maxConsentAgeMillis?: number;
  readonly maxFrameBytes?: number;
  readonly maxFrames?: number;
  readonly maxSessionMillis?: number;
}

const MAX_CONSENT_AGE_MILLIS = 60_000;
const DEFAULT_CONSENT_AGE_MILLIS = 5_000;
const MAX_FRAMES = 60_000;
const DEFAULT_FRAMES = 30_000;
const MAX_SESSION_MILLIS = 3_600_000;
const DEFAULT_SESSION_MILLIS = 300_000;
const MAX_CAMERA_SESSION_BYTES = MAX_CAPTURED_FRAME_BYTES;

export type CameraCaptureErrorCode =
  | "INVALID_REQUEST"
  | "PERMISSION_MISSING"
  | "PERMISSION_DENIED"
  | "PERMISSION_STALE"
  | "PERMISSION_UNKNOWN"
  | "PERMISSION_MISMATCH"
  | "CONSENT_REVOKED"
  | "DEVICE_UNAVAILABLE"
  | "SOURCE_METADATA_UNAVAILABLE"
  | "CODEC_UNSUPPORTED"
  | "CODEC_UNAVAILABLE"
  | "SIGNAL_UNSUPPORTED"
  | "FRAME_INVALID"
  | "FRAME_LIMIT"
  | "PTS_INVALID"
  | "DEVICE_SWITCHED"
  | "SESSION_CLOSED";

export class CameraCaptureError extends Error {
  public constructor(public readonly code: CameraCaptureErrorCode, message: string) {
    super(message);
    this.name = "CameraCaptureError";
  }
}

export interface CameraCapturedFrame extends CapturedFrame {
  readonly sourceIdentity: string;
  readonly purposeRef: string;
  readonly exactRightsScope: string;
  readonly sourceVersionRef: string;
  readonly frameClockRef: string;
  readonly epochRef: string;
  /** Host monotonic capture-clock ticks; distinct from source presentation ticks below. */
  readonly ptsNanos: bigint;
  readonly sourcePresentationTime: CameraSourcePresentationTime;
  readonly audioSampleTime: CameraAudioSampleTime;
  readonly cameraMetadata: CameraCaptureMetadata;
}

function fail(code: CameraCaptureErrorCode, message: string): CameraCaptureError {
  return new CameraCaptureError(code, message);
}

function snapshotRequest(request: CaptureRequest): CaptureRequest {
  if (!request || typeof request !== "object" || request.kind !== "CAMERA") {
    throw fail("INVALID_REQUEST", "camera request kind must be CAMERA");
  }
  const fields = [request.sourceIdentity, request.purposeRef, request.exactRightsScope,
    request.sourceVersionRef, request.secretsRef, request.frameClockRef];
  if (fields.some((field) => typeof field !== "string" || field.trim().length === 0
    || field !== field.trim() || field.length > 384)) {
    throw fail("INVALID_REQUEST", "camera request requires canonical source, purpose, rights, version, secret and clock refs");
  }
  return Object.freeze({ ...request });
}

function abortError(): CameraCaptureError {
  return fail("CONSENT_REVOKED", "camera consent changed during frame capture; frame discarded");
}

function awaitOrAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function toPts(value: bigint | number): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw fail("PTS_INVALID", "camera PTS must be non-negative");
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw fail("PTS_INVALID", "camera PTS must be a non-negative safe integer or bigint");
  }
  return BigInt(value);
}

function versionRef(value: unknown, label: string): string {
  const parsed = VersionRefSchema.safeParse(value);
  if (!parsed.success) throw fail("SOURCE_METADATA_UNAVAILABLE", `camera ${label} reference is missing or malformed`);
  return parsed.data;
}

function nullableVersionRef(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return versionRef(value, "source clock identity");
}

function boundedText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw fail("SOURCE_METADATA_UNAVAILABLE", `camera ${label} is missing or malformed`);
  }
  return value;
}

function normalizedSignals(value: unknown): CameraSignal[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2
    || value.some((signal) => signal !== "VIDEO" && signal !== "AUDIO")
    || new Set(value).size !== value.length) return null;
  return [...value].sort((left, right) => left.localeCompare(right)) as CameraSignal[];
}

function sameSignals(actual: readonly CameraSignal[] | undefined, expected: readonly CameraSignal[]): boolean {
  const normalized = normalizedSignals(actual);
  return normalized !== null && normalized.length === expected.length
    && normalized.every((signal, index) => signal === expected[index]);
}

export class CameraCaptureAdapter implements CaptureSourceAdapter {
  public readonly kind = "CAMERA" as const;
  private readonly options: CameraCaptureAdapterOptions;
  private readonly maxConsentAgeMillis: number;
  private readonly maxFrameBytes: number;
  private readonly maxFrames: number;
  private readonly maxSessionMillis: number;
  private activeSession: CameraCaptureSession | null = null;

  public constructor(options: CameraCaptureAdapterOptions) {
    if (!options || typeof options.mediaDevices?.open !== "function"
      || typeof options.consent?.checkFresh !== "function"
      || typeof options.consent?.subscribe !== "function"
      || typeof options.frameClock?.nowEpochMillis !== "function"
      || typeof options.frameClock?.beginEpoch !== "function"
      || typeof options.frameClock?.readPtsNanos !== "function") {
      throw new TypeError("media-device, consent and frame-clock ports are required");
    }
    this.options = options;
    this.maxConsentAgeMillis = options.maxConsentAgeMillis ?? DEFAULT_CONSENT_AGE_MILLIS;
    if (!Number.isSafeInteger(this.maxConsentAgeMillis) || this.maxConsentAgeMillis < 1
      || this.maxConsentAgeMillis > MAX_CONSENT_AGE_MILLIS) {
      throw new TypeError(`maxConsentAgeMillis must be 1..${MAX_CONSENT_AGE_MILLIS}`);
    }
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_CAPTURED_FRAME_BYTES;
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 1
      || this.maxFrameBytes > MAX_CAPTURED_FRAME_BYTES) {
      throw new TypeError(`maxFrameBytes must be 1..${MAX_CAPTURED_FRAME_BYTES}`);
    }
    this.maxFrames = options.maxFrames ?? DEFAULT_FRAMES;
    if (!Number.isSafeInteger(this.maxFrames) || this.maxFrames < 1 || this.maxFrames > MAX_FRAMES) {
      throw new TypeError(`maxFrames must be 1..${MAX_FRAMES}`);
    }
    this.maxSessionMillis = options.maxSessionMillis ?? DEFAULT_SESSION_MILLIS;
    if (!Number.isSafeInteger(this.maxSessionMillis) || this.maxSessionMillis < 1
      || this.maxSessionMillis > MAX_SESSION_MILLIS) {
      throw new TypeError(`maxSessionMillis must be 1..${MAX_SESSION_MILLIS}`);
    }
  }

  /** Start a bounded live session after fresh exact permission is confirmed. */
  public async openSession(request: CaptureRequest): Promise<CameraCaptureSession> {
    const bound = snapshotRequest(request);
    await this.activeSession?.close();
    const session = new CameraCaptureSession(this.options, bound, {
      maxConsentAgeMillis: this.maxConsentAgeMillis,
      maxFrameBytes: this.maxFrameBytes,
      maxFrames: this.maxFrames,
      maxSessionMillis: this.maxSessionMillis,
      onClose: (closed) => { if (this.activeSession === closed) this.activeSession = null; },
    });
    this.activeSession = session;
    try {
      await session.open();
    } catch (error) {
      if (this.activeSession === session) this.activeSession = null;
      throw error;
    }
    return session;
  }

  /** Adapt one live frame to the shared capture SPI; no frame bytes escape on denial/revoke. */
  public async capture(request: CaptureRequest): Promise<CameraCapturedFrame> {
    const session = await this.openSession(request);
    try {
      const frame = await session.nextFrame();
      return Object.freeze({ ...frame, bytes: Uint8Array.from(frame.bytes) });
    } finally {
      await session.close();
    }
  }

  public async close(): Promise<void> {
    await this.activeSession?.close();
  }
}

export interface CameraCaptureSessionLimits {
  readonly maxConsentAgeMillis: number;
  readonly maxFrameBytes: number;
  readonly maxFrames: number;
  readonly maxSessionMillis: number;
  readonly onClose: (session: CameraCaptureSession) => void;
}

export class CameraCaptureSession {
  private request: CaptureRequest;
  private readonly options: CameraCaptureAdapterOptions;
  private readonly limits: CameraCaptureSessionLimits;
  private track: CameraTrack | null = null;
  private stopPromise: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private unsubscribe: (() => void) | null = null;
  private revoked = false;
  private switching = false;
  private closed = false;
  private stopped = true;
  private epochRef = "";
  private lastPts: bigint | null = null;
  private lastSourcePts: bigint | null = null;
  private sourceMetadata: CameraCaptureMetadata | null = null;
  private frames = 0;
  private bytes = 0;
  private startedAt: number;
  private readonly seenEpochRefs = new Set<string>();

  public constructor(options: CameraCaptureAdapterOptions, request: CaptureRequest,
    limits: CameraCaptureSessionLimits) {
    this.options = options;
    this.request = request;
    this.limits = limits;
    this.startedAt = options.frameClock.nowEpochMillis();
  }

  public async open(): Promise<void> {
    await this.replaceSource(this.request, false);
  }

  public async nextFrame(): Promise<CameraCapturedFrame> {
    if (this.closed || this.track === null || this.controller === null) {
      throw fail("SESSION_CLOSED", "camera capture session is not active");
    }
    const track = this.track;
    const controller = this.controller;
    if (this.revoked) throw abortError();
    if (this.controller.signal.aborted) {
      throw this.switching
        ? fail("DEVICE_SWITCHED", "in-flight camera frame was discarded during device switch")
        : fail("SESSION_CLOSED", "camera session was stopped before the frame completed");
    }
    if (this.frames >= this.limits.maxFrames
      || this.options.frameClock.nowEpochMillis() - this.startedAt >= this.limits.maxSessionMillis) {
      await this.close();
      throw fail("FRAME_LIMIT", "camera session exceeded its bounded frame or duration limit");
    }
    try {
      await this.assertFreshPermission(this.request);
    } catch (error) {
      if (this.revoked) {
        await this.close();
        throw abortError();
      }
      if (this.switching) {
        throw fail("DEVICE_SWITCHED", "in-flight camera frame was discarded during device switch");
      }
      await this.close();
      throw error;
    }
    if (this.revoked) throw abortError();
    if (controller.signal.aborted || this.closed) {
      throw this.switching
        ? fail("DEVICE_SWITCHED", "in-flight camera frame was discarded during device switch")
        : fail("SESSION_CLOSED", "camera session stopped before frame completion");
    }
    let raw: Uint8Array | CameraFrameRead | null;
    try {
      raw = await awaitOrAbort(track.nextFrame(controller.signal), controller.signal);
    } catch (error) {
      if (this.revoked) {
        await this.close();
        throw abortError();
      }
      if (controller.signal.aborted && this.switching) {
        throw fail("DEVICE_SWITCHED", "in-flight camera frame was discarded during device switch");
      }
      if (controller.signal.aborted || this.closed) {
        throw fail("SESSION_CLOSED", "camera session stopped before frame completion");
      }
      await this.close();
      throw fail("DEVICE_UNAVAILABLE", "camera frame read failed; provider details were omitted");
    }
    if (this.revoked) throw abortError();
    if (controller.signal.aborted || this.closed) {
      throw this.switching
        ? fail("DEVICE_SWITCHED", "in-flight camera frame was discarded during device switch")
        : fail("SESSION_CLOSED", "camera session stopped before frame completion");
    }
    if (raw === null) {
      await this.close();
      throw fail("DEVICE_UNAVAILABLE", "camera source ended before a frame was produced");
    }
    const frameRead = raw instanceof Uint8Array ? { bytes: raw } : raw;
    if (!frameRead || !(frameRead.bytes instanceof Uint8Array)
      || frameRead.bytes.byteLength < 1 || frameRead.bytes.byteLength > this.limits.maxFrameBytes) {
      await this.close();
      throw fail("FRAME_INVALID", "camera frame is empty or exceeds its byte bound");
    }
    // Re-read exact permission after the await. A revoked/stale decision rejects
    // before the provider-owned byte array is copied or returned to the caller.
    try {
      await this.assertFreshPermission(this.request);
    } catch (error) {
      if (this.revoked) {
        await this.close();
        throw abortError();
      }
      if (this.switching) {
        throw fail("DEVICE_SWITCHED", "in-flight camera frame was discarded during device switch");
      }
      await this.close();
      throw error;
    }
    if (this.revoked) throw abortError();
    if (controller.signal.aborted || this.closed) {
      throw this.switching
        ? fail("DEVICE_SWITCHED", "in-flight camera frame was discarded during device switch")
        : fail("SESSION_CLOSED", "camera session stopped before frame completion");
    }
    const ptsNanos = toPts(this.options.frameClock.readPtsNanos(this.epochRef));
    if (this.lastPts !== null && ptsNanos <= this.lastPts) {
      await this.close();
      throw fail("PTS_INVALID", "camera PTS must strictly increase within each source epoch");
    }
    if (this.bytes + frameRead.bytes.byteLength > MAX_CAMERA_SESSION_BYTES) {
      await this.close();
      throw fail("FRAME_LIMIT", "camera session exceeded its aggregate byte budget");
    }
    let sourcePresentationTime: CameraSourcePresentationTime;
    let audioSampleTime: CameraAudioSampleTime;
    try {
      sourcePresentationTime = this.sourcePresentationTime(frameRead);
      audioSampleTime = this.audioSampleTime(frameRead);
    } catch (error) {
      await this.close();
      throw error;
    }
    const detached = Uint8Array.from(frameRead.bytes);
    this.lastPts = ptsNanos;
    this.frames += 1;
    this.bytes += detached.byteLength;
    const cameraMetadata = Object.freeze({
      ...this.sourceMetadata!,
      captureEpochRef: this.epochRef,
      captureClockRef: this.request.frameClockRef,
      hostCapturePtsNanos: ptsNanos.toString(),
    });
    return Object.freeze({
      sourceIdentity: this.request.sourceIdentity,
      purposeRef: this.request.purposeRef,
      exactRightsScope: this.request.exactRightsScope,
      sourceVersionRef: this.request.sourceVersionRef,
      frameClockRef: this.request.frameClockRef,
      epochRef: this.epochRef,
      ptsNanos,
      sourcePresentationTime,
      audioSampleTime,
      cameraMetadata,
      bytes: detached,
      capturedAtEpochMillis: this.options.frameClock.nowEpochMillis(),
    });
  }

  /** Rebind to another exact source only after old camera tracks have stopped. */
  public async switchDevice(request: CaptureRequest): Promise<void> {
    if (this.closed) throw fail("SESSION_CLOSED", "camera capture session is closed");
    if (this.switching) throw fail("DEVICE_SWITCHED", "a camera device switch is already in progress");
    const nextRequest = snapshotRequest(request);
    if (nextRequest.sourceIdentity === this.request.sourceIdentity
      && nextRequest.sourceVersionRef === this.request.sourceVersionRef) {
      throw fail("INVALID_REQUEST", "device switch must select a different exact source revision");
    }
    this.switching = true;
    try {
      await this.stopCurrentSource();
      this.request = nextRequest;
      this.revoked = false;
      this.lastPts = null;
      this.lastSourcePts = null;
      this.frames = 0;
      this.bytes = 0;
      this.sourceMetadata = null;
      await this.replaceSource(nextRequest, true);
    } finally {
      this.switching = false;
    }
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stopCurrentSource();
    this.limits.onClose(this);
  }

  private async replaceSource(request: CaptureRequest, switching: boolean): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.revoked = false;
    try {
      await this.checkPermission(request, controller.signal);
      this.unsubscribe = this.options.consent.subscribe(request, (disposition) => {
        if (disposition !== "GRANTED") {
          this.revoked = true;
          controller.abort();
          void this.stopCurrentTrack();
        }
      });
      // The check is repeated after listener installation and immediately
      // before media-device open to close the authorization/start race.
      await this.assertFreshPermission(request);
      if (this.revoked || controller.signal.aborted) throw abortError();
      const opening = this.options.mediaDevices.open(request, controller.signal);
      // A host may resolve open late despite an abort. If that happens after
      // revocation/switch, release the returned device tracks immediately.
      void opening.then((lateTrack) => {
        if (controller.signal.aborted && lateTrack
          && typeof lateTrack.stopTracks === "function") {
          return Promise.resolve().then(() => lateTrack.stopTracks()).catch(() => undefined);
        }
        return undefined;
      }, () => undefined);
      const track = await awaitOrAbort(opening, controller.signal);
      if (!track || typeof track.nextFrame !== "function" || typeof track.stopTracks !== "function") {
        throw fail("DEVICE_UNAVAILABLE", "camera host returned an invalid track port");
      }
      this.track = track;
      this.stopPromise = null;
      this.stopped = false;
      this.sourceMetadata = this.validateSourceMetadata(request, track.sourceMetadata);
      if (this.revoked || controller.signal.aborted) {
        await this.stopCurrentTrack();
        throw abortError();
      }
      const sourcePermission = await this.assertFreshPermission(request);
      this.sourceMetadata = Object.freeze({ ...this.sourceMetadata, permissionDecisionRef: sourcePermission.decisionRef });
      this.epochRef = this.options.frameClock.beginEpoch(request);
      if (typeof this.epochRef !== "string" || this.epochRef.trim().length === 0) {
        await this.stopCurrentSource();
        throw fail("PTS_INVALID", "frame clock did not create a source epoch");
      }
      if (this.seenEpochRefs.has(this.epochRef)) {
        await this.stopCurrentSource();
        throw fail("PTS_INVALID", "frame clock reused a source epoch");
      }
      this.seenEpochRefs.add(this.epochRef);
      this.startedAt = this.options.frameClock.nowEpochMillis();
    } catch (error) {
      await this.stopCurrentSource();
      if (error instanceof CameraCaptureError) throw error;
      throw fail("DEVICE_UNAVAILABLE", switching
        ? "camera device switch could not open the newly authorized source"
        : "camera device could not be opened after fresh permission");
    }
  }

  private async checkPermission(request: CaptureRequest,
    signal?: AbortSignal): Promise<CameraPermissionDecision> {
    const now = this.options.frameClock.nowEpochMillis();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw fail("PERMISSION_STALE", "trusted clock did not provide a valid current time");
    }
    let decision: CameraPermissionDecision;
    try {
      const pending = this.options.consent.checkFresh(request, now);
      decision = signal === undefined ? await pending : await awaitOrAbort(pending, signal);
    } catch (error) {
      if (error instanceof CameraCaptureError) throw error;
      throw fail("PERMISSION_MISSING", "fresh camera permission evidence is unavailable");
    }
    this.validateDecision(request, decision, now);
    return decision;
  }

  private async assertFreshPermission(request: CaptureRequest): Promise<CameraPermissionDecision> {
    const decision = await this.checkPermission(request, this.controller?.signal);
    const now = this.options.frameClock.nowEpochMillis();
    this.validateDecision(request, decision, now);
    if (this.revoked || decision.disposition === "REVOKED") throw abortError();
    if (decision.disposition === "UNKNOWN") {
      throw fail("PERMISSION_UNKNOWN", "current camera permission is unknown");
    }
    if (decision.disposition !== "GRANTED") {
      throw fail("PERMISSION_DENIED", "current camera permission does not authorize capture");
    }
    return decision;
  }

  private validateSourceMetadata(request: CaptureRequest,
    metadata: CameraTrackSourceMetadata | null | undefined): CameraCaptureMetadata {
    if (!metadata || typeof metadata !== "object") {
      throw fail("SOURCE_METADATA_UNAVAILABLE", "camera host did not provide exact source and codec metadata");
    }
    if (metadata.sourceIdentity !== request.sourceIdentity || metadata.sourceVersionRef !== request.sourceVersionRef) {
      throw fail("SOURCE_METADATA_UNAVAILABLE", "camera host returned metadata for another source revision");
    }
    if (metadata.codecDisposition === "UNSUPPORTED") {
      throw fail("CODEC_UNSUPPORTED", "selected camera codec profile is unsupported");
    }
    if (metadata.codecDisposition !== "AVAILABLE") {
      throw fail("CODEC_UNAVAILABLE", "camera codec availability is unknown");
    }
    const allowedSignals = normalizedSignals(metadata.allowedSignals);
    const selectedSignals = normalizedSignals(metadata.selectedSignals);
    if (!allowedSignals || !selectedSignals || selectedSignals.length === 0
      || !selectedSignals.includes("VIDEO") || selectedSignals.some((signal) => !allowedSignals.includes(signal))) {
      throw fail("SIGNAL_UNSUPPORTED", "camera source did not declare a supported selected signal subset");
    }
    const codecProfileRef = versionRef(metadata.codecProfileRef, "codec profile");
    const syncPolicyRef = versionRef(metadata.syncPolicyRef, "sync policy");
    const codecId = versionRef(metadata.codecId, "codec identity");
    const mimeType = boundedText(metadata.mimeType, 128, "codec MIME type");
    const width = metadata.width;
    const height = metadata.height;
    if (typeof width !== "number" || !Number.isSafeInteger(width) || width < 1 || width > 16_384
      || typeof height !== "number" || !Number.isSafeInteger(height) || height < 1 || height > 16_384) {
      throw fail("SOURCE_METADATA_UNAVAILABLE", "camera host did not declare bounded encoded dimensions");
    }
    const sourceClockRef = nullableVersionRef(metadata.sourceClockRef);
    const sourceStreamRef = nullableVersionRef(metadata.sourceStreamRef);
    const sourceOriginRef = nullableVersionRef(metadata.sourceOriginRef);
    let sourceTimeBase: CameraPositiveRational | null = null;
    if (metadata.sourceTimeBase !== undefined && metadata.sourceTimeBase !== null) {
      const parsed = PositiveRationalSchema.safeParse(metadata.sourceTimeBase);
      if (!parsed.success) throw fail("SOURCE_METADATA_UNAVAILABLE", "camera source time base is malformed");
      sourceTimeBase = parsed.data;
    }
    const clockMappings: readonly CameraClockMappingUncertainty[] = Object.freeze([
      "AUDIO_SAMPLE", "STORY", "SIMULATION", "WALL_CLOCK",
    ].map((destinationDomain) => Object.freeze({
      sourceDomain: "SOURCE_VIDEO_PRESENTATION" as const,
      destinationDomain: destinationDomain as CameraClockMappingUncertainty["destinationDomain"],
      disposition: "UNKNOWN" as const,
      reason: "NO_QUALIFIED_CLOCK_ALIGNMENT" as const,
    })));
    return Object.freeze({
      captureEpochRef: "",
      captureClockRef: request.frameClockRef,
      hostCapturePtsNanos: "",
      sourceIdentity: metadata.sourceIdentity,
      sourceVersionRef: metadata.sourceVersionRef,
      permissionDecisionRef: "pending-source-permission-readback",
      allowedSignals: Object.freeze(allowedSignals),
      selectedSignals: Object.freeze(selectedSignals),
      syncPolicyRef,
      codecDisposition: "AVAILABLE" as const,
      codecProfileRef,
      codecId,
      mimeType,
      width,
      height,
      sourceClockRef,
      sourceStreamRef,
      sourceOriginRef,
      sourceTimeBase,
      clockMappings,
    });
  }

  private sourcePresentationTime(frameRead: CameraFrameRead): CameraSourcePresentationTime {
    const metadata = this.sourceMetadata;
    if (metadata === null) {
      return { disposition: "UNKNOWN", reason: "SOURCE_CLOCK_IDENTITY_NOT_SUPPLIED" };
    }
    if (frameRead.presentationTicks === undefined) {
      return { disposition: "UNKNOWN", reason: "SOURCE_PTS_NOT_SUPPLIED" };
    }
    if (metadata.sourceTimeBase === null) {
      return { disposition: "UNKNOWN", reason: "SOURCE_TIMEBASE_NOT_SUPPLIED" };
    }
    if (metadata.sourceClockRef === null || metadata.sourceStreamRef === null || metadata.sourceOriginRef === null) {
      return { disposition: "UNKNOWN", reason: "SOURCE_CLOCK_IDENTITY_NOT_SUPPLIED" };
    }
    if (!SignedInt64DecimalSchema.safeParse(frameRead.presentationTicks).success
      || BigInt(frameRead.presentationTicks) < 0n) {
      throw fail("PTS_INVALID", "camera source PTS must be a non-negative canonical int64 decimal");
    }
    const pts = BigInt(frameRead.presentationTicks);
    const declaredDiscontinuity = frameRead.discontinuity;
    let discontinuity: CameraDiscontinuity;
    if (declaredDiscontinuity === undefined || declaredDiscontinuity.disposition === "UNKNOWN") {
      discontinuity = { disposition: "UNKNOWN", reason: "SOURCE_DISCONTINUITY_NOT_REPORTED" };
    } else if (declaredDiscontinuity.disposition === "NONE") {
      discontinuity = { disposition: "NONE" };
    } else if (declaredDiscontinuity.disposition === "GAP" || declaredDiscontinuity.disposition === "RESET") {
      discontinuity = {
        disposition: declaredDiscontinuity.disposition,
        evidenceRef: versionRef(declaredDiscontinuity.evidenceRef, "discontinuity evidence"),
      };
    } else {
      throw fail("PTS_INVALID", "camera source discontinuity status is unsupported");
    }
    if (this.lastSourcePts !== null && pts <= this.lastSourcePts && discontinuity.disposition !== "RESET") {
      throw fail("PTS_INVALID", "source presentation PTS must strictly increase within the exact source epoch");
    }
    this.lastSourcePts = pts;
    return Object.freeze({
      disposition: "KNOWN",
      sourceClockRef: metadata.sourceClockRef,
      sourceStreamRef: metadata.sourceStreamRef,
      sourceOriginRef: metadata.sourceOriginRef,
      presentationTicks: frameRead.presentationTicks,
      timeBase: metadata.sourceTimeBase,
      discontinuity: Object.freeze({ ...discontinuity }),
    });
  }

  private audioSampleTime(frameRead: CameraFrameRead): CameraAudioSampleTime {
    const metadata = this.sourceMetadata;
    if (metadata === null || !metadata.selectedSignals.includes("AUDIO")) {
      return { disposition: "NOT_SELECTED" };
    }
    const observation = frameRead.audioSample;
    if (observation === undefined) {
      return { disposition: "UNKNOWN", reason: "AUDIO_SAMPLE_CLOCK_NOT_SUPPLIED" };
    }
    if (!SignedInt64DecimalSchema.safeParse(observation.sampleIndex).success
      || BigInt(observation.sampleIndex) < 0n
      || !PositiveRationalSchema.safeParse(observation.sampleRate).success) {
      throw fail("PTS_INVALID", "camera audio sample index or rate is malformed");
    }
    const sourceStreamRef = versionRef(observation.sourceStreamRef, "audio source stream");
    if (!metadata.allowedSignals.includes("AUDIO")) {
      throw fail("SIGNAL_UNSUPPORTED", "camera returned audio samples outside the allowed signal set");
    }
    return Object.freeze({
      disposition: "KNOWN",
      sampleIndex: observation.sampleIndex,
      sampleRate: observation.sampleRate,
      sourceStreamRef,
    });
  }

  private validateDecision(request: CaptureRequest, decision: CameraPermissionDecision, now: number): void {
    if (!decision || typeof decision !== "object" || typeof decision.decisionRef !== "string"
      || decision.decisionRef.trim().length === 0) {
      throw fail("PERMISSION_MISSING", "camera permission response lacks a typed decision reference");
    }
    if (decision.sourceIdentity !== request.sourceIdentity || decision.purposeRef !== request.purposeRef
      || decision.exactRightsScope !== request.exactRightsScope
      || decision.sourceVersionRef !== request.sourceVersionRef) {
      throw fail("PERMISSION_MISMATCH", "camera permission does not bind the exact source and purpose");
    }
    if (this.sourceMetadata !== null
      && (!sameSignals(decision.allowedSignals, this.sourceMetadata.allowedSignals)
        || !sameSignals(decision.selectedSignals, this.sourceMetadata.selectedSignals)
        || decision.syncPolicyRef !== this.sourceMetadata.syncPolicyRef
        || decision.codecProfileRef !== this.sourceMetadata.codecProfileRef)) {
      throw fail("PERMISSION_MISMATCH", "camera permission does not bind the selected signals, sync policy and codec profile");
    }
    if (!Number.isSafeInteger(decision.checkedAtEpochMillis)
      || !Number.isSafeInteger(decision.expiresAtEpochMillis)
      || decision.checkedAtEpochMillis > now
      || now - decision.checkedAtEpochMillis > this.limits.maxConsentAgeMillis
      || decision.expiresAtEpochMillis <= now) {
      throw fail("PERMISSION_STALE", "camera permission decision is stale or expired");
    }
    if (decision.disposition !== "GRANTED" && decision.disposition !== "DENIED"
      && decision.disposition !== "REVOKED" && decision.disposition !== "UNKNOWN") {
      throw fail("PERMISSION_MISSING", "camera permission returned an unsupported disposition");
    }
  }

  private async stopCurrentSource(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.controller?.abort();
    await this.stopCurrentTrack();
    this.controller = null;
    this.sourceMetadata = null;
  }

  private async stopCurrentTrack(): Promise<void> {
    const track = this.track;
    if (track !== null && !this.stopped) {
      this.stopped = true;
      this.track = null;
      this.stopPromise = Promise.resolve().then(() => track.stopTracks()).catch(() => undefined);
    }
    if (this.stopPromise !== null) await this.stopPromise;
  }
}
