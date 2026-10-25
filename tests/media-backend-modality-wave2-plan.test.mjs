import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const plan = read('docs/implementation/MEDIA-BACKEND-MODALITY-WAVE2-EXECUTION.md');
const topology = JSON.parse(read('.product-experience/surfaces/media-physical-topology.v1.json'));
const grpcRegistry = read('.product-experience/pdp-3-product-experience/grpc/service-registry.yaml');
const nfrSource = read('.product-experience/pdp-0-product-truth/nonfunctional-requirements.yaml');

const owned = new Map([
  ['STT', { sourcePath: 'modules/speech/stt-service', count: 12 }],
  ['TTS', { sourcePath: 'modules/speech/tts-service', count: 12 }],
  ['VIS', { sourcePath: 'modules/vision/vision-service', count: 12 }],
  ['MM', { sourcePath: 'modules/intelligence/multimodal-service', count: 12 }],
  ['OBS', { sourcePath: 'audio-video-observability', count: 10 }],
]);

const tasks = [...plan.matchAll(/^\| \*\*((?:STT|TTS|VIS|MM|OBS)-\d{2})\*\* \((W[0-3])\) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|/gmu)]
  .map(match => ({ id: match[1], wave: Number(match[2][1]), dependencies: match[3].trim(),
    pdp: match[4].replaceAll('`', '').trim(), where: match[5].trim(), assertion: match[6].trim() }));
const taskIds = new Set(tasks.map(t => t.id));

function dependencyIds(spec) {
  if (spec === '—') return [];
  return spec.split(',').flatMap(token => {
    const trimmed = token.trim();
    const range = trimmed.match(/^(STT|TTS|VIS|MM|OBS)-(\d{2})\.\.(?:(?:STT|TTS|VIS|MM|OBS)-)?(\d{2})$/u);
    if (!range) return [trimmed];
    const from = Number(range[2]);
    const to = Number(range[3]);
    assert.ok(to >= from && to < 100, 'invalid dependency range ' + trimmed);
    return Array.from({ length: to - from + 1 }, (_, index) => range[1] + '-'
      + String(from + index).padStart(2, '0'));
  });
}

test('five selected physical surfaces have exact nonduplicated runnable task identifiers', () => {
  assert.equal(tasks.length, 58);
  assert.equal(taskIds.size, tasks.length);
  for (const [prefix, contract] of owned) {
    const expected = Array.from({ length: contract.count }, (_, i) =>
      prefix + '-' + String(i + 1).padStart(2, '0'));
    const actual = tasks.filter(t => t.id.startsWith(prefix + '-')).map(t => t.id);
    assert.deepEqual(actual, expected, prefix + ' task order/count mismatch');
    const surface = topology.manifestCandidates.find(v => v.sourcePath === contract.sourcePath);
    assert.ok(surface, prefix + ' missing source physical surface');
    assert.ok(plan.includes(surface.surfaceId), 'surface name missing in plan ' + surface.surfaceId);
    for (const operation of (surface.phaseApplicability['PDP-1']?.operationIds || [])) {
      assert.ok(plan.includes(operation), prefix + ' missing PDP-1 operation ' + operation);
    }
    for (const journey of (surface.phaseApplicability['PDP-3']?.journeyIds || [])) {
      assert.ok(plan.includes(journey), prefix + ' missing PDP-3 journey ' + journey);
    }
  }
});

test('every task binds existing PDP-0 capability, current NFR, exact code and executable assertion', () => {
  for (const task of tasks) {
    const prefix = task.id.split('-')[0];
    const surface = topology.manifestCandidates.find(v => v.sourcePath === owned.get(prefix).sourcePath);
    const sourceIds = task.pdp.split(';').map(v => v.trim());
    assert.ok(sourceIds.some(id => id.startsWith('media.')), 'missing capability ' + task.id);
    assert.ok(sourceIds.some(id => id.startsWith('NFR-')), 'missing NFR ' + task.id);
    for (const id of sourceIds) {
      if (id.startsWith('media.')) {
        assert.ok(surface.phaseApplicability['PDP-0'].capabilityIntentIds.includes(id),
          task.id + ' capability outside registered surface: ' + id);
      }
      if (id.startsWith('NFR-')) {
        assert.ok(nfrSource.includes('id: ' + id), task.id + ' missing PDP-0 NFR: ' + id);
      }
    }
    assert.ok(task.where.includes('`' + owned.get(prefix).sourcePath + '/'),
      task.id + ' missing precise Media owned source target');
    assert.ok(task.assertion.length >= 35, task.id + ' lacks an executable acceptance check');
    assert.ok(task.wave >= 0 && task.wave <= 3);
  }
});

