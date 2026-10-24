import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import yaml from 'yaml';
import { pdp0PhaseScopedSourcePins } from '../report-media-pdp-readiness.mjs';

export const F00_T01_SCHEMA = 'media.build-f00-t01-source-material-topology-observation.v1';
export const F00_T01_RECORD_KIND = 'SOURCE_ONLY_F00_T01_RECONCILIATION_NOT_BUILD_ADMISSION_OR_PDP_CLOSURE';
export const PHASES = ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'];

const paths = {
  topology: '.product-experience/surfaces/media-physical-topology.v1.json',
  registry: '.product-experience/surface-registry.yaml',
  sourceManifest: '.product-experience/source-manifest.yaml',
  workPackages: 'docs/implementation/MEDIA-BUILD-WORK-PACKAGES.v1.json',
  plan: 'docs/implementation/MEDIA-BUILD-IMPLEMENTATION-PLAN.md',
  phaseStatus: PHASES.map((phase, index) => ({
    phase,
    path: `docs/implementation/pdp-${index}-phase-dev-status.json`
  })),
  phaseMatrices: PHASES.map((phase, index) => ({
    phase,
    path: `docs/implementation/verification/pdp-38/pdp${index}-surface-phase-status-matrix.json`
  }))
};

const fail = message => { throw new Error(`F00.T01 observation: ${message}`); };
const read = (root, relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const json = (root, relativePath) => JSON.parse(read(root, relativePath));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const digestFile = (root, relativePath) => sha256(fs.readFileSync(path.join(root, relativePath)));
const exactKeys = (actual, expected, label) => {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || actual.some(item => !expected.includes(item)) || expected.some(item => !actual.includes(item))) {
    fail(`${label} is not an exact, unique ${expected.length}-identity set`);
  }
};
const ensure = (condition, message) => { if (!condition) fail(message); };

function topologyIdentities(topology) {
  const physicalIds = topology.manifestCandidates?.map(row => row.surfaceId);
  const compositionIds = topology.compositions?.map(row => row.surfaceId);
  const logicalIds = topology.consumerCrosswalk?.map(row => row.surfaceId);
  ensure(Array.isArray(physicalIds) && topology.activeManifestCandidateCount === 26 && physicalIds.length === 26, 'topology must contain exactly 26 active physical candidates');
  ensure(Array.isArray(compositionIds) && compositionIds.length === 7, 'topology must contain exactly 7 compositions including its root');
  ensure(Array.isArray(logicalIds) && logicalIds.length === 21, 'topology must contain exactly 21 logical consumers');
  const ids = [...physicalIds, ...compositionIds, ...logicalIds];
  ensure(ids.every(id => typeof id === 'string' && id.length > 0) && new Set(ids).size === 54, 'topology identities must be 54 unique nonempty IDs');
  return { ids, physicalIds, compositionIds, logicalIds };
}

