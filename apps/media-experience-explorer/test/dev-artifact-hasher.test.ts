import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashFileSha256 } from "../src/dev-artifact-hasher.js";

describe("Explorer incremental SHA-256", () => {
  it("matches the standard known vector", async () => {
    const file = new File(["abc"], "known.txt");
    expect(await hashFileSha256(file, new AbortController().signal))
      .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hashes a file larger than 64 MiB in bounded stream chunks without whole-file allocation", async () => {
    const size = 65 * 1024 * 1024 + 37;
    const sourceChunkBytes = 512 * 1024;
    const expected = createHash("sha256");
    let emittedBytes = 0;
    let maxSliceBytes = 0;
    let chunks = 0;
    const file = {
      size,
      slice(start: number, end: number) {
        const sliceSize = end - start;
        maxSliceBytes = Math.max(maxSliceBytes, sliceSize);
        let localBytesRead = 0;
        return {
          size: sliceSize,
          stream: () => new ReadableStream<Uint8Array>({
            pull(controller) {
              if (localBytesRead === sliceSize) {
                controller.close();
                return;
              }
              const length = Math.min(sourceChunkBytes, sliceSize - localBytesRead);
              const chunk = new Uint8Array(length);
              for (let index = 0; index < length; index += 1) {
                chunk[index] = (start + localBytesRead + index) & 0xff;
              }
              expected.update(chunk);
              localBytesRead += length;
              emittedBytes += length;
              chunks += 1;
              controller.enqueue(chunk);
            },
          }),
        };
      },
    } as File;

    const digest = await hashFileSha256(file, new AbortController().signal);
    expect(digest).toBe(expected.digest("hex"));
    expect(emittedBytes).toBe(size);
    expect(chunks).toBeGreaterThan(100);
    expect(maxSliceBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it("cancels the stream and rejects when aborted", async () => {
    const controller = new AbortController();
    let cancelObserved = false;
    let secondSliceStarted!: () => void;
    const secondSlice = new Promise<void>((resolve) => { secondSliceStarted = resolve; });
    const file = {
      size: 2,
      slice() {
        let firstPull = true;
        return {
          size: 2,
          stream: () => new ReadableStream<Uint8Array>({
            pull(streamController) {
              if (firstPull) {
                firstPull = false;
                streamController.enqueue(new Uint8Array([0x61]));
                return;
              }
              secondSliceStarted();
              return new Promise<void>((resolve) => setTimeout(resolve, 50));
            },
            cancel() { cancelObserved = true; },
          }),
        };
      },
    } as File;

    const hashing = hashFileSha256(file, controller.signal);
    await secondSlice;
    controller.abort();
    await expect(hashing).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelObserved).toBe(true);
  });

  it("rejects an overlong slice stream and cancels its active reader", async () => {
    let cancelObserved = false;
    const file = {
      size: 1,
      slice() {
        return {
          size: 1,
          stream: () => new ReadableStream<Uint8Array>({
            pull(streamController) { streamController.enqueue(new Uint8Array([0x61, 0x62])); },
            cancel() { cancelObserved = true; },
          }),
        };
      },
    } as File;

    await expect(hashFileSha256(file, new AbortController().signal))
      .rejects.toThrow("File stream exceeded the requested slice size.");
    expect(cancelObserved).toBe(true);
  });
});
