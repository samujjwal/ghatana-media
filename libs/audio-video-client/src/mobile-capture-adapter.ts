/**
 * Concrete MOBILE capture adapter: records bounded frame bytes from an
 * explicit, host-supplied mobile device source. The adapter never opens a
 * device, camera or screen directly — the host resolves exactly one
 * permission-scoped source per request.
 *
 * Device permission is checked before the first frame and rechecked per
 * frame: camera/screen data is emitted only while the device reports
 * GRANTED and the app is foregrounded. Backgrounded sessions emit no
 * camera data. A reconnect produces a new source through the resolver —
 * no stale source is reused across disconnects. Frames carry the device
 * frame clock so captured bytes stay clock-aligned.
 */
import {
  MAX_CAPTURED_FRAME_BYTES,
  type CaptureRequest,
  type CapturedFrame,
  type CaptureSourceAdapter,
} from "./capture-adapters.js";

export type MobilePermissionState = "GRANTED" | "DENIED" | "REVOKED";
export type MobileAppState = "FOREGROUND" | "BACKGROUND";

/** Explicit mobile capture source resolved by the host for one request. */
export interface MobileCaptureSource {
  /** Next raw frame; resolves `null` on stream end or detach. */
  nextFrame(): Promise<Uint8Array | null>;
  /** Device frame clock of the current source epoch (e.g. sensor monotonic). */
  frameClock(): { clockId: string; tickNanos: bigint | number };
  /** Live permission state for the scoped capture (camera or screen). */
  permissionState(): MobilePermissionState;
  /** Live app foreground state — backgrounded sources emit no media data. */
  appState(): MobileAppState;
  /** Release the source; must be idempotent. */
  detach(): Promise<void>;
}

export interface MobileCaptureAdapterOptions {
  /** Trusted resolver mapping the admitted request to one device source. */
  resolveSource: (request: CaptureRequest) => MobileCaptureSource | Promise<MobileCaptureSource>;
  maxBytes?: number;
  maxFrames?: number;
  maxSessionMillis?: number;
}

const MAX_FRAMES = 60_000;
const DEFAULT_FRAMES = 30_000;
const MAX_SESSION_MILLIS = 3_600_000;
const DEFAULT_SESSION_MILLIS = 300_000;

export class MobileCaptureError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MobileCaptureError";
  }
}

const failure = (m: string) => new MobileCaptureError(m);

function isMobileSource(value: unknown): value is MobileCaptureSource {
  const v = value as MobileCaptureSource | null;
  return v !== null && typeof v === "object"
    && typeof v.nextFrame === "function"
    && typeof v.frameClock === "function"
    && typeof v.permissionState === "function"
    && typeof v.appState === "function"
    && typeof v.detach === "function";
}

export class MobileCaptureAdapter implements CaptureSourceAdapter {
  public readonly kind = "MOBILE" as const;
  private readonly resolveSource: MobileCaptureAdapterOptions["resolveSource"];
  private readonly maxBytes: number;
  private readonly maxFrames: number;
  private readonly maxSessionMillis: number;
  private activeSource: MobileCaptureSource | null = null;
  private detachState: { done: boolean } | null = null;

  public constructor(options: MobileCaptureAdapterOptions) {
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
    if (!isMobileSource(source)) {
      throw failure("resolved source is not an explicit mobile capture source");
    }
    if (source.permissionState() !== "GRANTED") {
      throw failure("mobile capture permission is not granted");
    }
    this.activeSource = source;
    this.detachState = { done: false };
    const startedAt = Date.now();
    const deadline = startedAt + this.maxSessionMillis;
    const chunks: Uint8Array[] = [];
    let total = 0;
    let frames = 0;
    let lastClockId: string | null = null;
    const detachOnce = async () => {
      if (this.detachState !== null && !this.detachState.done) {
        this.detachState.done = true;
        await source.detach().catch(() => undefined);
      }
    };
    try {
      for (;;) {
        if (Date.now() >= deadline) {
          throw failure("mobile capture exceeded its bounded duration");
        }
        if (frames >= this.maxFrames) {
          throw failure("mobile capture exceeded its frame bound");
        }
        const permission = source.permissionState();
        if (permission !== "GRANTED") {
          throw failure(`mobile capture permission ${permission === "DENIED" ? "denied" : "revoked"}`);
        }
        if (source.appState() !== "FOREGROUND") {
          throw failure("mobile capture cannot emit media while the app is backgrounded");
        }
        const frame = await source.nextFrame();
        if (frame === null) break;
        const clock = source.frameClock();
        if (typeof clock.clockId !== "string" || clock.clockId.length === 0) {
          throw failure("mobile source reported no frame clock");
        }
        // A clock change mid-capture marks a new source epoch (e.g. after a
        // reconnect); the caller must not merge frames across epochs.
        if (lastClockId === null) lastClockId = clock.clockId;
        else if (clock.clockId !== lastClockId) {
          throw failure("mobile source frame clock changed mid-capture — re-resolve after reconnect");
        }
        frames += 1;
        total += frame.byteLength;
        if (total > this.maxBytes) {
          throw failure("mobile capture exceeds the capture byte bound");
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
