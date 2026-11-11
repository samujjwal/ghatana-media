import assert from "node:assert/strict";
import test from "node:test";

import { comparePngBuffers, decodePng, encodeRgbaPng } from "./png-visual-diff.mjs";

test("PNG pixel comparison accepts byte-identical RGB/RGBA pixels", () => {
  const rgba = Buffer.from([
    10, 20, 30, 255, 40, 50, 60, 255,
    70, 80, 90, 255, 100, 110, 120, 255,
  ]);
  const png = encodeRgbaPng(2, 2, rgba);
  const result = comparePngBuffers(png, png);
  assert.equal(result.differingPixels, 0);
  assert.equal(result.differingChannels, 0);
  assert.equal(result.differingPixelRatio, 0);
  assert.equal(result.bounds, null);
  assert.deepEqual(decodePng(result.diffPng).rgba, Buffer.from([
    24, 24, 24, 255, 24, 24, 24, 255,
    24, 24, 24, 255, 24, 24, 24, 255,
  ]));
});

test("PNG pixel comparison reports exact changed pixels and emits an actionable diff image", () => {
  const referencePixels = Buffer.alloc(3 * 2 * 4, 255);
  const actualPixels = Buffer.from(referencePixels);
  actualPixels[4 * (1 * 3 + 2)] = 0;
  const result = comparePngBuffers(
    encodeRgbaPng(3, 2, referencePixels),
    encodeRgbaPng(3, 2, actualPixels),
  );

  assert.equal(result.differingPixels, 1);
  assert.equal(result.differingChannels, 1);
  assert.equal(result.maximumChannelDelta, 255);
  assert.equal(result.differingPixelRatio, 1 / 6);
  assert.deepEqual(result.bounds, { left: 2, top: 1, right: 2, bottom: 1 });
  assert.deepEqual(result.samples, [{ x: 2, y: 1 }]);
  const diff = decodePng(result.diffPng);
  assert.deepEqual([...diff.rgba.subarray((1 * 3 + 2) * 4, (1 * 3 + 2) * 4 + 4)], [255, 32, 128, 255]);
  assert.deepEqual([...diff.rgba.subarray(0, 4)], [24, 24, 24, 255]);
});

test("PNG pixel comparison fails on dimension mismatch and corrupt input", () => {
  const onePixel = encodeRgbaPng(1, 1, Buffer.from([0, 0, 0, 255]));
  const twoPixels = encodeRgbaPng(2, 1, Buffer.from([0, 0, 0, 255, 0, 0, 0, 255]));
  assert.throws(() => comparePngBuffers(onePixel, twoPixels), /dimensions differ/u);
  assert.throws(() => decodePng(Buffer.from("nope")), /not a PNG/u);
});
