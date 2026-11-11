/**
 * Decode and compare unfiltered, non-interlaced 8-bit RGB/RGBA PNG screenshots.
 * Purpose: exact pixel regression for the Media Experience Explorer local audit.
 * Consumers: visual-reference comparator and its deterministic tests.
 * Non-goals: browser automation, perceptual design approval, tolerant image scoring.
 * Change policy: unsupported PNG encodings fail closed; comparison never rescales or masks pixels.
 */

import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PIXELS = 50_000_000;

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("input is not a PNG image");
  }

  let offset = 8;
  let header;
  const imageData = [];
  let ended = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error("PNG chunk is truncated");
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      if (header || length !== 13) throw new Error("PNG must contain exactly one valid IHDR chunk");
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      imageData.push(data);
    } else if (type === "IEND") {
      ended = true;
      break;
    }
    offset = dataEnd + 4;
  }

  if (!header || !ended || imageData.length === 0) throw new Error("PNG is missing IHDR, IDAT, or IEND");
  const { width, height, bitDepth, colorType, compression, filter, interlace } = header;
  if (!width || !height || width * height > MAX_PIXELS) throw new Error("PNG dimensions are empty or exceed the safe pixel limit");
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || compression !== 0 || filter !== 0 || interlace !== 0) {
    throw new Error("only non-interlaced 8-bit RGB/RGBA PNG images are supported");
  }

  const channels = colorType === 2 ? 3 : 4;
  const bytesPerRow = width * channels;
  const inflated = inflateSync(Buffer.concat(imageData), { maxOutputLength: height * (bytesPerRow + 1) });
  if (inflated.length !== height * (bytesPerRow + 1)) throw new Error("PNG scanline data has an unexpected length");
  const rgba = Buffer.alloc(width * height * 4);
  let inputOffset = 0;
  const previous = Buffer.alloc(bytesPerRow);

  for (let y = 0; y < height; y += 1) {
    const filterType = inflated[inputOffset++];
    if (filterType > 4) throw new Error("PNG scanline uses an unknown filter");
    const row = Buffer.from(inflated.subarray(inputOffset, inputOffset + bytesPerRow));
    inputOffset += bytesPerRow;
    for (let i = 0; i < bytesPerRow; i += 1) {
      const left = i >= channels ? row[i - channels] : 0;
      const up = previous[i];
      const upperLeft = i >= channels ? previous[i - channels] : 0;
      const predictor = filterType === 0 ? 0
        : filterType === 1 ? left
          : filterType === 2 ? up
            : filterType === 3 ? Math.floor((left + up) / 2)
              : paethPredictor(left, up, upperLeft);
      row[i] = (row[i] + predictor) & 0xff;
    }
    const outputOffset = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = outputOffset + x * 4;
      rgba[dst] = row[src];
      rgba[dst + 1] = row[src + 1];
      rgba[dst + 2] = row[src + 2];
      rgba[dst + 3] = channels === 4 ? row[src + 3] : 255;
    }
    row.copy(previous);
  }

  return { width, height, rgba };
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

export function encodeRgbaPng(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width * height > MAX_PIXELS || !Buffer.isBuffer(rgba) || rgba.length !== width * height * 4) {
    throw new Error("RGBA image dimensions and data length must agree");
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const dst = y * (1 + width * 4);
    scanlines[dst] = 0;
    rgba.copy(scanlines, dst + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function comparePngBuffers(referenceBuffer, actualBuffer, { sampleLimit = 12 } = {}) {
  const reference = decodePng(referenceBuffer);
  const actual = decodePng(actualBuffer);
  if (reference.width !== actual.width || reference.height !== actual.height) {
    throw new Error("PNG dimensions differ: reference " + reference.width + "x" + reference.height
      + ", actual " + actual.width + "x" + actual.height);
  }

  const difference = Buffer.alloc(reference.rgba.length);
  const samples = [];
  let differingPixels = 0;
  let differingChannels = 0;
  let maximumChannelDelta = 0;
  let left = reference.width;
  let top = reference.height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < reference.height; y += 1) {
    for (let x = 0; x < reference.width; x += 1) {
      const offset = (y * reference.width + x) * 4;
      let changed = false;
      for (let channel = 0; channel < 4; channel += 1) {
        const delta = Math.abs(reference.rgba[offset + channel] - actual.rgba[offset + channel]);
        if (delta > 0) {
          changed = true;
          differingChannels += 1;
          maximumChannelDelta = Math.max(maximumChannelDelta, delta);
        }
      }
      if (!changed) {
        difference[offset] = 24;
        difference[offset + 1] = 24;
        difference[offset + 2] = 24;
        difference[offset + 3] = 255;
        continue;
      }

      differingPixels += 1;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
      if (samples.length < sampleLimit) samples.push({ x, y });
      difference[offset] = 255;
      difference[offset + 1] = 32;
      difference[offset + 2] = 128;
      difference[offset + 3] = 255;
    }
  }

  const result = {
    width: reference.width,
    height: reference.height,
    differingPixels,
    differingChannels,
    differingPixelRatio: differingPixels / (reference.width * reference.height),
    maximumChannelDelta,
    bounds: differingPixels ? { left, top, right, bottom } : null,
    samples,
    diffPng: encodeRgbaPng(reference.width, reference.height, difference),
  };
  return result;
}
