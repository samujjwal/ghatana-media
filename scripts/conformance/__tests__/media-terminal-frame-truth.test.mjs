import assert from 'node:assert/strict';
import test from 'node:test';

import { validateMediaTerminalFrameTruth } from '../lib/media-terminal-frame-truth.mjs';

function fixture() {
  return {
    handlerSource: `boolean end = Boolean.parseBoolean(
      boundedBody(exchange, runtime.config().maximumChunkBytes(), end)
      static byte[] boundedBody(HttpExchange exchange, int maximum, boolean allowEmpty)
      if (!allowEmpty && bytes.length == 0) if (bytes.length > maximum)`,
    testSource: `terminalFrameAllowsEmptyBodyWithoutContentLength
      ordinaryFrameStillRequiresPayload terminalFrameRemainsBounded`,
    openApiSource: `  /api/v1/streams/{sessionId}/frames/{sequence}:
      name: X-End-Of-Stream requestBody: required: false`,
  };
}

test('accepts bounded empty terminal frames', () => {
  assert.deepEqual(validateMediaTerminalFrameTruth(fixture()), []);
});

test('rejects Content-Length coupling', () => {
  const value = fixture();
  value.handlerSource += '\nend && exchange.getRequestHeaders().getFirst("Content-Length")';
  assert.ok(validateMediaTerminalFrameTruth(value)
    .some(error => error.includes('must not depend on a Content-Length')));
});

test('requires transport and OpenAPI regression proof', () => {
  const value = fixture();
  value.testSource = '';
  value.openApiSource = '';
  const errors = validateMediaTerminalFrameTruth(value);
  assert.ok(errors.some(error => error.includes('terminalFrameAllowsEmptyBodyWithoutContentLength')));
  assert.ok(errors.some(error => error.includes('X-End-Of-Stream')));
});
