import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { enumerateExpectedMediaObligations } from './media-obligation-denominator-audit.mjs';
import { MEDIA_SOURCE_PDP_PHASES, readMediaSourcePhaseMapping } from './media-closure-phase-map.mjs';

const CLOSURE_BASE = 'config/closure/media-product-definition';
const TOPOLOGY_REF = '.product-experience/surfaces/media-physical-topology.v1.json';
const MATRIX_REFS = Object.fromEntries(MEDIA_SOURCE_PDP_PHASES.map((phase, index) => [
  phase, `docs/implementation/verification/pdp-38/pdp${index}-surface-phase-status-matrix.json`,
]));
const hashFile = (root, relativePath) => `sha256:${crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(root, relativePath))).digest('hex')}`;
const fileOf = (reference) => reference.split('#')[0];

export function buildMediaW3SourceCaseMap({ root, parseYaml }) {
  const readJson = (ref) => JSON.parse(fs.readFileSync(path.join(root, ref), 'utf8'));
  const digestCache = new Map();
  const digestFile = (relativePath) => {
    if (!digestCache.has(relativePath)) digestCache.set(relativePath, hashFile(root, relativePath));
    return digestCache.get(relativePath);
  };
  const topology = readJson(TOPOLOGY_REF);
  const obligations = readJson(`${CLOSURE_BASE}/obligations.json`);
  const linkProposal = readJson(`${CLOSURE_BASE}/l02-source-case-links.json`);
  const program = readJson(`${CLOSURE_BASE}/phase-program.json`);
  const matrices = Object.fromEntries(MEDIA_SOURCE_PDP_PHASES.map((phase) => [phase, readJson(MATRIX_REFS[phase])]));
  const sourcePhaseToClosurePhaseId = readMediaSourcePhaseMapping(program);
  const closurePhaseToSourcePhase = new Map(Object.entries(sourcePhaseToClosurePhaseId)
    .map(([sourcePhase, closurePhase]) => [closurePhase, sourcePhase]));
  const enumeration = enumerateExpectedMediaObligations({ root, parseYaml });
  if (enumeration.issues.length) {
    throw new Error(`W3 source map cannot enumerate current obligations: ${JSON.stringify(enumeration.issues)}`);
  }
  const expectedById = new Map(enumeration.records.map((row) => [row.obligationId, row]));
  const obligationById = new Map(obligations.map((row) => [row.id, row]));
  if (obligationById.size !== obligations.length) throw new Error('W3 source map found duplicate persisted obligation IDs');
  if (obligationById.size !== expectedById.size) throw new Error('W3 source map persisted obligation denominator does not match current enumeration');

  const sourceObligations = obligations.map((obligation) => {
    const expected = expectedById.get(obligation.id);
    const source = obligation.extensions?.['media-source'];
    const sourcePhase = closurePhaseToSourcePhase.get(obligation.phaseSemantics?.applicableIn?.[0]);
    if (!expected || !source?.sourceRef || !sourcePhase) {
      throw new Error(`W3 source map missing source/phase join for ${obligation.id}`);
    }
    if (expected.phase !== sourcePhase || expected.sourceRef !== source.sourceRef
      || expected.recordId !== source.recordId || !obligation.requirementIds?.includes(source.recordId)) {
      throw new Error(`W3 source map has invalid source/phase/applicability join for ${obligation.id}`);
    }
    const sourceDigest = digestFile(fileOf(source.sourceRef));
    if (source.sourceDigest !== sourceDigest) throw new Error(`W3 stale source pin for ${obligation.id}`);
    return {
      obligationId: obligation.id,
      sourcePhase,
      sourceRef: source.sourceRef,
      sourceDigest,
    };
  }).sort((left, right) => left.obligationId.localeCompare(right.obligationId));

  const p0Links = linkProposal.candidateLinks.filter((link) => link.obligationId.startsWith('media.pdp-0.'));
  if (linkProposal.candidateLinks.length !== 65 || linkProposal.unmappedObligationIds.length !== 8620) {
    throw new Error('W3 incumbent L02 denominator changed; reconcile the current source case-link artifact first');
  }
  const p0LinkKeys = new Set(p0Links.map((link) => `${link.obligationId}\0${link.caseId}`));
  const sourceRecordIds = new Set(sourceObligations.filter((row) => row.sourcePhase === 'PDP-0')
    .map((row) => obligationById.get(row.obligationId).extensions['media-source'].recordId));
  const topologyCandidateRows = topology.manifestCandidates.map((surface, index) => ({
    surfaceId: surface.surfaceId,
    surfaceType: 'PHYSICAL',
    topologyRef: `${TOPOLOGY_REF}#/manifestCandidates/${index}`,
    phaseApplicability: surface.phaseApplicability ?? {},
  }));
  const topologyRows = [
    ...topologyCandidateRows,
    ...(topology.compositions ?? []).map((surface, index) => ({
      surfaceId: surface.surfaceId,
      surfaceType: surface.kind === 'REPOSITORY_ROOT' ? 'ROOT' : 'COMPOSITION',
      topologyRef: `${TOPOLOGY_REF}#/compositions/${index}`,
      phaseApplicability: surface.phaseApplicability ?? {},
    })),
    ...(topology.consumerCrosswalk ?? []).map((surface, index) => ({
      surfaceId: surface.surfaceId,
      surfaceType: 'LOGICAL',
      topologyRef: `${TOPOLOGY_REF}#/consumerCrosswalk/${index}`,
      phaseApplicability: {},
    })),
  ];
  const surfaceIds = topologyRows.map(({ surfaceId }) => surfaceId);
  if (new Set(surfaceIds).size !== 54) throw new Error(`W3 source map expected 54 unique source identities, found ${new Set(surfaceIds).size}`);
  const matrixRowsByPhase = {};
  const matrixIndicesByPhase = {};
  for (const phase of MEDIA_SOURCE_PDP_PHASES) {
    const rows = matrices[phase].surfaces ?? [];
    const rowById = new Map(rows.map((row) => [row.surfaceId, row]));
    if (rows.length !== 54 || rowById.size !== 54
      || surfaceIds.some((surfaceId) => !rowById.has(surfaceId))) {
      throw new Error(`W3 ${phase} matrix must preserve exactly the current 54 topology identities`);
    }
    if (rows.some((row) => row.phase !== phase)) throw new Error(`W3 ${phase} matrix contains an invalid phase row`);
    if (matrices[phase].phaseSourceCurrentness?.status !== 'CURRENT'
      || matrices[phase].phaseSourceCurrentness?.staleSourcePinCount !== 0) {
      throw new Error(`W3 ${phase} surface matrix is not source-current`);
    }
    if (rows.some((row) => row.sourceCurrent !== true || !row.applicability?.disposition
      || !Array.isArray(row.sourceRefs))) {
      throw new Error(`W3 ${phase} matrix has a missing source-current/applicability/reference cell`);
    }
    matrixRowsByPhase[phase] = rowById;
    matrixIndicesByPhase[phase] = new Map(rows.map((row, index) => [row.surfaceId, index]));
  }

  const directMatchesByRecordId = new Map();
  for (const [surfaceId, matrixRow] of matrixRowsByPhase['PDP-0']) {
    const applicability = matrixRow.applicability;
    for (const sourceField of ['requirementRefs', 'capabilityIntentRefs', 'intentRefs', 'capabilityFamilyIds']) {
      for (const recordId of matrixRow[sourceField] ?? []) {
        if (!sourceRecordIds.has(recordId)) continue;
        const joins = directMatchesByRecordId.get(recordId) ?? [];
        const join = joins.find((entry) => entry.surfaceId === surfaceId);
        if (join) join.matchedFields.push(sourceField);
        else joins.push({
          surfaceId,
          surfaceType: matrixRow.surfaceType,
          applicabilityDisposition: applicability?.disposition ?? 'UNKNOWN',
          matrixRef: MATRIX_REFS['PDP-0'],
          matrixDigest: digestFile(MATRIX_REFS['PDP-0']),
          matrixRowRef: `${MATRIX_REFS['PDP-0']}#/surfaces/${matrixIndicesByPhase['PDP-0'].get(surfaceId)}`,
          matchedFields: [sourceField],
        });
        directMatchesByRecordId.set(recordId, joins);
      }
    }
  }

  const p0Obligations = obligations.filter((obligation) =>
    closurePhaseToSourcePhase.get(obligation.phaseSemantics?.applicableIn?.[0]) === 'PDP-0');
  const yamlCache = new Map();
  const readYaml = (relativePath) => {
    if (!yamlCache.has(relativePath)) yamlCache.set(relativePath,
      parseYaml(fs.readFileSync(path.join(root, relativePath), 'utf8')));
    return yamlCache.get(relativePath);
  };
  const openSlots = p0Obligations.map((obligation) => {
    const source = obligation.extensions['media-source'];
    const matches = directMatchesByRecordId.get(source.recordId) ?? [];
    const exactLinks = linkProposal.candidateLinks.filter((link) => link.obligationId === obligation.id
      && obligation.caseIds?.includes(link.caseId));
    const sourceCaseIds = obligation.caseIds ?? [];
    const sourceFile = fileOf(source.sourceRef);
    if (sourceCaseIds.length) {
      const sourceRecord = readYaml(sourceFile).requirements?.find(({ id }) => id === source.recordId);
      const declaredCaseIds = new Set((sourceRecord?.acceptanceCases ?? []).map(({ id }) => id));
      if (!sourceRecord || sourceCaseIds.some((caseId) => !declaredCaseIds.has(caseId))) {
        throw new Error(`W3 source case join missing from current PDP-0 source: ${obligation.id}`);
      }
    }
    const blockers = ['CLOSURE_SURFACE_ASSIGNMENT_UNRESOLVED', 'NATIVE_CLOSURE_SURFACE_NOT_ADMITTED'];
    if (matches.length === 0) blockers.push('SOURCE_SURFACE_JOIN_MISSING');
    if (matches.length > 1) blockers.push('SOURCE_SURFACE_JOIN_AMBIGUOUS');
    if (sourceCaseIds.length === 0) blockers.push('SOURCE_CASE_ID_MISSING');
    if (exactLinks.length === 0) blockers.push('EXECUTABLE_CASE_JOIN_MISSING');
    return {
      obligationId: obligation.id,
      phase: 'PDP-0',
      sourceRef: source.sourceRef,
      sourceDigest: digestFile(fileOf(source.sourceRef)),
      sourceRecordId: source.recordId,
      sourceSurfaceCandidates: matches,
      surfaceJoinStatus: matches.length === 0 ? 'NO_DIRECT_SOURCE_REFERENCE_MATCH'
        : matches.length === 1 ? 'ONE_DIRECT_SOURCE_REFERENCE_MATCH_NOT_OWNER_ASSIGNMENT'
          : 'MULTIPLE_DIRECT_SOURCE_REFERENCE_MATCHES_NOT_OWNER_ASSIGNMENT',
      sourceCaseIds,
      sourceCaseRefs: sourceCaseIds.map((caseId) =>
        `${sourceFile}#requirements/@id=${source.recordId}/acceptanceCases/@id=${caseId}`),
      l02CandidateLinks: exactLinks.map(({ caseId, testIdentity, scope, admission, method }) => ({
        caseId, testIdentity, scope, admission, method,
      })),
      closureSurfaceId: null,
      closureSurfaceDisposition: 'NOT_ADJUDICATED',
      mappingStatus: exactLinks.length ? 'PARTIAL_CANDIDATE_JOIN' : 'OPEN_UNMAPPED',
      blockers,
    };
  }).sort((left, right) => left.obligationId.localeCompare(right.obligationId));

  const phaseDenominators = MEDIA_SOURCE_PDP_PHASES.map((phase) => {
    const phaseRows = sourceObligations.filter((row) => row.sourcePhase === phase);
    return {
      phase,
      closurePhaseId: sourcePhaseToClosurePhaseId[phase],
      obligationCount: phaseRows.length,
      obligationIds: phaseRows.map(({ obligationId }) => obligationId),
      caseMapDisposition: phase === 'PDP-0' ? 'SELECTED_OPEN_MAPPING' : 'DEFERRED_PHASE_LOCAL_MAPPING_UNCHANGED',
      l02CandidateLinkCount: linkProposal.candidateLinks.filter((link) =>
        obligationById.get(link.obligationId)?.phaseSemantics?.applicableIn?.[0] === sourcePhaseToClosurePhaseId[phase]).length,
      l02CandidateLinkedObligationCount: new Set(linkProposal.candidateLinks.filter((link) =>
        obligationById.get(link.obligationId)?.phaseSemantics?.applicableIn?.[0] === sourcePhaseToClosurePhaseId[phase])
        .map(({ obligationId }) => obligationId)).size,
      matrixRef: MATRIX_REFS[phase],
      matrixDigest: digestFile(MATRIX_REFS[phase]),
      matrixPhaseSourceCurrentness: matrices[phase].phaseSourceCurrentness,
    };
  });

  const sourceIdentityRows = topologyRows.map((surface) => ({
    surfaceId: surface.surfaceId,
    surfaceType: surface.surfaceType,
    topologyRef: surface.topologyRef,
    topologyDigest: digestFile(TOPOLOGY_REF),
    phaseCells: Object.fromEntries(MEDIA_SOURCE_PDP_PHASES.map((phase) => {
      const matrix = matrices[phase];
      const matrixRow = matrixRowsByPhase[phase].get(surface.surfaceId);
      return [phase, {
        phase,
        matrixRef: MATRIX_REFS[phase],
        matrixDigest: digestFile(MATRIX_REFS[phase]),
        matrixRowRef: `${MATRIX_REFS[phase]}#/surfaces/${matrixIndicesByPhase[phase].get(surface.surfaceId)}`,
        applicability: matrixRow.applicability,
        sourceRefs: matrixRow.sourceRefs,
        sourceCurrent: matrixRow.sourceCurrent,
        sourceCurrentBasis: matrixRow.sourceCurrentBasis,
        developmentStatus: matrixRow.developmentStatus,
        remainingPhaseLocalTaskIds: matrixRow.remainingPhaseLocalTaskIds,
        sourceCaseMapStatus: phase === 'PDP-0' ? 'OPEN_SOURCE_CASE_JOIN' : 'DEFERRED_PHASE_LOCAL_MAPPING_UNCHANGED',
      }];
    })),
  })).sort((left, right) => left.surfaceId.localeCompare(right.surfaceId));
  const sourceIdentitySubtypes = {
    physical: sourceIdentityRows.filter(({ surfaceType }) => surfaceType === 'PHYSICAL').length,
    intermediateCompositions: sourceIdentityRows.filter(({ surfaceType }) => surfaceType === 'COMPOSITION').length,
    rootAggregates: sourceIdentityRows.filter(({ surfaceType }) => surfaceType === 'ROOT').length,
    logical: sourceIdentityRows.filter(({ surfaceType }) => surfaceType === 'LOGICAL').length,
  };
  if (JSON.stringify(sourceIdentitySubtypes) !== JSON.stringify({
    physical: 26, intermediateCompositions: 6, rootAggregates: 1, logical: 21,
  })) throw new Error(`W3 source identity type denominator mismatch: ${JSON.stringify(sourceIdentitySubtypes)}`);

  const p0LinkedObligationIds = new Set(p0Links.map(({ obligationId }) => obligationId));
  const p0OpenSlotsById = new Map(openSlots.map((slot) => [slot.obligationId, slot]));
  if (p0OpenSlotsById.size !== 4028) throw new Error(`PDP-0 open-slot denominator mismatch: ${p0OpenSlotsById.size}`);
  return {
    schemaVersion: 'media.w3-source-case-map.v1',
    recordKind: 'SOURCE_MAPPING_BACKLOG_NOT_LIFECYCLE_ADMISSION',
    campaign: {
      sourceIdentityCount: sourceIdentityRows.length,
      sourceIdentityKinds: { physical: 26, compositions: 7, logical: 21 },
      sourceIdentitySubtypes,
      obligationCount: sourceObligations.length,
      selectedPhase: 'PDP-0',
      sourcePhaseToClosurePhaseId,
    },
    inputFingerprints: Object.fromEntries([
      TOPOLOGY_REF,
      `${CLOSURE_BASE}/phase-program.json`,
      `${CLOSURE_BASE}/obligations.json`,
      `${CLOSURE_BASE}/l02-source-case-links.json`,
      ...Object.values(MATRIX_REFS),
    ].map((ref) => [ref, digestFile(ref)])),
    incumbentL02: {
      status: linkProposal.status,
      candidateLinkCount: linkProposal.candidateLinks.length,
      linkedObligationCount: new Set(linkProposal.candidateLinks.map(({ obligationId }) => obligationId)).size,
      unmappedObligationCount: linkProposal.unmappedObligationIds.length,
    },
    phaseDenominators,
    sourceIdentityRows,
    sourceObligations,
    pdp0CaseMap: {
      obligationCount: openSlots.length,
      candidateLinkCount: p0Links.length,
      candidateLinkedObligationCount: p0LinkedObligationIds.size,
      openSlotCount: openSlots.filter((slot) => slot.mappingStatus === 'OPEN_UNMAPPED').length,
      openSlots,
    },
    nativeAdmission: 'NOT_ISSUED',
    nativeReceipts: 0,
  };
}

