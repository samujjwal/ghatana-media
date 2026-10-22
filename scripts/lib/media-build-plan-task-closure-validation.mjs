import crypto from 'node:crypto';
import fs from 'node:fs';

const required = ['id','packageId','title','status','priority','packageDependencyScope','outcome','joinedSourceIdentities','ownership','fingerprints','predecessorTaskIds','actions','tests','expectedResult','finality','environmentPrerequisites','actionableBlocker','rollbackFencingCleanup','constraints','evidence','reviewerRole','approverRole'];
const nonempty = x => typeof x === 'string' && x.trim().length > 0;
const sha = path => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');

export function validateMediaBuildPlanTaskClosure(projection, { root = process.cwd() } = {}) {
  const errors = [];
  const add = message => errors.push(message);
  const packages = projection.packages ?? [], tasks = projection.tasks ?? [], trace = projection.trace ?? [], surfaces = projection.surfaces ?? [];
  const packageIds = packages.map(x => x.id), taskIds = tasks.map(x => x.id);
  const pkgSet = new Set(packageIds), taskSet = new Set(taskIds);
  if (new Set(packageIds).size !== packageIds.length) add('duplicate package IDs');
  if (new Set(taskIds).size !== taskIds.length) add('duplicate task IDs');
  if (projection.census?.packageCount !== packages.length) add('package census mismatch');
  if (projection.census?.traceIdentityCount !== trace.length) add('trace census mismatch');
  const traceKeys = trace.map(x => `${x.phase}:${x.kind}:${x.identity}`);
  if (new Set(traceKeys).size !== traceKeys.length || traceKeys.some(x => x.endsWith(':'))) add('duplicate or missing trace identities');
  const surfaceIds = surfaces.map(x => x.id);
  if (new Set(surfaceIds).size !== surfaceIds.length) add('duplicate surface IDs');
  if (projection.census?.surfaces?.total !== surfaces.length) add('surface census mismatch');
  const byTask = new Map(tasks.map(t => [t.id, t]));
  const listed = new Set();
  for (const p of packages) {
    if (!Array.isArray(p.taskIds) || !p.taskIds.length) add(`package has no task IDs: ${p.id}`);
    for (const id of p.taskIds ?? []) {
      if (!taskSet.has(id)) add(`missing task ${id} listed by ${p.id}`);
      else { listed.add(id); if (byTask.get(id).packageId !== p.id) add(`task/package ownership mismatch: ${id}`); }
    }
    for (const id of p.dependencies ?? []) if (!pkgSet.has(id)) add(`unknown package dependency: ${p.id} -> ${id}`);
  }
  const blockerIds = new Set();
  const sourceBlockers = [];
  const receiptRows = projection.materialSourceReceipt?.records ?? [];
  const receiptByKey = new Map(receiptRows.map(record => [`${record.phase}:${record.selector}`, record]));
  const sourcePinned = selector => {
    if (typeof selector !== 'string') return false;
    const path = selector.split('#')[0];
    return Boolean(path && projection.sourcePins?.[path]);
  };
  for (const t of tasks) {
    if (!pkgSet.has(t.packageId)) add(`unknown task package: ${t.id}`);
    if (!listed.has(t.id)) add(`orphan task: ${t.id}`);
    for (const key of required) if (t[key] === undefined || t[key] === null || (typeof t[key] === 'string' && !t[key].trim())) add(`missing required task field ${key}: ${t.id}`);
    for (const key of ['outcome','expectedResult','actionableBlocker','rollbackFencingCleanup','reviewerRole','approverRole']) if (!nonempty(t[key])) add(`empty required task field ${key}: ${t.id}`);
    if (!Array.isArray(t.joinedSourceIdentities)) add(`task joined source identities must be an array: ${t.id}`);
    if (!Array.isArray(t.actions) || !t.actions.length) add(`task has no actions: ${t.id}`);
    if (!Array.isArray(t.predecessorTaskIds)) add(`task predecessors must be named array: ${t.id}`);
    for (const dep of t.predecessorTaskIds ?? []) if (!taskSet.has(dep)) add(`dangling task dependency: ${t.id} -> ${dep}`);
    for (const row of t.joinedSourceIdentities ?? []) {
      if (row.selector) {
        const receipt = receiptByKey.get(`${row.phase}:${row.selector}`);
        if (!receipt) { sourceBlockers.push(`${t.id}: missing material source receipt for ${row.phase}:${row.selector}`); blockerIds.add(t.id); }
        else if (receipt.status !== 'CURRENT' || receipt.expectedSha256 !== row.expectedSha256 || receipt.currentSha256 !== row.currentSha256 || receipt.expectedSha256 !== receipt.currentSha256 || row.status !== 'CURRENT') { sourceBlockers.push(`${t.id}: stale or inconsistent material source receipt for ${row.phase}:${row.selector}`); blockerIds.add(t.id); }
        continue;
      }
      const identity = row.identity ?? row.id;
      if (!identity) { add(`task source join lacks identity or selector: ${t.id}`); continue; }
      const key = `${row.phase}:${row.kind}:${identity}`;
      // Some valid joins are source records referenced by a trace row, but are not
      // themselves members of the 3,186-row trace denominator. Validate selectors
      // for those endpoints against the projection's pinned source set.
      if (!traceKeys.includes(key) && !surfaceIds.includes(identity)) {
        const selectors = [...(row.sourceRecordSelectors ?? []), ...(row.sourceSelectors ?? [])];
        const endpointSelectors = Object.values(row.joins ?? {}).flatMap(v => Array.isArray(v) ? v : [v]).filter(v => v && typeof v === 'object').map(v => v.sourceRef ?? v.sourceRecordSelector).filter(Boolean);
        if (![...selectors, ...endpointSelectors].some(sourcePinned)) add(`non-trace task source join lacks pinned authoritative selector: ${t.id} -> ${key}`);
      }
      if ((row.unresolvedSourceBlockers ?? []).length || (row.unresolvedSourceSlots ?? []).length) blockerIds.add(t.id);
    }
    for (const pin of t.fingerprints?.sourcePins ?? []) {
      if (projection.sourcePins?.[pin.path] !== pin.sha256) add(`task source pin disagrees with projection: ${t.id} -> ${pin.path}`);
    }
  }
  const visitGraph = (items, getDeps, label) => {
    const active = new Set(), done = new Set();
    const visit = id => { if (active.has(id)) { add(`${label} dependency cycle at ${id}`); return; } if (done.has(id)) return; active.add(id); for (const d of getDeps(id) ?? []) if (items.has(d)) visit(d); active.delete(id); done.add(id); };
    for (const id of items) visit(id);
  };
  visitGraph(pkgSet, id => packages.find(x => x.id === id)?.dependencies, 'package');
  visitGraph(taskSet, id => byTask.get(id)?.predecessorTaskIds, 'task');
  for (const [path, expected] of Object.entries(projection.sourcePins ?? {})) {
    const absolute = `${root}/${path}`;
    if (!fs.existsSync(absolute) || sha(absolute) !== expected) add(`stale or missing source pin: ${path}`);
  }
  const wip = projection.wipPolicy;
  if (wip?.source?.section !== '11B' || !Number.isInteger(wip?.limits?.maxSimultaneouslyEditedPackagesPerLane) || wip.limits.maxSimultaneouslyEditedPackagesPerLane < 1 || wip.limits.maxSimultaneouslyEditedPackagesPerLane > 2 || !Number.isInteger(wip?.limits?.maxActiveChangeWritersPerSharedFileOrSchemaOwner) || wip.limits.maxActiveChangeWritersPerSharedFileOrSchemaOwner !== 1) add('WIP bound outside §11B policy or policy missing');
  for (const t of tasks) if (t.status === 'BLOCKED' || t.status === 'INCOMPLETE_SOURCE_RELATIONS') blockerIds.add(t.id);
  if (projection.materialSourceReceipt?.status !== 'CURRENT' || projection.materialSourceReceipt?.staleCount !== 0 || projection.materialSourceReceipt?.count !== receiptRows.length) sourceBlockers.push('material source receipt is missing, stale, or has a count mismatch');
  const blockers = [...blockerIds].sort();
  const structurallyValid = errors.length === 0;
  return { schemaVersion: 'media.build-plan-task-closure-validation.v1', structuralStatus: structurallyValid ? 'PASS' : 'FAIL', errors, taskCount: tasks.length, packageCount: packages.length, surfaceCount: surfaces.length, traceIdentityCount: trace.length, unresolvedBlockerTaskIds: blockers, sourceBlockers, taskClosure: 'PENDING', planReady: 'PENDING', approvalEvidenceStatus: 'MISSING', note: 'This Media structural validator does not authenticate Lifecycle approval or owner receipts.' };
}
