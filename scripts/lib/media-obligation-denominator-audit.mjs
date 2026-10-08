import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PHASES = ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'];

const SOURCE_ENUMERATORS = [
  ['PDP-0', '.product-experience/pdp-0-product-truth/requirements.yaml', 'requirements', 'product-truth'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/states.yaml', 'stateMachines', 'state-machine'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/transitions.yaml', 'transitionRecords', 'transition'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/domain-objects.yaml', 'objects', 'domain-object'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'operations', 'operation-family'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/operations.yaml', 'individualOperationContracts.records', 'operation-family'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/relationships.yaml', 'relationships', 'relationship'],
  ['PDP-1', '.product-experience/pdp-1-domain-data/value-objects.yaml', 'values', 'value-object'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/component-contracts.yaml', 'components', 'component-contract'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/gui/layout.yaml', 'layouts', 'layout'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml', 'patterns', 'interaction-pattern'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml', 'templates', 'view-template'],
  ['PDP-2', '.product-experience/pdp-2-design-interface-system/media-token-aliases.yaml', 'aliases', 'semantic-token-alias'],
  ['PDP-3', '.product-experience/pdp-3-product-experience/journey-registry.yaml', 'journeys', 'journey-contract'],
  ['PDP-3', '.product-experience/pdp-3-product-experience/screen-registry.yaml', 'screens', 'screen-contract'],
  ['PDP-3', '.product-experience/pdp-3-product-experience/screen-registry.yaml', 'laneViews', 'screen-contract'],
];

export function enumerateExpectedMediaObligations({ root, parseYaml }) {
  const records = [];
  const issues = [];
  for (const [phase, sourcePath, collection, dimension] of SOURCE_ENUMERATORS) {
    const absolutePath = path.resolve(root, sourcePath);
    if (!fs.existsSync(absolutePath)) {
      issues.push({ code: 'SOURCE_ENUMERATION_MISSING', detail: `Cannot enumerate ${sourcePath}` });
      continue;
    }
    let document;
    try {
      const text = fs.readFileSync(absolutePath, 'utf8');
      document = sourcePath.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
    } catch (error) {
      issues.push({ code: 'SOURCE_ENUMERATION_PARSE', detail: `${sourcePath}: ${error.message}` });
      continue;
    }
    const collectionPath = collection.split('.');
    const candidates = collectionPath.reduce((value, segment) => value?.[segment], document);
    if (!Array.isArray(candidates)) {
      issues.push({ code: 'SOURCE_ENUMERATION_COLLECTION', detail: `${sourcePath} has no ${collection} array` });
      continue;
    }
    for (const record of candidates) {
      const recordId = record?.id ?? record?.machineId;
      if (typeof recordId !== 'string' || !recordId.trim()) {
        issues.push({ code: 'SOURCE_ENUMERATION_ID', detail: `${sourcePath}#/${collection} has a record without a stable ID` });
        continue;
      }
      records.push({
        phase,
        dimension,
        sourcePath,
        sourceRef: `${sourcePath}#/${collectionPath.join('/')}/${recordId}`,
        recordId,
        obligationId: `media.${phase.toLowerCase()}.requirement.${recordId.toLowerCase()}`,
        sourceSummary: record.statement ?? record.purpose ?? record.useFor ?? record.domainIntent
          ?? record.meaning ?? record.statusDimension ?? record.name ?? record.id,
      });
    }
  }
  return { records, issues };
}

function addIssue(issues, code, detail) {
  issues.push({ code, detail });
}

function resolveAnchor(document, anchor) {
  const tokens = anchor.replace(/^\//u, '').split('/').filter(Boolean)
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
  let value = document;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (Array.isArray(value)) {
      const numericIndex = Number(token);
      value = Number.isInteger(numericIndex) ? value[numericIndex]
        : value.find((item) => item?.id === `${token}/${tokens[index + 1]}`)
          ?? value.find((item) => item?.id === token || item?.key === token || item?.recordId === token
            || item?.machineId === token || item?.sourceMachineId === token);
      if (value && value.id === `${token}/${tokens[index + 1]}`) index += 1;
    } else if (value && typeof value === 'object' && value.id === `${tokens[index - 1]}/${token}`) {
      // Anchors sometimes spell a composite record ID as two path segments.
    } else value = value?.[token];
    if (value === undefined || value === null) return undefined;
  }
  return value;
}

function compareMembership(label, expectedIds, selectedIds, issues) {
  const counts = new Map();
  for (const id of selectedIds ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, count] of counts) if (count > 1) addIssue(issues, 'DUPLICATE_SELECTION', `${label} selects ${id} ${count} times`);
  const expected = new Set(expectedIds);
  const selected = new Set(counts.keys());
  for (const id of expected) if (!selected.has(id)) addIssue(issues, 'MISSING_SELECTION', `${label} omits ${id}`);
  for (const id of selected) if (!expected.has(id)) addIssue(issues, 'CONTRADICTORY_SELECTION', `${label} selects unknown or contradictory obligation ${id}`);
}

