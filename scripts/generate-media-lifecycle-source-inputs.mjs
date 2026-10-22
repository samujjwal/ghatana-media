#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { enumerateExpectedMediaObligations } from './lib/media-obligation-denominator-audit.mjs';
import { MEDIA_SOURCE_PDP_PHASES, readMediaSourcePhaseMapping } from './lib/media-closure-phase-map.mjs';

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
const sourceDigests = new Map();
const observedDigest = (relativePath) => `sha256:${crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(root, relativePath))).digest('hex')}`;
const digest = (relativePath) => {
  if (!sourceDigests.has(relativePath)) sourceDigests.set(relativePath, observedDigest(relativePath));
  return sourceDigests.get(relativePath);
};
const fileAtRef = (reference) => reference.split('#')[0];

const enumeration = enumerateExpectedMediaObligations({ root, parseYaml: parse });
for (const [sourcePath, fingerprint] of Object.entries(enumeration.sourceDigests)) sourceDigests.set(sourcePath, fingerprint);
if (enumeration.issues.length) {
  throw new Error(`Cannot enumerate closure source inputs: ${JSON.stringify(enumeration.issues)}`);
}
const obligations = readJson(`${base}/obligations.json`);
const program = readJson(`${base}/phase-program.json`);
const sourcePhaseToClosurePhaseId = readMediaSourcePhaseMapping(program);
const history = readJson(`${base}/historical-obligation-supersessions.json`);
const historicalSupersessionsById = new Map((history.records ?? []).map((record) => [
  record.supersededObligation?.id, record,
]));
const expectedIdsBySourcePhase = Object.fromEntries(MEDIA_SOURCE_PDP_PHASES.map((phase) => [
  phase, enumeration.records.filter((record) => record.phase === phase)
    .map((record) => record.obligationId).sort(),
]));
const expectedIdsByClosurePhase = Object.fromEntries(Object.entries(sourcePhaseToClosurePhaseId)
  .map(([sourcePhase, closurePhase]) => [closurePhase, expectedIdsBySourcePhase[sourcePhase]]));
const expectedById = new Map(enumeration.records.map((record) => [record.obligationId, record]));
const enumeratedSourcePaths = new Set(enumeration.records.map((record) => record.sourcePath));
const activeObligations = obligations.filter((item) => {
  const source = item.extensions?.['media-source'];
  const sourcePath = source?.sourceRef ? fileAtRef(source.sourceRef) : undefined;
  if (!sourcePath || !enumeratedSourcePaths.has(sourcePath) || expectedById.has(item.id)) return true;
  const supersession = historicalSupersessionsById.get(item.id);
  if (!supersession) {
    throw new Error(`Stale source obligation ${item.id} has no historical supersession record`);
  }
  if (supersession.supersededObligation?.extensions?.['media-source']?.recordId !== source.recordId) {
    throw new Error(`Historical supersession for ${item.id} does not preserve its source record identity`);
  }
  return false;
});
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
const existingBySource = new Map(activeObligations.map((item) => {
  const source = item.extensions?.['media-source'];
  return [`${source?.sourceRef ?? ''}|${source?.recordId ?? ''}`, item];
}));
if (existingBySource.size !== activeObligations.filter((item) => item.extensions?.['media-source']?.sourceRef).length) {
  throw new Error('Duplicate persisted source identity in obligation records');
}
const existingById = new Map(activeObligations.map((item) => [item.id, item]));
const existingIds = new Set(existingById.keys());
const additions = [];
for (const expected of enumeration.records) {
  const key = `${expected.sourceRef}|${expected.recordId}`;
  if (existingBySource.has(key)) continue;
  if (existingIds.has(expected.obligationId)) {
    const existing = existingById.get(expected.obligationId);
    const source = existing.extensions?.['media-source'];
    if (source?.recordId !== expected.recordId || fileAtRef(source?.sourceRef ?? '') !== expected.sourcePath) {
      throw new Error(`Source obligation identity conflict for ${expected.obligationId}`);
    }
    source.sourceRef = expected.sourceRef;
    source.sourceDigest = digest(expected.sourcePath);
    existingBySource.set(key, existing);
    continue;
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
      applicableIn: [sourcePhaseToClosurePhaseId[expected.phase]],
      blockingIn: [sourcePhaseToClosurePhaseId[expected.phase]],
      affects: [sourcePhaseToClosurePhaseId[expected.phase]],
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

for (const item of activeObligations) {
  const source = item.extensions?.['media-source'];
  if (source?.sourceRef) {
    const expected = expectedById.get(item.id);
    if (expected) {
      if (source.recordId !== expected.recordId) {
        throw new Error(`Source record identity mismatch for ${item.id}: ${source.recordId} != ${expected.recordId}`);
      }
      source.sourceRef = expected.sourceRef;
      source.sourceDigest = digest(expected.sourcePath);
      const sourcePhase = expected.phase;
      const closurePhaseId = sourcePhaseToClosurePhaseId[sourcePhase];
      item.phaseSemantics = {
        applicableIn: [closurePhaseId],
        blockingIn: [closurePhaseId],
        affects: [closurePhaseId],
      };
    }
  }
}
const merged = [...activeObligations, ...additions].sort((left, right) => left.id.localeCompare(right.id));

const binding = readJson(`${base}/phase-binding.json`);
const closurePhaseIds = Object.keys(expectedIdsByClosurePhase).sort();
if (JSON.stringify(Object.keys(binding.phases).sort()) !== JSON.stringify(closurePhaseIds)) {
  throw new Error('Lifecycle phase binding keys must match the mapped PhaseProgram phase IDs exactly');
}
for (const phase of program.phases) phase.obligationIds = expectedIdsByClosurePhase[phase.id] ?? [];
for (const phase of Object.keys(binding.phases)) {
  binding.phases[phase].obligationIds = expectedIdsByClosurePhase[phase] ?? [];
}
const surface = readJson(`${base}/surface.json`);
surface.obligationIds = Object.values(expectedIdsByClosurePhase).flat().sort();

const l02 = readJson(`${base}/l02-source-case-links.json`);
const linkedIds = new Set(l02.candidateLinks.map(({ obligationId }) => obligationId));
const allIds = Object.values(expectedIdsByClosurePhase).flat().sort();
l02.obligationIds = allIds;
l02.unmappedObligationIds = allIds.filter((id) => !linkedIds.has(id));

const l03 = readJson(`${base}/l03-proof-route-candidates.json`);
l03.l02CaseLinkReview.reviewedLinkCount = l02.candidateLinks.length;
l03.l02CaseLinkReview.reviewedObligationCount = linkedIds.size;
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
// Every identity and fingerprint must describe the same source cut. Refuse all
// writes when a concurrent edit invalidates that cut; never publish mixed inputs.
for (const [sourcePath, fingerprint] of sourceDigests) {
  if (observedDigest(sourcePath) !== fingerprint) throw new Error(`Source changed during generation: ${sourcePath}; rerun against a stable cut`);
}
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
  phaseCounts: Object.fromEntries(Object.entries(expectedIdsByClosurePhase).map(([phase, ids]) => [phase, ids.length])),
  sourceFingerprintRefresh: 'CURRENT_SOURCE_DIGESTS_RECORDED; ALL_PRIOR_CANDIDATE_PROOFS_INVALIDATED_PENDING_RERUN_AND_REVIEW',
  caseLinks: l02.candidateLinks.length,
  caseLinkedObligations: linkedIds.size,
  unmappedObligations: l02.unmappedObligationIds.length,
  providerObserverOracleAdmissions: 0,
  receipts: 0,
}, null, 2));
