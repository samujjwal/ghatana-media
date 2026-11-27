import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type {
  FinalRenderMuxAndProbePort,
  FinalRenderRequest,
  RenderCaptionTiming,
  RenderedContainer,
  RenderRational,
} from "./recorder-orchestrator.js";
import type { SceneRun } from "./recorder-orchestrator.js";

const MAX_TOOL_OUTPUT = 2 * 1024 * 1024;
const MAX_RENDER_OUTPUT = 64 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_INPUTS = 64;

export interface FinalRenderSourceResolver {
  resolveSceneSource(run: SceneRun): string | Promise<string>;
  resolveNarrationSource(trackRef: string): string | Promise<string>;
  resolveCaptionText(captionRef: string): string | Promise<string>;
}

export interface PinnedFfmpegRenderOptions {
  readonly ffmpegPath: string;
  readonly ffmpegSha256: string;
  readonly ffprobePath: string;
  readonly ffprobeSha256: string;
  readonly expectedVersion: string;
  readonly sourceRoot: string;
  readonly resolver: FinalRenderSourceResolver;
  readonly width?: number;
  readonly height?: number;
  readonly timeoutMillis?: number;
  /** Explicit record that this codec tool profile is for local development fixtures only. */
  readonly developmentLicenseProfileRef: string;
}

interface ToolRun { readonly code: number; readonly stdout: Buffer; readonly stderr: Buffer; }

function codecAbortError(): Error {
  const error = new Error("codec operation was cancelled");
  error.name = "AbortError";
  return error;
}