function validateG0(status) {
  ensure(status?.schemaVersion === 'ghatana.lifecycle.media-structured-method-status.v1', 'G0 status has an unsupported schema');
  ensure(status.recordKind === 'GTOOL_METHOD_SOURCE_DEVELOPMENT_PROJECTION_NOT_CLOSURE', 'G0 status is not a source-development projection');
  ensure(status.selectedMethodId === 'ghatana.media-product-development', 'G0 status selects an unexpected method');
  ensure(status.status === 'SOURCE_DEFINITION_DEV_COMPLETE_CURRENT', 'G0 source status is not complete/current');
  ensure(/^sha256:[a-f0-9]{64}$/u.test(status.sourceSnapshotFingerprint ?? ''), 'G0 source snapshot fingerprint is missing or malformed');
  ensure(status.sourceSubjectCount === 54 && status.sourcePhaseCellCount === 216, 'G0 denominator must be exactly 54 subjects × 4 phases = 216 cells');
  ensure(Array.isArray(status.errors) && status.errors.length === 0, 'G0 status reports errors');
  ensure(status.writesPerformed === false, 'G0 readback must report writesPerformed=false');
  ensure(status.sourceProgressionAuthority === 'READ_ONLY_OBSERVATION_NOT_STAGE_TRANSITION_OR_CLOSURE', 'G0 status has an unexpected progression authority');

  const phaseCounts = status.phaseCounts ?? {};
  for (const phase of PHASES) {
    const count = phaseCounts[phase];
    ensure(count?.rows === 54 && count.completeCurrent === 54 && count.incomplete === 0 && count.unknown === 0 && count.nonemptyDefinitionTasks === 0, `${phase} G0 phase counts are incomplete, stale, unknown, or have remaining definition tasks`);
  }
  ensure(Array.isArray(status.rows) && status.rows.length === 216, 'G0 readback must contain exactly 216 phase rows');
  const rowKeys = status.rows.map(row => `${row.subjectId}\u0000${row.phase}`);
  ensure(new Set(rowKeys).size === 216, 'G0 readback has duplicate subject/phase rows');
  for (const row of status.rows) {
    ensure(typeof row.subjectId === 'string' && row.subjectId.length > 0, 'G0 phase row has a missing subject ID');
    ensure(PHASES.includes(row.phase), `G0 phase row has unknown phase ${row.phase}`);
    ensure(row.completion === 'COMPLETE' && row.currentness === 'CURRENT', `G0 row ${row.subjectId}/${row.phase} is not COMPLETE and CURRENT`);
    ensure(row.knownDefinitionTaskCount === 0 && row.sourceDevelopmentReady === true, `G0 row ${row.subjectId}/${row.phase} has tasks or is not source-development ready`);
    const applicability = row.applicability;
    const value = applicability?.value;
    const sourceRefs = [...(Array.isArray(value?.authorityRefs) ? value.authorityRefs : []), value?.authorityRef].filter(ref => typeof ref === 'string' && ref.trim().length > 0);
    ensure(['APPLICABLE', 'NOT_APPLICABLE'].includes(applicability?.status), `G0 row ${row.subjectId}/${row.phase} has missing or unknown applicability status`);
    ensure(typeof applicability.authorityRef === 'string' && applicability.authorityRef.trim().length > 0, `G0 row ${row.subjectId}/${row.phase} has no applicability authority reference`);
    ensure(typeof applicability.rationale === 'string' && applicability.rationale.trim().length > 0, `G0 row ${row.subjectId}/${row.phase} has no applicability rationale`);
    ensure(['APPLICABLE', 'NOT_APPLICABLE'].includes(value?.status), `G0 row ${row.subjectId}/${row.phase} has missing or unknown applicability value status`);
    ensure(typeof value?.disposition === 'string' && value.disposition.trim().length > 0, `G0 row ${row.subjectId}/${row.phase} has no applicability value disposition`);
    ensure(typeof value?.rationale === 'string' && value.rationale.trim().length > 0, `G0 row ${row.subjectId}/${row.phase} has no applicability value rationale`);
    ensure(applicability.status === value.status, `G0 row ${row.subjectId}/${row.phase} applicability status disagrees with its value status`);
    ensure(sourceRefs.length > 0, `G0 row ${row.subjectId}/${row.phase} has no owner source authority reference`);
    if (applicability.status === 'NOT_APPLICABLE') {
      ensure(value.status === 'NOT_APPLICABLE', `G0 NOT_APPLICABLE row ${row.subjectId}/${row.phase} has a non-N/A value status`);
      ensure(sourceRefs.length > 0, `G0 NOT_APPLICABLE row ${row.subjectId}/${row.phase} has no source authority reference`);
    }
  }

  const progression = status.sourcePhaseProgression;
  ensure(progression?.status === 'ALL_SOURCE_PHASES_COMPLETE' && progression.subjectCount === 54 && progression.sourceCompleteSubjectCount === 54, 'G0 phase progression is not complete for all 54 subjects');
  ensure(progression.readOnly === true && progression.writesPerformed === false && progression.stageTransitionPerformed === false, 'G0 progression must be read-only and perform no stage transition');
  ensure(Array.isArray(progression.phaseSummary) && progression.phaseSummary.length === 4, 'G0 phase summary must contain four rows');
  progression.phaseSummary.forEach((row, index) => {
    ensure(row.phaseId === PHASES[index], 'G0 phase summary order differs from PDP-0 through PDP-3');
    ensure(row.enteredEligible === 54 && row.sourceComplete === 54 && row.blockedOnPredecessor === 0 && row.activeSourceDevelopment === 0, `${row.phaseId} G0 phase summary disagrees with 54 complete subjects`);
  });
  ensure(Array.isArray(progression.subjects) && progression.subjects.length === 54, 'G0 progression must contain exactly 54 subject records');
  const progressionIds = progression.subjects.map(subject => subject.subjectId);
  ensure(progressionIds.every(id => typeof id === 'string' && id.length > 0) && new Set(progressionIds).size === 54, 'G0 progression has missing or duplicate subject IDs');
  for (const subject of progression.subjects) {
    ensure(Array.isArray(subject.phaseStates) && subject.phaseStates.length === 4, `G0 progression subject ${subject.subjectId} must have four phase states`);
    subject.phaseStates.forEach((phaseState, index) => {
      ensure(phaseState.phaseId === PHASES[index] && phaseState.sourceDevelopmentReady === true && phaseState.phaseDisposition === 'SOURCE_DEV_COMPLETE', `G0 progression subject ${subject.subjectId}/${phaseState.phaseId} is not source-complete`);
    });
  }
  return { rowKeys, progressionIds };
}