export function validateMediaW3SourceCaseMap(record, { root, parseYaml, expected: expectedInput }) {
  const obligationIds = record?.pdp0CaseMap?.openSlots?.map(({ obligationId }) => obligationId) ?? [];
  if (new Set(obligationIds).size !== obligationIds.length) throw new Error('W3 duplicate PDP-0 obligation join');
  if (obligationIds.length !== 4028) throw new Error(`W3 missing PDP-0 obligation joins: expected 4028, received ${obligationIds.length}`);
  const expected = expectedInput ?? buildMediaW3SourceCaseMap({ root, parseYaml });
  const expectedById = new Map(expected.pdp0CaseMap.openSlots.map((slot) => [slot.obligationId, slot]));
  for (const slot of record.pdp0CaseMap.openSlots) {
    const target = expectedById.get(slot.obligationId);
    if (!target || slot.phase !== 'PDP-0' || slot.sourceRef !== target.sourceRef
      || slot.sourceDigest !== target.sourceDigest) throw new Error(`W3 stale/invalid source pin or phase applicability: ${slot.obligationId}`);
    if (JSON.stringify(slot.sourceSurfaceCandidates) !== JSON.stringify(target.sourceSurfaceCandidates)) {
      throw new Error(`W3 invalid source-surface applicability join: ${slot.obligationId}`);
    }
    if (JSON.stringify(slot.sourceCaseIds) !== JSON.stringify(target.sourceCaseIds)
      || JSON.stringify(slot.l02CandidateLinks) !== JSON.stringify(target.l02CandidateLinks)
      || slot.closureSurfaceId !== null || slot.closureSurfaceDisposition !== 'NOT_ADJUDICATED') {
      throw new Error(`W3 invalid/missing case join: ${slot.obligationId}`);
    }
  }
  if (JSON.stringify(record) !== JSON.stringify(expected)) throw new Error('W3 case-map projection is stale or non-deterministic');
  return [];
}

export function parseMediaW3YamlFromWorkspace(root) {
  const require = createRequire(path.resolve(root, '../ghatana-tools/package.json'));
  return require('yaml').parse;
}
