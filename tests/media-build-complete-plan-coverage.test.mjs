import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const source = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const map = json('docs/implementation/media-build-coverage-plan-2026-10-15.json');

test('future Build blueprint has a finite DAG but grants no current Build or Delivery admission', () => {
  assert.equal(map.stage.macro, 'DISCOVERY');
  assert.equal(map.stage.phase, 'PDP-3');
  assert.equal(map.stage.currentDiscoveryBarrier, 'FAIL');
  assert.equal(map.stage.pdp3SourceCurrentness, 'UNKNOWN_R6');
  assert.equal(map.stage.buildLane, 'NOT_ENTERED');
  assert.equal(map.stage.delivery, 'BLOCKED');
  assert.equal(map.coverageAssertions.actualBuildImplementationPass, false);
  assert.equal(map.buildPackages.length, 16);
  const resolved = new Set();
  for (const pkg of map.buildPackages) {
    assert.match(pkg.id, /^PBI-\d{2}$/);
    assert.equal(pkg.stage, 'PLAN_ONLY_UNTIL_DISCOVERY_PASS');
    assert.ok(pkg.dependsOn.every((id) => resolved.has(id)), 'must order dependencies before ' + pkg.id);
    assert.equal(pkg.reference, 'docs/implementation/MEDIA-BUILD-COMPLETE-PRODUCT-PLAN-2026-10-15.md');
    resolved.add(pkg.id);
  }
});

test('all 50 physical, composition, and consumer identities match canonical topology', () => {
  const topology = json('.product-experience/surfaces/media-physical-topology.v1.json');
  const expected = [
    ...topology.manifestCandidates.map((x) => x.surfaceId),
    ...topology.compositions.map((x) => x.surfaceId),
    ...topology.consumerCrosswalk.map((x) => x.surfaceId),
  ].sort();
  const observed = map.surfaces.map((x) => x.surfaceId).sort();
  assert.equal(expected.length, 50);
  assert.deepEqual(observed, expected);
  const packages = new Set(map.buildPackages.map((x) => x.id));
  for (const surface of map.surfaces) {
    assert.equal(surface.pdp3R6Currentness.startsWith('UNKNOWN'), true);
    if (surface.surfaceId === 'media.surface.desktop-archive') {
      assert.equal(surface.applicability, 'NOT_APPLICABLE_ARCHIVED');
      assert.deepEqual(surface.plannedBuildPackageIds, []);
    } else {
      assert.ok(surface.plannedBuildPackageIds.length, 'unassigned active surface ' + surface.surfaceId);
      assert.ok(surface.plannedBuildPackageIds.every((id) => packages.has(id)));
      if (surface.kind === 'PHYSICAL_CANDIDATE') {
        assert.ok(fs.existsSync(path.join(root, surface.sourcePath)), 'source path ' + surface.sourcePath);
      }
    }
  }
  assert.equal(topology.manifestCandidates.length, 26);
  assert.equal(topology.compositions.length, 7);
  assert.equal(topology.consumerCrosswalk.length, 17);
});

test('all 30 journey IDs and exact names are preserved from the PDP-3 journey registry', () => {
  const raw = source('.product-experience/pdp-3-product-experience/journey-registry.yaml');
  const ids = [...raw.matchAll(/^  - id: (J-\d{2})$/gm)].map((m) => m[1]).sort();
  assert.equal(ids.length, 30);
  assert.deepEqual(map.journeys.map((x) => x.journeyId).sort(), ids);
  const packages = new Set(map.buildPackages.map((x) => x.id));
  for (const row of map.journeys) {
    assert.ok(packages.has(row.leadBuildPackageId));
    assert.ok(row.contractPath?.endsWith('.yaml'));
    assert.ok(fs.existsSync(path.join(root, row.contractPath)));
    assert.equal(row.developmentClaim, 'PLAN_ONLY');
  }
});

test('all 47 historical post-PDP stable tasks are preserved without inventing completion', () => {
  const raw = source('docs/implementation/post-pdp-owner-reviewed-execution-directive-2026-10-12.md');
  const ids = [...raw.matchAll(/^### ((?:BASE|SUR|DEP|MIG|RUN|EXP|ACC|LC|REL)-\d{2}) — `/gm)]
    .map((m) => m[1]).sort();
  const tasks = map.historicalPostPdpTasks;
  assert.equal(ids.length, 47);
  assert.deepEqual(tasks.map((x) => x.taskId).sort(), ids);
  const counted = {};
  const packages = new Set(map.buildPackages.map((x) => x.id));
  for (const row of tasks) {
    counted[row.historicalStatus] = (counted[row.historicalStatus] ?? 0) + 1;
    assert.equal(row.currentStatusClaim, 'NOT_RECHECKED_ON_2026_10_15');
    assert.ok(row.buildPackageIds.every((id) => packages.has(id)));
    if (row.lane === 'SEPARATE_ACCEPTANCE_OR_PDP_CLOSURE'
      || row.lane === 'DELIVER_RELEASE' || row.lane === 'REUSE_HISTORICALLY_COMPLETE') {
      assert.deepEqual(row.buildPackageIds, [], 'non-Build lane must not be reopened: ' + row.taskId);
    }
  }
  assert.deepEqual(counted, map.historicalTaskStatusCounts);
});


test('complete-product Build requires a source-derived capability-leaf bridge, not only 50/30/47 planning coverage', () => {
  const bridge = map.capabilityLeafBridge;
  assert.equal(bridge.status, 'PLAN_IMPLEMENTATION_GATE_NOT_GENERATED_NOT_ADMITTED');
  assert.equal(bridge.completed, false);
  assert.equal(map.reviewOverlayR2.buildLane, 'NOT_ENTERED');
  assert.equal(map.reviewOverlayR2.r6CurrentForLatestSource, false);
  assert.equal(bridge.historicalLeafPopulation, 462);
  assert.equal(Object.values(bridge.historicalApplicability).reduce((sum, count) => sum + count, 0), 462);
  assert.equal(new Set(bridge.requiredFields).size, bridge.requiredFields.length);
  assert.ok(bridge.requiredFields.includes('capabilityIntentId'));
  assert.ok(bridge.requiredFields.includes('pdp1OperationResultRefs'));
  assert.ok(bridge.requiredFields.includes('pbiWorkPackageId'));
  assert.ok(bridge.requiredFields.includes('positiveDeniedUnknownRecoveryTestRefs'));
});
