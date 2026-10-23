import {createHash} from 'node:crypto';

const P0_IDS = Array.from({length: 8}, (_, index) => `P0-${String(index + 1).padStart(2, '0')}`);
const PXD_HEADING = /^### PXD-(\d{3})\b[^\n]*(?:\n|$)/gm;

export const pdp0SourceProjectionPinName = '.product-experience/source-manifest.yaml#PDP-0-projection';
export const pdp0DirectCriteriaProjectionPinName = 'docs/implementation/verification/pdp-38/direct-definition-criteria-review.json#PDP-0-projection';
export const pdp0OwnerCandidateProjectionPinName = 'truth-domain-pdp0-pdp1-owner-candidate-199.json#PDP-0-projection';
export const pdp0OwnerTargetObservationsProjectionPinName = 'migration-current-owner-target-observations.json#PDP-0-targets';
export const pdp0DecisionSectionPinName = decisionId => {
  const normalized = String(decisionId).startsWith('PXD-') ? String(decisionId) : `PXD-${decisionId}`;
  if (!/^PXD-\d{3}$/.test(normalized)) throw new TypeError('decisionId must be PXD-NNN or NNN');
  return `.product-experience/decision-log.md#${normalized}-section`;
};

// Frozen P0 membership copied from the reviewed 199-row source at implementation
// start. Downstream owner rows or observations cannot redefine this denominator.
export const pdp0OwnerCandidateClaimIds = Object.freeze([
  'MPSEM-0021-C004','MPSEM-0022-C001','MPSEM-0022-C002','MPSEM-0023-C003','MPSEM-0023-C004','MPSEM-0024-C001','MPSEM-0024-C004','MPSEM-0026-C001','MPSEM-0026-C003','MPSEM-0027-C005','MPSEM-0028-C001','MPSEM-0028-C004','MPSEM-0031-C002','MPSEM-0032-C002','MPSEM-0035-C002','MPSEM-0038-C001','MPSEM-0038-C004','MPSEM-0039-C004','MPSEM-0040-C001','MPSEM-0040-C002','MPSEM-0040-C003','MPSEM-0041-C002','MPSEM-0041-C003','MPSEM-0043-C001','MPSEM-0045-C003','MPSEM-0046-C001','MPSEM-0054-C001','MPSEM-0057-C001','MPSEM-0060-C001','MPSEM-0062-C001','MPSEM-0068-C001','MPSEM-0069-C001','MPSEM-0075-C002','MPSEM-0077-C002','MPSEM-0078-C003','MPSEM-0079-C002','MPSEM-0079-C003','MPSEM-0091-C002','MPSEM-0094-C001','MPSEM-0094-C004','MPSEM-0095-C003','MPSEM-0096-C001','MPSEM-0096-C003','MPSEM-0098-C001','MPSEM-0099-C002','MPSEM-0100-C002','MPSEM-0102-C001','MPSEM-0102-C003','MPSEM-0157-C001','MPSEM-0157-C003','MPSEM-0158-C001','MPSEM-0159-C001','MPSEM-0161-C003','MPSEM-0163-C003','MPSEM-0166-C004','MPSEM-0166-C006','MPSEM-0170-C003','MPSEM-0172-C001','MPSEM-0180-C002','MPSEM-0180-C003','MPSEM-0181-C001','MPSEM-0187-C002','MPSEM-0198-C001','MPSEM-0204-C004','MPSEM-0204-C005','MPSEM-0213-C003','MPSEM-0215-C001','MPSEM-0260-C001','MPSEM-0267-C002','MPSEM-0268-C002','MPSEM-0271-C003','MPSEM-0272-C003','MPSEM-0278-C001','MPSEM-0278-C003','MPSEM-0278-C004','MPSEM-0278-C006','MPSEM-0279-C001','MPSEM-0279-C002','MPSEM-0279-C003','MPSEM-0279-C004','MPSEM-0286-C001','MPSEM-0291-C005','MPSEM-0296-C004','MPSEM-0297-C001','MPSEM-0297-C004','MPSEM-0300-C004','MPSEM-0300-C005','MPSEM-0303-C001','MPSEM-0306-C002','MPSEM-0311-C004','MPSEM-0320-C001','MPSEM-0334-C001','MPSEM-0338-C002','MPSEM-0353-C004','MPSEM-0354-C003','MPSEM-0354-C004','MPSEM-0356-C003','MPSEM-0357-C002','MPSEM-0365-C003','MPSEM-0366-C002','MPSEM-0366-C004','MPSEM-0367-C002','MPSEM-0368-C001','MPSEM-0368-C002','MPSEM-0368-C005','MPSEM-0371-C003','MPSEM-0372-C001','MPSEM-0372-C002','MPSEM-0373-C002','MPSEM-0373-C003','MPSEM-0373-C004','MPSEM-0375-C003','MPSEM-0376-C003','MPSEM-0377-C005','MPSEM-0378-C001','MPSEM-0380-C003','MPSEM-0380-C004','MPSEM-0386-C001','MPSEM-0386-C003','MPSEM-0388-C004','MPSEM-0444-C002','MPSEM-0444-C005','MPSEM-0446-C001','MPSEM-0447-C001','MPSEM-0448-C004','MPSEM-0449-C001','MPSEM-0449-C005','MPSEM-0450-C003','MPSEM-0451-C001','MPSEM-0451-C002','MPSEM-0451-C003','MPSEM-0451-C005','MPSEM-0451-C007','MPSEM-0453-C001','MPSEM-0453-C002','MPSEM-0453-C003','MPSEM-0453-C004','MPSEM-0453-C005','MPSEM-0453-C007','MPSEM-0454-C003','MPSEM-0455-C004','MPSEM-0455-C005','MPSEM-0457-C001','MPSEM-0461-C002','MPSEM-0461-C004','MPSEM-0471-C002','MPSEM-0475-C002','MPSEM-0475-C003',
]);

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}

