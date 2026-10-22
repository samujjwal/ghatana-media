import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { validateBuildWorkPackageProjection } from '../scripts/lib/media-build-work-packages-validation.mjs';
import { buildSemanticSourceJoins } from '../scripts/lib/media-build-semantic-source-joins.mjs';

const run = (...args) => execFileSync(process.execPath, ['scripts/generate-media-build-work-packages.mjs', ...args], { encoding: 'utf8' });
const path = 'docs/implementation/MEDIA-BUILD-WORK-PACKAGES.v1.json';
const digest = () => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');

test('Build work package projection is deterministic and source-pinned', () => {
  run();
  const first = digest();
  run();
  assert.equal(digest(), first);
  assert.match(run('--check'), /PASS/);
  const projection = JSON.parse(fs.readFileSync(path, 'utf8'));
  assert.equal(projection.census.traceIdentityCount, 3186);
  assert.equal(projection.packages.length, 50);
  assert.deepEqual(projection.census.surfaces, { physical: 26, compositions: 7, logical: 21, total: 54 });
  assert.equal(projection.tasks.filter(x => x.id.startsWith('M-BLD-F00.T')).length, 3);
  assert.equal(projection.tasks.filter(x => x.id.startsWith('M-BLD-L01.T')).length, 5);
  assert.equal(projection.tasks.filter(x => x.id.startsWith('M-BLD-V03.T')).length, 2);
  assert.equal(projection.tasks.length, 57);
  assert.deepEqual(projection.wipPolicy.source, { path: 'docs/implementation/MEDIA-BUILD-IMPLEMENTATION-PLAN.md', section: '11B' });
  assert.equal(projection.wipPolicy.laneModel, 'existing-package-family-prefix');
  assert.deepEqual(projection.wipPolicy.limits, {
    maxSimultaneouslyEditedPackagesPerLane: 2,
    maxActiveChangeWritersPerSharedFileOrSchemaOwner: 1
  });
  assert.deepEqual(projection.wipPolicy.lanes, [
    { id: 'F', packageIds: projection.packages.filter(pkg => /^M-BLD-F\d{2}$/.test(pkg.id)).map(pkg => pkg.id) },
    { id: 'V', packageIds: projection.packages.filter(pkg => /^M-BLD-V\d{2}$/.test(pkg.id)).map(pkg => pkg.id) },
    { id: 'L', packageIds: projection.packages.filter(pkg => /^M-BLD-L\d{2}$/.test(pkg.id)).map(pkg => pkg.id) },
    { id: 'X', packageIds: projection.packages.filter(pkg => /^M-BLD-X\d{2}$/.test(pkg.id)).map(pkg => pkg.id) }
  ]);
  assert.equal(projection.wipPolicy.semantics, 'Policy limits only; this projection does not record staffing, active work, or readiness.');
  assert(projection.packages.every(p => p.taskIds.every(id => projection.tasks.some(task => task.id === id))));
  const taskById = new Map(projection.tasks.map(task => [task.id, task]));
  assert.deepEqual(taskById.get('M-BLD-F01.T01').predecessorTaskIds, ['M-BLD-F00.T03']);
  assert.deepEqual(taskById.get('M-BLD-F02.T01').predecessorTaskIds, ['M-BLD-F00.T03', 'M-BLD-F01.T01']);
  assert.deepEqual(taskById.get('M-BLD-L01.T01').predecessorTaskIds, ['M-BLD-F00.T01']);
  assert.deepEqual(taskById.get('M-BLD-L01.T03').predecessorTaskIds, ['M-BLD-V03.T02']);
  assert(taskById.get('M-BLD-L01.T01').sourceScope.journeyIds.join(',') === 'J-01,J-02,J-20,J-03');
  assert(taskById.get('M-BLD-L01.T01').sourceScope.sourceSelectors.length > 0);
  assert(taskById.get('M-BLD-V03.T02').prerequisiteBasis.includes('§5A'));
  assert(taskById.get('M-BLD-V03.T02').expectedResult.includes('one real source-authorized channel'));
  assert.match(taskById.get('M-BLD-V03.T02').title, /^Generated §5A/);
  assert.deepEqual(taskById.get('M-BLD-V03.T02').taskOrigin, {
    type: 'GENERATED_SCOPED_DECOMPOSITION',
    canonicalPlanAuthored: false,
    source: 'docs/implementation/MEDIA-BUILD-IMPLEMENTATION-PLAN.md',
    section: '5A',
    rationale: '§5A requires a one-channel J-03 business-outcome implementation subtask for L01.T03; this generated dependency node does not assert a canonical plan-authored task ID.'
  });
  assert.deepEqual(taskById.get('M-BLD-L01.T05').predecessorTaskIds, [
    'M-BLD-L01.T01', 'M-BLD-L01.T02', 'M-BLD-L01.T03', 'M-BLD-L01.T04',
    'M-BLD-F13.T01', 'M-BLD-V01.T01', 'M-BLD-V02.T01', 'M-BLD-V20.T01', 'M-BLD-V24.T01', 'M-BLD-V29.T01'
  ]);
  assert(taskById.get('M-BLD-L01.T05').expectedResult.includes('full recorder'));
  assert.equal(projection.census.matrixRows.length, 4);
  assert.equal(projection.materialSourceReceipt.count, 859);
  assert.equal(projection.materialSourceReceipt.staleCount, 0);
  assert.equal(projection.materialSourceReceipt.status, 'CURRENT');
  assert(projection.trace.every(x => x.planningStatus === 'ASSIGNED_UNVERIFIED'));
  assert(projection.trace.every(x => x.codeSymbol.status === 'UNBOUND'));
  assert(projection.trace.some(x => x.unresolvedSourceSlots.length));
});

