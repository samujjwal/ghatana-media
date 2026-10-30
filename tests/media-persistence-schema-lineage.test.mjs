import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalDir = join(repo, 'providers/aws-postgresql/src/main/resources/db/media-runtime');
const jpaMigration = join(repo, 'modules/infrastructure/persistence/src/main/resources/db/migration/V1__init_schema.sql');

const canonicalSql = readdirSync(canonicalDir)
  .filter((name) => /^V\d+__.*\.sql$/.test(name))
  .map((name) => ({ name, sql: readFileSync(join(canonicalDir, name), 'utf8') }));
const jpaSql = readFileSync(jpaMigration, 'utf8');

test('IP-01: canonical media_* tables and legacy audio_video schema stay disjoint', () => {
  assert.ok(canonicalSql.length >= 15, 'canonical migration history present');
  for (const { name, sql } of canonicalSql) {
    assert.ok(!/audio_video/i.test(sql),
      `${name} must not create or reference the legacy audio_video schema`);
  }
  assert.ok(!/CREATE\s+TABLE[^;]*\bmedia_/i.test(jpaSql),
    'the legacy JPA migration must not create canonical media_* tables');
  assert.ok(/audio_video\.audio_files/.test(jpaSql)
      && /audio_video\.transcriptions/.test(jpaSql),
    'legacy JPA migration creates only the expected audio_video tables');
});

test('IP-01: canonical transcript history is immutable revisions, JPA remains a mutable legacy model', () => {
  const v017 = canonicalSql.find(({ name }) => name.startsWith('V017'));
  assert.ok(v017, 'V017 transcript revisions migration exists');
  assert.match(v017.sql, /media_transcript_revisions/);
  assert.ok(!/DROP\s+COLUMN|DROP\s+TABLE/i.test(v017.sql),
    'canonical revision history is additive, not destructive');
  // The legacy model is mutable: version column + soft delete flags.
  assert.match(jpaSql, /version\s+BIGINT/i);
  assert.match(jpaSql, /deleted\s+BOOLEAN/i);
});

test('IP-01: JPA entities do not auto-manage the canonical schema', () => {
  const entityDir = join(repo, 'modules/infrastructure/persistence/src/main/java/com/ghatana/audio/video/infrastructure/persistence/entity');
  const entitySources = readdirSync(entityDir).filter((f) => f.endsWith('.java'))
    .map((f) => readFileSync(join(entityDir, f), 'utf8')).join('\n');
  assert.match(entitySources, /schema\s*=\s*"audio_video"/,
    'JPA entities stay bound to the legacy audio_video schema');
  assert.ok(!/schema\s*=\s*"media"/.test(entitySources)
      && !/"media_/.test(entitySources),
    'JPA entities must not bind to canonical media_* tables');
});