function assertKnownKeys(value, allowed, label) {
  assertObject(value, label);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unclassified field(s): ${unknown.sort().join(', ')}`);
}

function pick(value, keys, label) {
  assertKnownKeys(value, new Set(keys), label);
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function fingerprint(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function externalObservationRefs(value, refs = new Set()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/(?:^|[/#])externalOwnerObservations\/([A-Za-z0-9._-]+)/g)) refs.add(match[1]);
  } else if (Array.isArray(value)) {
    for (const entry of value) externalObservationRefs(entry, refs);
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) externalObservationRefs(entry, refs);
  }
  return refs;
}

const manifestRootKeys = new Set([
  'schemaVersion', 'productId', 'authorityModel', 'migrationReference',
  'externalOwnerObservations', 'supplementalDecisionReference', 'productArtifactIndex',
]);
const repoObservationKeys = new Set(['repositoryId', 'available', 'revision', 'workingTree', 'files']);
const externalFileKeys = new Set(['path', 'package', 'version', 'sha256']);
const artifactIndexKeys = new Set(['status', 'authoritySource', 'taskDependencySource', 'generator', 'records']);
const artifactRecordKeys = new Set([
  'artifactId', 'title', 'owner', 'authorityClass', 'owningPhase', 'path', 'surfaceIds',
  'semanticStatus', 'generatedOrAuthored', 'generatedFrom', 'dependencyBasis', 'dependencies',
  'dependents', 'schema', 'verification', 'acceptanceState', 'explorerProjection',
  'semanticFingerprint', 'legacyPlanTaskRefs',
]);

/**
 * Project the shared source manifest onto PDP-0 authorities. External owner
 * entries are retained only when a PDP-0 reuse decision names their exact
 * source-manifest selector. PDP-0 artifact dependency edges are filtered to
 * PDP-0 targets; dependents are downstream projections and are omitted.
 */
export function projectPdp0SourceManifest(manifest, reuseDecisions) {
  assertKnownKeys(manifest, manifestRootKeys, 'source manifest');
  assertObject(manifest.authorityModel, 'source manifest authorityModel');
  const authorityModel = pick(manifest.authorityModel,
    ['canonicalPdpPhases', 'explorerOutsidePdpPhases', 'canonicalLocationPolicy', 'semanticFingerprintAuthority', 'currentnessAuthority'],
    'source manifest authorityModel');
  const migrationReference = pick(manifest.migrationReference,
    ['title', 'path', 'classification', 'executionRole', 'semanticAuthority'], 'source manifest migrationReference');
  const supplementalDecisionReference = pick(manifest.supplementalDecisionReference,
    ['title', 'path', 'classification'], 'source manifest supplementalDecisionReference');

  assertKnownKeys(manifest.externalOwnerObservations, new Set(['status', 'repositories']), 'externalOwnerObservations');
  if (!Array.isArray(manifest.externalOwnerObservations.repositories)) throw new TypeError('externalOwnerObservations.repositories must be an array');
  const refs = externalObservationRefs(reuseDecisions);
  const repositories = new Map();
  for (const repository of manifest.externalOwnerObservations.repositories) {
    assertKnownKeys(repository, repoObservationKeys, 'external owner repository observation');
    if (typeof repository.repositoryId !== 'string' || repositories.has(repository.repositoryId)) throw new Error('external owner repository IDs must be unique strings');
    if (!Array.isArray(repository.files)) throw new TypeError(`external owner ${repository.repositoryId} files must be an array`);
    const files = repository.files.map((file, index) => pick(file, [...externalFileKeys], `external owner ${repository.repositoryId} file ${index}`));
    repositories.set(repository.repositoryId, {...repository, files});
  }
  const missing = [...refs].filter(id => !repositories.has(id));
  if (missing.length) throw new Error(`PDP-0 reuse decisions reference missing external-owner evidence: ${missing.sort().join(', ')}`);

  assertKnownKeys(manifest.productArtifactIndex, artifactIndexKeys, 'productArtifactIndex');
  if (!Array.isArray(manifest.productArtifactIndex.records)) throw new TypeError('productArtifactIndex.records must be an array');
  const allArtifactRecords = manifest.productArtifactIndex.records;
  const artifactById = new Map();
  for (const record of allArtifactRecords) {
    assertObject(record, 'product artifact record');
    if (typeof record.artifactId !== 'string' || typeof record.owningPhase !== 'string' || artifactById.has(record.artifactId)) throw new Error('product artifact IDs and owning phases must be present and unique');
    artifactById.set(record.artifactId, record);
  }
  const p0Records = allArtifactRecords.filter(record => record.owningPhase === 'PDP-0');
  const p0Ids = new Set(p0Records.map(record => record.artifactId));
  if (p0Ids.size !== p0Records.length) throw new Error('PDP-0 product artifact IDs must be unique');
  const records = p0Records.map(record => {
    assertKnownKeys(record, artifactRecordKeys, `product artifact ${record.artifactId ?? '<unknown>'}`);
    if (!Array.isArray(record.dependencies)) throw new TypeError(`product artifact ${record.artifactId} dependencies must be an array`);
    const dependencies = record.dependencies.filter(id => {
      if (typeof id !== 'string' || !artifactById.has(id)) throw new Error(`product artifact ${record.artifactId} has malformed or missing dependency ${String(id)}`);
      return p0Ids.has(id);
    });
    if (record.semanticFingerprint !== undefined) pick(record.semanticFingerprint,
      ['status', 'contentSha256', 'contentFingerprintSemantics'], `product artifact ${record.artifactId} semanticFingerprint`);
    const projected = {...record, dependencies};
    delete projected.dependents;
    return projected;
  }).sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  const productArtifactIndex = {
    status: manifest.productArtifactIndex.status,
    authoritySource: manifest.productArtifactIndex.authoritySource,
    generator: manifest.productArtifactIndex.generator,
    records,
  };
  return canonicalize({
    schemaVersion: manifest.schemaVersion,
    productId: manifest.productId,
    authorityModel,
    migrationReference,
    externalOwnerObservations: {
      status: manifest.externalOwnerObservations.status,
      repositories: [...refs].sort().map(id => repositories.get(id)),
    },
    supplementalDecisionReference,
    productArtifactIndex,
  });
}

/** Return exact anchored Markdown for a PXD decision, excluding adjacent decisions. */
export function extractPxdDecisionSection(decisionLog, decisionId) {
  if (typeof decisionLog !== 'string') throw new TypeError('decision log must be text');
  const normalizedId = String(decisionId).replace(/^PXD-/, '');
  if (!/^\d{3}$/.test(normalizedId)) throw new TypeError('decisionId must be PXD-NNN or NNN');
  const matches = [...decisionLog.matchAll(PXD_HEADING)];
  const matching = matches.filter(match => match[1] === normalizedId);
  if (matching.length !== 1) throw new Error(`expected one anchored PXD-${normalizedId} section, found ${matching.length}`);
  const start = matching[0].index;
  const next = matches.find(match => match.index > start);
  return decisionLog.slice(start, next?.index ?? decisionLog.length);
}

export function fingerprintPxdDecisionSection(decisionLog, decisionId) {
  const section = extractPxdDecisionSection(decisionLog, decisionId);
  return {decisionId: `PXD-${String(decisionId).replace(/^PXD-/, '')}`, section, sha256: createHash('sha256').update(section, 'utf8').digest('hex')};
}

/** Select exactly the eight PDP-0 direct-review records, excluding other phases. */
export function projectPdp0DirectCriterionReviews(reviewDocument, sourceOwnerPhase = () => undefined) {
  assertKnownKeys(reviewDocument, new Set(['schemaVersion', 'decisionRef', 'authority', 'records', 'verification', 'nonClaims', 'scopeBoundary']), 'direct-criterion review document');
  if (!Array.isArray(reviewDocument.records)) throw new TypeError('direct-criterion records must be an array');
  const byId = new Map();
  for (const record of reviewDocument.records) {
    assertObject(record, 'direct-criterion record');
    if (typeof record.taskId !== 'string') throw new Error('direct-criterion record requires taskId');
    if (byId.has(record.taskId)) throw new Error(`duplicate direct-criterion record: ${record.taskId}`);
    byId.set(record.taskId, record);
  }
  const records = P0_IDS.filter(id => byId.has(id)).map(id => byId.get(id));
  if (!records.length) throw new Error('direct-criterion review contains no PDP-0 records');
  const allowedRecordKeys = new Set(['taskId', 'status', 'decisionRef', 'scope', 'sourceFingerprints', 'verification', 'acceptanceBoundary', 'currentCorrectiveReview', 'currentSourceReview', 'historicalCorrectiveReviews', 'currentSourcePinRefresh', 'currentProjectionRefresh', 'scopeBoundary']);
  const reviewKeys = new Set([
    'status', 'decisionRef', 'reviewKind', 'phaseScope', 'scope', 'sourceFingerprints', 'supersedesReviewRef',
    'verification', 'acceptanceBoundary', 'acceptanceEffect', 'ownerApproval', 'currentSourceCutNote',
    'publishedSourceCommit', 'reopenedDecisionRef', 'requiredVerification', 'reviewArtifactRef',
    'priorApprovedCorrectionDecision', 'remainingCriteria', 'runtimeAndIndependentAcceptance', 'preservedHistoricalReviews',
  ]);
  const verificationKeys = new Set([
    'status', 'reviewedSourceBase', 'focusedTestCount', 'focusedPassed', 'focusedFailed', 'evidenceRef',
    'projectionPublicValidator', 'projectionEvidenceRef', 'productDefinitionSchema', 'productDefinitionPublicValidator',
    'tests', 'passed', 'failed', 'command', 'commands', 'evidenceRefs', 'acceptanceBoundary', 'passedTests',
    'testEvidenceRef', 'applicabilityTests', 'applicabilityEvidenceRef',
  ]);
  const ignoredGlobalPins = new Set([
    '.product-experience/decision-log.md',
    '.product-experience/source-manifest.yaml',
    '.product-experience/gaps.yaml',
    'docs/PRODUCT-DEFINITION-COVERAGE.md',
    'apps/media-experience-explorer/specification-artifacts.json',
    'docs/implementation/verification/pdp-38/truth-domain-pdp0-pdp1-owner-candidate-199.json',
  ]);
  const projectFingerprintMap = pins => {
    assertObject(pins, 'criterion sourceFingerprints');
    return Object.fromEntries(Object.entries(pins).filter(([file]) => {
      if (ignoredGlobalPins.has(file)) return false;
      if (['PDP-1', 'PDP-2', 'PDP-3'].includes(sourceOwnerPhase(file))) return false;
      return true;
    }));
  };
  const projectVerification = verification => {
    if (!verification) return verification;
    assertKnownKeys(verification, verificationKeys, 'criterion verification');
    return {...verification};
  };
  const projectReview = review => {
    if (!review) return review;
    assertKnownKeys(review, reviewKeys, 'criterion corrective review');
    const projected = {...review};
    if (review.sourceFingerprints) projected.sourceFingerprints = projectFingerprintMap(review.sourceFingerprints);
    if (review.verification) projected.verification = projectVerification(review.verification);
    return projected;
  };
  const assertShaMap = (value, label) => {
    assertObject(value, label);
    for (const [sourceRef, sha256] of Object.entries(value)) {
      if (!sourceRef || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`${label} must contain lowercase SHA-256 pins`);
    }
  };
  const projectCurrentSourcePinRefresh = (refresh, taskId) => {
    const keys = ['status', 'phaseScope', 'decisionContextRef', 'preservesReviewRef', 'predecessorSourceFingerprints', 'currentSourceFingerprints', 'scopedClauseFingerprints', 'semanticReview', 'ownerApproval', 'acceptanceEffect', 'decisionContextFingerprint', ...(taskId === 'P0-05' || taskId === 'P0-07' ? ['currentnessAuthority'] : []), ...(taskId === 'P0-07' ? ['crosswalkImpact'] : [])];
    const projected = pick(refresh, keys, `${taskId} currentSourcePinRefresh`);
    const contextDecision = taskId === 'P0-02' ? 'PXD-207' : taskId === 'P0-05' ? 'PXD-208' : 'PXD-209';
    if (refresh.status !== 'CURRENT_SOURCE_PIN_REFRESH_ONLY' || refresh.phaseScope !== 'PDP-0'
        || refresh.decisionContextRef !== `.product-experience/decision-log.md#${contextDecision}`
        || refresh.preservesReviewRef !== '.product-experience/decision-log.md#PXD-196'
        || refresh.semanticReview !== 'NOT_PERFORMED' || refresh.ownerApproval !== 'NOT_CLAIMED'
        || refresh.acceptanceEffect !== 'none') throw new Error(`${taskId} currentSourcePinRefresh has an invalid bounded status or authority boundary`);
    assertShaMap(refresh.predecessorSourceFingerprints, `${taskId} predecessorSourceFingerprints`);
    assertShaMap(refresh.currentSourceFingerprints, `${taskId} currentSourceFingerprints`);
    if (taskId !== 'P0-07' && canonicalJson(Object.keys(refresh.predecessorSourceFingerprints).sort()) !== canonicalJson(Object.keys(refresh.currentSourceFingerprints).sort())) throw new Error(`${taskId} predecessor/current source fingerprint keys differ`);
    if (!refresh.decisionContextFingerprint || refresh.decisionContextFingerprint.sourceRef !== `${refresh.decisionContextRef}-section`
        || !/^[a-f0-9]{64}$/.test(refresh.decisionContextFingerprint.sha256 ?? '')) throw new Error(`${taskId} currentSourcePinRefresh must pin its decision context`);
    if (taskId === 'P0-05' || taskId === 'P0-07') {
      assertKnownKeys(refresh.currentnessAuthority,
        new Set(['decisionRef', 'artifactRef', 'artifactSha256', 'decisionSectionSha256']),
        `${taskId} currentnessAuthority`);
      if (refresh.currentnessAuthority.decisionRef !== '.product-experience/decision-log.md#PXD-225'
          || refresh.currentnessAuthority.artifactRef !== 'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd225.json'
          || !/^[a-f0-9]{64}$/.test(refresh.currentnessAuthority.artifactSha256 ?? '')
          || !/^[a-f0-9]{64}$/.test(refresh.currentnessAuthority.decisionSectionSha256 ?? '')) {
        throw new Error(`${taskId} currentnessAuthority must bind the PXD-225 reconciliation and exact decision section`);
      }
    }
    if (!Array.isArray(refresh.scopedClauseFingerprints) || !refresh.scopedClauseFingerprints.length) throw new Error(`${taskId} currentSourcePinRefresh requires scoped clause fingerprints`);
    const scopedRefs = new Set();
    projected.scopedClauseFingerprints = refresh.scopedClauseFingerprints.map((entry, index) => {
      const clause = pick(entry, ['sourceRef', 'claimIdentities', 'predecessorSha256', 'currentSha256'], `${taskId} scoped clause ${index}`);
      if (typeof clause.sourceRef !== 'string' || scopedRefs.has(clause.sourceRef) || !Array.isArray(clause.claimIdentities)
          || !clause.claimIdentities.length || new Set(clause.claimIdentities).size !== clause.claimIdentities.length
          || clause.claimIdentities.some(identity => typeof identity !== 'string' || !identity)
          || !/^[a-f0-9]{64}$/.test(clause.predecessorSha256 ?? '') || clause.predecessorSha256 !== clause.currentSha256) {
        throw new Error(`${taskId} scoped clause ${index} is malformed or claims non-equal currentness`);
      }
      scopedRefs.add(clause.sourceRef);
      return clause;
    });
    if (taskId === 'P0-07') {
      const expectedScopedClauses = [
        ['.product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records/@capabilityRef=media.artifact.import/channelApplicability', 'b2cd8ef702d6f2fdadc205b4bc645599692eea15c47cf113ebc5e728321cffef'],
        ['.product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records/@capabilityRef=media.artifact.import/{requirementRefs,profileRef,boundsRef}', 'e8e181a315742cbe359740b3f74afa3e395ecdb027a152b6058f7717c8aa8098'],
      ];
      if (projected.scopedClauseFingerprints.length !== expectedScopedClauses.length
          || projected.scopedClauseFingerprints.some((clause, index) => clause.sourceRef !== expectedScopedClauses[index][0]
            || JSON.stringify(clause.claimIdentities) !== JSON.stringify(['media.artifact.import'])
            || clause.predecessorSha256 !== expectedScopedClauses[index][1])) throw new Error('P0-07 current-source pin must preserve the exact PXD-196 import-channel and identity tuple clauses');
      const expectedPredecessorKeys = [
        '.product-experience/pdp-0-product-truth/capabilities.yaml',
        '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
        '.product-experience/pdp-0-product-truth/applications-channels.yaml',
        '.product-experience/pdp-0-product-truth/requirements.yaml',
        'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
        '.product-experience/decision-log.md#PXD-196-section',
      ].sort();
      const expectedCurrentKeys = [...expectedPredecessorKeys.filter(key => key !== '.product-experience/decision-log.md#PXD-196-section'),
        'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-audit-aq-traceability.json',
        '.product-experience/decision-log.md#PXD-209-section'].sort();
      if (canonicalJson(Object.keys(refresh.predecessorSourceFingerprints).sort()) !== canonicalJson(expectedPredecessorKeys)
          || canonicalJson(Object.keys(refresh.currentSourceFingerprints).sort()) !== canonicalJson(expectedCurrentKeys)
          || refresh.crosswalkImpact !== 'AUD-ASSET-012 import/export mapping adds no channel-applicability meaning') throw new Error('P0-07 source pin scope or crosswalk-impact boundary is invalid');
    }
    return projected;
  };
  const projectCurrentProjectionRefresh = refresh => {
    const keys = ['status', 'phaseScope', 'decisionContextRefs', 'preservesReviewRef', 'projectionArtifactRef', 'projectionArtifactSha256', 'sourceFingerprints', 'decisionContextFingerprints', 'changedJoins', 'semanticDecision', 'ownerApproval', 'acceptanceEffect'];
    const projected = pick(refresh, keys, 'P0-06 currentProjectionRefresh');
    if (refresh.status !== 'CURRENT_PDP0_QUALITY_PROJECTION_REFRESH' || refresh.phaseScope !== 'PDP-0'
        || canonicalJson(refresh.decisionContextRefs) !== canonicalJson(['.product-experience/decision-log.md#PXD-207', '.product-experience/decision-log.md#PXD-208', '.product-experience/decision-log.md#PXD-225'])
        || refresh.preservesReviewRef !== '.product-experience/decision-log.md#PXD-196'
        || refresh.projectionArtifactRef !== 'docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd225.json'
        || !/^[a-f0-9]{64}$/.test(refresh.projectionArtifactSha256 ?? '')
        || refresh.semanticDecision !== 'NOT_MADE' || refresh.ownerApproval !== 'NOT_CLAIMED' || refresh.acceptanceEffect !== 'none') {
      throw new Error('P0-06 currentProjectionRefresh has an invalid scope, source, or authority boundary');
    }
    assertShaMap(refresh.sourceFingerprints, 'P0-06 projection sourceFingerprints');
    assertKnownKeys(refresh.decisionContextFingerprints, new Set(['.product-experience/decision-log.md#PXD-207-section', '.product-experience/decision-log.md#PXD-208-section', '.product-experience/decision-log.md#PXD-225-section']), 'P0-06 decisionContextFingerprints');
    if (Object.keys(refresh.decisionContextFingerprints).length !== 3 || Object.values(refresh.decisionContextFingerprints).some(sha => !/^[a-f0-9]{64}$/.test(sha))) throw new Error('P0-06 decision-context pins must cover PXD-207, PXD-208, and PXD-225');
    const expectedJoins = ['media.compose.multitrack-timeline', 'media.compose.reusable-composition', 'media.compose.safe-area', 'media.speech.synthesis.speaker.condition', 'media.master.audio.stereo-width'];
    if (!Array.isArray(refresh.changedJoins) || canonicalJson(refresh.changedJoins.map(join => join.capabilityId)) !== canonicalJson(expectedJoins)) throw new Error('P0-06 changedJoins must retain the exact five PXD-207 quality joins');
    projected.changedJoins = refresh.changedJoins.map((join, index) => {
      const value = pick(join, ['capabilityId', 'previousInputArtifactTypesSha256', 'currentInputArtifactTypesSha256', 'previousOutputArtifactTypesSha256', 'currentOutputArtifactTypesSha256'], `P0-06 changed join ${index}`);
      for (const key of Object.keys(value).filter(key => key.endsWith('Sha256'))) if (!/^[a-f0-9]{64}$/.test(value[key] ?? '')) throw new Error(`P0-06 changed join ${index} has malformed ${key}`);
      if (value.capabilityId === 'media.compose.multitrack-timeline' || value.capabilityId === 'media.compose.reusable-composition' || value.capabilityId === 'media.compose.safe-area') {
        if (value.previousInputArtifactTypesSha256 !== value.currentInputArtifactTypesSha256 || value.previousOutputArtifactTypesSha256 === value.currentOutputArtifactTypesSha256) throw new Error(`P0-06 ${value.capabilityId} must pin its changed output join`);
      } else if (value.previousInputArtifactTypesSha256 === value.currentInputArtifactTypesSha256 || value.previousOutputArtifactTypesSha256 !== value.currentOutputArtifactTypesSha256) throw new Error(`P0-06 ${value.capabilityId} must pin its changed input join`);
      return value;
    });
    return projected;
  };
  const projectedRecords = records.map(record => {
    assertKnownKeys(record, allowedRecordKeys, `direct-criterion ${record.taskId}`);
    if (/^P0-\d{2}$/.test(record.taskId) && !P0_IDS.includes(record.taskId)) throw new Error(`unrecognized PDP-0 direct-criterion ID: ${record.taskId}`);
    const activeP0Review = record.currentSourceReview ?? record.currentCorrectiveReview;
    if (P0_IDS.includes(record.taskId) && activeP0Review && activeP0Review.phaseScope !== 'PDP-0') {
      throw new Error(`${record.taskId} current review must declare PDP-0 phaseScope`);
    }
    const projected = {...record};
    if (record.sourceFingerprints) projected.sourceFingerprints = projectFingerprintMap(record.sourceFingerprints);
    if (record.verification) projected.verification = projectVerification(record.verification);
    if (record.currentCorrectiveReview) projected.currentCorrectiveReview = projectReview(record.currentCorrectiveReview);
    if (record.currentSourceReview) projected.currentSourceReview = projectReview(record.currentSourceReview);
    if (record.currentSourcePinRefresh) {
      if (!['P0-02', 'P0-05', 'P0-07'].includes(record.taskId)) throw new Error(`${record.taskId} cannot carry currentSourcePinRefresh`);
      projected.currentSourcePinRefresh = projectCurrentSourcePinRefresh(record.currentSourcePinRefresh, record.taskId);
    }
    if (record.currentProjectionRefresh) {
      if (record.taskId !== 'P0-06') throw new Error(`${record.taskId} cannot carry currentProjectionRefresh`);
      projected.currentProjectionRefresh = projectCurrentProjectionRefresh(record.currentProjectionRefresh);
    }
    if (record.historicalCorrectiveReviews) {
      if (!Array.isArray(record.historicalCorrectiveReviews)) throw new TypeError(`${record.taskId} historicalCorrectiveReviews must be an array`);
      projected.historicalCorrectiveReviews = record.historicalCorrectiveReviews.map(projectReview);
    }
    return projected;
  });
  return canonicalize({records: projectedRecords});
}