function runBounded(executable: string, args: readonly string[], timeoutMillis: number,
  maxOutputBytes: number, signal?: AbortSignal): Promise<ToolRun> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(codecAbortError());
      return;
    }
    const child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "pipe"], shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let total = 0;
    let settled = false;
    let failure: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const stop = (error: Error) => {
      if (settled || failure) return;
      failure = error;
      if (timer) clearTimeout(timer);
      if (child.pid !== undefined) {
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      }
    };
    const onAbort = () => stop(codecAbortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => stop(new Error("codec process timed out or was terminated")), timeoutMillis);
    if (signal?.aborted) onAbort();
    const collect = (target: Buffer[], chunk: Buffer) => {
      if (failure || settled) return;
      total += chunk.byteLength;
      if (total > maxOutputBytes) {
        stop(new Error("codec output exceeded bound"));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => stop(error));
    child.on("close", (code, processSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failure) {
        reject(failure);
        return;
      }
      if (processSignal !== null) {
        reject(new Error("codec process timed out or was terminated"));
        return;
      }
      resolvePromise({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function quoteSrtTime(milliseconds: number): string {
  const clamped = Math.max(0, Math.floor(milliseconds));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1_000);
  const millis = clamped % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}
function seconds(ticks: number, timeBase: RenderRational): number {
  return ticks * timeBase.numerator / timeBase.denominator;
}
function positiveRational(value: string): RenderRational | null {
  const match = /^(\d+)\/(\d+)$/u.exec(value);
  if (!match) return null;
  const numerator = Number(match[1]); const denominator = Number(match[2]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || !denominator) return null;
  let a = numerator; let b = denominator;
  while (b !== 0) { const rem = a % b; a = b; b = rem; }
  return { numerator: numerator / a, denominator: denominator / a };
}

export class PinnedFfmpegFinalRenderMuxer implements FinalRenderMuxAndProbePort {
  private readonly sourceRoot: string;
  private readonly width: number;
  private readonly height: number;
  private readonly timeoutMillis: number;
  private readonly ffmpegSha256: string;
  private readonly ffprobeSha256: string;

  public constructor(private readonly options: PinnedFfmpegRenderOptions) {
    if (!options || !options.resolver || typeof options.resolver.resolveSceneSource !== "function"
      || typeof options.resolver.resolveNarrationSource !== "function"
      || typeof options.resolver.resolveCaptionText !== "function") throw new TypeError("trusted source resolver is required");
    if (!/^[0-9a-f]{64}$/u.test(options.ffmpegSha256) || !/^[0-9a-f]{64}$/u.test(options.ffprobeSha256)) {
      throw new TypeError("exact FFmpeg and FFprobe SHA-256 pins are required");
    }
    if (!options.expectedVersion || options.expectedVersion.length > 64
      || !options.developmentLicenseProfileRef || options.developmentLicenseProfileRef.length > 384) {
      throw new TypeError("pinned version and development codec license profile are required");
    }
    this.sourceRoot = resolve(options.sourceRoot);
    this.width = options.width ?? 640;
    this.height = options.height ?? 360;
    this.timeoutMillis = options.timeoutMillis ?? 30_000;
    if (!Number.isSafeInteger(this.width) || this.width < 16 || this.width > 1920
      || !Number.isSafeInteger(this.height) || this.height < 16 || this.height > 1080
      || !Number.isSafeInteger(this.timeoutMillis) || this.timeoutMillis < 100 || this.timeoutMillis > 120_000) {
      throw new TypeError("render dimensions or timeout exceed local development bounds");
    }
    this.ffmpegSha256 = options.ffmpegSha256;
    this.ffprobeSha256 = options.ffprobeSha256;
  }

  public async muxAndVerify(request: FinalRenderRequest, signal?: AbortSignal): Promise<RenderedContainer> {
    if (signal?.aborted) throw codecAbortError();
    if (!request.fileName.toLowerCase().endsWith(".mp4") || request.variableFrameRate || request.creditRefs.length > 0
      || request.timeBase.numerator !== 1 || request.plan.sceneRuns.length < 1
      || request.plan.sceneRuns.length > MAX_INPUTS) throw new Error("unsupported local render profile");
    const totalMillis = request.plan.sceneRuns.reduce((total, run) => total + run.durationMillis, 0);
    if (!Number.isSafeInteger(totalMillis)
      || BigInt(totalMillis) * BigInt(request.timeBase.denominator) !== BigInt(request.durationTicks) * 1000n) {
      throw new Error("render duration does not match the exact scene clock");
    }
    const ffmpeg = await this.validateTool(this.options.ffmpegPath, this.ffmpegSha256);
    const ffprobe = await this.validateTool(this.options.ffprobePath, this.ffprobeSha256);
    const version = await runBounded(ffmpeg, ["-version"], this.timeoutMillis, MAX_TOOL_OUTPUT, signal);
    const probeVersion = await runBounded(ffprobe, ["-version"], this.timeoutMillis, MAX_TOOL_OUTPUT, signal);
    if (version.code !== 0 || probeVersion.code !== 0
      || !version.stdout.toString("utf8").includes(this.options.expectedVersion)
      || !probeVersion.stdout.toString("utf8").includes(this.options.expectedVersion)) {
      throw new Error("codec tool version does not match its pin");
    }
    const root = await realpath(this.sourceRoot);
    const scenePaths = await Promise.all(request.plan.sceneRuns.map((run) => this.resolveFile(root,
      this.options.resolver.resolveSceneSource(run), "video")));
    const narrationRefs = [...new Set(request.plan.sceneRuns.flatMap((run) => run.narration.map((cue) => cue.trackRef)))];
    const narrationSources: { ref: string; sceneOffsetMillis: number; cueAtMillis: number; path: string }[] = [];
    let sceneOffsetMillis = 0;
    for (const run of request.plan.sceneRuns) {
      for (const cue of run.narration) {
        narrationSources.push({ ref: cue.trackRef, sceneOffsetMillis, cueAtMillis: cue.atMillis,
          path: await this.resolveFile(root, this.options.resolver.resolveNarrationSource(cue.trackRef), "audio") });
      }
      sceneOffsetMillis += run.durationMillis;
    }
    if (scenePaths.length + narrationSources.length
      + (Array.isArray(request.captions) && request.captions.length > 0 ? 1 : 0) > MAX_INPUTS) {
      throw new Error("render input count exceeds bound");
    }
    const inputBytes = (await Promise.all([...scenePaths, ...narrationSources.map((source) => source.path)]
      .map(async (path) => (await stat(path)).size))).reduce((sum, size) => sum + size, 0);
    if (!Number.isSafeInteger(inputBytes) || inputBytes > MAX_TOTAL_SOURCE_BYTES) {
      throw new Error("combined source inputs exceed the local render bound");
    }
    if (!Array.isArray(request.captions) || request.captions.length > 256) throw new Error("caption count exceeds bound");
    const captions = await Promise.all(request.captions.map(async (caption) => ({
      ...caption,
      text: await this.options.resolver.resolveCaptionText(caption.captionRef),
    })));
    if (captions.some(({ text }) => typeof text !== "string" || text.trim().length === 0
      || text.length > 2_000 || /[\r\n\u0000-\u0008]/u.test(text))) throw new Error("caption text is invalid");

    if (signal?.aborted) throw codecAbortError();
    const work = await mkdtemp(resolve(tmpdir(), "media-render-"));
    try {
      const subtitlePath = resolve(work, "captions.srt");
      if (captions.length > 0) {
        const content = captions.map((caption, index) => [String(index + 1),
          `${quoteSrtTime(seconds(caption.startTicks, request.timeBase) * 1000)} --> ${quoteSrtTime(seconds(caption.endTicks, request.timeBase) * 1000)}`,
          caption.text.replace(/-->/gu, "—>"), ""].join("\n")).join("\n");
        await writeFile(subtitlePath, content, { encoding: "utf8", mode: 0o600 });
      }
      const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
      for (const path of scenePaths) {
        const formatWhitelist = path.toLowerCase().endsWith(".webm") ? "matroska,webm" : "mov,matroska";
        args.push("-protocol_whitelist", "file,pipe", "-format_whitelist", formatWhitelist, "-i", path);
      }
      for (const source of narrationSources) args.push("-protocol_whitelist", "file,pipe", "-format_whitelist", "wav,mp3,mov,aac", "-i", source.path);
      if (captions.length > 0) args.push("-protocol_whitelist", "file,pipe", "-format_whitelist", "srt", "-i", subtitlePath);
      const filters: string[] = [];
      const fps = `${request.frameRate.numerator}/${request.frameRate.denominator}`;
      request.plan.sceneRuns.forEach((run, index) => {
        const duration = run.durationMillis / 1000;
        filters.push(`[${index}:v:0]trim=duration=${duration},setpts=PTS-STARTPTS,fps=${fps},scale=${this.width}:${this.height}:force_original_aspect_ratio=decrease,pad=${this.width}:${this.height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}]`);
      });
      filters.push(`${request.plan.sceneRuns.map((_, index) => `[v${index}]`).join("")}concat=n=${scenePaths.length}:v=1:a=0[vout]`);
      const trackRefs: string[] = [];
      for (const ref of narrationRefs) {
        const trackIndex = trackRefs.length;
        const cues = narrationSources.filter((source) => source.ref === ref);
        const delayed: string[] = [];
        for (const [cueIndex, cue] of cues.entries()) {
          const inputIndex = scenePaths.length + narrationSources.indexOf(cue);
          const delay = cue.sceneOffsetMillis + cue.cueAtMillis;
          const label = `n${trackIndex}_${cueIndex}`;
          filters.push(`[${inputIndex}:a:0]asetpts=PTS-STARTPTS,adelay=${delay}|${delay}[${label}]`);
          delayed.push(`[${label}]`);
        }
        const out = `a${trackIndex}`;
        filters.push(`${delayed.join("")}amix=inputs=${delayed.length}:duration=longest:dropout_transition=0,atrim=duration=${totalMillis / 1000}[${out}]`);
        trackRefs.push(ref);
      }
      const outputPath = resolve(work, "render.mp4");
      args.push("-filter_complex", filters.join(";"), "-map", "[vout]");
      for (let i = 0; i < trackRefs.length; i += 1) args.push("-map", `[a${i}]`);
      if (captions.length > 0) args.push("-map", `${scenePaths.length + narrationSources.length}:s:0`);
      args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", fps,
        "-video_track_timescale", String(request.timeBase.denominator), "-c:a", "aac");
      for (let i = 0; i < trackRefs.length; i += 1) args.push(`-metadata:s:a:${i}`, `handler_name=${trackRefs[i]}`);
      if (captions.length > 0) args.push("-c:s", "mov_text", "-metadata:s:s:0", "title=Media captions");
      args.push("-t", String(totalMillis / 1000), "-movflags", "+faststart", "-fs", String(MAX_RENDER_OUTPUT), outputPath);
      const encoded = await runBounded(ffmpeg, args, this.timeoutMillis, MAX_TOOL_OUTPUT, signal);
      if (encoded.code !== 0) throw new Error("FFmpeg failed to encode the local render");
      const bytes = await readFile(outputPath);
      if (bytes.byteLength < 1 || bytes.byteLength > MAX_RENDER_OUTPUT) throw new Error("render output exceeds local bound");
      const decoded = await runBounded(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", outputPath,
        "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"], this.timeoutMillis, MAX_TOOL_OUTPUT, signal);
      if (decoded.code !== 0) throw new Error("FFmpeg could not decode the complete local render");
      const probeRun = await runBounded(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-show_format",
        "-of", "json", outputPath], this.timeoutMillis, MAX_TOOL_OUTPUT, signal);
      if (probeRun.code !== 0) throw new Error("FFprobe could not inspect the local render");
      const metadata = JSON.parse(probeRun.stdout.toString("utf8")) as ProbeDocument;
      const video = metadata.streams.find((stream) => stream.codec_type === "video");
      if (!video) throw new Error("render has no video stream");
      const frameRate = positiveRational(video.avg_frame_rate ?? video.r_frame_rate ?? "");
      const timeBase = positiveRational(video.time_base ?? "");
      const durationTicks = Number(video.duration_ts);
      const decodedFrameCount = Number(video.nb_read_frames ?? video.nb_frames);
      if (!frameRate || !timeBase || !Number.isSafeInteger(durationTicks) || !Number.isSafeInteger(decodedFrameCount)) {
        throw new Error("FFprobe render observations are incomplete");
      }
      const audioStreams = metadata.streams.filter((stream) => stream.codec_type === "audio");
      const subtitleStreams = metadata.streams.filter((stream) => stream.codec_type === "subtitle");
      const observedRefs = audioStreams.map((stream) => stream.tags?.handler_name ?? "");
      if (observedRefs.some((ref) => !ref) || observedRefs.length !== trackRefs.length
        || observedRefs.some((ref, index) => ref !== trackRefs[index])) throw new Error("audio track inventory differs from request");
      if (subtitleStreams.length !== (captions.length > 0 ? 1 : 0)) {
        throw new Error("subtitle track inventory differs from request");
      }
      const packetTimes = captions.length === 0 ? []
        : await this.probeCaptionPackets(ffprobe, outputPath, request.timeBase, signal);
      if (packetTimes.length !== captions.length) throw new Error("subtitle packet inventory differs from request");
      const captionTimings = captions.map((caption, index) => {
        const packet = packetTimes[index];
        if (!packet || packet.start === null || packet.duration === null) throw new Error("subtitle timing was not observed");
        return { captionRef: caption.captionRef, startTicks: packet.start,
          endTicks: packet.start + packet.duration };
      });
      const container = metadata.format.format_name;
      if (typeof container !== "string" || !container.split(",").includes("mp4")) {
        throw new Error("output is not an MP4 container");
      }
      return {
        bytes: new Uint8Array(bytes), contentType: "video/mp4",
        probe: {
          container,
          frameRate,
          variableFrameRate: false,
          timeBase,
          durationTicks,
          decodedFrameCount,
          audioTrackCount: audioStreams.length,
          narrationTrackRefs: observedRefs,
          captionTrackCount: subtitleStreams.length,
          captionTimings,
          creditRefsIncluded: [],
        },
      };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  private async validateTool(pathValue: string, expectedDigest: string): Promise<string> {
    if (!pathValue || !isAbsolute(pathValue)) throw new Error("codec executable path must be absolute");
    const path = await realpath(pathValue);
    const info = await stat(path);
    if (!info.isFile() || (info.mode & 0o111) === 0 || info.size > 100 * 1024 * 1024) {
      throw new Error("codec tool is not a bounded executable file");
    }
    if (sha256(await readFile(path)) !== expectedDigest) throw new Error("codec executable digest mismatch");
    return path;
  }

  private async probeCaptionPackets(
    ffprobe: string,
    outputPath: string,
    timeBase: RenderRational,
    signal?: AbortSignal,
  ): Promise<readonly { readonly start: number | null; readonly duration: number | null }[]> {
    // Restrict packet enumeration to the single bounded subtitle stream. Probing every video and
    // audio packet grows with render duration and can exceed the process output ceiling.
    const result = await runBounded(ffprobe, ["-v", "error", "-select_streams", "s", "-show_packets",
      "-show_entries", "packet=pts_time,dts_time,duration_time,size", "-of", "json", outputPath],
    this.timeoutMillis, MAX_TOOL_OUTPUT, signal);
    if (result.code !== 0) throw new Error("FFprobe could not inspect rendered caption packets");
    const metadata = JSON.parse(result.stdout.toString("utf8")) as ProbePacketsDocument;
    if (!Array.isArray(metadata.packets) || metadata.packets.length > 256
      || metadata.packets.some((packet) => typeof packet.size !== "string"
        || !/^\d+$/u.test(packet.size) || Number(packet.size) < 2)) {
      throw new Error("rendered caption packet inventory is invalid");
    }
    // FFmpeg's MOV text subtitle stream may begin with a valid two-byte empty
    // packet that clears the display before the first cue. It is not a caption
    // cue; count only packets with actual payload and verify those against the
    // requested caption inventory below.
    return metadata.packets.filter((packet) => Number(packet.size) > 2).map((packet) => ({
      start: parseProbeTicks(packet.pts_time ?? packet.dts_time ?? "", timeBase),
      duration: parseProbeTicks(packet.duration_time ?? "", timeBase),
    }));
  }

  private async resolveFile(root: string, pathValue: string | Promise<string>, kind: "video" | "audio"): Promise<string> {
    const inputPath = await pathValue;
    if (typeof inputPath !== "string" || !isAbsolute(inputPath)) throw new Error("source resolver must return an absolute path");
    const path = await realpath(inputPath);
    const fromRoot = relative(root, path);
    if (fromRoot === "" || fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
      throw new Error("resolved source is outside the configured root");
    }
    const info = await stat(path);
    if (!info.isFile() || info.size < 1 || info.size > MAX_RENDER_OUTPUT) throw new Error("resolved source is not a bounded file");
    const extension = basename(path).toLowerCase().slice(basename(path).lastIndexOf("."));
    const allowed = kind === "video" ? new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm"])
      : new Set([".wav", ".mp3", ".m4a", ".aac"]);
    if (!allowed.has(extension)) throw new Error("resolved source format is outside the local profile");
    return path;
  }
}

interface ProbeStream {
  readonly index?: number; readonly codec_type?: string; readonly avg_frame_rate?: string; readonly r_frame_rate?: string;
  readonly time_base?: string; readonly duration_ts?: string; readonly nb_read_frames?: string;
  readonly nb_frames?: string; readonly tags?: { readonly title?: string; readonly handler_name?: string };
}
interface ProbePacket { readonly size?: string; readonly pts_time?: string; readonly dts_time?: string; readonly duration_time?: string; }
interface ProbeDocument { readonly streams: readonly ProbeStream[]; readonly format: { readonly format_name?: string }; }
interface ProbePacketsDocument { readonly packets: readonly ProbePacket[]; }

function parseProbeTicks(value: string, timeBase: RenderRational): number | null {
  if (!/^\d+(?:\.\d+)?$/u.test(value)) return null;
  const scaled = Number(value) * timeBase.denominator / timeBase.numerator;
  return Number.isSafeInteger(Math.round(scaled)) ? Math.round(scaled) : null;
}
