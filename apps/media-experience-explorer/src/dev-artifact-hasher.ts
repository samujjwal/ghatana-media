import { sha256 } from "@noble/hashes/sha2.js";

const MAX_HASH_SLICE_BYTES = 1024 * 1024;

/** Hash a browser File incrementally through bounded Blob slices and readers. */
export async function hashFileSha256(file: File, signal: AbortSignal): Promise<string> {
  if (!file || typeof file.slice !== "function" || !Number.isSafeInteger(file.size) || file.size < 0) {
    throw new TypeError("A browser File is required for incremental SHA-256.");
  }
  if (signal.aborted) throw abortError();

  const hash = sha256.create();
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelActiveReader = () => { void activeReader?.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancelActiveReader, { once: true });
  let bytesRead = 0;
  try {
    while (bytesRead < file.size) {
      if (signal.aborted) throw abortError();
      const sliceEnd = Math.min(bytesRead + MAX_HASH_SLICE_BYTES, file.size);
      const slice = file.slice(bytesRead, sliceEnd);
      if (slice.size !== sliceEnd - bytesRead) throw new Error("File slice did not match the requested range.");
      activeReader = slice.stream().getReader();
      while (true) {
        if (signal.aborted) throw abortError();
        const { done, value } = await activeReader.read();
        if (signal.aborted) throw abortError();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new TypeError("File stream produced a non-byte chunk.");
        bytesRead += value.byteLength;
        if (!Number.isSafeInteger(bytesRead) || bytesRead > sliceEnd || bytesRead > file.size) {
          throw new Error("File stream exceeded the requested slice size.");
        }
        hash.update(value);
      }
      activeReader.releaseLock();
      activeReader = undefined;
      if (bytesRead !== sliceEnd) throw new Error("File stream ended before the requested slice was complete.");
    }
    if (bytesRead !== file.size) throw new Error("File stream ended before the declared size.");
    if (signal.aborted) throw abortError();
    return Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch (error) {
    if (activeReader) {
      try { await activeReader.cancel(); } catch { /* A failed stream is already canceled by its source. */ }
    }
    hash.destroy();
    if (signal.aborted) throw abortError();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancelActiveReader);
    activeReader?.releaseLock();
  }
}

function abortError(): DOMException {
  return new DOMException("File hashing was aborted.", "AbortError");
}