/** Select only current owner-target observations whose target is a canonical PDP-0 source. */
export function projectPdp0OwnerTargetObservations(document) {
  assertKnownKeys(document, new Set(['schemaVersion', 'scope', 'records', 'decisionRef']), 'owner-target observations');
  if (!Array.isArray(document.records)) throw new TypeError('owner-target observation records must be an array');
  const allowedRecordKeys = new Set([
    'claimId', 'targetRef', 'historicalCurrentTargetValueSha256', 'currentTargetValueSha256',
    'historicalSourceImpactRef', 'additionalOwnerRuleRef', 'additionalRuleId', 'meaning',
    'additionalOwnerRules', 'claimParityBasis', 'disposition', 'acceptanceEffect', 'runtimeAdmission',
    'historicalTargetTextSha256', 'sourceText', 'historicalReviewRef',
  ]);
  const records = document.records.filter(record => typeof record?.targetRef === 'string'
      && record.targetRef.startsWith('.product-experience/pdp-0-product-truth/'));
  const ids = new Set();
  for (const record of records) {
    assertKnownKeys(record, allowedRecordKeys, `PDP-0 owner-target observation ${record.claimId ?? '<unknown>'}`);
    if (typeof record.claimId !== 'string' || ids.has(record.claimId)) throw new Error('PDP-0 owner-target claim IDs must be unique strings');
    ids.add(record.claimId);
  }
  return canonicalize({schemaVersion: document.schemaVersion, records});
}