test('local implementation task dependencies are resolvable acyclic and wave ordered', () => {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const visiting = new Set(), visited = new Set();
  const dfs = id => {
    if (visited.has(id)) return;
    assert.ok(!visiting.has(id), 'cycle at ' + id);
    visiting.add(id);
    for (const dependency of dependencyIds(byId.get(id).dependencies)) {
      const predecessor = byId.get(dependency);
      assert.ok(predecessor, 'unresolved dependency: ' + id + ' -> ' + dependency);
      assert.ok(predecessor.wave <= byId.get(id).wave,
        'later-wave predecessor: ' + id + ' -> ' + dependency);
      dfs(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of taskIds) dfs(id);
  assert.equal(visited.size, 58);
});

test('all 99 source-declared surface-intent memberships have one mapped owner task', () => {
  const memberships = [...plan.matchAll(/^\| (STT|TTS|VIS|MM|OBS) \| `(media\.[^`]+)` \| ([^|]+) \| ([^|]+) \|/gmu)]
    .map(m => ({ prefix: m[1], id: m[2], task: m[3].trim(), kind: m[4].trim() }));
  assert.equal(memberships.length, 99);
  for (const [prefix, contract] of owned) {
    const surface = topology.manifestCandidates.find(v => v.sourcePath === contract.sourcePath);
    const expected = surface.phaseApplicability['PDP-0'].capabilityIntentIds;
    const matches = memberships.filter(row => row.prefix === prefix);
    assert.deepEqual(matches.map(row => row.id), expected, prefix + ' PDP capability set/order drift');
    for (const match of matches) {
      const assigned = match.task.split(' ')[0];
      assert.ok(taskIds.has(assigned), match.id + ' assigned to missing task ' + assigned);
      if (prefix === 'MM' && match.id.startsWith('media.speech.')) {
        assert.match(match.kind, /Delegated exact STT contract/u);
      }
      if (prefix === 'MM' && match.id.startsWith('media.vision.')) {
        assert.match(match.kind, /Delegated exact Vision contract/u);
      }
    }
  }
});

test('43 exact registered gRPC methods each map to implementation task and remain provisional', () => {
  const actual = [...plan.matchAll(/^\| `(media\.grpc\.[\w.]+)` \| ([^|]+) \| ([^|]+) \|/gmu)]
    .map(m => ({ id: m[1], owner: m[2].trim(), check: m[3].trim() }));
  const expected = [...grpcRegistry.matchAll(/^\s*- id: (media\.grpc\.[\w.]+)$/gmu)]
    .map(m => m[1]);
  assert.equal(actual.length, 43);
  assert.deepEqual(actual.map(x => x.id).sort(), expected.sort());
  assert.equal(new Set(actual.map(x => x.id)).size, 43);
  for (const item of actual) {
    for (const owner of item.owner.split('+')) {
      assert.ok(taskIds.has(owner.trim()), item.id + ' has missing implementation owner ' + owner);
    }
    assert.match(item.check, /real qualified provider/u);
  }
  assert.match(grpcRegistry, /explicitProposedLogicalOperationBindings: 24/u);
  assert.match(grpcRegistry, /unresolvedLogicalOperationBindings: 19/u);
  assert.match(plan, /\*\*not\*\* PDP approval/u);
});

test('GH-90000, Checkstyle, Track B, legacy operations and Shared handoff remain separate', () => {
  const residual = [...plan.matchAll(/^\| \*\*(R-0[1-5]) \/ ([^|]+) \|/gmu)]
    .map(m => m[1]);
  assert.deepEqual(residual, ['R-01','R-02','R-03','R-04','R-05']);
  assert.equal((plan.match(/^\| \*\*W2-E\d{2}\*\* /gmu) || []).length, 12);
  assert.match(plan, /9 user-reported compose-stack tests skipped/u);
  assert.match(plan, /AUDIO_VIDEO_STT_IMAGE/u);
  assert.match(plan, /AUDIO_VIDEO_TTS_IMAGE/u);
  assert.match(plan, /Checkstyle/u);
  assert.match(plan, /TRACK_B_UNTOUCHED/u);
  assert.match(plan, /LEGACY_RUNTIME_CUTOVER_UNPERFORMED/u);
  assert.match(plan, /VerifyIntentionalPublicApiTask\.kt/u);
  assert.match(plan, /does not convert skipped\/unrun coverage/u);
  assert.match(plan, /IMPLEMENTATION_NOT_VERIFIED_FOR_THIS_WAVE/u);
});
