/**
 * Concrete TERMINAL capture adapter: records a bounded transcript from an
 * explicit, host-supplied terminal/PTY session handle. The adapter never
 * opens paths, spawns processes, or resolves ambient sessions — callers must
 * resolve an exact session through the trusted `resolveSession` seam, so
 * off-session capture is structurally impossible.
 *
 * Output is a normalized timed transcript (JSONL): ANSI control sequences are
 * stripped, line endings normalized, per-chunk millisecond timing and geometry
 * preserved, and secret-shaped content redacted before it ever reaches the
 * returned bytes. Session detach/close is guaranteed exactly once on end,
 * deadline, byte bound, error or external detach.
 */
import {
  MAX_CAPTURED_FRAME_BYTES,
  type CaptureRequest,
  type CapturedFrame,
  type CaptureSourceAdapter,
} from "./capture-adapters.js";

/** Explicit session handle resolved by the host for one request. */
export interface TerminalSession {
  /** Next output chunk; resolves `null` on session end or detach. */
  read(): Promise<Uint8Array | null>;
  /** Current terminal geometry in character cells. */
  geometry(): { cols: number; rows: number };
  /** Detach and release the session; must be idempotent. */
  detach(): Promise<void>;
}

export interface TerminalCaptureAdapterOptions {
  /** Trusted resolver mapping the admitted request to one explicit session. */
  resolveSession: (request: CaptureRequest) => TerminalSession | Promise<TerminalSession>;
  /** Maximum normalized transcript bytes; defaults to MAX_CAPTURED_FRAME_BYTES. */
  maxBytes?: number;
  /** Maximum session wall time; defaults to 300_000 ms, capped at 1 hour. */
  maxSessionMillis?: number;
  /** Additional host redaction patterns applied before built-in patterns. */
  redactPatterns?: ReadonlyArray<RegExp>;
}

const MAX_SESSION_MILLIS = 3_600_000;
const DEFAULT_SESSION_MILLIS = 300_000;
const REDACTED = "‹REDACTED›";

/** Built-in secret shapes redacted regardless of host patterns. */
const BUILTIN_SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:bearer|authorization)[ \t]+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
  /\b(?:password|passwd|secret|api[_-]?key|token)[=:][ \t]*[^\s"']{4,}/gi,
];

export class TerminalCaptureError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TerminalCaptureError";
  }
}

function failure(message: string): TerminalCaptureError {
  return new TerminalCaptureError(message);
}

function isTerminalSession(value: unknown): value is TerminalSession {
  const v = value as TerminalSession | null;
  return v !== null && typeof v === "object"
    && typeof v.read === "function"
    && typeof v.geometry === "function"
    && typeof v.detach === "function";
}

/**
 * Strip ANSI escape sequences (CSI, OSC, charset and single-char controls)
 * and normalize CR/LF variants to "\n". Returns printable transcript text.
 */
export function normalizeTerminalText(input: string): string {
  return input
    .replace(/\][^]*(?:|\\)/g, "")       // OSC ... BEL or ST
    .replace(/\[[0-?]*[ -/]*[@-~]/g, "")        // CSI
    .replace(/[()][0-2A-B]/g, "")               // charset select
    .replace(/[@-Z\\-_]/g, "")                  // two-char escapes
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");   // remaining C0 controls except \n \t
}

export class TerminalCaptureAdapter implements CaptureSourceAdapter {
  public readonly kind = "TERMINAL" as const;
  private readonly resolveSession: TerminalCaptureAdapterOptions["resolveSession"];
  private readonly maxBytes: number;
  private readonly maxSessionMillis: number;
  private readonly redactPatterns: ReadonlyArray<RegExp>;
  private activeSession: TerminalSession | null = null;

  public constructor(options: TerminalCaptureAdapterOptions) {
    if (!options || typeof options.resolveSession !== "function") {
      throw new TypeError("resolveSession is required");
    }
    this.resolveSession = options.resolveSession;
    const maxBytes = options.maxBytes ?? MAX_CAPTURED_FRAME_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CAPTURED_FRAME_BYTES) {
      throw new TypeError(`maxBytes must be 1..${MAX_CAPTURED_FRAME_BYTES}`);
    }
    const maxSession = options.maxSessionMillis ?? DEFAULT_SESSION_MILLIS;
    if (!Number.isSafeInteger(maxSession) || maxSession < 1 || maxSession > MAX_SESSION_MILLIS) {
      throw new TypeError(`maxSessionMillis must be 1..${MAX_SESSION_MILLIS}`);
    }
    this.maxBytes = maxBytes;
    this.maxSessionMillis = maxSession;
    this.redactPatterns = options.redactPatterns ?? [];
    for (const p of this.redactPatterns) {
      if (!(p instanceof RegExp)) throw new TypeError("redactPatterns must be RegExp values");
    }
  }

  private redact(text: string): string {
    let out = text;
    for (const p of this.redactPatterns) out = out.replace(p, REDACTED);
    for (const p of BUILTIN_SECRET_PATTERNS) out = out.replace(p, REDACTED);
    return out;
  }

  /** External detach: aborts an in-flight capture and closes the session once. */
  public async detach(): Promise<void> {
    const session = this.activeSession;
    if (session !== null && this.detachState !== null && !this.detachState.done) {
      this.detachState.done = true;
      await session.detach().catch(() => undefined);
    }
  }

  private detachState: { done: boolean } | null = null;

  public async capture(request: CaptureRequest): Promise<CapturedFrame> {
    if (request === null || typeof request !== "object" || request.kind !== this.kind) {
      throw new TypeError("capture request kind does not match this adapter");
    }
    const session = await this.resolveSession(request);
    if (!isTerminalSession(session)) {
      throw failure("resolved source is not an explicit terminal session");
    }
    this.activeSession = session;
    this.detachState = { done: false };
    const startedAt = Date.now();
    const deadline = startedAt + this.maxSessionMillis;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const detachOnce = async () => {
      if (this.detachState !== null && !this.detachState.done) {
        this.detachState.done = true;
        await session.detach().catch(() => undefined);
      }
    };
    try {
      for (;;) {
        if (Date.now() >= deadline) {
          throw failure("terminal session exceeded its bounded duration");
        }
        const raw = await session.read();
        if (raw === null) break;
        const t = Date.now() - startedAt;
        const { cols, rows } = session.geometry();
        if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 1 || rows < 1) {
          throw failure("terminal session reported invalid geometry");
        }
        const text = this.redact(normalizeTerminalText(decoder.decode(raw)));
        const line = `${JSON.stringify({ t, cols, rows, text })}\n`;
        const encoded = encoder.encode(line);
        total += encoded.byteLength;
        if (total > this.maxBytes) {
          throw failure("terminal transcript exceeds the capture byte bound");
        }
        chunks.push(encoded);
      }
    } finally {
      this.activeSession = null;
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