function validatePhaseMatrix(matrix, phase, expectedIds) {
  ensure(matrix.campaign?.phase === phase && matrix.campaign?.status === 'DEV_COMPLETE', `${phase} matrix is not a DEV_COMPLETE phase matrix`);
  ensure(matrix.campaign?.denominator === 54 || matrix.summary?.totalSurfaceIdentities === 54, `${phase} matrix does not declare the 54-surface denominator`);
  ensure(matrix.phaseSourceCurrentness?.status === 'CURRENT' && matrix.phaseSourceCurrentness.staleSourcePinCount === 0, `${phase} matrix source pins are stale or unknown`);
  ensure(Array.isArray(matrix.surfaces) && matrix.surfaces.length === 54, `${phase} matrix must contain exactly 54 rows`);
  const ids = matrix.surfaces.map(row => row.surfaceId);
  exactKeys(ids, expectedIds, `${phase} matrix IDs`);
  for (const row of matrix.surfaces) {
    ensure(row.sourceCurrent === true, `${phase} matrix row ${row.surfaceId} is not source-current`);
    ensure(Array.isArray(row.remainingPhaseLocalTaskIds), `${phase} matrix row ${row.surfaceId} has an unknown task inventory`);
    ensure(row.remainingPhaseLocalTaskIds.length === 0, `${phase} matrix row ${row.surfaceId} has outstanding phase-local tasks`);
    const applicability = row.applicability;
    const authorityRefs = [...(Array.isArray(applicability?.authorityRefs) ? applicability.authorityRefs : []), applicability?.authorityRef]
      .filter(ref => typeof ref === 'string' && ref.trim().length > 0);
    ensure(typeof applicability?.disposition === 'string' && applicability.disposition.trim().length > 0, `${phase} matrix row ${row.surfaceId} has no applicability disposition`);
    ensure(typeof applicability?.rationale === 'string' && applicability.rationale.trim().length > 0, `${phase} matrix row ${row.surfaceId} has no applicability rationale`);
    ensure(authorityRefs.length > 0, `${phase} matrix row ${row.surfaceId} has no applicability authority reference`);
  }
  ensure(matrix.summary?.remainingPhaseLocalTaskCount === 0, `${phase} matrix summary does not report zero phase-local tasks`);
}

