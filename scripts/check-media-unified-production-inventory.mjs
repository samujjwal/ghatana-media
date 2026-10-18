// Source-derived 501-feature inventory audit. Not a PDP phase exit or provider/runtime qualification.
// This checker preserves exactly one canonical PDP source and treats heuristic maps as unreviewed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const inputs = Object.freeze({
  blueprint: 'docs/implementation/references/MEDIA-UNIFIED-DATA-DRIVEN-PRODUCTION-BLUEPRINT-V3-2026-10-17.md',
  audit: 'docs/implementation/observations/media-unified-production-501-feature-reconciliation-2026-10-18.json',
  attachedAudit: 'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json',
  uploadedIdCrosswalk: 'docs/implementation/observations/media-attached-third-pass-id-provenance-crosswalk-2026-10-18.json',
  taskLedger: 'docs/implementation/observations/media-unified-source-task-and-experiment-crosswalk-2026-10-18.json',
  crosswalk: '.product-experience/pdp-0-product-truth/capability-preservation-crosswalk.yaml',
  requirements: '.product-experience/pdp-0-product-truth/requirements.yaml',
  p1: '.product-experience/pdp-1-domain-data/declarative-production-contracts.yaml',
  p2: '.product-experience/pdp-2-design-interface-system/animation-simulation-grammar.yaml',
  p3: '.product-experience/pdp-3-product-experience/declarative-production-experience.yaml'
});
const validPbis = new Set(Array.from({length: 16}, (_, i) => 'PBI-' + String(i).padStart(2, '0')));
const groups = { RECORDER: 12, ANIMATION: 17, SIMULATION: 22, TUTORPUTOR: 12, UNIFIED: 10 };
const perDomain = {
  SPEC: 20, CAP: 28, ASSET: 19, EDIT: 28, COLOR: 17, ASR: 20, TTS: 24,
  CLONE: 17, DUB: 17, DSP: 20, MUSIC: 15, GEN: 28, VISION: 18, MOTION: 16,
  DIRECT: 21, SOCIAL: 14, INTER: 11, COLLAB: 13, DELIV: 24, QA: 17, TRUST: 19, OPS: 22
};
function duplicates(rows) {
  return rows.length !== new Set(rows).size;
}
function yamlDocument(text, name, fail) {
  const d = parseDocument(text, {strict: true, uniqueKeys: true});
  for (const problem of d.errors) fail(name + ': invalid YAML / duplicate key: ' + problem.message);
  if (d.errors.length) return {};
  try { return d.toJS(); }
  catch (e) { fail(name + ': unusable YAML: ' + e.message); return {}; }
}
export function verifyUnifiedProductionInventory({repoRoot = root, overrides = {}} = {}) {
  const errors = [], fail = message => errors.push(message);
  const raw = Object.fromEntries(Object.entries(inputs).map(([key, file]) => [
    key, Object.hasOwn(overrides, key) ? overrides[key] : fs.readFileSync(path.join(repoRoot, file), 'utf8')
  ]));
  let audit;
  try { audit = JSON.parse(raw.audit); }
  catch (e) { return {errors: ['audit: invalid JSON: ' + e.message], stats: {}}; }
  let attached, stableIds;
  try {
    attached = JSON.parse(raw.attachedAudit);
    stableIds = JSON.parse(raw.uploadedIdCrosswalk);
  } catch (e) { return {errors: ['attached source/crosswalk invalid JSON: ' + e.message], stats: {}}; }

  let taskLedger;
  try { taskLedger = JSON.parse(raw.taskLedger); }
  catch (e) { return {errors: ['source task ledger: invalid JSON: ' + e.message], stats: {}}; }
  const sourceTaskRowDefinitions = [
    ['M', /^\\|\\s*(M-\\d{2})\\s*\\|[^\\n]*$/gm, 16],
    ['INV', /^\\|\\s*(INV-\\d{2})\\s*\\|[^\\n]*$/gm, 12],
    ['DAS', /^\\|\\s*\\*\\*(DAS-\\d{2})[^|\\n]*\\|[^\\n]*$/gm, 12],
    ['C', /^\\|\\s*\\*\\*(C-\\d{2})[^|\\n]*\\|[^\\n]*$/gm, 28],
    ['DAS-A', /^\\|\\s*`(DAS-A\\d{2})`\\s*\\|[^\\n]*$/gm, 18]
  ];
  const exactSourceTasks = sourceTaskRowDefinitions.flatMap(([prefix, regex, total]) => {
    const rows = [...raw.blueprint.matchAll(regex)].map(m => ({id:m[1],markdown:m[0]}));
    if (rows.length !== total) fail('blueprint: original source task family missing or changed ' + prefix);
    return rows;
  });
  const projectedTasks = taskLedger.items || [];
  if (taskLedger.status !== 'LOSSLESS_SOURCE_TASKS_RECORDED_NO_BUILD_ADMISSION_OR_EXPERIMENT_EXECUTION' ||
      projectedTasks.length !== 86 || duplicates(projectedTasks.map(t=>t.sourceTaskId)) ||
      exactSourceTasks.length !== 86)
    fail('original source tasks: expected unique 16 M, 12 INV, 12 DAS, 28 C, 18 DAS-A (86)');
  const tasksById = new Map(projectedTasks.map(t=>[t.sourceTaskId,t]));
  for (const row of exactSourceTasks) {
    const task = tasksById.get(row.id);
    if (!task || task.exactSourceMarkdownRow !== row.markdown ||
        task.originalSourcePath !== inputs.blueprint ||
        task.completionStatus !== 'NOT_ASSERTED_BY_THIS_RECONCILIATION' ||
        !Array.isArray(task.candidateExistingPbiPackages) ||
        task.candidateExistingPbiPackages.length === 0 ||
        task.candidateExistingPbiPackages.some(p=>!validPbis.has(p)))
      fail('original source task dropped, corrupted or prematurely marked complete: ' + row.id);
  }
  const product = yamlDocument(raw.requirements, 'requirements', fail);
  const p1 = yamlDocument(raw.p1, 'p1', fail);
  yamlDocument(raw.p2, 'p2', fail);
  yamlDocument(raw.p3, 'p3', fail);
  const sourceRows = [...raw.blueprint.matchAll(/^\|\s*\x60(AUD-([A-Z]+)-\d{3})\x60\s*\|\s*([^|]+)\s*\|\s*\x60([BEN])\x60\s*\|/gm)]
    .map(m => ({id:m[1], domain:m[2], feature:m[3].trim(), prior:m[4]}));
  const sourceIds = sourceRows.map(row => row.id), observed = audit.originalAudit || [];
  const auditIds = observed.map(row => row.auditId), focused = audit.focusedAudit || [];
  const focusedIds = focused.map(row => row.auditId);
  if (sourceRows.length !== 428 || duplicates(sourceIds)) fail('blueprint: exactly 428 distinct audit-local IDs expected');
  if (observed.length !== 428 || duplicates(auditIds) ||
      sourceIds.some(id => !auditIds.includes(id))) fail('inventory: lost, added, or duplicate one of 428 original features');
  if (focused.length !== 73 || duplicates(focusedIds) ||
      focusedIds.some(id => sourceIds.includes(id))) fail('inventory: focused 73 and original 428 must be disjoint');
  if (audit.auditCounts?.totalUnique !== 501 || audit.auditCounts?.focused73 !== 73 ||
      audit.auditCounts?.original428 !== 428) fail('inventory: 501 population claims do not match source');
  for (const [domain, size] of Object.entries(perDomain)) {
    if (sourceRows.filter(row => row.domain === domain).length !== size ||
        observed.filter(row => row.auditId.startsWith('AUD-' + domain + '-')).length !== size)
      fail('inventory: exact source domain denominator drift: ' + domain);
  }
  for (const [prior, size] of Object.entries({B:246,E:80,N:102})) {
    if (sourceRows.filter(row => row.prior === prior).length !== size ||
        observed.filter(row => row.priorReviewCode === prior).length !== size)
      fail('inventory: source prior-review classification ' + prior + ' changed');
  }
  const famBlocks = raw.crosswalk.slice(raw.crosswalk.indexOf('\nfamilyCrosswalk:\n'))
    .split(/\n- masterPlanSection:/).slice(1);
  const owner = new Map();
  for (const block of famBlocks) {
    const req = block.match(/\n  requirementId:\s*(\S+)/)?.[1];
    const leaves = [...(block.match(/\n  capabilityIds:\n((?:  - media\.[^\n]+\n)+)/)?.[1] || '')
      .matchAll(/^  - (media\.[A-Za-z0-9_.-]+)$/gm)].map(m => m[1]);
    for (const leaf of leaves) {
      if (owner.has(leaf)) fail('capability owner duplication: ' + leaf);
      owner.set(leaf, req);
    }
  }
  if (famBlocks.length !== 38 || owner.size !== 462) fail('source authority: historical 38 families and 462 leaves were not preserved');
  const bySource = new Map(sourceRows.map(row => [row.id, row]));
  for (const row of observed) {
    const source = bySource.get(row.auditId);
    if (!source || source.feature !== row.sourceFeature || source.prior !== row.priorReviewCode)
      fail('inventory: source audit text/status mismatch: ' + row.auditId);
    if (!owner.has(row.existingCapabilityLeafCandidate) ||
        owner.get(row.existingCapabilityLeafCandidate) !== row.existingParentRequirementCandidate)
      fail('inventory: nonexistent/wrong-family existing capability candidate: ' + row.auditId);
    if (!Array.isArray(row.buildPackageCandidates) ||
        row.buildPackageCandidates.some(id => !validPbis.has(id)))
      fail('inventory: nonexistent Build PBI owner: ' + row.auditId);
    if (!['LEXICAL_MATCH_NOT_SEMANTIC_PROOF','WEAK_OR_FAMILY_LEVEL_MATCH_NOT_SEMANTIC_PROOF'].includes(row.candidateStrength))
      fail('inventory: unreviewed lexical candidate cannot be promoted by a similarity score: ' + row.auditId);
    const candidate = row.curatedCandidate || {};
    if (candidate.disposition !== 'CURATED_SOURCE_LEAF_IDENTITY_REVIEW_PENDING' ||
        candidate.status !== 'PDP0_OWNER_AND_NATIVE_CURRENTNESS_REVIEW_REQUIRED' ||
        candidate.sourceCapabilityRef !== '.product-experience/pdp-0-product-truth/capabilities.yaml#' + row.existingCapabilityLeafCandidate ||
        !candidate.sourceLeafLabel || !candidate.meaningStillToProve ||
        candidate.selector !== 'MANUAL_SOURCE_CATALOG_CROSSWALK_NOT_SEMANTIC_ACCEPTANCE') {
      fail('inventory: original audit has unreviewed or falsely promoted curated source leaf: ' + row.auditId);
    }
    if (row.priorLexicalCandidate && (row.priorLexicalCandidate === row.existingCapabilityLeafCandidate || !owner.has(row.priorLexicalCandidate)))
      fail('inventory: prior lexical source candidate is not a distinct real capability: ' + row.auditId);
  }
  if (audit.curatedCrosswalkReview?.candidatePopulation !== 428 ||
      audit.curatedCrosswalkReview?.stillAwaitingSemanticAcceptance !== 428 ||
      audit.curatedCrosswalkReview?.acceptanceEffect !== 'none' ||
      observed.some(r => !r.curatedCandidate)) {
    fail('inventory: 428 reviewed catalog candidates cannot silently become accepted PDP requirements');
  }
  const criticalCrossModalPairs = {
    'AUD-ASR-002': 'media.speech.transcription.stream',
    'AUD-EDIT-001': 'media.compose.multitrack-timeline',
    'AUD-MOTION-003': 'media.animation.interpolation-easing',
    'AUD-VISION-001': 'media.vision.detect.shot-boundary',
    'AUD-COLLAB-001': 'media.project.review',
    'AUD-TRUST-017': 'media.deliver.publish-governed'
  };
  for (const [auditId, expectedLeaf] of Object.entries(criticalCrossModalPairs)) {
    const row = observed.find(r => r.auditId === auditId);
    if (row?.existingCapabilityLeafCandidate !== expectedLeaf)
      fail('inventory: cross-modal source-leaf mismatch at ' + auditId);
  }
  if (audit.originalAuditDefaults?.semanticMappingDisposition !== 'EXACT_LEAF_FIT_REVIEW_REQUIRED' ||
      audit.recordKind !== 'SOURCE_REVIEW_PROJECTION_NOT_CANONICAL_REQUIREMENTS_OR_ACCEPTANCE')
    fail('inventory: do not promote heuristic matches to accepted Product Truth or runtime proof');

  // The original user-supplied audit is an immutable source snapshot. AUD-FOCUS-*
  // IDs are derived, many-to-many planning keys: never substitute them for the
  // original AUD-REC3/ANIM3/SIM3/EDU3/CROSS3 IDs or claim coverage via an alias.
  const originalSourceRows = attached.originalAudit?.inventory || [];
  const uploadedFocusRows = attached.thirdPassAdditions || [];
  const sourceToPrior = {
    EXPLICIT_OR_CLUSTER_LEVEL_IN_PRIOR_BLUEPRINT: 'B',
    NEEDS_ATOMIC_CONTRACT_OR_ACCEPTANCE_EXPANSION: 'E',
    NEW_EXPLICIT_SECOND_PASS_SCOPE: 'N'
  };
  if (attached.originalAuditCount !== 428 || attached.newScopedAuditCount !== 73 ||
      attached.combinedCount !== 501 || originalSourceRows.length !== 428 ||
      uploadedFocusRows.length !== 73)
    fail('attached source: 428+73=501 immutable population was lost');
  if (duplicates(originalSourceRows.map(r => r.audit_id)) ||
      duplicates(uploadedFocusRows.map(r => r.audit_id)))
    fail('attached source: repeated stable original audit ID');
  const observedById = new Map(observed.map(r => [r.auditId, r]));
  for (const row of originalSourceRows) {
    const projected = observedById.get(row.audit_id);
    if (!projected || projected.sourceFeature !== row.capability ||
        projected.priorReviewCode !== sourceToPrior[row.prior_blueprint_disposition])
      fail('attached source: original 428 feature or review status changed at ' + row.audit_id);
  }
  const stableRows = stableIds.thirdPassTraceability || [];
  if (stableIds.status !== 'REVIEW_PROPOSAL_PENDING_EXACT_PDP0_SEMANTIC_ACCEPTANCE' ||
      stableIds.authority !== 'NON_NORMATIVE_SOURCE_PRESERVATION_AND_EARLIEST_AFFECTED_PDP0_REVIEW_ONLY' ||
      stableIds.preservedUploadedAudit !== inputs.attachedAudit ||
      stableRows.length !== 73 || duplicates(stableRows.map(r=>r.sourceAuditId)))
    fail('attached source crosswalk: incomplete, duplicate or falsely promoted 73 stable IDs');
  const stableMap = new Map(stableRows.map(r => [r.sourceAuditId,r]));
  const validCaseIds = new Set([
    ...(product.recorderStudioProfile?.acceptanceClauses || []).map(r=>r.id),
    ...(product.declarativeProductionProfile?.acceptanceClauses || []).map(r=>r.id)
  ]);
  const normalizedFocusById = new Map(focused.map(r => [r.auditId,r]));
  for (const row of uploadedFocusRows) {
    const alias = stableMap.get(row.audit_id);
    if (!alias || alias.sourceFeature !== row.capability ||
        alias.sourceOwnerSurfaceProposal !== row.owner_surface_proposal ||
        alias.originalAcceptance !== row.acceptance ||
        alias.originalRuntimeVerification !== row.runtime_verification ||
        alias.originalCanonicalId !== row.canonical_media_pdp_id ||
        alias.p0Disposition !== 'P0_OWNER_SOURCE_SEMANTIC_REVIEW_REQUIRED' ||
        alias.nativeValidation !== 'NOT_RUN' ||
        alias.candidateFit !== 'REVIEW_ONLY_PARTIAL_OR_BROAD_SCOPE_NOT_EQUIVALENT_TO_FULL_FEATURE')
      fail('attached stable ID not preserved or prematurely accepted: ' + row.audit_id);
    for (const id of alias?.candidateP0AcceptanceCases || []) {
      if (!validCaseIds.has(id)) fail('attached stable ID references missing canonical case: ' + row.audit_id + ' => ' + id);
    }
    for (const id of alias?.normalizedFocusedAuditCandidates || []) {
      const focus = normalizedFocusById.get(id);
      if (!focus || !(alias.candidateP0AcceptanceCases || []).includes(focus.canonicalAcceptanceCaseRef))
        fail('attached stable ID normalized alias drift: ' + row.audit_id + ' => ' + id);
    }
    if (!(alias?.candidateP0AcceptanceCases || []).length &&
        !alias?.additionalSemanticRisk)
      fail('attached stable ID missing case and explicit semantic gap: ' + row.audit_id);
  }
  const linkedFocus = new Set(stableRows.flatMap(r => r.normalizedFocusedAuditCandidates || []));
  if (focused.some(r => !linkedFocus.has(r.auditId)) || linkedFocus.size !== 73)
    fail('attached stable IDs: untraced normalized focus plan row');
  if (stableIds.totals?.normalizedFocusCandidatesLinked !== 73)
    fail('attached source crosswalk: 73 normalized focus references must all link back to source IDs');
  const unresolvedSource = stableRows.filter(r => !(r.candidateP0AcceptanceCases || []).length).map(r => r.sourceAuditId);
  if (unresolvedSource.length !== stableIds.totals?.sourceRowsExplicitlyMissingAtomicCandidates ||
      unresolvedSource.some(id => !(stableIds.totals?.zeroCandidateSourceIds || []).includes(id)))
    fail('attached crosswalk: omitted unmapped source-level semantic gap');
  const sourceRec = product.recorderStudioProfile?.acceptanceClauses || [];
  const srcDec = product.declarativeProductionProfile?.acceptanceClauses || [];
  if (sourceRec.length !== 84 || srcDec.length !== 61) fail('source PDP-0: Recorder 84 and declarative 61 must remain exact');
  const recIds = new Set(sourceRec.map(r => r.id)), decIds = new Set(srcDec.map(r => r.id));
  const bindings = new Map((p1.caseOperationBindings || []).map(r => [r.caseId,r]));
  for (const [group, count] of Object.entries(groups)) {
    if (focused.filter(row => row.group === group).length !== count)
      fail('focused audit: count mismatch for ' + group);
  }
  for (const row of focused) {
    if (row.group === 'RECORDER') {
      if (!recIds.has(row.canonicalAcceptanceCaseRef)) fail('focused audit: missing Recorder case ' + row.auditId);
    } else {
      const source = srcDec.find(r => r.id === row.canonicalAcceptanceCaseRef);
      const binding = bindings.get(row.canonicalAcceptanceCaseRef);
      if (!source || !binding || row.capabilityLeafId !== source.capabilityLeafId ||
          row.parentRequirementId !== source.parentRequirementId ||
          row.canonicalP1OperationRef !== binding.canonicalOperationRef ||
          row.ownerSurface !== source.surfaceId)
        fail('focused audit: drift in exact P0/P1 case source ' + row.auditId);
    }
  }
  const businessTests = new Set([...raw.blueprint.matchAll(/\bC-(\d{2})\b/g)].map(m=>+m[1]).filter(n=>n>=1&&n<=28));
  const scienceTests = new Set([...raw.blueprint.matchAll(/\bDAS-A(\d{2})\b/g)].map(m=>+m[1]).filter(n=>n>=1&&n<=18));
  if (businessTests.size !== 28 || scienceTests.size !== 18)
    fail('blueprint: all C-01..28 and DAS-A01..18 acceptance experiment IDs must be retained');
  return {errors,stats:{original:observed.length,focused:focused.length,total:observed.length+focused.length,
    canonFamilyCount:famBlocks.length,canonLeafCount:owner.size,recorderCases:sourceRec.length,
    declarativeCases:srcDec.length,competitiveTests:businessTests.size,scientificTests:scienceTests.size}};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyUnifiedProductionInventory();
  if (result.errors.length) {
    for (const e of result.errors) console.error(e);
    process.exitCode = 1;
  } else console.log(JSON.stringify({status:'SOURCE_REVIEW_ONLY_PASS', ...result.stats}));
}
