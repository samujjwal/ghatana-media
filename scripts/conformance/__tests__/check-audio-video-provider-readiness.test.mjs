import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { findMediaProviderSourceViolations,
  findAudioVideoProviderReadinessViolations } from '../check-audio-video-provider-readiness.mjs';

test('Media-owned source preflight passes without Data Cloud private source dependencies', () => {
  assert.deepEqual(findMediaProviderSourceViolations(), []);
  assert.strictEqual(findAudioVideoProviderReadinessViolations, findMediaProviderSourceViolations);
});

test('a missing candidate source tree fails closed, never claims readiness', () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-preflight-'));
  try {
    const violations = findMediaProviderSourceViolations({ root: dir });
    assert.ok(violations.length >= 10, 'missing source requires exact diagnostics');
    assert.ok(violations.some((x) => x.includes('docs/capability-map.md')));
    assert.ok(violations.some((x) => x.includes('.dockerignore')));
    assert.ok(violations.some((x) => x.includes('docker/Dockerfile.vision-service')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