export function inspectMaterialSourceReceipt({ root, phaseStatuses, receipt, pdp0ProjectionPins = pdp0PhaseScopedSourcePins() }) {
  const expectedCount = phaseStatuses.reduce((sum, status) => sum + Object.keys(status.sourceShaSet ?? {}).length, 0);
  const records = receipt?.records;
  if (!Array.isArray(records)) return { expectedCount, receiptCount: null, staleSelectors: ['MATERIAL_RECEIPT_RECORDS_MISSING'] };
  const receiptByKey = new Map(records.map(row => [`${row.phase}\u0000${row.selector}`, row]));
  const staleSelectors = [];
  for (let index = 0; index < paths.phaseStatus.length; index++) {
    const phase = paths.phaseStatus[index].phase;
    for (const [selector, expectedSha256] of Object.entries(phaseStatuses[index].sourceShaSet ?? {})) {
      const currentSha256 = selector.includes('#')
        ? (phase === 'PDP-0' ? pdp0ProjectionPins[selector] : undefined)
        : (fs.existsSync(path.join(root, selector)) ? digestFile(root, selector) : undefined);
      const current = currentSha256 ?? null;
      const record = receiptByKey.get(`${phase}\u0000${selector}`);
      if (!record || record.expectedSha256 !== expectedSha256 || record.currentSha256 !== current
          || record.status !== (current === expectedSha256 ? 'CURRENT' : 'STALE_OR_UNSUPPORTED')
          || current !== expectedSha256) {
        staleSelectors.push({ phase, selector, expectedSha256, currentSha256: current });
      }
    }
  }
  return { expectedCount, receiptCount: receipt.count ?? null, recordCount: records.length, staleSelectors };
}

function validateSourceInputs(root, workPackages, expectedIds) {
  ensure(workPackages.schemaVersion === 'media.build-work-packages.v1', 'current generated build work-package projection has an unsupported schema');
  const sourceStatusRecords = paths.phaseStatus.map(({ path: relativePath }) => json(root, relativePath));
  const receiptReadback = inspectMaterialSourceReceipt({ root, phaseStatuses: sourceStatusRecords, receipt: workPackages.materialSourceReceipt });
  ensure(receiptReadback.receiptCount === receiptReadback.expectedCount && receiptReadback.recordCount === receiptReadback.expectedCount,
    `work-package material source receipt count/records ${receiptReadback.receiptCount ?? 'UNKNOWN'}/${receiptReadback.recordCount ?? 'UNKNOWN'} differ from live phase sourceShaSet count ${receiptReadback.expectedCount}`);
  ensure(receiptReadback.staleSelectors.length === 0,
    `material receipt is stale or mismatched at ${receiptReadback.staleSelectors.length} selectors: ${receiptReadback.staleSelectors.slice(0, 20).map(row => `${row.phase}:${row.selector}`).join('; ')}`);
  const reduced = records.map(({ phase, selector, expectedSha256, currentSha256, status }) => ({ phase, selector, expectedSha256, currentSha256, status }))
    .sort((a, b) => a.phase.localeCompare(b.phase) || a.selector.localeCompare(b.selector));
  const materialPinCanonicalSha256 = sha256(JSON.stringify(reduced));
  const fullPinProjectionSha256 = sha256(JSON.stringify(records));

  ensure(workPackages.census?.surfaces?.total === 54 && workPackages.census.surfaces.physical === 26 && workPackages.census.surfaces.compositions === 7 && workPackages.census.surfaces.logical === 21, 'work-package census differs from 26/7/21 = 54');
  ensure(Array.isArray(workPackages.surfaces), 'work-package surface projection is missing');
  const workPackageIds = workPackages.surfaces.map(surface => surface.id);
  exactKeys(workPackageIds, expectedIds, 'generated work-package surface IDs');
  const typeCounts = workPackages.surfaces.reduce((counts, surface) => ({ ...counts, [surface.type]: (counts[surface.type] ?? 0) + 1 }), {});
  ensure(typeCounts.physical === 26 && typeCounts.composition === 7 && typeCounts.logical === 21, 'generated work-package surface types differ from 26/7/21');

  const sourcePins = Object.entries(workPackages.sourcePins ?? {}).sort(([a], [b]) => a.localeCompare(b));
  ensure(sourcePins.length > 0, 'generated work-package source pin map is empty');
  const sourcePinDigests = sourcePins.map(([relativePath, expectedSha256]) => {
    ensure(fs.existsSync(path.join(root, relativePath)), `pinned source is missing: ${relativePath}`);
    const currentSha256 = digestFile(root, relativePath);
    ensure(currentSha256 === expectedSha256, `generated work-package source pin is stale: ${relativePath}`);
    return { path: relativePath, sha256: currentSha256 };
  });
  return { materialPinCanonicalSha256, fullPinProjectionSha256, sourcePinDigests, typeCounts };
}

