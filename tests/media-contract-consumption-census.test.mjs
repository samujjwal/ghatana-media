import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

test('CT-01: only libs/audio-video-types declares the public zod contract surface', () => {
  const offenders = [];
  const scan = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!e.isFile() || !e.name.endsWith('.ts')) continue;
      const full = join(e.parentPath, e.name);
      if (/node_modules|dist|\.test\.ts$|__tests__/.test(full)) continue;
      const src = readFileSync(full, 'utf8');
      if (/z\.enum\(\s*\[\s*"QUEUED"|z\.discriminatedUnion\("state"/.test(src)
          && !full.includes('libs/audio-video-types')) {
        offenders.push(relative(repo, full));
      }
    }
  };
  for (const dir of ['libs', 'apps', 'modules']) {
    scan(join(repo, dir));
  }
  assert.deepEqual(offenders, [],
    'a second public media contract schema was declared outside libs/audio-video-types');
});

test('CT-01: every AvTranscriptionJob.JobStatus value is handled by the lifecycle adapter', () => {
  const jobSrc = readFileSync(join(repo,
    'modules/speech/stt-service/src/main/java/com/ghatana/stt/job/AvTranscriptionJob.java'), 'utf8');
  const adapterSrc = readFileSync(join(repo,
    'modules/speech/stt-service/src/main/java/com/ghatana/stt/job/AvJobLifecycleAdapter.java'), 'utf8');
  const enumBlock = jobSrc.match(/enum JobStatus\s*\{([\s\S]*?)\}/)[1];
  const values = [...enumBlock.matchAll(/^\s*([A-Z_]+)/gm)].map((m) => m[1]);
  assert.ok(values.length >= 9, `expected the 9-state domain lifecycle, got ${values}`);
  for (const value of values) {
    assert.ok(adapterSrc.includes(value),
      `AvTranscriptionJob.JobStatus.${value} has no explicit mapping in AvJobLifecycleAdapter`);
  }
});

test('CT-01: ledger adapter mapping stays fail-closed with no unmapped fallthrough', () => {
  const src = readFileSync(join(repo,
    'adapters/ledger/src/main/java/com/ghatana/audiovideo/adapter/ledger/AudioVideoRunLedgerAdapter.java'), 'utf8');
  const mappers = src.match(/private static JobExecutionState map\w+JobState[\s\S]*?switch[\s\S]*?default -> [^;]+;/g);
  assert.ok(mappers && mappers.length >= 2, 'state mappers present');
  for (const mapper of mappers) {
    assert.ok(/default -> throw new IllegalArgumentException/.test(mapper),
      'unmapped input must throw, never fall through to a fabricated state');
    assert.ok(!/default -> JobExecutionState\.(RUNNING|COMPLETED|FAILED)/.test(mapper),
      'no silent unknown→RUNNING/COMPLETED/FAILED projection');
  }
});
