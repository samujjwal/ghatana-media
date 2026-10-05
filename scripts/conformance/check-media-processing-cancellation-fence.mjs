#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const processing = read('providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/HttpMediaProcessingProvider.java');
const streaming = read('providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/HttpMediaStreamingProvider.java');
const client = read('providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/MediaHttpProviderClient.java');
const processingTest = read('providers/aws-postgresql/src/test/java/com/ghatana/media/provider/aws/HttpMediaProcessingCancellationFenceTest.java');
const streamingTest = read('providers/aws-postgresql/src/test/java/com/ghatana/media/provider/aws/HttpMediaStreamingCloseFenceTest.java');
const errors = [];

requireTokens('HTTP Media processing provider', processing, [
  'ConcurrentMap<String, Object> requestLocks',
  'ConcurrentMap<String, Instant> cancellationTombstones',
  'ConcurrentMap<String, CompletableFuture<HttpResponse<byte[]>>> activeRequests',
  'synchronized (lock)',
  'cancellationTombstones.containsKey(requestKey)',
  'activeRequests.put(requestKey, raw)',
  'CompletableFuture<Map<String, Object>> result = new CompletableFuture<>()',
  'if (result.isCancelled()) raw.cancel(true)',
  'active.cancel(true)',
  'scheduleCancellationCleanup(',
  'public boolean fallbackEligible(Throwable failure)',
  'return false;',
]);
requireTokens('HTTP Media streaming provider', streaming, [
  'ConcurrentMap<String, Object> sessionLocks',
  'ConcurrentMap<String, Instant> closingSessions',
  'ConcurrentMap<String, Set<CompletableFuture<HttpResponse<byte[]>>>> activeFrames',
  'closingSessions.containsKey(sessionKey)',
  'activeFrames.computeIfAbsent(',
  'CompletableFuture<StreamAck> result = new CompletableFuture<>()',
  'if (result.isCancelled()) raw.cancel(true)',
  'active.forEach(future -> future.cancel(true))',
  'scheduleCloseCleanup(',
]);
requireTokens('bounded Media provider HTTP client', client, [
  'MEDIA_HTTP_PROVIDER_MAX_RESPONSE_BYTES',
  'boundedByteArrayHandler()',
  'readNBytes(maximumResponseBytes + 1)',
]);
requireTokens('Media processing cancellation race test', processingTest, [
  'cancellationThatWinsPreventsLaterProcessingDispatch',
  'activeProcessingIsCancelledWhenCancellationArrivesAfterDispatch',
  'ambiguousRemoteFailuresAreNotAutomaticallyEligibleForFallback',
  'assertThat(processCalls).hasValue(0)',
  'assertThat(cancelCalls).hasValue(1)',
]);
requireTokens('Media streaming close race test', streamingTest, [
  'closeThatWinsRejectsLaterFrameEvenFromStaleContext',
  'closeCancelsFrameThatWasAlreadyDispatched',
  'assertThat(frameCalls).hasValue(0)',
  'assertThat(closeCalls).hasValue(1)',
]);
forbidTokens('HTTP Media processing provider', processing, [
  'return value instanceof java.util.concurrent.TimeoutException',
  'return failure instanceof TimeoutException',
  'return raw.thenApply(',
]);
forbidTokens('HTTP Media streaming provider', streaming, [
  'return raw.thenApply(',
]);

if (errors.length) {
  console.error(`Media provider cancellation/failover authority failed with ${errors.length} violation(s):`);
  errors.forEach(error => console.error(`- ${error}`));
  process.exit(1);
}
console.log('Media processing and streaming effects are cancellation/close fenced, derived future cancellation reaches raw HTTP work, responses are bounded, and ambiguous processing failures do not auto-failover.');

function requireTokens(owner, source, tokens) {
  for (const token of tokens) if (!source.includes(token)) errors.push(`${owner} missing ${token}`);
}
function forbidTokens(owner, source, tokens) {
  for (const token of tokens) if (source.includes(token)) errors.push(`${owner} retains forbidden token ${token}`);
}
