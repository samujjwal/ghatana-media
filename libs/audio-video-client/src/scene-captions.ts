/**
 * Scenario narration/caption binding: converts validated caption cues into
 * WebVTT or TTML using exact integer source-tick arithmetic — never float
 * seconds — so generated captions stay frame-aligned to the declared source
 * clock. Cue offsets, seek windows and cancellation truncations are expressed
 * in the same ticks. Narration tracks are admitted only from approved TTS or
 * user-provided sources; voice-substitution claims are never a narration
 * source here.
 */

export const MAX_SCENE_CAPTION_CUES = 1024;
const REDACTED = "‹REDACTED›";
const PRIVATE_CONTENT_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:bearer|authorization)[ \t]+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(?:password|passwd|secret|api[_-]?key|token)[=:][ \t]*[^\s"']{4,}/gi,
];

export class SceneCaptionError extends Error {
  public readonly code: "INVALID_CUE" | "INVALID_CLOCK" | "NARRATION_NOT_ADMITTED";
  public constructor(code: SceneCaptionError["code"], message: string) {
    super(message);
    this.name = "SceneCaptionError";
    this.code = code;
  }
}

/** One validated caption cue in exact source ticks. */
export interface CaptionCue {
  readonly cueId: string;
  readonly text: string;
  readonly startTick: number;
  readonly endTick: number;
}

export interface SourceCaptionClock {
  /** Exact declared source clock reference (e.g. clock/ntsc-30). */
  readonly frameClockRef: string;
  readonly ticksPerSecond: number;
  readonly sourceDurationTicks: number;
}

export type NarrationSource =
  | { readonly tag: "APPROVED_TTS"; readonly voiceRef: string }
  | { readonly tag: "USER_PROVIDED"; readonly trackRef: string };

export function admitNarrationSource(source: NarrationSource | { tag: string }): asserts source is NarrationSource {
  if (!source || typeof source !== "object") {
    throw new SceneCaptionError("NARRATION_NOT_ADMITTED", "narration source must be an object");
  }
  if (source.tag === "APPROVED_TTS") {
    if (typeof (source as { voiceRef?: unknown }).voiceRef !== "string"
      || (source as { voiceRef: string }).voiceRef.trim().length === 0) {
      throw new SceneCaptionError("NARRATION_NOT_ADMITTED",
        "APPROVED_TTS narration must identify a non-empty voiceRef");
    }
    return;
  }
  if (source.tag === "USER_PROVIDED") {
    if (typeof (source as { trackRef?: unknown }).trackRef !== "string"
      || (source as { trackRef: string }).trackRef.trim().length === 0) {
      throw new SceneCaptionError("NARRATION_NOT_ADMITTED",
        "USER_PROVIDED narration must identify a non-empty trackRef");
    }
    return;
  }
  throw new SceneCaptionError("NARRATION_NOT_ADMITTED",
    `narration source '${String((source as { tag?: unknown }).tag)}' is not admitted — only APPROVED_TTS or USER_PROVIDED tracks may voice a scene`);
}

function requireClock(clock: SourceCaptionClock): void {
  if (!clock || typeof clock !== "object"
    || typeof clock.frameClockRef !== "string" || clock.frameClockRef.length === 0
    || !Number.isSafeInteger(clock.ticksPerSecond) || clock.ticksPerSecond < 1
    || !Number.isSafeInteger(clock.sourceDurationTicks) || clock.sourceDurationTicks < 1) {
    throw new SceneCaptionError("INVALID_CLOCK", "caption clock must declare a frameClockRef, positive ticksPerSecond and sourceDurationTicks");
  }
}

export function redactCaptionText(text: string, extraPatterns: ReadonlyArray<RegExp> = []): string {
  let out = text;
  for (const p of extraPatterns) out = out.replace(p, REDACTED);
  for (const p of PRIVATE_CONTENT_PATTERNS) out = out.replace(p, REDACTED);
  return out;
}

