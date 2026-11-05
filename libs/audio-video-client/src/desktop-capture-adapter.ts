/**
 * Concrete DESKTOP capture adapter: records bounded frame bytes from an
 * explicit, host-supplied desktop/window source. The adapter never opens
 * displays, enumerates windows, or links to any archived Tauri backend —
 * the host resolves exactly one consented source per request through the
 * trusted `resolveSource` seam.
 *
 * Opt-in is structural: every source must report a current consent state;
 * capture refuses before reading any pixels when consent is absent or
 * denied, and stops emitting frames the moment consent is revoked mid-run.
 * Frame bytes, crop geometry and device changes are bounded; detached
 * sources are closed exactly once.
 */
import {
  MAX_CAPTURED_FRAME_BYTES,
  type CaptureRequest,
  type CapturedFrame,
  type CaptureSourceAdapter,
} from "./capture-adapters.js";

export type DesktopConsentState = "GRANTED" | "DENIED" | "REVOKED";

/** Explicit desktop capture source resolved by the host for one request. */
export interface DesktopCaptureSource {
  /** Next raw frame; resolves `null` on stream end or detach. */
  nextFrame(): Promise<Uint8Array | null>;
  /** Current pixel geometry and format of emitted frames. */
  geometry(): { width: number; height: number; pixelFormat: string };
  /** Live consent state; checked before every frame read. */
  consentState(): DesktopConsentState;
  /** Release the capture source; must be idempotent. */
  detach(): Promise<void>;
}

export interface DesktopCaptureAdapterOptions {
  /** Trusted resolver mapping the admitted request to one consented source. */
  resolveSource: (request: CaptureRequest) => DesktopCaptureSource | Promise<DesktopCaptureSource>;
  /** Maximum emitted frame bytes; defaults to MAX_CAPTURED_FRAME_BYTES. */
  maxBytes?: number;
  /** Maximum frames per capture; defaults to 30_000, capped at 60_000. */
  maxFrames?: number;
  /** Maximum source duration; defaults to 300_000 ms, capped at 1 hour. */
  maxSessionMillis?: number;
}

const MAX_FRAMES = 60_000;
const DEFAULT_FRAMES = 30_000;
const MAX_SESSION_MILLIS = 3_600_000;
const DEFAULT_SESSION_MILLIS = 300_000;
const MAX_DIMENSION = 16_384;

export class DesktopCaptureError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DesktopCaptureError";
  }
}

const failure = (m: string) => new DesktopCaptureError(m);

function isDesktopSource(value: unknown): value is DesktopCaptureSource {
  const v = value as DesktopCaptureSource | null;
  return v !== null && typeof v === "object"
    && typeof v.nextFrame === "function"
    && typeof v.geometry === "function"
    && typeof v.consentState === "function"
    && typeof v.detach === "function";
}

export class DesktopCaptureAdapter implements CaptureSourceAdapter {
  public readonly kind = "DESKTOP" as const;
  private readonly resolveSource: DesktopCaptureAdapterOptions["resolveSource"];
  private readonly maxBytes: number;
  private readonly maxFrames: number;
  private readonly maxSessionMillis: number;
  private activeSource: DesktopCaptureSource | null = null;
  private detachState: { done: boolean } | null = null;

  public constructor(options: DesktopCaptureAdapterOptions) {
    if (!options || typeof options.resolveSource !== "function") {
      throw new TypeError("resolveSource is required");
    }
    this.resolveSource = options.resolveSource;
    const maxBytes = options.maxBytes ?? MAX_CAPTURED_FRAME_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CAPTURED_FRAME_BYTES) {
      throw new TypeError(`maxBytes must be 1..${MAX_CAPTURED_FRAME_BYTES}`);
    }
    const maxFrames = options.maxFrames ?? DEFAULT_FRAMES;
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > MAX_FRAMES) {
      throw new TypeError(`maxFrames must be 1..${MAX_FRAMES}`);
    }
    const maxSession = options.maxSessionMillis ?? DEFAULT_SESSION_MILLIS;
    if (!Number.isSafeInteger(maxSession) || maxSession < 1 || maxSession > MAX_SESSION_MILLIS) {
      throw new TypeError(`maxSessionMillis must be 1..${MAX_SESSION_MILLIS}`);
    }
    this.maxBytes = maxBytes;
    this.maxFrames = maxFrames;
    this.maxSessionMillis = maxSession;
  }

  /** External detach: aborts an in-flight capture and closes once. */
  public async detach(): Promise<void> {
    const source = this.activeSource;
    if (source !== null && this.detachState !== null && !this.detachState.done) {
      this.detachState.done = true;
      await source.detach().catch(() => undefined);
    }
  }

  public async capture(request: CaptureRequest): Promise<CapturedFrame> {
    if (request === null || typeof request !== "object" || request.kind !== this.kind) {
      throw new TypeError("capture request kind does not match this adapter");
    }
    const source = await this.resolveSource(request);
    if (!isDesktopSource(source)) {
      throw failure("resolved source is not an explicit desktop capture source");
    }
    // Opt-in gate: refuse before any pixel is read when consent is absent.
    if (source.consentState() !== "GRANTED") {
      throw failure("desktop capture consent is not granted");
    }
    this.activeSource = source;
    this.detachState = { done: false };
    const startedAt = Date.now();
    const deadline = startedAt + this.maxSessionMillis;
    const chunks: Uint8Array[] = [];
    let total = 0;
    let frames = 0;
    const detachOnce = async () => {
      if (this.detachState !== null && !this.detachState.done) {
        this.detachState.done = true;
        await source.detach().catch(() => undefined);
      }
    };
    try {
      for (;;) {
        if (Date.now() >= deadline) {
          throw failure("desktop capture exceeded its bounded duration");
        }
        if (frames >= this.maxFrames) {
          throw failure("desktop capture exceeded its frame bound");
        }
        // Re-check consent per frame: a mid-run revoke stops all pixels.
        const consent = source.consentState();
        if (consent !== "GRANTED") {
          throw failure(`desktop capture consent ${consent === "DENIED" ? "denied" : "revoked"}`);
        }
        const frame = await source.nextFrame();
        if (frame === null) break;
        const { width, height, pixelFormat } = source.geometry();
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
          || width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION
          || typeof pixelFormat !== "string" || pixelFormat.length === 0) {
          throw failure("desktop source reported invalid frame geometry");
        }
        frames += 1;
        total += frame.byteLength;
        if (total > this.maxBytes) {
          throw failure("desktop capture exceeds the capture byte bound");
        }
        chunks.push(frame);
      }
    } finally {
      this.activeSource = null;
      await detachOnce();
      this.detachState = null;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      sourceIdentity: request.sourceIdentity,
      purposeRef: request.purposeRef,
      exactRightsScope: request.exactRightsScope,
      sourceVersionRef: request.sourceVersionRef,
      frameClockRef: request.frameClockRef,
      bytes,
      capturedAtEpochMillis: Date.now(),
    };
  }
}
