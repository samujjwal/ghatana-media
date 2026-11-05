/**
 * Concrete BROWSER capture adapter: records bounded frame bytes from an
 * explicit, host-supplied browser/DOM source (e.g. a Playwright page or
 * MediaRecorder stream wired by the host). The adapter never opens browsers,
 * tabs, or origins itself and grants no arbitrary browser privilege — the
 * host resolves exactly one origin-permitted source per request.
 *
 * Origin permission, visibility and viewport geometry are checked before the
 * first frame and rechecked per frame: a revoked permission, a hidden or
 * overlaid viewport, a CSP-violating source, a clock drift beyond the bound,
 * or a source-version mismatch all fail closed before more bytes are emitted.
 */
import {
  MAX_CAPTURED_FRAME_BYTES,
  type CaptureRequest,
  type CapturedFrame,
  type CaptureSourceAdapter,
} from "./capture-adapters.js";

export type BrowserOriginPermission = "GRANTED" | "DENIED" | "REVOKED";
export type BrowserVisibility = "VISIBLE" | "HIDDEN" | "OCCLUDED";

/** Explicit browser capture source resolved by the host for one request. */
export interface BrowserCaptureSource {
  /** Next raw frame; resolves `null` on stream end or detach. */
  nextFrame(): Promise<Uint8Array | null>;
  /** Exact viewport and scroll geometry of the current frame. */
  viewport(): { width: number; height: number; scrollX: number; scrollY: number };
  /** Live origin permission for the captured origin. */
  originPermission(): BrowserOriginPermission;
  /** Live visibility — hidden/occluded sources emit nothing. */
  visibility(): BrowserVisibility;
  /** Frame clock tick (nanos or millis by source epoch) for drift checks. */
  frameClockTick(): { clockId: string; tick: bigint | number };
  /** The exact source version of emitted frames. */
  sourceVersion(): string;
  /** Release the source; must be idempotent. */
  detach(): Promise<void>;
}

export interface BrowserCaptureAdapterOptions {
  /** Trusted resolver mapping the admitted request to one origin source. */
  resolveSource: (request: CaptureRequest) => BrowserCaptureSource | Promise<BrowserCaptureSource>;
  maxBytes?: number;
  maxFrames?: number;
  maxSessionMillis?: number;
  /** Maximum tolerated clock jump between consecutive frames (ms). */
  maxClockDriftMillis?: number;
}

const MAX_FRAMES = 60_000;
const DEFAULT_FRAMES = 30_000;
const MAX_SESSION_MILLIS = 3_600_000;
const DEFAULT_SESSION_MILLIS = 300_000;
const DEFAULT_CLOCK_DRIFT_MILLIS = 5_000;
const MAX_VIEWPORT_DIMENSION = 16_384;

export class BrowserCaptureError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BrowserCaptureError";
  }
}

const failure = (m: string) => new BrowserCaptureError(m);

function isBrowserSource(value: unknown): value is BrowserCaptureSource {
  const v = value as BrowserCaptureSource | null;
  return v !== null && typeof v === "object"
    && typeof v.nextFrame === "function"
    && typeof v.viewport === "function"
    && typeof v.originPermission === "function"
    && typeof v.visibility === "function"
    && typeof v.frameClockTick === "function"
    && typeof v.sourceVersion === "function"
    && typeof v.detach === "function";
}

export class BrowserCaptureAdapter implements CaptureSourceAdapter {
  public readonly kind = "BROWSER" as const;
  private readonly resolveSource: BrowserCaptureAdapterOptions["resolveSource"];
  private readonly maxBytes: number;
  private readonly maxFrames: number;
  private readonly maxSessionMillis: number;
  private readonly maxClockDriftMillis: number;
  private activeSource: BrowserCaptureSource | null = null;
  private detachState: { done: boolean } | null = null;

  public constructor(options: BrowserCaptureAdapterOptions) {
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
    const drift = options.maxClockDriftMillis ?? DEFAULT_CLOCK_DRIFT_MILLIS;
    if (!Number.isSafeInteger(drift) || drift < 1) {
      throw new TypeError("maxClockDriftMillis must be a positive integer");
    }
    this.maxBytes = maxBytes;
    this.maxFrames = maxFrames;
    this.maxSessionMillis = maxSession;
    this.maxClockDriftMillis = drift;
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
      throw new TypeError("capture request does not match this adapter");
    }
    const source = await this.resolveSource(request);
    if (!isBrowserSource(source)) {
      throw failure("resolved source is not an explicit browser capture source");
    }
    if (source.originPermission() !== "GRANTED") {
      throw failure("browser origin permission is not granted");
    }
    this.activeSource = source;
    this.detachState = { done: false };
    const startedAt = Date.now();
    const deadline = startedAt + this.maxSessionMillis;
    const chunks: Uint8Array[] = [];
    let total = 0;
    let frames = 0;
    let lastTick: bigint | null = null;
    const detachOnce = async () => {
      if (this.detachState !== null && !this.detachState.done) {
        this.detachState.done = true;
        await source.detach().catch(() => undefined);
      }
    };
    try {
      for (;;) {
        if (Date.now() >= deadline) {
          throw failure("browser capture exceeded its bounded duration");
        }
        if (frames >= this.maxFrames) {
          throw failure("browser capture exceeded its frame bound");
        }
        if (source.originPermission() !== "GRANTED") {
          throw failure("browser origin permission was revoked or denied mid-capture");
        }
        if (source.visibility() !== "VISIBLE") {
          throw failure("browser source is hidden or occluded — no frames may be emitted");
        }
        const frame = await source.nextFrame();
        if (frame === null) break;
        // Source-version binding: emitted frames must carry the admitted version.
        if (source.sourceVersion() !== request.sourceVersionRef) {
          throw failure("browser source version does not match the admitted sourceVersionRef");
        }
        const { width, height, scrollX, scrollY } = source.viewport();
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
          || width < 1 || height < 1 || width > MAX_VIEWPORT_DIMENSION || height > MAX_VIEWPORT_DIMENSION
          || !Number.isFinite(scrollX) || !Number.isFinite(scrollY)) {
          throw failure("browser source reported invalid viewport geometry");
        }
        const tick = source.frameClockTick();
        if (typeof tick.clockId !== "string" || tick.clockId.length === 0) {
          throw failure("browser source reported no frame clock");
        }
        const tickNanos = BigInt(tick.tick);
        if (lastTick !== null) {
          const driftMillis = Number(tickNanos > lastTick ? tickNanos - lastTick : lastTick - tickNanos) / 1e6;
          if (driftMillis > this.maxClockDriftMillis) {
            throw failure("browser frame clock drift exceeded the bounded tolerance");
          }
        }
        lastTick = tickNanos;
        frames += 1;
        total += frame.byteLength;
        if (total > this.maxBytes) {
          throw failure("browser capture exceeds the capture byte bound");
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