const candidateTopKeys = new Set([
  'claimId', 'exactSourceText', 'sourceTextSha256', 'ownerPhase', 'ownerSourceFile',
  'priorLocatorRef', 'currentLocatorResolution', 'currentTargetValueSha256', 'currentTargetValuePreview',
  'semanticDisposition', 'materialGap', 'priorTargetValueSha256', 'targetHashEncoding',
  'targetSnapshotStatus', 'ownerSourceSha256', 'sourcePlanCommit', 'sourcePlanPath',
  'sourcePlanLineNumbers', 'exactParentContext', 'ownerSemanticReview', 'currentProposalObservation',
]);
const semanticReviewKeys = new Set([
  'disposition', 'reason', 'proposedTargetRef', 'exactContractRefs', 'materialPredicates',
  'negativeCases', 'oracleRef', 'acceptanceEffect', 'runtimeStatus', 'materialBindings',
  'sourceEvidenceRef', 'sourceEvidenceSha256', 'historicalDisposition', 'historicalMaterialBindings',
]);
const materialBindingKeys = new Set(['ref', 'requiredSourcePhrase', 'sourceFileSha256', 'sourceValueSha256', 'preRefreshCurrentSourceFileSha256', 'currentProposalObservation']);
const historicalBindingKeys = new Set(['ref', 'requiredSourcePhrase', 'currentProposalObservation']);
const observationKeys = new Set([
  'status', 'priorSourceFileSha256', 'currentSourceFileSha256', 'previousCurrentSourceFileSha256',
  'supersededCurrentSourceFileSha256', 'priorSourceValueSha256', 'currentSourceValueSha256',
  'priorTargetValueSha256', 'currentTargetValueSha256', 'currentTargetValuePreview', 'reason',
  'changedFields', 'currentTargetRef', 'currentMaterialRefs', 'currentMaterialValueSha256',
  'sourceFileSha256History', 'supersededCurrentSourceValueSha256', 'currentSourceSuccessorPredecessorFileSha256',
  'currentSourceSuccessorRef', 'preRefreshCurrentSourceFileSha256',
]);
const candidateRootKeys = new Set([
  'schemaVersion', 'artifactId', 'scope', 'authority', 'sourcePartition', 'population', 'records',
  'sourcePlanSha256', 'currentProposalObservationStatus', 'currentProposalObservationReason',
  'laterPhaseHandoffs', 'focusedPdp1SourceObservations',
]);

