import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ROOT } from '../scripts/lib/media-demo-scenario.mjs';

function assessSurface(surface) {
  const phasesReady = ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'].every((phase) => {
    const record = surface.phases[phase];
    return record?.status === 'DEV_COMPLETE'
      && record.sourceCurrent === true
      && record.outstandingDefinitionTaskIds?.length === 0;
  });
  const dependenciesReady = surface.declaredDependencies.every((dependency) => dependency.status === 'PASS');
  return phasesReady && dependenciesReady ? 'BUILD_ELIGIBLE' : 'BLOCKED';
}

test('per-surface Build policy permits A while B remains blocked and aggregate is partial', async () => {
  const agents = await readFile(`${ROOT}/AGENTS.md`, 'utf8');
  assert.match(agents, /eligible BUILD work to proceed per source-bound unit while other surfaces continue Discovery/u);
  assert.match(agents, /An unrelated incomplete surface or aggregate Discovery status does not block an eligible independent surface/u);

  const completePhases = Object.fromEntries(['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'].map((phase) => [phase, {
    status: 'DEV_COMPLETE', sourceCurrent: true, outstandingDefinitionTaskIds: [],
  }]));
  const surfaceA = { id: 'A', phases: completePhases, declaredDependencies: [{ status: 'PASS' }] };
  const surfaceB = { id: 'B', phases: { ...completePhases, 'PDP-2': { ...completePhases['PDP-2'], sourceCurrent: false } }, declaredDependencies: [{ status: 'PASS' }] };
  const dispositions = [surfaceA, surfaceB].map((surface) => [surface.id, assessSurface(surface)]);
  const eligibleCount = dispositions.filter(([, disposition]) => disposition === 'BUILD_ELIGIBLE').length;
  const blockedCount = dispositions.filter(([, disposition]) => disposition === 'BLOCKED').length;
  const aggregateDiscovery = blockedCount === 0 ? 'PASS' : eligibleCount === 0 ? 'FAIL' : 'PARTIAL';

  assert.deepEqual(dispositions, [['A', 'BUILD_ELIGIBLE'], ['B', 'BLOCKED']]);
  assert.equal(aggregateDiscovery, 'PARTIAL');
});

test('backend engineering is independently permitted without counterfeit formal stage admission', async () => {
  const agents = await readFile(`${ROOT}/AGENTS.md`, 'utf8');
  const claude = await readFile(`${ROOT}/CLAUDE.md`, 'utf8');
  const plan = await readFile(
    `${ROOT}/docs/implementation/MEDIA-BACKEND-FOUNDATION-DEEP-IMPLEMENTATION-2026-10-24.md`,
    'utf8',
  );
  assert.match(agents, /Default action: inspect relevant source, implement, test, integrate and report the changed unit/u);
  assert.match(agents, /not prerequisites to starting/u);
  assert.match(agents, /exclusively a rule for formal BUILD stage admission/u);
  assert.match(agents, /sole canonical executable runtime and migration\/queue writer/u);
  assert.match(agents, /No native closure run is needed to call a backend package logically implementation-ready/u);
  assert.match(claude, /backend engineering may proceed on existing PDP product intent despite incomplete PDP formalization or gtool admission/u);
  assert.match(claude, /formal DISCOVERY → BUILD → DELIVER → ENHANCE/u);

  for (const [prefix, count] of Object.entries({ C: 10, S: 10, A: 12, J: 13, E: 11 })) {
    const actualIds = [...plan.matchAll(new RegExp(`\\*\\*${prefix}(\\d{2})\\*\\*`, 'g'))]
      .map((match) => Number(match[1]));
    assert.deepEqual(actualIds, Array.from({ length: count }, (_, index) => index + 1),
      `missing or duplicated task in backend package ${prefix}`);
  }
  assert.match(plan, /No package can be marked ready on zero code or green mocks alone/u);
});