export function auditMediaObligationDenominator({ root, obligations, program, binding, surface, traceability, parseYaml }) {
  const issues = [];
  const sourceEnumeration = enumerateExpectedMediaObligations({ root, parseYaml });
  issues.push(...sourceEnumeration.issues);
  const expectedById = new Map(sourceEnumeration.records.map((record) => [record.obligationId, record]));
  const obligationBySource = new Map(obligations.map((record) => {
    const source = record?.extensions?.['media-source'];
    return [`${source?.sourceRef ?? ''}|${source?.recordId ?? ''}`, record];
  }));
  for (const expected of sourceEnumeration.records) {
    const record = obligationBySource.get(`${expected.sourceRef}|${expected.recordId}`);
    if (!record) addIssue(issues, 'MISSING_SOURCE_OBLIGATION', `${expected.obligationId} is missing for ${expected.sourceRef}`);
    else if (record.id !== expected.obligationId || record.dimension !== expected.dimension) {
      addIssue(issues, 'SOURCE_OBLIGATION_MISMATCH', `${expected.sourceRef} expects ${expected.obligationId} (${expected.dimension}), found ${record.id} (${record.dimension})`);
    }
  }
  for (const record of obligations) {
    const source = record?.extensions?.['media-source'];
    const sourcePath = source?.sourceRef?.split('#')[0];
    if (SOURCE_ENUMERATORS.some(([, candidatePath]) => candidatePath === sourcePath)
      && !expectedById.has(record.id)) {
      addIssue(issues, 'CONTRADICTORY_SOURCE_OBLIGATION', `${record.id} does not resolve to an enumerated source record`);
    }
  }

  const ids = obligations.map((record) => record?.id).filter(Boolean);
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, count] of counts) if (count > 1) addIssue(issues, 'DUPLICATE_ID', `${id} occurs ${count} times`);
  for (let i = 0; i < obligations.length; i += 1) {
    const record = obligations[i];
    if (!record?.id) addIssue(issues, 'MISSING_ID', `obligation index ${i} has no ID`);
    if (record?.disposition !== 'REQUIRED') addIssue(issues, 'DISPOSITION', `${record?.id ?? `index ${i}`} has disposition ${String(record?.disposition)}; exactly one REQUIRED disposition is expected in this source set`);
    if (record?.disposition === undefined) addIssue(issues, 'MISSING_DISPOSITION', `${record?.id ?? `index ${i}`} has no disposition`);
    const applicable = record?.phaseSemantics?.applicableIn ?? [];
    const phase = record?.id?.match(/^media\.(pdp-[0-3])\./u)?.[1]?.toUpperCase();
    if (applicable.length !== 1 || applicable[0] !== phase) {
      addIssue(issues, 'CONTRADICTORY_PHASE', `${record?.id ?? `index ${i}`} phase ID=${phase ?? 'unknown'} applicableIn=${JSON.stringify(applicable)}`);
    }
    for (const field of ['blockingIn', 'affects']) {
      const values = record?.phaseSemantics?.[field] ?? [];
      if (!Array.isArray(values) || values.some((value) => !PHASES.includes(value))) {
        addIssue(issues, 'CONTRADICTORY_PHASE', `${record?.id ?? `index ${i}`} has invalid ${field}=${JSON.stringify(values)}`);
      }
    }
  }

  const expectedIdsByPhase = Object.fromEntries(PHASES.map((phase) => [phase,
    sourceEnumeration.records.filter((record) => record.phase === phase).map((record) => record.obligationId)]));
  const expectedPhaseCounts = Object.fromEntries(PHASES.map((phase) => [phase, expectedIdsByPhase[phase].length]));
  const phaseCounts = Object.fromEntries(PHASES.map((phase) => [phase,
    obligations.filter((record) => record?.phaseSemantics?.applicableIn?.length === 1 && record.phaseSemantics.applicableIn[0] === phase).length]));
  for (const [phase, expected] of Object.entries(expectedPhaseCounts)) {
    if (phaseCounts[phase] !== expected) addIssue(issues, 'PHASE_COUNT', `${phase} count ${phaseCounts[phase]} != source-enumerated ${expected}`);
  }
  if (obligations.length !== sourceEnumeration.records.length) {
    addIssue(issues, 'TOTAL_COUNT', `total ${obligations.length} != source-enumerated ${sourceEnumeration.records.length}`);
  }

  const selectedByPhase = Object.fromEntries(PHASES.map((phase) => [phase,
    expectedIdsByPhase[phase]]));
  for (const phase of PHASES) {
    compareMembership(`phase-program ${phase}`, selectedByPhase[phase], program?.phases?.find((item) => item.id === phase)?.obligationIds, issues);
    compareMembership(`phase-binding ${phase}`, selectedByPhase[phase], binding?.phases?.[phase]?.obligationIds, issues);
  }
  compareMembership('closure-surface', sourceEnumeration.records.map((record) => record.obligationId), surface?.obligationIds, issues);

  const sourceHashes = {};
  const sourceDocuments = new Map();
  let resolvedSourceRefs = 0;
  let unresolvedSourceRefs = 0;
  const fingerprintComparisons = { present: 0, matching: 0, stale: 0, absent: 0 };
  for (const record of obligations) {
    const source = record?.extensions?.['media-source'];
    if (!source?.sourceRef || !source?.recordId) {
      unresolvedSourceRefs += 1;
      addIssue(issues, 'MISSING_SOURCE_REF', `${record?.id ?? 'unknown'} lacks sourceRef or recordId`);
      continue;
    }
    const hashAt = source.sourceRef.indexOf('#');
    const relativePath = hashAt < 0 ? source.sourceRef : source.sourceRef.slice(0, hashAt);
    const anchor = hashAt < 0 ? '' : decodeURIComponent(source.sourceRef.slice(hashAt + 1));
    const absolutePath = path.resolve(root, relativePath);
    if (!fs.existsSync(absolutePath)) {
      unresolvedSourceRefs += 1;
      addIssue(issues, 'UNRESOLVED_SOURCE', `${record.id} source file missing: ${relativePath}`);
      continue;
    }
    let sourceEntry = sourceDocuments.get(relativePath);
    if (!sourceEntry) {
      const text = fs.readFileSync(absolutePath, 'utf8');
      sourceEntry = {
        digest: `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`,
        document: undefined,
        parseError: undefined,
      };
      try { sourceEntry.document = relativePath.endsWith('.json') ? JSON.parse(text) : parseYaml(text); }
      catch (error) { sourceEntry.parseError = error; }
      sourceDocuments.set(relativePath, sourceEntry);
      sourceHashes[relativePath] = sourceEntry.digest;
    }
    const { digest } = sourceEntry;
    if (sourceEntry.parseError) {
      unresolvedSourceRefs += 1;
      addIssue(issues, 'SOURCE_PARSE', `${record.id} cannot parse ${relativePath}: ${sourceEntry.parseError.message}`);
      continue;
    }
    const resolved = anchor ? resolveAnchor(sourceEntry.document, anchor) : sourceEntry.document;
    const resolvedId = resolved?.id ?? resolved?.requirementId ?? resolved?.key ?? resolved?.recordId
      ?? resolved?.machineId ?? resolved?.sourceMachineId;
    if (!resolved || (resolvedId !== undefined && resolvedId !== source.recordId)) {
      unresolvedSourceRefs += 1;
      addIssue(issues, 'SOURCE_REFERENCE_MISMATCH', `${record.id} ${source.sourceRef} did not resolve recordId ${source.recordId}${resolvedId ? ` (found ${resolvedId})` : ''}`);
      continue;
    }
    resolvedSourceRefs += 1;
    const expectedFingerprint = source.sourceDigest;
    if (expectedFingerprint) {
      fingerprintComparisons.present += 1;
      if (expectedFingerprint === digest) fingerprintComparisons.matching += 1;
      else {
        fingerprintComparisons.stale += 1;
        addIssue(issues, 'STALE_SOURCE_FINGERPRINT', `${record.id} expected ${expectedFingerprint}, observed ${digest}`);
      }
    } else {
      fingerprintComparisons.absent += 1;
      addIssue(issues, 'MISSING_SOURCE_FINGERPRINT', `${record.id} has no persisted sourceDigest`);
    }
  }
  if (!traceability || traceability.status !== 'partial-authored-links; independent-P0-010-semantic-closure-pending') {
    addIssue(issues, 'TRACEABILITY_STATE', 'traceability source is missing or no longer declares partial authored links / pending independent review');
  }
  return {
    status: issues.length === 0 ? 'DENOMINATOR_AND_MEMBERSHIP_CHECKED_SOURCE_SEMANTIC_ACCEPTANCE_PENDING' : 'AUDIT_FINDINGS',
    total: obligations.length,
    uniqueIds: counts.size,
    phaseCounts,
    expectedPhaseCounts,
    sourceEnumeration: { total: sourceEnumeration.records.length, phaseCounts: expectedPhaseCounts },
    dispositionRecords: obligations.filter((record) => record?.disposition === 'REQUIRED').length,
    sourceReferences: { total: obligations.length, resolved: resolvedSourceRefs, unresolved: unresolvedSourceRefs },
    sourceFingerprints: { algorithm: 'sha256', files: sourceHashes, comparison: fingerprintComparisons,
      note: 'Persisted sourceDigest values are compared with the current source file hashes.' },
    traceability: { status: traceability?.status ?? 'MISSING', completeness: traceability?.coverageSemantics?.completeness ?? 'UNKNOWN', independentReviewRequired: traceability?.coverageSemantics?.independentReviewRequired ?? null },
    authoritativeObserverAssignments: obligations.filter((record) => record?.observerIds?.length).length,
    authoritativeOracleAssignments: obligations.filter((record) => record?.oracleIds?.length).length,
    issues,
  };
}
