/**
 * Concrete MEDIA_FILE capture adapter (Node.js): resolves the admitted
 * `sourceIdentity` through a host-trusted resolver to a local file path and
 * returns the file's real bytes as the captured frame. Request fields never
 * carry paths, so callers cannot aim capture at arbitrary files.
 *
 * When `allowedRoot` is configured, the resolved file must realpath inside
 * that root — symlinks and `..` segments cannot escape it. Reads are
 * bounded: the byte cap is enforced before and during the read, so a file
 * that grows past the bound mid-read is rejected rather than buffered.
 * Error messages never include resolved paths, which can disclose host
 * layout; failures surface through `captureWithAdmission` as sanitized
 * UNKNOWN outcomes.
 */

import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  MAX_CAPTURED_FRAME_BYTES,
  type CaptureRequest,
  type CapturedFrame,
  type CaptureSourceKind,
} from "./capture-adapters.js";

export interface MediaFileCaptureAdapterOptions {
  /** Host-trusted mapping from the admitted capture request to a local path. */
  resolveSource: (request: CaptureRequest) => string | Promise<string>;
  /** Optional directory that resolved sources must remain inside (realpath). */
  readonly allowedRoot?: string;
  /** Maximum captured bytes; defaults to MAX_CAPTURED_FRAME_BYTES. */
  readonly maxBytes?: number;
}

const MAX_SOURCE_PATH_CHARS = 4_096;
const READ_CHUNK_BYTES = 1024 * 1024;

/** Adapter-internal failure; messages never carry resolved paths or payloads. */
class FileCaptureError extends Error {
  public constructor(message: string) {
    super(`file capture failed: ${message}`);
    this.name = "FileCaptureError";
  }
}

function isInsideRoot(rootReal: string, fileReal: string): boolean {
  const rel = relative(rootReal, fileReal);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export class MediaFileCaptureAdapter {
  public readonly kind: CaptureSourceKind = "MEDIA_FILE";

  private readonly resolveSource: MediaFileCaptureAdapterOptions["resolveSource"];
  private readonly allowedRoot: string | undefined;
  private readonly maxBytes: number;

  public constructor(options: MediaFileCaptureAdapterOptions) {
    if (!options || typeof options.resolveSource !== "function") {
      throw new TypeError("resolveSource is required");
    }
    this.resolveSource = options.resolveSource;
    if (options.allowedRoot !== undefined) {
      if (typeof options.allowedRoot !== "string" || options.allowedRoot.length === 0
        || options.allowedRoot.length > MAX_SOURCE_PATH_CHARS || options.allowedRoot.includes("\0")) {
        throw new TypeError("allowedRoot must be a bounded non-empty path");
      }
      this.allowedRoot = options.allowedRoot;
    }
    const maxBytes = options.maxBytes ?? MAX_CAPTURED_FRAME_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CAPTURED_FRAME_BYTES) {
      throw new TypeError(`maxBytes must be 1..${MAX_CAPTURED_FRAME_BYTES}`);
    }
    this.maxBytes = maxBytes;
  }

  private async resolveContainedPath(resolved: string): Promise<string> {
    if (typeof resolved !== "string" || resolved.length === 0
      || resolved.length > MAX_SOURCE_PATH_CHARS || resolved.includes("\0")) {
      throw new FileCaptureError("resolved source path is not a bounded path string");
    }
    const candidate = resolve(resolved);
    if (this.allowedRoot === undefined) {
      return candidate;
    }
    let rootReal: string;
    let fileReal: string;
    try {
      rootReal = await realpath(this.allowedRoot);
      fileReal = await realpath(candidate);
    } catch {
      throw new FileCaptureError("resolved source is not readable inside the allowed root");
    }
    if (!isInsideRoot(rootReal, fileReal)) {
      throw new FileCaptureError("resolved source escapes the allowed root");
    }
    return fileReal;
  }

  private async readBounded(filePath: string): Promise<Uint8Array> {
    let handle;
    try {
      handle = await open(filePath, "r");
    } catch {
      throw new FileCaptureError("resolved source could not be opened");
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new FileCaptureError("resolved source is not a regular file");
      }
      if (info.size > this.maxBytes) {
        throw new FileCaptureError("source file exceeds the capture byte bound");
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const scratch = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, this.maxBytes + 1));
      for (;;) {
        const { bytesRead } = await handle.read(scratch, 0, scratch.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > this.maxBytes) {
          throw new FileCaptureError("source file exceeds the capture byte bound");
        }
        chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } catch (error) {
      if (error instanceof FileCaptureError) throw error;
      throw new FileCaptureError("source file could not be read");
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  public async capture(request: CaptureRequest): Promise<CapturedFrame> {
    if (request === null || typeof request !== "object" || request.kind !== this.kind) {
      throw new TypeError("capture request kind does not match this adapter");
    }
    const resolved = await this.resolveSource(request);
    const filePath = await this.resolveContainedPath(resolved);
    const bytes = await this.readBounded(filePath);
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
