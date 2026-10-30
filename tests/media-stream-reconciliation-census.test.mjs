import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const census = JSON.parse(readFileSync(
  join(repo, 'docs/implementation/media-stream-reconciliation-census.v1.json'), 'utf8'));

const helperSources = [
  'modules/audio-streaming/src/main/java/com/ghatana/audio/streaming/AudioStreamSession.java',
  'modules/video-streaming/src/main/java/com/ghatana/video/streaming/VideoStreamSession.java',
].map((f) => readFileSync(join(repo, f), 'utf8'));

test('AS-01/VS-01: streaming helpers stay stateless — no persistence or store imports', () => {
  for (const [index, source] of helperSources.entries()) {
    const name = ['audio', 'video'][index];
    assert.ok(!/import\s+(java\.sql|javax\.sql|jakarta\.|javax\.persistence|org\.flywaydb|com\.ghatana\.(?!audio\.streaming|video\.streaming))/u
        .test(source),
      `${name} stream helper must not import a persistence or canonical-store surface`);
    assert.ok(!/static\s+[^=]*Map|static\s+[^=]*List|static\s+[^=]*Set|static\s+[^=]*ConcurrentHashMap/u
        .test(source),
      `${name} helper must not keep in-process session state — reconciliation is durable, not in-memory`);
  }
});

test('AS-01/VS-01: canonical stream reconciliation owner tables exist', () => {
  const migrationDir = join(repo, 'providers/aws-postgresql/src/main/resources/db/media-runtime');
  const migrations = readdirSync(migrationDir).join('\n');
  assert.match(migrations, /V019__media_stream_acknowledgements\.sql/);
  assert.match(migrations, /V020__media_stream_inflight_attempts\.sql/);
  assert.equal(census.canonicalOwner.table, 'media_stream_sessions');
});

test('AS-01/VS-01: wire decode is bounded per the audited guard', () => {
  for (const source of helperSources) {
    assert.match(source, /MAX_FRAME_PAYLOAD_BYTES/, 'decode bound constant present');
    assert.match(source, /FRAME_HEADER_BYTES/, 'fixed header bound present');
    assert.match(source, /buffer\.remaining\(\)\s*!=\s*length|remaining\(\) != length/,
      'exact-remaining check rejects truncation and trailing garbage');
  }
});
