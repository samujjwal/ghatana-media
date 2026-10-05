export function validateMediaTerminalFrameTruth({ handlerSource, testSource, openApiSource }) {
  const errors = [];
  requireTokens(errors, 'Media HTTP handler', handlerSource, [
    'boolean end = Boolean.parseBoolean(',
    'boundedBody(exchange, runtime.config().maximumChunkBytes(), end)',
    'static byte[] boundedBody(HttpExchange exchange, int maximum, boolean allowEmpty)',
    'if (!allowEmpty && bytes.length == 0)',
    'if (bytes.length > maximum)',
  ]);
  if (handlerSource.includes('end && exchange.getRequestHeaders().getFirst("Content-Length")')) {
    errors.push('Media terminal frames must not depend on a Content-Length: 0 header.');
  }
  requireTokens(errors, 'Media terminal-frame tests', testSource, [
    'terminalFrameAllowsEmptyBodyWithoutContentLength',
    'ordinaryFrameStillRequiresPayload',
    'terminalFrameRemainsBounded',
  ]);
  for (const token of [
    '/api/v1/streams/{sessionId}/frames/{sequence}:',
    'name: X-End-Of-Stream',
    'requestBody:',
    'required: false',
  ]) {
    if (!openApiSource.includes(token)) errors.push(`Media OpenAPI missing ${token}.`);
  }
  return errors;
}

function requireTokens(errors, owner, source, tokens) {
  for (const token of tokens) if (!source.includes(token)) errors.push(`${owner} missing ${token}.`);
}