test('validator rejects negative identity, join, edge, cycle, N/A, census, and pin fixtures', () => {
  run('--check');
  const original = JSON.parse(fs.readFileSync(path, 'utf8'));
  const appendix = JSON.parse(fs.readFileSync('docs/implementation/MEDIA-BUILD-IDENTITY-TRACE.v1.json', 'utf8'));
  const sourceBridge = buildSemanticSourceJoins({ root: process.cwd(), traceRows: appendix.traceRows });
  const stateReferenceProvenance = sourceBridge.rows
    .filter(row => row.kind === 'stateMachines')
    .flatMap(row => Object.values(row.joins).flat())
    .map(edge => edge.sourceRef);
  assert(stateReferenceProvenance.some(ref => ref.endsWith('/p1StateRefs')));
  assert(stateReferenceProvenance.some(ref => ref.endsWith('/pdp1StateOrObservationRefs')));
  const transitionProvenance = sourceBridge.rows
    .filter(row => row.kind === 'stateMachines')
    .flatMap(row => Object.values(row.joins).flat())
    .map(edge => edge.sourceRef);
  assert(transitionProvenance.some(ref => ref.includes('#ownerDefinedTransitionRecords/@id=') && ref.endsWith('/sourceMachineId')));
  assert(transitionProvenance.some(ref => ref.includes('#transitionRecords/@id=') && ref.endsWith('/sourceMachineId')));
  const p0CapabilityJoins = sourceBridge.rows.filter(row => row.phase === 'PDP-0' && row.kind === 'capability-intent').flatMap(row => Object.values(row.joins).flat());
  assert(p0CapabilityJoins.some(edge => edge.phase === 'PDP-1' && edge.sourceRef.includes('#capabilityOperationContracts/records/@id=') && edge.sourceRef.endsWith('/capabilityRef')));
  const capabilityOperationJoins = sourceBridge.rows.filter(row => row.phase === 'PDP-1' && row.kind === 'capabilityOperations').flatMap(row => Object.values(row.joins).flat());
  assert(capabilityOperationJoins.some(edge => edge.sourceRef.includes('#capabilityOperationContracts/records/@id=') && edge.sourceRef.endsWith('/operationRefs')));
  const operationJoins = sourceBridge.rows.filter(row => row.phase === 'PDP-1' && row.kind === 'operations').flatMap(row => Object.values(row.joins).flat());
  assert(operationJoins.some(edge => edge.phase === 'PDP-3' && /\/actionRefs?$/.test(edge.sourceRef)));
  assert(operationJoins.some(edge => edge.phase === 'PDP-3' && edge.sourceRef.endsWith('/actionRef') && edge.id.includes('#actions/@id=')));
  assert(operationJoins.some(edge => edge.phase === 'PDP-1' && edge.sourceRef.endsWith('/domainObjectRefs')));
  assert(sourceBridge.rows.flatMap(row => Object.values(row.joins).flat()).some(edge => edge.phase === 'PDP-1' && edge.sourceRef.endsWith('/stateRefs')));
  const transitionJoins = sourceBridge.rows.filter(row => row.phase === 'PDP-1' && row.kind === 'transitions').flatMap(row => Object.values(row.joins).flat());
  assert(transitionJoins.some(edge => edge.sourceRef.endsWith('/operationRefs')));
  const purposeJoins = sourceBridge.rows.filter(row => row.phase === 'PDP-3' && row.kind === 'journey-step-purpose').flatMap(row => Object.values(row.joins).flat());
  assert(purposeJoins.some(edge => edge.phase === 'PDP-1' && edge.sourceRef.includes('operationRefs=')));
  const channelJoins = sourceBridge.rows.filter(row => row.phase === 'PDP-3' && row.kind === 'journey-channel-edge').flatMap(row => Object.values(row.joins).flat());
  assert(channelJoins.some(edge => edge.phase === 'PDP-1' && edge.sourceRef.includes('/p1OperationBindings/') && edge.sourceRef.endsWith('/operationRef')));
  const screenJoins = sourceBridge.rows.filter(row => row.phase === 'PDP-3' && row.kind === 'screen').flatMap(row => Object.values(row.joins).flat());
  assert(screenJoins.some(edge => edge.phase === 'PDP-3' && edge.sourceRef.endsWith('/journeyRefs')));
  assert(screenJoins.some(edge => edge.phase === 'PDP-2' && edge.sourceRef.endsWith('/templateId')));
  assert(screenJoins.some(edge => edge.phase === 'PDP-2' && edge.sourceRef.endsWith('/layoutIds')));
  assert(sourceBridge.rows.some(row => row.unresolvedSourceBlockers.some(blocker => blocker.startsWith('UNRESOLVED_HANDOFF_SELECTOR:'))));
  assert(sourceBridge.rows.some(row => row.unresolvedSourceBlockers.some(blocker => blocker.startsWith('REQUIRED_P1_OPERATION_OMITTED_FROM_TRACE:'))));
  const ids = sourceBridge.authoritativeIdentityKeys;
  const joinsByIdentity = new Map(sourceBridge.rows.map(x => [`${x.phase}:${x.kind}:${x.identity}`, x.joins]));
  const permittedNA = new Set(original.trace.filter(x => x.primaryPackageId === 'N/A').map(x => `${x.phase}:${x.kind}:${x.identity}`));
  const expected = {
    traceIdentityKeys: ids, traceCount: 3186, packageIds: original.packages.map(x => x.id),
    packageDependencies: Object.fromEntries(original.packages.map(pkg => [pkg.id, pkg.dependencies])),
    wipPolicy: original.wipPolicy,
    validNAIdentities: permittedNA, joinsByIdentity,
    edgeIds: original.trace.filter(x => x.kind === 'journey-channel-edge').map(x => x.identity),
    surfaceCounts: original.census.surfaces, sourcePins: original.sourcePins,
    tracePopulations: original.census.tracePopulations,
    materialSources: original.materialSourceReceipt.records,
    matrixPaths: original.census.matrixRows.map(x => x.path),
    surfaceIds: original.surfaces.map(x => x.id)
  };
  const rejected = (mutate, extra = {}) => {
    const candidate = structuredClone(original);
    mutate(candidate);
    assert.notDeepEqual(validateBuildWorkPackageProjection(candidate, { ...expected, ...extra }), []);
  };
  rejected(x => { x.trace[0].identity = x.trace[1].identity; }); // duplicate identity
  rejected(x => { x.trace.pop(); }); // missing trace identity / source census
  rejected(x => { x.census.tracePopulations['PDP-3.journey-channel-edge']++; }); // wrong category membership
  rejected(x => { x.trace.find(r => r.kind === 'journey-step-purpose').joins.p0Capability[0].id = 'invented.capability'; }); // wrong cross-layer join
  rejected(x => { const r = x.trace.find(r => r.kind === 'journey-step-purpose' && r.joins.p1Operation?.length); r.joins.p1Operation.pop(); }); // missing source-declared edge
  assert.notDeepEqual(validateBuildWorkPackageProjection(original, { ...expected, edgeIds: [...expected.edgeIds, expected.edgeIds[0]] }), []); // duplicate source edge
  rejected(x => { x.packages[0].dependencies = [x.packages[1].id]; x.packages[1].dependencies = [x.packages[0].id]; }); // cycle
  rejected(x => { x.trace.find(r => r.identity !== 'media.surface.desktop-archive').primaryPackageId = 'N/A'; }); // invalid N/A
  rejected(x => { x.trace.find(r => r.identity === 'media.surface.desktop-archive').primaryPackageId = 'M-BLD-F00'; }); // source-authorized N/A silently removed
  rejected(x => { x.trace[0].primaryPackageId = 'M-BLD-UNKNOWN'; }); // missing package ownership target
  rejected(x => { x.sourcePins[Object.keys(x.sourcePins)[0]] = 'stale'; }); // stale source pin
  rejected(x => { x.materialSourceReceipt.records[0].expectedSha256 = 'stale'; }); // stale phase material pin
  rejected(x => { x.packages[0].taskIds = ['MISSING.T01']; }); // missing task record
  rejected(x => { x.tasks[0].predecessorTaskIds = ['MISSING.T01']; }); // dangling task edge
  rejected(x => { x.tasks[0].predecessorTaskIds = [x.tasks[1].id]; x.tasks[1].predecessorTaskIds = [x.tasks[0].id]; }); // task cycle
  rejected(x => { x.tasks.find(task => task.id === 'M-BLD-F01.T01').predecessorTaskIds = ['M-BLD-F00.T01']; }); // package dependency task undercoverage
  rejected(x => { x.tasks.find(task => task.id === 'M-BLD-F02.T01').predecessorTaskIds = ['M-BLD-F01.T01']; }); // F02 cannot bypass F00 package completion
  rejected(x => { delete x.wipPolicy; }); // WIP policy is mandatory
  rejected(x => { x.wipPolicy.limits.maxSimultaneouslyEditedPackagesPerLane = 3; }); // WIP cap is source-defined
  rejected(x => { x.wipPolicy.limits.maxActiveChangeWritersPerSharedFileOrSchemaOwner = 2; }); // shared-owner writer limit is source-defined
  rejected(x => { x.wipPolicy.lanes.find(lane => lane.id === 'F').packageIds.pop(); }); // package-family lane membership is complete
  rejected(x => { x.wipPolicy.staffing = { engineer: 'invented' }; }); // projection cannot invent staffing
  rejected(x => { x.wipPolicy.readiness = 'READY'; }); // capacity projection cannot assert readiness
  rejected(x => { x.tasks.find(task => task.id === 'M-BLD-V03.T02').title = 'Single-channel J-03 task'; }); // generated decomposition must be labeled
  rejected(x => { x.tasks.find(task => task.id === 'M-BLD-V03.T02').taskOrigin.canonicalPlanAuthored = true; }); // generated task is not canonical plan-authored
  rejected(x => { x.tasks.find(task => task.id === 'M-BLD-L01.T05').predecessorTaskIds = x.tasks.find(task => task.id === 'M-BLD-L01.T05').predecessorTaskIds.filter(id => id !== 'M-BLD-V24.T01'); }); // full L01 completion retains V24 dependency
  rejected(x => { x.tasks.find(task => task.id === 'M-BLD-L01.T01').predecessorTaskIds = ['M-BLD-F00.T03']; }); // early source task must not inherit full F00 completion
  rejected(x => { x.tasks.find(task => task.id === 'M-BLD-L01.T01').sourceScope.journeyIds = ['J-01', 'J-02', 'J-03']; }); // exact early story scope
  rejected(x => { x.tasks.find(task => task.id === 'M-BLD-L01.T03').predecessorTaskIds = ['M-BLD-V03.T01']; }); // early recording cannot wait on full V03
  rejected(x => { x.tasks.find(task => task.id === 'M-BLD-V03.T02').predecessorTaskIds = ['M-BLD-V20.T01', 'M-BLD-F08.T01', 'M-BLD-F11.T01', 'M-BLD-F09.T01']; }); // one-channel business task prerequisite undercoverage
  rejected(x => { x.packages.find(pkg => pkg.id === 'M-BLD-F01').dependencies = []; }); // package DAG must match canonical plan
  rejected(x => { delete x.tasks.find(task => task.id === 'M-BLD-F02.T01').packageDependencyScope; }); // task package dependency mode is mandatory
  rejected(x => { x.packages.find(pkg => pkg.id === 'M-BLD-L01').taskIds = x.packages.find(pkg => pkg.id === 'M-BLD-L01').taskIds.filter(id => id !== 'M-BLD-L01.T05'); }); // no orphaned full acceptance task
  rejected(x => { x.census.matrixRows.pop(); }); // missing source matrix
  rejected(x => { x.census.matrixRows[0].surfaceIds[0] = 'wrong.surface'; }); // wrong matrix membership
  assert.notDeepEqual(validateBuildWorkPackageProjection(original, { ...expected, surfaceCounts: { ...expected.surfaceCounts, total: 53 } }), []); // missing surface census
});
