export function validateBuildWorkPackageProjection(projection, expected = {}) {
  const errors = [];
  const canonicalJson = value => JSON.stringify(value, (key, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  const rows = projection.trace ?? [];
  const identities = rows.map(row => `${row.phase}:${row.kind}:${row.identity}`);
  const identitySet = new Set(identities);
  if (identitySet.size !== identities.length || identities.some(id => id.endsWith(':'))) errors.push('duplicate or missing trace identity');
  if (expected.traceIdentityKeys) {
    const wanted = new Set(expected.traceIdentityKeys);
    if (wanted.size !== expected.traceIdentityKeys.length || wanted.size !== identitySet.size || [...wanted].some(id => !identitySet.has(id))) errors.push('trace identity census does not match source set');
  }
  if (expected.tracePopulations && canonicalJson(projection.census?.tracePopulations) !== canonicalJson(expected.tracePopulations)) errors.push('trace category membership/count census mismatch');
  if (projection.census?.traceIdentityCount !== rows.length || (expected.traceCount != null && rows.length !== expected.traceCount)) errors.push('trace source census count mismatch');
  const packages = projection.packages ?? [];
  const packageIds = packages.map(p => p.id);
  const packageSet = new Set(packageIds);
  if (packageSet.size !== packageIds.length || (expected.packageIds && (packageSet.size !== expected.packageIds.length || expected.packageIds.some(id => !packageSet.has(id))))) errors.push('package identity census mismatch');
  const familyLanes = new Map();
  for (const id of packageIds) {
    const family = String(id).match(/^M-BLD-([FVLX])\d{2}$/)?.[1];
    if (!family) {
      errors.push(`package ID does not identify an approved WIP lane: ${id}`);
      continue;
    }
    if (!familyLanes.has(family)) familyLanes.set(family, []);
    familyLanes.get(family).push(id);
  }
  const expectedLanes = [...familyLanes].map(([id, lanePackageIds]) => ({ id, packageIds: lanePackageIds }));
  const wipPolicy = projection.wipPolicy;
  const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
  if (!exactKeys(wipPolicy, ['source', 'laneModel', 'limits', 'lanes', 'semantics'])) {
    errors.push('WIP policy is missing or contains unapproved staffing/readiness fields');
  }
  if (!exactKeys(wipPolicy?.source, ['path', 'section']) || wipPolicy.source.path !== 'docs/implementation/MEDIA-BUILD-IMPLEMENTATION-PLAN.md' || wipPolicy.source.section !== '11B') errors.push('WIP policy lacks canonical §11B source basis');
  if (wipPolicy?.laneModel !== 'existing-package-family-prefix') errors.push('WIP policy must use existing package-family lanes');
  if (canonicalJson(wipPolicy?.limits ?? null) !== canonicalJson({ maxSimultaneouslyEditedPackagesPerLane: 2, maxActiveChangeWritersPerSharedFileOrSchemaOwner: 1 })) errors.push('WIP policy limits differ from canonical §11B');
  if (canonicalJson(wipPolicy?.lanes ?? null) !== canonicalJson(expectedLanes)) errors.push('WIP lane membership does not exactly cover existing package families');
  if (wipPolicy?.semantics !== 'Policy limits only; this projection does not record staffing, active work, or readiness.') errors.push('WIP policy must not assert assignments or readiness');
  for (const lane of wipPolicy?.lanes ?? []) if (!exactKeys(lane, ['id', 'packageIds'])) errors.push(`WIP lane contains unsupported capacity or assignment fields: ${lane?.id ?? '<unknown>'}`);
  if (expected.wipPolicy && canonicalJson(wipPolicy ?? null) !== canonicalJson(expected.wipPolicy)) errors.push('WIP policy differs from canonical generator policy');
  if (expected.packageDependencies) {
    for (const [id, dependencies] of Object.entries(expected.packageDependencies)) {
      const actual = byPackageId(packages, id)?.dependencies;
      if (canonicalJson(actual ?? null) !== canonicalJson(dependencies)) errors.push(`package dependency set differs from canonical plan: ${id}`);
    }
  }
  const visiting = new Set(); const visited = new Set();
  const byId = new Map(packages.map(p => [p.id, p]));
  const visit = id => {
    if (visiting.has(id)) { errors.push(`package dependency cycle: ${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependencies ?? []) {
      if (!packageSet.has(dep)) errors.push(`unknown package dependency: ${id} -> ${dep}`);
      else visit(dep);
    }
    visiting.delete(id); visited.add(id);
  };
  for (const id of packageIds) visit(id);
  const tasks = projection.tasks ?? [];
  const taskIds = tasks.map(task => task.id);
  const taskSet = new Set(taskIds);
  if (taskSet.size !== taskIds.length) errors.push('duplicate task identity');
  const taskVisiting = new Set(); const taskVisited = new Set(); const taskById = new Map(tasks.map(task => [task.id, task]));
  const generatedSingleChannelTask = taskById.get('M-BLD-V03.T02');
  const generatedOrigin = generatedSingleChannelTask?.taskOrigin;
  if (generatedSingleChannelTask && (
    !String(generatedSingleChannelTask.title ?? '').startsWith('Generated §5A') ||
    generatedOrigin?.type !== 'GENERATED_SCOPED_DECOMPOSITION' ||
    generatedOrigin?.canonicalPlanAuthored !== false ||
    generatedOrigin?.source !== 'docs/implementation/MEDIA-BUILD-IMPLEMENTATION-PLAN.md' ||
    generatedOrigin?.section !== '5A' ||
    !String(generatedOrigin?.rationale ?? '').includes('§5A') ||
    !String(generatedOrigin?.rationale ?? '').includes('generated dependency node')
  )) errors.push('M-BLD-V03.T02 must be labeled as a §5A-generated subtask, not a canonical plan-authored task');
  const declaredTaskIds = new Set();
  for (const pkg of packages) {
    if (!Array.isArray(pkg.taskIds) || pkg.taskIds.length === 0) errors.push(`package has no task handoff: ${pkg.id}`);
    if (new Set(pkg.taskIds ?? []).size !== (pkg.taskIds ?? []).length) errors.push(`duplicate package task reference: ${pkg.id}`);
    for (const taskId of pkg.taskIds ?? []) {
      if (!taskSet.has(taskId)) errors.push(`missing package task: ${pkg.id} -> ${taskId}`);
      else {
        declaredTaskIds.add(taskId);
        if (taskById.get(taskId)?.packageId !== pkg.id) errors.push(`package/task owner mismatch: ${pkg.id} -> ${taskId}`);
      }
    }
  }
  for (const task of tasks) {
    if (!packageSet.has(task.packageId)) errors.push(`task references unknown package: ${task.id} -> ${task.packageId}`);
    if (!declaredTaskIds.has(task.id)) errors.push(`orphan task not listed by its package: ${task.id}`);
    if (new Set(task.predecessorTaskIds ?? []).size !== (task.predecessorTaskIds ?? []).length) errors.push(`duplicate task predecessor: ${task.id}`);
  }
  const visitTask = id => {
    if (taskVisiting.has(id)) { errors.push(`task dependency cycle: ${id}`); return; }
    if (taskVisited.has(id)) return;
    taskVisiting.add(id);
    for (const dep of taskById.get(id)?.predecessorTaskIds ?? []) {
      if (!taskSet.has(dep)) errors.push(`dangling predecessor task: ${id} -> ${dep}`);
      else visitTask(dep);
    }
    taskVisiting.delete(id); taskVisited.add(id);
  };
  for (const id of taskIds) visitTask(id);
  const taskPackageId = new Map(tasks.map(task => [task.id, task.packageId]));
  const terminalTasksByPackage = new Map(packages.map(pkg => {
    const internalSuccessors = new Set(tasks
      .filter(task => task.packageId === pkg.id)
      .flatMap(task => (task.predecessorTaskIds ?? []).filter(id => taskPackageId.get(id) === pkg.id)));
    return [pkg.id, (pkg.taskIds ?? []).filter(taskId => !internalSuccessors.has(taskId))];
  }));
  const scopedTaskRules = {
    'M-BLD-L01.T01': { packageId: 'M-BLD-L01', predecessors: ['M-BLD-F00.T01'], journeyIds: ['J-01', 'J-02', 'J-20', 'J-03'] },
    'M-BLD-L01.T02': { packageId: 'M-BLD-L01', predecessors: ['M-BLD-L01.T01'], journeyIds: ['J-01', 'J-02', 'J-20', 'J-03'] },
    'M-BLD-L01.T03': { packageId: 'M-BLD-L01', predecessors: ['M-BLD-V03.T02'], journeyIds: ['J-01', 'J-02', 'J-20', 'J-03'] },
    'M-BLD-L01.T04': { packageId: 'M-BLD-L01', predecessors: ['M-BLD-L01.T01', 'M-BLD-L01.T02', 'M-BLD-L01.T03'], journeyIds: ['J-01', 'J-02', 'J-20', 'J-03'] },
    'M-BLD-V03.T02': { packageId: 'M-BLD-V03', predecessors: ['M-BLD-V02.T01', 'M-BLD-V20.T01', 'M-BLD-F08.T01', 'M-BLD-F11.T01', 'M-BLD-F09.T01'], journeyIds: ['J-03'] }
  };
  for (const task of tasks) {
    const pkg = byPackageId(packages, task.packageId);
    const predecessorIds = task.predecessorTaskIds ?? [];
    if (task.packageDependencyScope === 'FULL_PACKAGE') {
      for (const dependencyId of pkg?.dependencies ?? []) {
        const requiredTerminalIds = terminalTasksByPackage.get(dependencyId) ?? [];
        for (const terminalId of requiredTerminalIds) if (!predecessorIds.includes(terminalId)) errors.push(`task dependency undercoverage: ${task.id} does not depend on ${dependencyId} terminal ${terminalId}`);
      }
    } else if (task.packageDependencyScope === 'EARLY_SCOPED') {
      const rule = scopedTaskRules[task.id];
      if (!rule || task.packageId !== rule.packageId) errors.push(`unapproved early scoped task dependency exception: ${task.id}`);
      else {
        if (canonicalJson([...predecessorIds].sort()) !== canonicalJson([...rule.predecessors].sort())) errors.push(`early scoped task prerequisites differ from §5A: ${task.id}`);
        if (!String(task.prerequisiteBasis ?? '').includes('§5A')) errors.push(`early scoped task lacks §5A basis: ${task.id}`);
        const scope = task.sourceScope;
        if (!scope || scope.status !== 'SOURCE_SCOPED_PLANNING_ONLY' || canonicalJson(scope.journeyIds) !== canonicalJson(rule.journeyIds)) errors.push(`early scoped task lacks exact source journey scope: ${task.id}`);
        if (!scope?.sourceIdentityKeys?.length || !scope?.sourceSelectors?.length || !scope?.purposeBindingIds?.length || !scope?.channelEdgeIds?.length) errors.push(`early scoped task source bridge is incomplete: ${task.id}`);
        const sourceIdentityKeys = (task.joinedSourceIdentities ?? []).map(row => `${row.phase}:${row.kind}:${row.id}`).sort();
        if (canonicalJson(sourceIdentityKeys) !== canonicalJson([...(scope?.sourceIdentityKeys ?? [])].sort())) errors.push(`early scoped task source identities differ from its scoped bridge: ${task.id}`);
        for (const journeyId of rule.journeyIds) if (!scope?.sourceIdentityKeys?.includes(`PDP-3:journey:${journeyId}`)) errors.push(`early scoped task is missing journey identity ${journeyId}: ${task.id}`);
        for (const selector of scope?.sourceSelectors ?? []) {
          const sourcePath = selector.split('#')[0];
          if (sourcePath && !projection.sourcePins?.[sourcePath]) errors.push(`early scoped source selector is not pinned: ${task.id} -> ${selector}`);
        }
      }
      if (terminalTasksByPackage.get(task.packageId)?.includes(task.id)) errors.push(`early scoped task cannot be a package completion task: ${task.id}`);
    } else {
      errors.push(`task has unknown package dependency scope: ${task.id}`);
    }
    for (const predecessorId of predecessorIds) {
      const predecessorPackageId = taskPackageId.get(predecessorId);
      if (!predecessorPackageId || predecessorPackageId === task.packageId) continue;
      const isDeclaredPackageDependency = (pkg?.dependencies ?? []).includes(predecessorPackageId);
      const scopedException = task.packageDependencyScope === 'EARLY_SCOPED' && scopedTaskRules[task.id]?.predecessors.includes(predecessorId);
      if (!isDeclaredPackageDependency && !scopedException) errors.push(`task predecessor is outside package dependency scope: ${task.id} -> ${predecessorId}`);
    }
  }
  const taskAncestors = taskId => {
    const found = new Set();
    const visit = id => {
      for (const predecessorId of taskById.get(id)?.predecessorTaskIds ?? []) {
        if (found.has(predecessorId)) continue;
        found.add(predecessorId);
        visit(predecessorId);
      }
    };
    visit(taskId);
    return found;
  };
  for (const [taskId, rule] of Object.entries(scopedTaskRules)) {
    if (!taskSet.has(taskId)) continue;
    const completionTasks = terminalTasksByPackage.get(rule.packageId) ?? [];
    if (!completionTasks.some(completionTaskId => taskAncestors(completionTaskId).has(taskId))) errors.push(`scoped prerequisite is not included in eventual package completion: ${taskId}`);
  }
  for (const task of tasks) for (const field of ['outcome', 'joinedSourceIdentities', 'ownership', 'fingerprints', 'predecessorTaskIds', 'actions', 'tests', 'expectedResult', 'finality', 'environmentPrerequisites', 'actionableBlocker', 'rollbackFencingCleanup', 'constraints', 'evidence', 'reviewerRole', 'approverRole']) if (task[field] == null) errors.push(`task ${task.id} missing handoff field ${field}`);
  for (const row of rows) {
    if (row.primaryPackageId !== 'N/A' && !packageSet.has(row.primaryPackageId)) errors.push(`unknown package owner: ${row.identity}`);
    if (row.primaryPackageId === 'N/A' && !expected.validNAIdentities?.has(`${row.phase}:${row.kind}:${row.identity}`)) errors.push(`invalid N/A owner: ${row.identity}`);
    const key = `${row.phase}:${row.kind}:${row.identity}`;
    if (expected.validNAIdentities?.has(key) && row.primaryPackageId !== 'N/A') errors.push(`source-authorized N/A disposition removed: ${row.identity}`);
    if (expected.joinsByIdentity && JSON.stringify(row.joins) !== JSON.stringify(expected.joinsByIdentity.get(key))) errors.push(`wrong source join: ${row.identity}`);
  }
  const edgeIds = expected.edgeIds ?? [];
  if (new Set(edgeIds).size !== edgeIds.length || edgeIds.some(id => !id)) errors.push('duplicate or missing channel edge identity');
  const expectedSurfaces = expected.surfaceCounts;
  if (expectedSurfaces && JSON.stringify(projection.census?.surfaces) !== JSON.stringify(expectedSurfaces)) errors.push('surface source census mismatch');
  if (expected.surfaceRecords && canonicalJson(projection.surfaces ?? null) !== canonicalJson(expected.surfaceRecords)) {
    errors.push('surface handoff differs from exact topology, registry applicability, or phase-matrix source records');
  }
  if (expected.sourcePins) {
    for (const [path, hash] of Object.entries(expected.sourcePins)) if (projection.sourcePins?.[path] !== hash) errors.push(`stale or missing source pin: ${path}`);
    for (const path of Object.keys(projection.sourcePins ?? {})) if (!(path in expected.sourcePins)) errors.push(`unexpected source pin: ${path}`);
  }
  const receipt = projection.materialSourceReceipt;
  if (receipt) {
    const stale = (receipt.records ?? []).filter(record => record.currentSha256 !== record.expectedSha256 || record.status !== 'CURRENT');
    if (receipt.count !== receipt.records?.length || receipt.staleCount !== stale.length || receipt.status !== (stale.length ? 'STALE_BLOCKED' : 'CURRENT')) errors.push('material source pin receipt is inconsistent');
    if (expected.materialSources && JSON.stringify(receipt.records) !== JSON.stringify(expected.materialSources)) errors.push('material source pin set differs from current phase sourceShaSet');
  }
  if (expected.matrixPaths) {
    const matrices = projection.census?.matrixRows ?? [];
    if (matrices.length !== expected.matrixPaths.length || expected.matrixPaths.some(path => !matrices.some(matrix => matrix.path === path && matrix.rowCount === 54 && matrix.sourceCurrentness === 'CURRENT' && matrix.status === 'DEV_COMPLETE' && matrix.surfaceIds?.length === 54 && (!expected.surfaceIds || expected.surfaceIds.every(id => matrix.surfaceIds.includes(id)))))) errors.push('phase matrix census is incomplete or not current');
  }
  return errors;
}

function byPackageId(packages, id) {
  return packages.find(pkg => pkg.id === id);
}
