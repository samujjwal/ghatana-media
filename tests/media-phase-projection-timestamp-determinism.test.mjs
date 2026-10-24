import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { preserveGeneratedProjectionTimestamps } from '../scripts/lib/preserve-generated-projection-timestamps.mjs';

const candidates = [
  ['product-definition', '.product-experience/pdp-0-product-truth/generated/product-definition.candidate.json'],
  ['experience-language', '.product-experience/pdp-2-design-interface-system/generated/experience-language.candidate.json'],
  ['experience-specification', '.product-experience/pdp-3-product-experience/generated/experience-specification.candidate.json'],
];

test('unchanged PDP-0, PDP-2, and PDP-3 projection generation/check preserve exact candidate bytes', async () => {
  for (const [name, candidatePath] of candidates) {
    const before = await readFile(candidatePath, 'utf8');
    const generation = spawnSync(process.execPath, ['scripts/generate-media-phase-projections.mjs', `--only=${name}`], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(generation.status, 0, `${name}: ${generation.stderr || generation.stdout}`);
    const afterGeneration = await readFile(candidatePath, 'utf8');
    assert.equal(afterGeneration, before, `${name} generation changed unchanged source bytes`);

    const check = spawnSync(process.execPath, ['scripts/generate-media-phase-projections.mjs', `--only=${name}`, '--check', '--strict'], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(check.status, 0, `${name}: ${check.stderr || check.stdout}`);
    assert.equal(await readFile(candidatePath, 'utf8'), afterGeneration, `${name} check changed candidate bytes`);
  }
});

test('a normative projection change is not hidden by timestamp preservation', () => {
  const prior = {
    projectionKind: 'experience-language',
    candidateModel: { subjectId: 'media', createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' },
    sourceAuthorities: [{ path: 'source.yaml', sha256: 'old' }],
  };
  const changed = structuredClone(prior);
  changed.candidateModel.subjectId = 'changed-meaning';
  changed.candidateModel.createdAt = '2026-10-23T00:00:00.000Z';
  changed.candidateModel.updatedAt = '2026-10-23T00:00:00.000Z';
  const result = preserveGeneratedProjectionTimestamps(JSON.stringify(prior), changed);
  assert.equal(result.candidateModel.subjectId, 'changed-meaning');
  assert.equal(result.candidateModel.createdAt, prior.candidateModel.createdAt);
  assert.equal(result.candidateModel.updatedAt, '2026-10-23T00:00:00.000Z');
});