function validateObservation(observation, label) {
  if (observation == null) return;
  assertKnownKeys(observation, observationKeys, label);
}

function phaseInRef(ref) {
  if (typeof ref !== 'string') throw new TypeError('material binding ref must be a string');
  const match = ref.match(/(?:^|\/)(pdp-([0-3]))-/i);
  return match ? `PDP-${match[2]}` : null;
}

function projectCandidateRecord(record) {
  assertKnownKeys(record, candidateTopKeys, `owner-candidate ${record.claimId ?? '<unknown>'}`);
  if (record.ownerPhase !== 'PDP-0') throw new Error(`non-PDP-0 owner claim entered PDP-0 projection: ${record.claimId}`);
  if (typeof record.ownerSourceFile !== 'string' || !record.ownerSourceFile.startsWith('.product-experience/pdp-0-product-truth/')) {
    throw new Error(`PDP-0 owner claim has non-PDP-0 source ownership: ${record.claimId}`);
  }
  const output = {...record};
  const review = record.ownerSemanticReview;
  assertKnownKeys(review, semanticReviewKeys, `owner-candidate ${record.claimId} semantic review`);
  const projectedReview = {...review};
  for (const key of ['materialBindings', 'historicalMaterialBindings']) {
    if (!Object.hasOwn(review, key)) continue;
    if (!Array.isArray(review[key])) throw new TypeError(`${record.claimId} ${key} must be an array`);
    projectedReview[key] = review[key].map((binding, index) => {
      const allowed = key === 'materialBindings' ? materialBindingKeys : historicalBindingKeys;
      assertKnownKeys(binding, allowed, `${record.claimId} ${key}[${index}]`);
      const phase = phaseInRef(binding.ref);
      const projected = phase === 'PDP-0' ? {...binding} : Object.fromEntries(Object.entries(binding).filter(([field]) => field === 'ref' || field === 'requiredSourcePhrase'));
      validateObservation(binding.currentProposalObservation, `${record.claimId} ${key}[${index}] observation`);
      return projected;
    });
  }
  output.ownerSemanticReview = projectedReview;
  validateObservation(record.currentProposalObservation, `${record.claimId} current proposal observation`);
  if (Array.isArray(record.exactParentContext)) {
    for (const [index, context] of record.exactParentContext.entries()) pick(context, ['line', 'text', 'sha256'], `${record.claimId} exactParentContext[${index}]`);
  }
  return output;
}