function planCriterion(root) {
  const text = read(root, paths.plan);
  const line = text.split(/\r?\n/u).find(item => item.startsWith('| `M-BLD-F00.T01` |'));
  ensure(line, 'canonical F00.T01 acceptance row is missing from the implementation plan');
  const cells = line.split('|').map(cell => cell.trim()).filter(Boolean);
  return { taskDescription: cells[1], acceptanceCriterion: cells[2] };
}

export function buildF00T01Observation({ root = process.cwd(), g0StatusPath, now = new Date() }) {
  ensure(typeof g0StatusPath === 'string' && g0StatusPath.length > 0, 'required --g0-status input is missing');
  const absoluteG0Path = path.resolve(root, g0StatusPath);
  ensure(fs.existsSync(absoluteG0Path), `G0 status input does not exist: ${absoluteG0Path}`);
  const g0Status = JSON.parse(fs.readFileSync(absoluteG0Path, 'utf8'));
  const g0Rows = validateG0(g0Status);

  const topology = json(root, paths.topology);
  const topologySet = topologyIdentities(topology);
  const expectedIds = topologySet.ids;
  const registry = yaml.parse(read(root, paths.registry));
  const registryIds = registry.surfaces?.map(surface => surface.surfaceId) ?? [];
  exactKeys(registryIds, topologySet.logicalIds, 'logical topology/registry identity set');
  const workPackages = json(root, paths.workPackages);
  const inputProof = validateSourceInputs(root, workPackages, expectedIds);
  const expectedG0Keys = expectedIds.flatMap(subjectId => PHASES.map(phase => `${subjectId}\u0000${phase}`));
  exactKeys(g0Rows.rowKeys, expectedG0Keys, 'G0 subject/phase cell set');
  exactKeys(g0Rows.progressionIds, expectedIds, 'G0 progression subject IDs');

  const matrixRecords = paths.phaseMatrices.map(({ phase, path: relativePath }) => {
    const matrix = json(root, relativePath);
    validatePhaseMatrix(matrix, phase, expectedIds);
    return { phase, path: relativePath, sha256: digestFile(root, relativePath), matrix };
  });
  const matrixRowsByPhase = new Map(matrixRecords.map(({ phase, matrix }) => [phase, new Map(matrix.surfaces.map(row => [row.surfaceId, row]))]));
  for (const g0Row of g0Status.rows) {
    const matrixRow = matrixRowsByPhase.get(g0Row.phase)?.get(g0Row.subjectId);
    ensure(matrixRow, `G0 row ${g0Row.subjectId}/${g0Row.phase} has no matching Media matrix row`);
    const value = g0Row.applicability.value;
    const matrixApplicability = matrixRow.applicability;
    ensure(value.disposition === matrixApplicability.disposition, `G0 applicability disposition disagrees with Media matrix for ${g0Row.subjectId}/${g0Row.phase}`);
    ensure(value.rationale === matrixApplicability.rationale, `G0 applicability rationale disagrees with Media matrix for ${g0Row.subjectId}/${g0Row.phase}`);
    const matrixStatus = ['NOT_APPLICABLE', 'NOT_ACTIVE_ARCHIVED'].includes(matrixRow.developmentStatus) ? 'NOT_APPLICABLE' : 'APPLICABLE';
    ensure(value.status === matrixStatus, `G0 applicability status disagrees with Media matrix for ${g0Row.subjectId}/${g0Row.phase}`);
  }
  const statusRecords = paths.phaseStatus.map(({ phase, path: relativePath }) => {
    const status = json(root, relativePath);
    ensure(status.phase === phase && status.status === 'DEV_COMPLETE', `${phase} canonical status record is not DEV_COMPLETE`);
    ensure(status.sourceShaSet && typeof status.sourceShaSet === 'object' && !Array.isArray(status.sourceShaSet), `${phase} canonical status record has no sourceShaSet map`);
    return { phase, path: relativePath, sha256: digestFile(root, relativePath), status: status.status, materialPinCount: Object.keys(status.sourceShaSet).length };
  });
  const materialPinCounts = statusRecords.reduce((counts, row) => ({ ...counts, [row.phase]: row.materialPinCount }), {});
  ensure(Object.values(materialPinCounts).reduce((a, b) => a + b, 0) === receiptReadback.expectedCount, `phase status sourceShaSet counts do not total ${receiptReadback.expectedCount}`);

  const workPackageTask = workPackages.tasks.find(task => task.id === 'M-BLD-F00.T01');
  ensure(workPackageTask?.status === 'PLANNING_RECEIPT_ONLY', 'generated F00.T01 task status is not PLANNING_RECEIPT_ONLY');
  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim() || 'DETACHED';
  const recordedAt = now.toISOString().replace(/\.\d{3}Z$/u, 'Z');
  ensure(!Number.isNaN(Date.parse(recordedAt)), 'recordedAt could not be generated as UTC');
  const relativeG0Path = path.relative(root, absoluteG0Path).split(path.sep).join('/');
  const g0RelativePath = relativeG0Path === '..' || relativeG0Path.startsWith('../') ? absoluteG0Path : relativeG0Path;
  const g0Sha256 = sha256(fs.readFileSync(absoluteG0Path));
  const topologySha256 = digestFile(root, paths.topology);
  const registrySha256 = digestFile(root, paths.registry);
  const sourceManifestSha256 = digestFile(root, paths.sourceManifest);
  const currentStatus = workPackages.materialSourceReceipt;
  const criteria = planCriterion(root);

  return {
    schemaVersion: F00_T01_SCHEMA,
    recordKind: F00_T01_RECORD_KIND,
    recordedAt,
    campaign: {
      repository: 'samujjwal/ghatana-media',
      branch,
      head: gitHead,
      macroStage: 'BUILD',
      exactSubstage: 'KDEV-STAGE-PLAN-IMPLEMENTATION',
      selectedTaskId: 'M-BLD-F00.T01',
      campaignDenominator: {
        surfaceIdentities: 54,
        physicalLeaves: topologySet.physicalIds.length,
        compositionsIncludingRoot: topologySet.compositionIds.length,
        logicalConsumers: topologySet.logicalIds.length,
        phaseSurfaceCells: 216
      }
    },
    reconciliation: {
      status: 'SOURCE_INPUTS_RECONCILED_WITH_CURRENT_G0_SOURCE_READBACK',
      claims: [
        'The exact topology identity set reconciles across physical manifest candidates, compositions including the root, logical consumers, the surface registry, generated work-package projection, all four Media phase matrices, and the supplied G0 status rows.',
        `All ${currentStatus.count} material source selectors in the generated work-package receipt are CURRENT and reconcile to their emitted expected/current digests; no stale or unsupported material selector is present.`,
        'All four phase matrices contain 54 unique source-current rows with known-zero phase-local task inventories; the supplied G0 readback reports COMPLETE and CURRENT for each of 216 subject/phase rows.',
        'The supplied G0 status is a source-development readback only. This observation does not assert method-level aggregate completion beyond the fields present in that input.'
      ],
      topology: {
        sourcePath: paths.topology,
        sha256: topologySha256,
        physicalManifestCandidates: topologySet.physicalIds.length,
        semanticCompositionsIncludingRoot: topologySet.compositionIds.length,
        logicalConsumers: topologySet.logicalIds.length,
        identityCount: expectedIds.length,
        uniqueIdentityCount: new Set(expectedIds).size,
        surfaceRegistryPath: paths.registry,
        surfaceRegistrySha256: registrySha256
      },
      phaseMatrices: matrixRecords.map(({ phase, path: relativePath, sha256: digest, matrix }) => ({
        phase,
        path: relativePath,
        sha256: digest,
        rows: matrix.surfaces.length,
        uniqueSurfaceIds: new Set(matrix.surfaces.map(row => row.surfaceId)).size,
        status: matrix.campaign.status,
        sourceCurrentness: matrix.phaseSourceCurrentness.status,
        taskInventoryKnown: matrix.surfaces.every(row => Array.isArray(row.remainingPhaseLocalTaskIds)),
        remainingPhaseLocalTaskCount: matrix.summary.remainingPhaseLocalTaskCount,
        developmentStatusCounts: matrix.surfaces.reduce((counts, row) => ({ ...counts, [row.developmentStatus]: (counts[row.developmentStatus] ?? 0) + 1 }), {})
      })),
      gtoolRowIdentityComparison: {
        localMediaPhaseCells: 216,
        g0StatusPhaseCells: g0Status.rows.length,
        uniqueLocalMediaPhaseCells: 216,
        uniqueG0StatusPhaseCells: new Set(g0Rows.rowKeys).size,
        identitySetsEqual: true
      },
      materialSourcePins: {
        status: currentStatus.status,
        count: currentStatus.count,
        staleOrUnsupportedCount: currentStatus.staleCount,
        canonicalSha256: inputProof.materialPinCanonicalSha256,
        canonicalization: 'SHA-256 of JSON.stringify over records reduced to phase, selector, expectedSha256, currentSha256, status and sorted by phase then selector.',
        phaseCounts: materialPinCounts,
        fullPinRecordsRef: `${paths.workPackages}#/materialSourceReceipt/records`,
        fullPinProjectionSha256: inputProof.fullPinProjectionSha256,
        fullPinProjectionCanonicalization: 'SHA-256 of JSON.stringify over the full materialSourceReceipt.records array in emitted order.'
      }
    },
    sourceBaseline: {
      g0Status: {
        path: g0RelativePath,
        sha256: g0Sha256,
        schemaVersion: g0Status.schemaVersion,
        recordKind: g0Status.recordKind,
        status: g0Status.status,
        selectedMethodId: g0Status.selectedMethodId,
        sourceSnapshotFingerprint: g0Status.sourceSnapshotFingerprint,
        sourceSubjectCount: g0Status.sourceSubjectCount,
        sourcePhaseCellCount: g0Status.sourcePhaseCellCount,
        nonemptyDefinitionTasks: PHASES.reduce((sum, phase) => sum + g0Status.phaseCounts[phase].nonemptyDefinitionTasks, 0),
        writesPerformed: g0Status.writesPerformed
      },
      mediaSourceManifest: { path: paths.sourceManifest, sha256: sourceManifestSha256 },
      generatedWorkPackages: { path: paths.workPackages, sha256: digestFile(root, paths.workPackages) },
      mediaSourcePins: inputProof.sourcePinDigests,
      mediaStatusRecords: statusRecords
    },
    canonicalTaskCriterion: {
      planPath: paths.plan,
      workPackageGeneratorPath: 'scripts/generate-media-build-work-packages.mjs#M-BLD-F00.T01',
      taskId: workPackageTask.id,
      title: workPackageTask.title,
      outcome: workPackageTask.outcome,
      taskDescription: criteria.taskDescription,
      acceptanceCriterionFromPlan: criteria.acceptanceCriterion,
      taskStatus: workPackageTask.status,
      taskActionableBlocker: workPackageTask.actionableBlocker
    },
    taskAndGateBoundaries: {
      gtoolMethodAggregate: {
        status: 'NOT_ASSERTED_BY_SUPPLIED_G0_STATUS_INPUT',
        meaning: 'The supplied structured phase status does not provide a separate method aggregate owner-binding result; this observation does not infer one.'
      },
      gtoolPhaseRows: {
        count: g0Status.sourcePhaseCellCount,
        completion: 'COMPLETE',
        currentness: 'CURRENT',
        phaseLocalDefinitionTasks: 0
      },
      buildTasks: ['M-BLD-F00.T01', 'M-BLD-F00.T02', 'M-BLD-F00.T03'].map(id => {
        const task = workPackages.tasks.find(row => row.id === id);
        ensure(task, `generated work-package task ${id} is missing`);
        return { id, status: task.status, boundary: task.actionableBlocker };
      }),
      sourceStatusAxes: {
        sourceDefinition: g0Status.status,
        buildImplementationStatus: g0Status.buildImplementationStatus,
        independentAcceptanceStatus: g0Status.independentAcceptanceStatus,
        nativeClosureStatus: g0Status.nativeClosureStatus,
        deliveryStatus: g0Status.deliveryStatus,
        sourceProgressionAuthority: g0Status.sourceProgressionAuthority,
        writesPerformed: g0Status.writesPerformed
      }
    },
    verification: {
      command: `node scripts/generate-media-build-f00-t01-observation.mjs --g0-status ${g0RelativePath}`,
      exitCode: 0,
      result: `PASS current G0 source rows, Media phase matrices, ${receiptReadback.expectedCount} material pins, topology set, generated projection source pins, and 54/216 denominators`,
      scope: 'Read-only F00.T01 source material and topology receipt generation; no source, status, task, owner, or authority writes.',
      testsRun: false
    },
    claimsBoundary: {
      sourceObservationOnly: true,
      authoringComplete: false,
      plannerAdmission: 'NOT_ESTABLISHED',
      taskCompletion: 'NOT_ESTABLISHED',
      nativePdpClosure: g0Status.nativeClosureStatus,
      independentAcceptance: g0Status.independentAcceptanceStatus,
      buildImplementation: g0Status.buildImplementationStatus,
      releaseQualification: 'NOT_EVALUATED',
      delivery: g0Status.deliveryStatus,
      limitations: [
        'This generated artifact is a read-only source receipt and does not establish Work Planner admission or F00.T01 task completion.',
        'The supplied G0 source-development readback does not establish independent acceptance, native PDP closure, Build implementation, release qualification, or Delivery.',
        'No source status, G0 status, work-package projection, task queue, authority, or other input file was changed by this generator.'
      ]
    }
  };
}

export function checkF00T01Observation({ root = process.cwd(), g0StatusPath, artifactPath }) {
  ensure(typeof artifactPath === 'string' && artifactPath.length > 0, 'required --artifact input is missing for --check');
  const artifactAbsolutePath = path.resolve(root, artifactPath);
  const artifact = JSON.parse(fs.readFileSync(artifactAbsolutePath, 'utf8'));
  ensure(artifact.schemaVersion === F00_T01_SCHEMA && artifact.recordKind === F00_T01_RECORD_KIND, 'artifact schema or recordKind is unexpected');
  ensure(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(artifact.recordedAt ?? '') && !Number.isNaN(Date.parse(artifact.recordedAt)), 'artifact recordedAt is missing or malformed');
  const expected = buildF00T01Observation({ root, g0StatusPath, now: new Date(artifact.recordedAt) });
  const withoutTimestamp = value => {
    const copy = structuredClone(value);
    delete copy.recordedAt;
    return copy;
  };
  ensure(JSON.stringify(withoutTimestamp(artifact)) === JSON.stringify(withoutTimestamp(expected)), 'artifact does not match current G0/source inputs');
  return artifact;
}
