#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { enumerateExpectedMediaObligations } from './lib/media-obligation-denominator-audit.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootIndex = process.argv.indexOf('--root');
const root = path.resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : repositoryRoot);
const requireTools = createRequire(path.resolve(repositoryRoot, '../ghatana-tools/package.json'));
const { parse } = requireTools('yaml');
const base = 'config/closure/media-product-definition';
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const writeJson = (relativePath, value) => fs.writeFileSync(
  path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (relativePath) => `sha256:${crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(root, relativePath))).digest('hex')}`;
const fileAtRef = (reference) => reference.split('#')[0];

const enumeration = enumerateExpectedMediaObligations({ root, parseYaml: parse });
if (enumeration.issues.length) {
  throw new Error(`Cannot enumerate closure source inputs: ${JSON.stringify(enumeration.issues)}`);
}
const obligations = readJson(`${base}/obligations.json`);
const seenSources = new Set();
const seenObligationIds = new Set();
for (const expected of enumeration.records) {
  const sourceKey = `${expected.sourceRef}|${expected.recordId}`;
  if (seenSources.has(sourceKey)) throw new Error(`Duplicate enumerated source identity: ${sourceKey}`);
  seenSources.add(sourceKey);
  if (seenObligationIds.has(expected.obligationId)) throw new Error(`Duplicate enumerated obligation identity: ${expected.obligationId}`);
  seenObligationIds.add(expected.obligationId);
}
const duplicateObligationIds = obligations.map(({ id }) => id)
  .filter((id, index, values) => values.indexOf(id) !== index);
if (duplicateObligationIds.length) throw new Error(`Duplicate persisted obligation IDs: ${[...new Set(duplicateObligationIds)].join(', ')}`);
const existingBySource = new Map(obligations.map((item) => {
  const source = item.extensions?.['media-source'];
  return [`${source?.sourceRef ?? ''}|${source?.recordId ?? ''}`, item];
}));
if (existingBySource.size !== obligations.filter((item) => item.extensions?.['media-source']?.sourceRef).length) {
  throw new Error('Duplicate persisted source identity in obligation records');
}
const existingIds = new Set(obligations.map(({ id }) => id));
const additions = [];
for (const expected of enumeration.records) {
  const key = `${expected.sourceRef}|${expected.recordId}`;
  if (existingBySource.has(key)) continue;
  if (existingIds.has(expected.obligationId)) {
    throw new Error(`Source obligation identity conflict for ${expected.obligationId}`);
  }
  additions.push({
    schemaVersion: 'ghatana.assurance.obligation',
    id: expected.obligationId,
    closureSurfaceId: 'media.product-definition',
    dimension: expected.dimension,
    statement: `Review and establish the canonical ${expected.phase} source obligation for ${expected.recordId}; source proposal: ${String(expected.sourceSummary).replace(/\s+/gu, ' ').trim()}.`,
    disposition: 'REQUIRED',
    programId: 'media.product-definition.v1',
    phaseSemantics: {
      applicableIn: [expected.phase],
      blockingIn: [expected.phase],
      affects: [expected.phase],
    },
    caseIds: [],
    observerIds: [],
    oracleIds: [],
    requirementIds: [expected.recordId],
    extensions: {
      'media-source': {
        sourceRef: expected.sourceRef,
        recordId: expected.recordId,
        sourceDigest: digest(fileAtRef(expected.sourceRef)),
      },
    },
  });
}

const expectedIdsByPhase = Object.fromEntries(['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'].map((phase) => [
  phase, enumeration.records.filter((record) => record.phase === phase)
    .map((record) => record.obligationId).sort(),
]));
for (const item of obligations) {
  const source = item.extensions?.['media-source'];
  if (source?.sourceRef) source.sourceDigest = digest(fileAtRef(source.sourceRef));
}
const merged = [...obligations, ...additions].sort((left, right) => left.id.localeCompare(right.id));

const program = readJson(`${base}/phase-program.json`);
for (const phase of program.phases) phase.obligationIds = expectedIdsByPhase[phase.id] ?? [];
const binding = readJson(`${base}/phase-binding.json`);
for (const phase of Object.keys(binding.phases)) binding.phases[phase].obligationIds = expectedIdsByPhase[phase] ?? [];
const surface = readJson(`${base}/surface.json`);
surface.obligationIds = Object.values(expectedIdsByPhase).flat().sort();

const l02 = readJson(`${base}/l02-source-case-links.json`);
const linkedIds = new Set(l02.candidateLinks.map(({ obligationId }) => obligationId));
const allIds = Object.values(expectedIdsByPhase).flat().sort();
l02.obligationIds = allIds;
l02.unmappedObligationIds = allIds.filter((id) => !linkedIds.has(id));

const l03 = readJson(`${base}/l03-proof-route-candidates.json`);
l03.l02CaseLinkReview.obligationDenominator = allIds.length;
l03.l02CaseLinkReview.unmappedObligationCount = l02.unmappedObligationIds.length;
l03.l02CaseLinkReview.authoritativeAssignments = `UNCHANGED_ZERO_OF_${allIds.length}`;
for (const route of l03.routes) {
  const observerPath = fileAtRef(route.candidateObserver.sourceRef);
  const criteriaPath = fileAtRef(route.candidateOracle.sourceRef);
  const testPath = route.candidateOracle.testIdentity;
  const currentDigests = {
    producer: digest(observerPath),
    criteria: digest(criteriaPath),
    test: digest(testPath),
  };
  const previousDigests = route.sourceDigests ?? {};
  const changed = Object.keys(currentDigests).some((key) => currentDigests[key] !== previousDigests[key]);
  if (changed) {
    route.sourceDigestHistory ??= [];
    const historyEntry = { recordedAt: '2026-10-08', sourceDigests: previousDigests, status: 'SUPERSEDED_SOURCE_FINGERPRINTS' };
    if (Object.keys(previousDigests).length && !route.sourceDigestHistory.some((entry) => JSON.stringify(entry) === JSON.stringify(historyEntry))) {
      route.sourceDigestHistory.push(historyEntry);
    }
    route.candidateOracle.resultCriteria.executionState = 'NOT_RUN_SOURCE_CHANGED';
    route.rerunRequired = true;
  }
  route.sourceDigests = currentDigests;
}

const outputs = new Map([
  [`${base}/obligations.json`, merged],
  [`${base}/phase-program.json`, program],
  [`${base}/phase-binding.json`, binding],
  [`${base}/surface.json`, surface],
  [`${base}/l02-source-case-links.json`, l02],
  [`${base}/l03-proof-route-candidates.json`, l03],
]);
const drift = [...outputs].filter(([relativePath, value]) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8') !== stableJson(value));
if (process.argv.includes('--check')) {
  if (drift.length) {
    console.error(`Lifecycle source-input drift: ${drift.map(([relativePath]) => relativePath).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('Lifecycle source inputs are current.');
  }
} else {
  for (const [relativePath, value] of drift) writeJson(relativePath, value);
}

console.log(JSON.stringify({
  generatedObligations: additions.length,
  denominator: merged.length,
  phaseCounts: Object.fromEntries(Object.entries(expectedIdsByPhase).map(([phase, ids]) => [phase, ids.length])),
  sourceFingerprintRefresh: 'CURRENT_SOURCE_DIGESTS_RECORDED; ALL_PRIOR_CANDIDATE_PROOFS_INVALIDATED_PENDING_RERUN_AND_REVIEW',
  caseLinks: l02.candidateLinks.length,
  caseLinkedObligations: linkedIds.size,
  unmappedObligations: l02.unmappedObligationIds.length,
  providerObserverOracleAdmissions: 0,
  receipts: 0,
}, null, 2));