/**
 * Build a stable PDP-0-only view of the mixed owner-candidate artifact.
 * `expectedClaimIds` must come from the reviewed static P0 inventory.
 */
export function projectPdp0OwnerCandidates(candidate, expectedClaimIds) {
  assertKnownKeys(candidate, candidateRootKeys, 'owner-candidate document');
  const expected = expectedClaimIds ?? pdp0OwnerCandidateClaimIds;
  if (!Array.isArray(expected) || expected.some(id => typeof id !== 'string') || new Set(expected).size !== expected.length) {
    throw new TypeError('expectedClaimIds must be a unique array of claim IDs');
  }
  if (JSON.stringify([...expected].sort()) !== JSON.stringify([...pdp0OwnerCandidateClaimIds].sort())) {
    throw new Error('expectedClaimIds differs from the frozen PDP-0 owner-candidate membership');
  }
  if (!Array.isArray(candidate.records)) throw new TypeError('owner-candidate records must be an array');
  if (candidate.population !== undefined) {
    assertKnownKeys(candidate.population, new Set(['claimCount', 'ownerPhaseCounts', 'locatorResolutionCounts']), 'owner-candidate population');
    if (candidate.population.ownerPhaseCounts !== undefined) assertKnownKeys(candidate.population.ownerPhaseCounts, new Set(['PDP-0', 'PDP-1', 'PDP-1/PDP-2 cross-interface']), 'owner-candidate phase counts');
    if (candidate.population.locatorResolutionCounts !== undefined) assertKnownKeys(candidate.population.locatorResolutionCounts, new Set(['RESOLVED_EXACT_SOURCE_VALUE']), 'owner-candidate locator counts');
    if (candidate.population.ownerPhaseCounts?.['PDP-0'] !== undefined
        && candidate.population.ownerPhaseCounts['PDP-0'] !== expected.length) {
      throw new Error('owner-candidate PDP-0 population count does not match expected membership');
    }
  }
  const byId = new Map();
  for (const record of candidate.records) {
    assertObject(record, 'owner-candidate record');
    if (typeof record.claimId !== 'string' || byId.has(record.claimId)) throw new Error('owner-candidate claim IDs must be unique strings');
    byId.set(record.claimId, record);
  }
  const p0Records = candidate.records.filter(record => record.ownerPhase === 'PDP-0');
  const expectedSorted = [...expected].sort();
  const actual = p0Records.map(record => record.claimId).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedSorted)) throw new Error('PDP-0 owner-candidate claim membership differs from reviewed expected IDs');
  const records = p0Records.map(projectCandidateRecord).sort((a, b) => a.claimId.localeCompare(b.claimId));
  return canonicalize({
    schemaVersion: candidate.schemaVersion,
    artifactId: candidate.artifactId,
    records,
  });
}

export const pdp0DirectCriterionIds = Object.freeze([...P0_IDS]);