/** Validate cues: integer ticks, ordered, inside source duration, ≤ bound. */
export function validateCaptionCues(
  cues: readonly CaptionCue[],
  clock: SourceCaptionClock,
): readonly CaptionCue[] {
  requireClock(clock);
  if (!Array.isArray(cues) || cues.length > MAX_SCENE_CAPTION_CUES) {
    throw new SceneCaptionError("INVALID_CUE",
      `caption cues must be an array of at most ${MAX_SCENE_CAPTION_CUES} entries`);
  }
  let lastStart = -1;
  for (const [index, cue] of cues.entries()) {
    if (!cue || typeof cue !== "object"
      || typeof cue.cueId !== "string" || cue.cueId.length === 0
      || typeof cue.text !== "string"
      || !Number.isSafeInteger(cue.startTick) || !Number.isSafeInteger(cue.endTick)) {
      throw new SceneCaptionError("INVALID_CUE", `caption cue[${index}] must carry id, text and integer ticks`);
    }
    if (cue.startTick < 0 || cue.endTick <= cue.startTick || cue.endTick > clock.sourceDurationTicks) {
      throw new SceneCaptionError("INVALID_CUE",
        `caption cue[${index}] ${cue.cueId} is outside the declared source duration`);
    }
    if (cue.startTick < lastStart) {
      throw new SceneCaptionError("INVALID_CUE", `caption cues must be ordered by startTick`);
    }
    lastStart = cue.startTick;
  }
  return cues;
}

/** Exact tick → "HH:MM:SS.mmm" conversion using integer arithmetic. */
function vttTime(tick: number, tps: number): string {
  const ms = (BigInt(tick) * 1000n) / BigInt(tps);
  const h = ms / 3_600_000n, m = (ms / 60_000n) % 60n, s = (ms / 1000n) % 60n, f = ms % 1000n;
  const p = (v: bigint, w = 2) => v.toString().padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}.${p(f, 3)}`;
}

const escapeVtt = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/-->/g, "-&gt;");
const escapeXml = escapeVtt;

export function compileSceneVtt(
  cues: readonly CaptionCue[],
  clock: SourceCaptionClock,
  options: { readonly redactPatterns?: ReadonlyArray<RegExp> } = {},
): string {
  const valid = validateCaptionCues(cues, clock);
  const lines = ["WEBVTT", ""];
  for (const cue of valid) {
    lines.push(
      `${vttTime(cue.startTick, clock.ticksPerSecond)} --> ${vttTime(cue.endTick, clock.ticksPerSecond)}`,
      escapeVtt(redactCaptionText(cue.text, options.redactPatterns ?? [])),
      "",
    );
  }
  return lines.join("\n");
}

export function compileSceneTtml(
  cues: readonly CaptionCue[],
  clock: SourceCaptionClock,
  options: { readonly redactPatterns?: ReadonlyArray<RegExp>; readonly languageTag?: string } = {},
): string {
  const valid = validateCaptionCues(cues, clock);
  const lang = options.languageTag !== undefined ? ` xml:lang="${escapeXml(options.languageTag)}"` : "";
  const body = valid.map((cue) =>
    `    <p begin="${vttTime(cue.startTick, clock.ticksPerSecond)}" end="${vttTime(cue.endTick, clock.ticksPerSecond)}">${escapeXml(redactCaptionText(cue.text, options.redactPatterns ?? []))}</p>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tt xmlns="http://www.w3.org/ns/ttml"${lang}>\n  <body>\n${body}\n  </body>\n</tt>\n`;
}

/** Cues visible at an exact source-tick offset (deterministic seek). */
export function cuesAtOffset(cues: readonly CaptionCue[], tickOffset: number): readonly CaptionCue[] {
  if (!Number.isSafeInteger(tickOffset) || tickOffset < 0) {
    throw new SceneCaptionError("INVALID_CUE", "seek offset must be a non-negative integer tick");
  }
  return cues.filter((cue) => cue.startTick <= tickOffset && tickOffset < cue.endTick);
}

/** Truncate cues at a cancel tick — cues starting at/after it are dropped. */
export function truncateCuesAt(cues: readonly CaptionCue[], cancelTick: number): readonly CaptionCue[] {
  if (!Number.isSafeInteger(cancelTick) || cancelTick < 0) {
    throw new SceneCaptionError("INVALID_CUE", "cancel tick must be a non-negative integer");
  }
  return cues
    .filter((cue) => cue.startTick < cancelTick)
    .map((cue) => cue.endTick > cancelTick ? { ...cue, endTick: cancelTick } : cue);
}
