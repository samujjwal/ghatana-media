import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const EXPECTED_PHASE_COUNTS = { 'PDP-0': 38, 'PDP-1': 130, 'PDP-2': 74, 'PDP-3': 77 };
const PHASES = Object.keys(EXPECTED_PHASE_COUNTS);

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

  const phaseCounts = Object.fromEntries(PHASES.map((phase) => [phase,
    obligations.filter((record) => record?.phaseSemantics?.applicableIn?.length === 1 && record.phaseSemantics.applicableIn[0] === phase).length]));
  for (const [phase, expected] of Object.entries(EXPECTED_PHASE_COUNTS)) {
    if (phaseCounts[phase] !== expected) addIssue(issues, 'PHASE_COUNT', `${phase} count ${phaseCounts[phase]} != expected ${expected}`);
  }
  if (obligations.length !== 319) addIssue(issues, 'TOTAL_COUNT', `total ${obligations.length} != expected 319`);

  const selectedByPhase = Object.fromEntries(PHASES.map((phase) => [phase,
    obligations.filter((record) => record?.phaseSemantics?.applicableIn?.includes(phase)).map((record) => record.id)]));
  for (const phase of PHASES) {
    compareMembership(`phase-program ${phase}`, selectedByPhase[phase], program?.phases?.find((item) => item.id === phase)?.obligationIds, issues);
    compareMembership(`phase-binding ${phase}`, selectedByPhase[phase], binding?.phases?.[phase]?.obligationIds, issues);
  }
  compareMembership('closure-surface', ids, surface?.obligationIds, issues);

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
    expectedPhaseCounts: EXPECTED_PHASE_COUNTS,
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
