#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  fingerprint, fingerprintPxdDecisionSection, pdp0DecisionSectionPinName,
  pdp0OwnerCandidateProjectionPinName, pdp0SourceProjectionPinName,
  projectPdp0OwnerCandidates, projectPdp0SourceManifest,
} from './lib/pdp0-phase-scoped-source-fingerprints.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json';
export const PDP0_AUDIT_SOURCE_PATH = 'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json';
const dispositions = new Set([
  'BOUND_EXISTING', 'PDP0_MEANING_CHANGE_REQUIRED', 'EXPLICIT_NOT_APPLICABLE',
  'POST_PDP_IMPLEMENTATION_ONLY', 'BLOCKED_EXTERNAL_OWNER_DECISION',
]);
const requireFromTools = createRequire(path.resolve(root, '../ghatana-tools/package.json'));
const parseYaml = requireFromTools('yaml').parse;
const PHASE_SCOPED_FINGERPRINT_ALGORITHM = 'SHA-256 of canonical PDP-0 projection JSON; PXD sections hash exact UTF-8 bytes';

export function currentPdp0PhaseScopedSourceFingerprints(decisionRef) {
  const decisionId = typeof decisionRef === 'string' && decisionRef.match(/PXD-\d{3}$/)?.[0];
  if (!decisionId) throw new Error('coordinatorReview.decisionRef must identify an exact PXD-NNN decision section');
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const decisionLog = read('.product-experience/decision-log.md');
  return {
    [pdp0SourceProjectionPinName]: fingerprint(projectPdp0SourceManifest(
      parseYaml(read('.product-experience/source-manifest.yaml')),
      parseYaml(read('.product-experience/pdp-0-product-truth/reuse-decisions.yaml')),
    )),
    [pdp0OwnerCandidateProjectionPinName]: fingerprint(projectPdp0OwnerCandidates(
      JSON.parse(read('docs/implementation/verification/pdp-38/truth-domain-pdp0-pdp1-owner-candidate-199.json')),
    )),
    [pdp0DecisionSectionPinName(decisionId)]: fingerprintPxdDecisionSection(decisionLog, decisionId).sha256,
  };
}

function loadData(file) {
  const raw = fs.readFileSync(path.join(root, file), 'utf8');
  if (/\.ya?ml$/i.test(file)) return parseYaml(raw);
  if (/\.json$/i.test(file)) return JSON.parse(raw);
  throw new Error(`Unsupported source format: ${file}`);
}
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function selectorValue(token) {
  const match = token.match(/^@([^=]+)=(.*)$/s);
  if (!match) return null;
  let expected;
  try { expected = JSON.parse(match[2]); } catch { expected = match[2]; }
  return {key:match[1], expected};
}
function selectArrayItem(array, token, arrayIndex) {
  const selector = selectorValue(token);
  if (!selector) return {matches:[], reason:`invalid selector ${token}`};
  let indexes = arrayIndex.get(array);
  if (!indexes) { indexes = new Map(); arrayIndex.set(array, indexes); }
  let values = indexes.get(selector.key);
  if (!values) {
    values = new Map();
    for (const item of array) {
      if (!isRecord(item) || !Object.hasOwn(item, selector.key)) continue;
      const value = JSON.stringify(item[selector.key]);
      const list = values.get(value) ?? []; list.push(item); values.set(value, list);
    }
    indexes.set(selector.key, values);
  }
  return {matches:values.get(JSON.stringify(selector.expected)) ?? [], reason:`selector ${token}`};
}
function resolveAnchor(document, anchor, identityIndex, arrayIndex) {
  if (!anchor) return {ok: false, reason: 'empty anchor'};
  if (anchor.startsWith('originalAudit.')) anchor = anchor.replace(/^originalAudit\.inventory/, 'originalAudit/inventory');
  // A single identity token is an established shorthand in some P0 records.
  if (!anchor.includes('/')) {
    const hits = identityIndex.get(anchor) ?? [];
    return hits.length === 1 ? {ok: true, value: hits[0]} : {ok: false, reason: `identity shorthand resolved ${hits.length} times`};
  }
  let current = document;
  for (const token of anchor.replace(/^\//, '').split('/')) {
    if (token.startsWith('@')) {
      if (!Array.isArray(current)) return {ok: false, reason: `selector ${token} applied to non-array`};
      const matches = selectArrayItem(current, token, arrayIndex).matches;
      if (matches.length !== 1) return {ok: false, reason: `selector ${token} resolved ${matches.length} times`};
      current = matches[0];
    } else if (Array.isArray(current) && /^\d+$/.test(token)) {
      current = current[Number(token)];
    } else if (isRecord(current) && Object.hasOwn(current, token)) {
      current = current[token];
    } else {
      return {ok: false, reason: `path component ${token} not found`};
    }
    if (current === undefined) return {ok: false, reason: `path component ${token} is undefined`};
  }
  return {ok: true, value: current};
}
function buildIdentityIndex(document) {
  const index = new Map();
  const seen = new Set();
  const add = (key, value) => {
    const list = index.get(key) ?? [];
    if (!list.includes(value)) list.push(value);
    index.set(key, list);
  };
  const visit = value => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (['id', 'auditId', 'capabilityId', 'requirementId', 'intentId', 'caseId'].includes(key) && typeof child === 'string') add(child, value);
        if (key !== 'id') add(key, child);
        visit(child);
      }
    } else for (const child of value) visit(child);
  };
  visit(document);
  return index;
}
function resolveSourceRef(ref, cache) {
  if (typeof ref !== 'string' || !ref.trim()) return {ok: false, reason: 'reference must be non-empty string'};
  const split = ref.indexOf('#');
  if (split < 1) return {ok: false, reason: 'reference must include a source anchor'};
  const file = ref.slice(0, split);
  const anchor = ref.slice(split + 1);
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..') || !fs.existsSync(path.join(root, file))) return {ok: false, reason: `source file missing or outside repository: ${file}`};
  try {
    if (!cache.has(file)) cache.set(file, {document: loadData(file), identityIndex: null});
    const entry = cache.get(file);
    if (!anchor.includes('/') && !entry.identityIndex) entry.identityIndex = buildIdentityIndex(entry.document);
    entry.arrayIndex ??= new WeakMap();
    return resolveAnchor(entry.document, anchor, entry.identityIndex, entry.arrayIndex);
  } catch (error) { return {ok: false, reason: `cannot read source: ${error.message}`}; }
}
function addError(errors, message) { errors.push(message); }

export function validatePdp0AuditDispositions({repositoryRoot = root, crosswalk = null, stopAfterFirstError = false} = {}) {
  const errors = [];
  const fileCache = new Map();
  const refCache = new Map();
  const resolveRef = ref => {
    if (!refCache.has(ref)) refCache.set(ref, resolveSourceRef(ref, fileCache));
    return refCache.get(ref);
  };
  let ledger;
  let audit;
  try {
    ledger = crosswalk ?? JSON.parse(fs.readFileSync(path.join(repositoryRoot, PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH), 'utf8'));
    audit = JSON.parse(fs.readFileSync(path.join(repositoryRoot, PDP0_AUDIT_SOURCE_PATH), 'utf8'));
  } catch (error) { return {errors: [`cannot load authoritative input: ${error.message}`], stats: null}; }

  if (ledger.sourceBaseline?.fingerprintAlgorithm !== 'SHA-256 of exact file bytes') addError(errors, 'sourceBaseline must declare SHA-256 of exact file bytes');
  const fingerprintMap = ledger.sourceBaseline?.workingTreeSourceFingerprintsSha256;
  if (!isRecord(fingerprintMap) || Object.keys(fingerprintMap).length === 0) addError(errors, 'sourceBaseline must contain current source fingerprints');
  else for (const [file, expected] of Object.entries(fingerprintMap)) {
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) { addError(errors, `invalid SHA-256 fingerprint for ${file}`); continue; }
    const absolute = path.resolve(repositoryRoot, file);
    if (!absolute.startsWith(path.resolve(repositoryRoot) + path.sep) || !fs.existsSync(absolute)) { addError(errors, `fingerprinted source missing or outside repository: ${file}`); continue; }
    const actual = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    if (actual !== expected) addError(errors, `stale source fingerprint: ${file}`);
  }

  if (ledger.sourceBaseline?.phaseScopedFingerprintAlgorithm !== PHASE_SCOPED_FINGERPRINT_ALGORITHM) {
    addError(errors, 'sourceBaseline must declare the PDP-0 scoped fingerprint algorithm');
  }
  const expectedPhaseScoped = (() => {
    try { return currentPdp0PhaseScopedSourceFingerprints(ledger.coordinatorReview?.decisionRef); }
    catch (error) { addError(errors, `cannot compute PDP-0 phase-scoped source fingerprints: ${error.message}`); return {}; }
  })();
  const phaseScopedMap = ledger.sourceBaseline?.phaseScopedSourceFingerprintsSha256;
  if (!isRecord(phaseScopedMap) || Object.keys(phaseScopedMap).length === 0) addError(errors, 'sourceBaseline must contain current phase-scoped fingerprints');
  else {
    for (const [pin, expected] of Object.entries(expectedPhaseScoped)) {
      if (typeof phaseScopedMap[pin] !== 'string' || !/^[a-f0-9]{64}$/.test(phaseScopedMap[pin])) addError(errors, `invalid PDP-0 phase-scoped fingerprint for ${pin}`);
      else if (phaseScopedMap[pin] !== expected) addError(errors, `stale PDP-0 phase-scoped fingerprint: ${pin}`);
    }
    for (const pin of Object.keys(phaseScopedMap)) if (!Object.hasOwn(expectedPhaseScoped, pin)) addError(errors, `unrecognized PDP-0 phase-scoped fingerprint: ${pin}`);
  }

  const original = audit.originalAudit?.inventory;
  const focused = audit.thirdPassAdditions;
  if (!Array.isArray(original) || original.length !== 428) addError(errors, 'authoritative original audit must contain exactly 428 rows');
  if (!Array.isArray(focused) || focused.length !== 73) addError(errors, 'authoritative third-pass audit must contain exactly 73 rows');
  const sourceRows = new Map();
  for (const [partition, rows] of [['originalAudit', original ?? []], ['focusedAudit', focused ?? []]]) {
    for (const source of rows) {
      const id = partition === 'originalAudit' ? source.audit_id : source.audit_id;
      if (typeof id !== 'string' || !id) { addError(errors, `${partition} has a source row without audit_id`); continue; }
      if (sourceRows.has(id)) addError(errors, `duplicate authoritative source ID ${id}`);
      sourceRows.set(id, {partition, source});
    }
  }
  const rows = ledger.rows;
  if (!Array.isArray(rows)) addError(errors, 'crosswalk rows must be an array');
  if (Array.isArray(rows)) {
    const ids = rows.map(row => row?.auditId).filter(id => typeof id === 'string');
    const idSet = new Set(ids);
    for (const id of sourceRows.keys()) if (!idSet.has(id)) addError(errors, `missing crosswalk row ${id}`);
    if (idSet.size !== ids.length) addError(errors, 'duplicate crosswalk auditId detected');
    for (const id of idSet) if (!sourceRows.has(id)) addError(errors, `invented or unexpected audit ID ${id}`);
    if (ids.length !== 501 || idSet.size !== 501) addError(errors, `crosswalk must contain exactly 501 unique IDs, found ${idSet.size}`);
  }
  if (stopAfterFirstError && errors.length) return {errors, stats:null};
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = row?.auditId;
    if (typeof id !== 'string' || !id) { addError(errors, 'crosswalk row missing auditId'); continue; }
    if (seen.has(id)) addError(errors, `duplicate crosswalk auditId ${id}`);
    seen.add(id);
    const sourceEntry = sourceRows.get(id);
    if (!sourceEntry) { addError(errors, `${id}: invented or unexpected audit ID`); continue; }
    const {partition, source} = sourceEntry;
    if (row.sourcePartition !== partition) addError(errors, `${id}: sourcePartition mismatch (expected ${partition})`);
    const expectedText = partition === 'originalAudit' ? source.capability : source.capability;
    const expectedAcceptance = partition === 'originalAudit' ? source.acceptance_family : source.acceptance;
    const expectedAnchor = `${PDP0_AUDIT_SOURCE_PATH}#${partition === 'originalAudit' ? 'originalAudit.inventory' : 'thirdPassAdditions'}/@audit_id=${id}`;
    if (row.sourceText !== expectedText) addError(errors, `${id}: sourceText does not round-trip exactly`);
    if (row.sourceAcceptanceText !== expectedAcceptance) addError(errors, `${id}: sourceAcceptanceText does not round-trip exactly`);
    if (row.sourceTextRef !== expectedAnchor) addError(errors, `${id}: sourceTextRef is not the exact authoritative source anchor`);
    if (stopAfterFirstError && errors.length) break;
    const resolved = resolveRef(row.sourceTextRef);
    if (!resolved.ok || resolved.value?.audit_id !== id) addError(errors, `${id}: sourceTextRef invalid (${resolved.reason ?? 'wrong identity'})`);
    if (!dispositions.has(row.disposition)) addError(errors, `${id}: unsupported disposition ${String(row.disposition)}`);
    if (typeof row.phaseLocalRationale !== 'string' || !row.phaseLocalRationale.trim()) addError(errors, `${id}: phaseLocalRationale required`);
    if (row.ownerApproval !== 'NOT_CLAIMED') addError(errors, `${id}: ownerApproval must remain NOT_CLAIMED`);

    const ownerSurfaceProposal = source.owner_surface_proposal;
    const definitionScopeBinding = row.definitionScopeBinding;
    const expectedSurfaceRegistryRef = `.product-experience/surface-registry.yaml#surfaces/@surfaceId=${ownerSurfaceProposal}`;
    const expectedPdp0ScopeRef = `.product-experience/pdp-0-product-truth/applications-channels.yaml#/logicalConsumerPdp0Scope/records/@surfaceRef=${ownerSurfaceProposal}`;
    if (row.ownerSurfaceProposal !== ownerSurfaceProposal
        || definitionScopeBinding?.status !== 'DEFINITION_SCOPE_ONLY'
        || definitionScopeBinding?.surfaceRegistryRef !== expectedSurfaceRegistryRef
        || definitionScopeBinding?.pdp0ScopeRef !== expectedPdp0ScopeRef
        || definitionScopeBinding?.ownerApproval !== 'NOT_CLAIMED'
        || definitionScopeBinding?.runtimeAdmission !== 'NOT_CLAIMED') {
      addError(errors, `${id}: preserve the exact source owner-surface proposal and bind it to current PDP-0 definition scope only, with owner approval and runtime admission unclaimed`);
    } else {
      const surface = resolveRef(expectedSurfaceRegistryRef);
      const scope = resolveRef(expectedPdp0ScopeRef);
      if (!surface.ok || surface.value?.surfaceId !== ownerSurfaceProposal
          || !(surface.value?.applicablePdpArtifacts ?? []).includes('PDP-0')) {
        addError(errors, `${id}: proposed owner surface does not resolve to an exact registered PDP-0 surface`);
      }
      if (!scope.ok || scope.value?.surfaceRef !== ownerSurfaceProposal) {
        addError(errors, `${id}: proposed owner surface has no exact current PDP-0 logical-consumer scope`);
      }
    }

    const evidenceRefs = Array.isArray(row.pdp0EvidenceRefs) ? row.pdp0EvidenceRefs : [];
    const contextRefs = Array.isArray(row.pdp0ContextRefs) ? row.pdp0ContextRefs : [];
    for (const [kind, refs] of [['PDP-0 evidence', evidenceRefs], ['PDP-0 context', contextRefs]]) {
      for (const ref of refs) {
        const file = typeof ref === 'string' ? ref.split('#')[0] : '';
        if (!file.startsWith('.product-experience/pdp-0-product-truth/')) addError(errors, `${id}: ${kind} reference is not a PDP-0 source: ${String(ref)}`);
        const found = resolveRef(ref);
        if (!found.ok) addError(errors, `${id}: invalid ${kind} reference ${String(ref)} (${found.reason})`);
      }
    }
    if (row.disposition === 'BOUND_EXISTING') {
      if (evidenceRefs.length === 0) addError(errors, `${id}: BOUND_EXISTING requires at least one exact PDP-0 evidence reference`);
      if (!row.phaseLocalRationale?.trim()) addError(errors, `${id}: BOUND_EXISTING requires semantic rationale`);
    } else if (row.disposition === 'PDP0_MEANING_CHANGE_REQUIRED') {
      if (typeof row.proposedPdp0SourceChange !== 'string' || !row.proposedPdp0SourceChange.trim()) addError(errors, `${id}: meaning change requires proposedPdp0SourceChange`);
      if (contextRefs.length === 0) addError(errors, `${id}: meaning change requires exact current PDP-0 context refs`);
      if (row.proposedPdp0SourceChange && /(?:new|invented)\s+(?:stable\s+)?(?:capability|requirement|intent)\s+id/i.test(row.proposedPdp0SourceChange)) addError(errors, `${id}: proposed change must not invent a stable P0 identity`);
    } else if (row.disposition === 'EXPLICIT_NOT_APPLICABLE') {
      const authority = row.applicabilityAuthority ?? row.authorityRef ?? row.externalOwnerDecision;
      if (typeof authority !== 'string' || !authority.trim()) addError(errors, `${id}: explicit N/A requires an authority decision/reference`);
      if (!row.phaseLocalRationale?.trim()) addError(errors, `${id}: explicit N/A requires rationale`);
    } else if (row.disposition === 'BLOCKED_EXTERNAL_OWNER_DECISION') {
      if (typeof row.externalOwnerDecision !== 'string' || !row.externalOwnerDecision.trim()) addError(errors, `${id}: blocker requires exact external owner decision needed`);
      if (!row.phaseLocalRationale?.trim()) addError(errors, `${id}: blocker requires rationale`);
    } else if (row.disposition === 'POST_PDP_IMPLEMENTATION_ONLY') {
      if (!row.implementationHandoff && !row.laterPhaseHandoffs) addError(errors, `${id}: post-PDP work requires a separately recorded handoff`);
    }

    // Later-phase work is recorded only as a handoff and never satisfies P0 evidence.
    const handoffs = row.laterPhaseHandoffs;
    if (handoffs !== undefined && handoffs !== null && !Array.isArray(handoffs) && !isRecord(handoffs)) addError(errors, `${id}: laterPhaseHandoffs must be a list/object`);
    for (const handoff of Array.isArray(handoffs) ? handoffs : isRecord(handoffs) ? [handoffs] : []) {
      const phaseText = [handoff.phase, handoff.ownerPhase, handoff.sourcePhase, handoff.consumerPhase].filter(Boolean).join(' ');
      if (/PDP-0(?:\b|\/)/.test(phaseText) && !/after external decision/i.test(phaseText)) addError(errors, `${id}: later-phase handoff is mislabeled as P0 binding`);
      for (const ref of handoff.evidenceRefs ?? handoff.sourceRefs ?? []) {
        if (evidenceRefs.includes(ref)) addError(errors, `${id}: downstream handoff ref is also presented as PDP-0 evidence`);
      }
    }
    for (const ref of row.reviewProvenance ? [row.reviewProvenance] : []) {
      const found = resolveRef(ref);
      if (!found.ok) addError(errors, `${id}: invalid reviewProvenance ${ref} (${found.reason})`);
    }
    if (row.independentQcRef) {
      const found = resolveRef(row.independentQcRef);
      if (!found.ok) addError(errors, `${id}: invalid independentQcRef ${row.independentQcRef} (${found.reason})`);
      else if (found.value?.sourceAuditId !== id) addError(errors, `${id}: independent QC record identity mismatch`);
      else {
        const resolution = row.independentQcDispositionResolution;
        const recommendation = found.value?.qcRecommendation;
        const pxd172SourceMeaningRepairs = new Set(['AUD-CAP-020', 'AUD-TTS-017', 'AUD-TTS-018']);
        const expectedResolution = pxd172SourceMeaningRepairs.has(id)
          ? 'RESOLVED_IN_CURRENT_PDP0_SOURCE'
          : recommendation === 'REFINE_EXISTING_P0'
          ? 'RESOLVED_IN_CURRENT_PDP0_SOURCE'
          : recommendation === 'BOUND_EXISTING'
            ? 'NO_ADDITIONAL_PDP0_MEANING'
            : id === 'AUD-SIM3-010'
              ? 'CURRENT_SOURCE_MEANING_BOUNDED_BY_EXPLICIT_OWNER_ADMISSION_GATE'
              : 'CONDITIONAL_PDP0_MEANING_DOWNSTREAM_AUTHORITY_REQUIRED';
        const expectedReviewRef = pxd172SourceMeaningRepairs.has(id)
          ? '.product-experience/decision-log.md#PXD-172'
          : id === 'AUD-MUSIC-014'
            ? '.product-experience/decision-log.md#PXD-196'
          : id === 'AUD-DSP-007'
            ? '.product-experience/decision-log.md#PXD-207'
          : id === 'AUD-SIM3-010'
            ? '.product-experience/decision-log.md#PXD-169'
            : '.product-experience/decision-log.md#PXD-167';
        if (!resolution || resolution.resolution !== expectedResolution
            || resolution.currentSourceReviewRef !== expectedReviewRef
            || resolution.ownerApproval !== 'NOT_CLAIMED'
            || JSON.stringify([...(resolution.currentSourceEvidenceRefs ?? [])].sort()) !== JSON.stringify([...evidenceRefs].sort())) {
          addError(errors, `${id}: independent QC disposition needs an exact current-source reconciliation, evidence set, its current decision ref, and unclaimed owner approval`);
        }
        if (recommendation === 'EXTERNAL_OWNER_BLOCKER'
            && (!(row.laterPhaseHandoffs ?? []).length || !(row.downstreamApprovalHandoffs ?? []).length)) {
          addError(errors, `${id}: conditional external-owner QC requires explicit downstream phase/use handoffs`);
        }
      }
    }
    if (stopAfterFirstError && errors.length) break;
  }
  for (const id of sourceRows.keys()) if (!seen.has(id)) addError(errors, `missing crosswalk row ${id}`);
  if (seen.size !== 501) addError(errors, `crosswalk must contain exactly 501 unique IDs, found ${seen.size}`);
  const referencedFiles = new Set();
  for (const row of rows ?? []) {
    for (const ref of [row.sourceTextRef, row.reviewProvenance, row.independentQcRef,
      row.definitionScopeBinding?.surfaceRegistryRef, row.definitionScopeBinding?.pdp0ScopeRef,
      ...(row.pdp0EvidenceRefs ?? []), ...(row.pdp0ContextRefs ?? [])]) {
      if (typeof ref === 'string' && ref.includes('#')) referencedFiles.add(ref.slice(0, ref.indexOf('#')));
    }
  }
  for (const file of referencedFiles) if (!Object.hasOwn(fingerprintMap ?? {}, file)) addError(errors, `referenced source is not fingerprinted: ${file}`);
  const originalIds = [...sourceRows].filter(([,v])=>v.partition==='originalAudit').map(([id])=>id);
  const focusedIds = [...sourceRows].filter(([,v])=>v.partition==='focusedAudit').map(([id])=>id);
  if (rows?.filter(r=>r.sourcePartition==='originalAudit').length !== 428) addError(errors, 'crosswalk must contain exactly 428 originalAudit rows');
  if (rows?.filter(r=>r.sourcePartition==='focusedAudit').length !== 73) addError(errors, 'crosswalk must contain exactly 73 focusedAudit rows');
  const softBody = rows?.find(row => row.auditId === 'AUD-SIM3-009');
  const specializedSimulationFamilies = [
    'rigid-body','soft-body','cloth','rope','particle','fluid','smoke','fire','collision','constraint','vehicle',
    'crowd','agent','human-motion','procedural-world','camera-experiment','lighting-experiment','educational-demo',
    'scientific-demo','robotics','kinematics','synthetic-data',
  ];
  const specializedSimulationRefs = specializedSimulationFamilies.map(name =>
    `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.simulation.${name}`);
  const specializedSimulationRequirementRefs = [
    '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-SIMULATION/acceptanceCases/@id=MEDIA-REQ-CAP-SIMULATION-AC-01',
    '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-SIMULATION/acceptanceCases/@id=MEDIA-REQ-CAP-SIMULATION-AC-02',
  ];
  if (!softBody || [...specializedSimulationRefs, ...specializedSimulationRequirementRefs].some(ref => !(softBody.pdp0EvidenceRefs ?? []).includes(ref))
      || !/other specialized simulation/i.test(softBody.sourceText ?? '')
      || !specializedSimulationFamilies.every(name => (softBody.phaseLocalRationale ?? '').includes(`media.simulation.${name}`))) {
    addError(errors, 'AUD-SIM3-009 must enumerate every exact specialized model-family leaf and bind family-specific qualification/fallback boundaries');
  }
  const agentScope = rows?.find(row => row.auditId === 'AUD-SIM3-010');
  const agentQcRef = 'docs/implementation/observations/pdp0-semantic-audit-slices/meaning-gap-qc.json#records/@sourceAuditId=AUD-SIM3-010';
  const agentEvidenceRefs = [
    '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-SIMULATION/acceptanceCases/@id=MEDIA-REQ-CAP-SIMULATION-AC-03',
    '.product-experience/pdp-0-product-truth/requirements.yaml#declarativeProductionProfile/acceptanceClauses/@id=MEDIA-DECL-P0-AC-023',
    '.product-experience/pdp-0-product-truth/requirements.yaml#declarativeProductionProfile/acceptanceClauses/@id=MEDIA-DECL-P0-AC-024',
    '.product-experience/pdp-0-product-truth/requirements.yaml#declarativeProductionProfile/acceptanceClauses/@id=MEDIA-DECL-P0-AC-034',
    '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.simulation.agent',
  ];
  if (!agentScope || agentScope.disposition !== 'BOUND_EXISTING'
      || agentScope.independentQcRef !== agentQcRef
      || agentEvidenceRefs.some(ref => !(agentScope.pdp0EvidenceRefs ?? []).includes(ref))
      || agentScope.independentQcDispositionResolution?.resolution !== 'CURRENT_SOURCE_MEANING_BOUNDED_BY_EXPLICIT_OWNER_ADMISSION_GATE'
      || agentScope.decisionRef?.id !== 'PXD-169'
      || !/UNQUALIFIED/i.test(agentScope.conditionalProductScope ?? '')
      || !/qualified domain-owner admission/i.test(agentScope.conditionalProductScope ?? '')
      || !/applicability blocks execution/i.test(agentScope.conditionalProductScope ?? '')
      || !(agentScope.laterPhaseHandoffs ?? []).some(handoff => handoff.phase === 'PDP-1' && /PRNG/.test(handoff.scope ?? ''))
      || !(agentScope.downstreamApprovalHandoffs ?? []).some(handoff => /qualified scientific validation/i.test(handoff.requiredAction ?? ''))) {
    addError(errors, 'AUD-SIM3-010 must cite exact current AC-03, AC-023, AC-024, AC-034 and agent capability meaning, bound family scope behind qualified domain-owner admission, preserve UNQUALIFIED/NON_REPLAYABLE meaning, and hand off typed PRNG and qualified-claim validation downstream');
  }
  const exactRequirementRef = (requirementId, caseId) => `.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=${requirementId}/acceptanceCases/@id=${caseId}`;
  const exactClauseRef = clauseId => `.product-experience/pdp-0-product-truth/requirements.yaml#declarativeProductionProfile/acceptanceClauses/@id=${clauseId}`;
  const exactRecorderClauseRef = clauseId => `.product-experience/pdp-0-product-truth/requirements.yaml#recorderStudioProfile/acceptanceClauses/@id=${clauseId}`;
  const exactCapabilityRef = capabilityId => `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${capabilityId}`;
  const hasEvidence = (row, ref) => (row?.pdp0EvidenceRefs ?? []).includes(ref);
  const sourceMeaning = ref => {
    const result = resolveRef(ref);
    return result.ok && isRecord(result.value) ? result.value : null;
  };

  // The accepted source text for AUD-MUSIC-014 concerns checkpoint rights,
  // not the adjacent audit label's copyright-similarity observation.
  const musicCheckpoint = rows?.find(row => row.auditId === 'AUD-MUSIC-014');
  const musicRightsCase = exactRequirementRef('MEDIA-REQ-CAP-GENERATE-AUDIO', 'MEDIA-REQ-CAP-GENERATE-AUDIO-AC-05');
  const musicUnknownLicenseCase = exactRequirementRef('MEDIA-REQ-CAP-GENERATE-AUDIO', 'MEDIA-REQ-CAP-GENERATE-AUDIO-AC-02');
  const musicPermittedUseCase = exactRequirementRef('MEDIA-REQ-CAP-RIGHTS', 'MEDIA-REQ-CAP-RIGHTS-AC-02');
  const musicRightsMeaning = sourceMeaning(musicRightsCase);
  const musicDirectEvidence = musicCheckpoint?.pdp0EvidenceRefs ?? [];
  if (!musicCheckpoint || musicCheckpoint.disposition !== 'BOUND_EXISTING'
      || !hasEvidence(musicCheckpoint, musicRightsCase)
      || !hasEvidence(musicCheckpoint, musicUnknownLicenseCase)
      || !hasEvidence(musicCheckpoint, musicPermittedUseCase)
      || hasEvidence(musicCheckpoint, exactRequirementRef('MEDIA-REQ-CAP-QUALITY', 'MEDIA-REQ-CAP-QUALITY-AC-05'))
      || !musicDirectEvidence.includes(exactCapabilityRef('media.generate.audio.music'))
      || !/checkpoint identity and version/i.test(musicRightsMeaning?.then ?? '')
      || !/license identity and use-scope terms/i.test(musicRightsMeaning?.then ?? '')
      || !/noncommercial checkpoint terms for commercial use/i.test(musicRightsMeaning?.then ?? '')
      || !/similarity observation/i.test(musicRightsMeaning?.rejection ?? '')
      || musicCheckpoint.decisionRef?.id !== 'PXD-196'
      || JSON.stringify([...(musicCheckpoint.independentQcDispositionResolution?.currentSourceEvidenceRefs ?? [])].sort())
        !== JSON.stringify([...musicDirectEvidence].sort())) {
    addError(errors, 'AUD-MUSIC-014 must bind exact checkpoint license/use-scope meaning and must not treat similarity observation as rights clearance');
  }

  // This acceptance binds internal governed asset search and derived indexes;
  // importing an admitted source is not a search operation.
  const governedAssetSearch = rows?.find(row => row.auditId === 'AUD-ASSET-009');
  const assetEvidence = governedAssetSearch?.pdp0EvidenceRefs ?? [];
  const assetLicenseFilterCase = exactRequirementRef('MEDIA-REQ-CAP-ARTIFACT', 'MEDIA-REQ-CAP-ARTIFACT-AC-05');
  const assetLicenseFilterMeaning = sourceMeaning(assetLicenseFilterCase);
  if (!governedAssetSearch || governedAssetSearch.disposition !== 'BOUND_EXISTING'
      || !assetEvidence.includes(assetLicenseFilterCase)
      || !assetEvidence.includes(exactCapabilityRef('media.artifact.search'))
      || !assetEvidence.includes(exactCapabilityRef('media.artifact.derive'))
      || !assetEvidence.includes(exactCapabilityRef('media.artifact.retain'))
      || assetEvidence.some(ref => ref.includes('media.artifact.import'))
      || governedAssetSearch.decisionRef?.id !== 'PXD-196'
      || !/current authoritative per-version rights and license evidence explicitly permits the declared scope/i.test(assetLicenseFilterMeaning?.then ?? '')
      || !/unknown or review-required rather than as an empty eligible result/i.test(assetLicenseFilterMeaning?.then ?? '')
      || !/external-catalog search.*ranking.*complete results/i.test(assetLicenseFilterMeaning?.rejection ?? '')
      || !/immutable artifact version\/hash identity/i.test(governedAssetSearch.phaseLocalRationale ?? '')
      || !/purpose and tenant controls/i.test(governedAssetSearch.phaseLocalRationale ?? '')
      || !/MEDIA-REQ-CAP-ARTIFACT-AC-05.*media\.artifact\.search/i.test(governedAssetSearch.phaseLocalRationale ?? '')
      || !/does not interpret license terms.*legal clearance.*external-catalog search/i.test(governedAssetSearch.phaseLocalRationale ?? '')) {
    addError(errors, 'AUD-ASSET-009 must bind the exact license/use-scope candidate filter, unknown-rights result boundary, and governed asset search/derivation meaning; external catalog and legal clearance remain unclaimed');
  }

  // Imported acceptance text is retained for provenance and exact source round-trip only.
  // It cannot broaden the audited watermark meaning or substitute for its current P0 case.
  const cloneWatermark = rows?.find(row => row.auditId === 'AUD-CLONE-012');
  const qualityAc06 = exactRequirementRef('MEDIA-REQ-CAP-QUALITY', 'MEDIA-REQ-CAP-QUALITY-AC-06');
  const qualityInspectCapability = exactCapabilityRef('media.quality.inspect');
  const cloneCandidateMappings = ledger.resolvedCandidateMappings?.['AUD-CLONE-012'] ?? [];
  const cloneMappingResolvesToAc06 = cloneCandidateMappings.length === 1
    && resolveRef(cloneCandidateMappings[0]).ok
    && resolveRef(cloneCandidateMappings[0]).value === resolveRef(qualityAc06).value;
  if (!cloneWatermark || cloneWatermark.disposition !== 'BOUND_EXISTING'
      || JSON.stringify(cloneWatermark.pdp0EvidenceRefs ?? []) !== JSON.stringify([qualityAc06])
      || cloneWatermark.pdp0CapabilityScopeDisposition !== 'PARENT_REQUIREMENT_FAMILY_SCOPE_ONLY'
      || !cloneWatermark.pdp0ContextRefs?.includes(qualityInspectCapability)
      || !/parent-requirement family scope/i.test(cloneWatermark.phaseLocalRationale ?? '')
      || !/no watermark-specific capability claim/i.test(cloneWatermark.phaseLocalRationale ?? '')
      || !/robustness under a declared transformation/i.test(cloneWatermark.phaseLocalRationale ?? '')
      || !cloneMappingResolvesToAc06
      || cloneWatermark.decisionRef?.id !== 'PXD-174'
      || cloneWatermark.decisionRef?.path !== '.product-experience/decision-log.md#PXD-174'
      || !/provenance-only/i.test(cloneWatermark.decisionRationaleStatus ?? '')
      || !/provenance-only/i.test(ledger.coordinatorReview?.note ?? '')
      || !/provenance-only/i.test(ledger.decision?.note ?? '')) {
    addError(errors, 'AUD-CLONE-012 must remain scoped only to QUALITY-AC-06 under PXD-174; imported acceptance-text mismatch is provenance-only under PXD-172');
  }

  // Gesture/trigger semantics are owned by AC-061. Constraint ordering (AC-010)
  // does not define the interaction mapping or the fail-closed behavior.
  const animationGesture = rows?.find(row => row.auditId === 'AUD-ANIM3-010');
  const gestureClauseRef = exactClauseRef('MEDIA-DECL-P0-AC-061');
  const gestureClause = sourceMeaning(gestureClauseRef);
  if (!animationGesture || !hasEvidence(animationGesture, gestureClauseRef)
      || hasEvidence(animationGesture, exactClauseRef('MEDIA-DECL-P0-AC-010'))
      || !/gesture or trigger/i.test(gestureClause?.when ?? '')
      || !/explicitly mapped/i.test(gestureClause?.then ?? '')
      || !/unknown, out-of-scope, and unmapped triggers have no effect/i.test(gestureClause?.then ?? '')
      || !/arbitrary embedded scripts.*embedded product credentials.*privileged external effects/i.test(gestureClause?.rejection ?? '')) {
    addError(errors, 'AUD-ANIM3-010 must bind the exact gesture/trigger map and fail-closed semantics in AC-061, not constraint ordering in AC-010');
  }

  // Job finality and partial-result meaning is defined by JOB-AC-03, not
  // numerical simulation QA or synthetic-fixture classification.
  const simulationFinality = rows?.find(row => row.auditId === 'AUD-SIM3-018');
  const jobAc03 = exactRequirementRef('MEDIA-REQ-CAP-JOB', 'MEDIA-REQ-CAP-JOB-AC-03');
  const jobClause = sourceMeaning(jobAc03);
  const staleSimulationRefs = [
    exactClauseRef('MEDIA-DECL-P0-AC-027'),
    exactClauseRef('MEDIA-DECL-P0-AC-039'),
  ];
  if (!simulationFinality || !hasEvidence(simulationFinality, jobAc03)
      || staleSimulationRefs.some(ref => hasEvidence(simulationFinality, ref))
      || !/partial result is explicitly labeled/i.test(jobClause?.then ?? '')
      || !/outcome UNKNOWN/i.test(jobClause?.then ?? '')
      || !/authoritative confirmation/i.test(jobClause?.then ?? '')
      || !/cancellation request or acknowledgement/i.test(jobClause?.rejection ?? '')) {
    addError(errors, 'AUD-SIM3-018 must bind partial-result and authoritative finality semantics to JOB-AC-03, without numerical-QA or synthetic-fixture clauses');
  }

  // Compatibility is fail-closed for every unknown or unlisted version; legacy
  // replacement requires exact owner-issued semantic-parity evidence.
  const educationCompatibility = rows?.find(row => row.auditId === 'AUD-EDU3-012');
  const compatibilityClauseRef = exactClauseRef('MEDIA-DECL-P0-AC-040');
  const compatibilityClause = sourceMeaning(compatibilityClauseRef);
  if (!educationCompatibility || !hasEvidence(educationCompatibility, compatibilityClauseRef)
      || !/only for exact AEF\/USP versions published in the public TutorPutor adapter contract/i.test(compatibilityClause?.then ?? '')
      || !/unknown or unlisted versions NOT_ADMITTED/i.test(compatibilityClause?.then ?? '')
      || !/private module imports.*silent data-contract upgrades.*blanket legacy support/i.test(compatibilityClause?.rejection ?? '')
      || !/exact owner-issued semantic-parity evidence/i.test(compatibilityClause?.rejection ?? '')) {
    addError(errors, 'AUD-EDU3-012 must bind AC-040 fail-closed compatibility boundaries for unknown/unlisted versions and exact owner parity');
  }
  for (const id of ['AUD-CLONE-012', 'AUD-ANIM3-010', 'AUD-SIM3-018', 'AUD-EDU3-012']) {
    const row = rows?.find(item => item.auditId === id);
    if (row?.decisionRef?.id !== 'PXD-174'
        || row?.decisionRef?.path !== '.product-experience/decision-log.md#PXD-174') {
      addError(errors, `${id} must cite the exact PXD-174 row-level source review reference`);
    }
  }

  const exactCaseRef = (family, suffix) => exactRequirementRef(family, `MEDIA-REQ-CAP-${family}-AC-${suffix}`);
  const requiredAuditCases = {
    'AUD-SPEC-013': exactRequirementRef('MEDIA-REQ-CAP-DELIVER','MEDIA-REQ-CAP-DELIVER-AC-03'),
    'AUD-SPEC-019': exactRequirementRef('MEDIA-REQ-CAP-QUALITY','MEDIA-REQ-CAP-QUALITY-AC-09'),
    'AUD-SPEC-020': '.product-experience/pdp-0-product-truth/campaign-extensions.yaml#records/@id=AUD-SPEC-020/requirementDefinition/acceptanceCases/@id=MEDIA-REQ-CAP-RULES-AC-01',
    'AUD-TTS-011': exactRequirementRef('MEDIA-REQ-CAP-SPEECH-SYNTHESIS','MEDIA-REQ-CAP-SPEECH-SYNTHESIS-AC-06'),
    'AUD-TTS-013': exactRequirementRef('MEDIA-REQ-CAP-SPEECH-SYNTHESIS','MEDIA-REQ-CAP-SPEECH-SYNTHESIS-AC-07'),
    'AUD-DUB-002': exactRequirementRef('MEDIA-REQ-CAP-SPEECH-TRANSCRIPTION','MEDIA-REQ-CAP-SPEECH-TRANSCRIPTION-AC-06'),
  };
  for (const [id, ref] of Object.entries(requiredAuditCases)) {
    const row = rows?.find(item => item.auditId === id);
    if (!row || row.disposition !== 'BOUND_EXISTING' || !hasEvidence(row, ref)) {
      addError(errors, `${id} must bind its exact feature-specific PDP-0 acceptance case ${ref}`);
    }
  }
  const exactCampaignExtensionRef = anchor => `.product-experience/pdp-0-product-truth/campaign-extensions.yaml#records/@id=AUD-SPEC-020/${anchor}`;
  const spec013 = rows?.find(row => row.auditId === 'AUD-SPEC-013');
  const spec013Handoffs = new Map((spec013?.laterPhaseHandoffs ?? []).map(handoff => [handoff.phase, handoff]));
  if (!spec013 || !['PDP-2', 'PDP-3'].every(phase => spec013Handoffs.has(phase))
      || !/variant selection/i.test(spec013Handoffs.get('PDP-2')?.scope ?? '')
      || !/preview/i.test(spec013Handoffs.get('PDP-2')?.scope ?? '')
      || !/full|complete/i.test(spec013Handoffs.get('PDP-3')?.scope ?? '')
      || !/deliver/i.test(spec013Handoffs.get('PDP-3')?.scope ?? '')) {
    addError(errors, 'AUD-SPEC-013 must hand off explicit PDP-2 variant selection/preview and PDP-3 full variant planning/delivery');
  }
  const spec019 = rows?.find(row => row.auditId === 'AUD-SPEC-019');
  const qualityRankTrustRef = '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerTrustReconstructionDispositions/records/@id=media.capability-trust-reconstruction.media-capability-adjudication-quality-rank.v1';
  const qualityRankCapabilityRef = '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.quality.rank';
  const qualityRankTrust = sourceMeaning(qualityRankTrustRef);
  const qualityAc09 = sourceMeaning(requiredAuditCases['AUD-SPEC-019']);
  const spec019Handoffs = new Map((spec019?.laterPhaseHandoffs ?? []).map(handoff => [handoff.phase, handoff]));
  if (!spec019 || !hasEvidence(spec019, qualityRankTrustRef) || !hasEvidence(spec019, qualityRankCapabilityRef)
      || !hasEvidence(spec019, requiredAuditCases['AUD-SPEC-019'])
      || qualityRankTrust?.capabilityRef !== 'media.quality.rank'
      || !/hard resource budget/i.test(qualityAc09?.given ?? '')
      || !/preserve the user's explicit selection/i.test(qualityAc09?.then ?? '')
      || !/new explicit selection/i.test(qualityAc09?.then ?? '')
      || !['PDP-2', 'PDP-3'].every(phase => spec019Handoffs.has(phase))
      || !/compare and select/i.test(spec019Handoffs.get('PDP-2')?.scope ?? '')
      || !/compare\/select\/reselect/i.test(spec019Handoffs.get('PDP-3')?.scope ?? '')
      || !/unknown/i.test(spec019Handoffs.get('PDP-3')?.scope ?? '')) {
    addError(errors, 'AUD-SPEC-019 must bind the exact media.quality.rank trust record and QUALITY-AC-09 budget/selection semantics with PDP-2/PDP-3 compare-select-reselect-unknown handoffs');
  }
  const spec020 = rows?.find(row => row.auditId === 'AUD-SPEC-020');
  const spec020RequiredRefs = [
    exactCampaignExtensionRef('capabilityDefinition'),
    exactCampaignExtensionRef('requirementDefinition'),
    exactCampaignExtensionRef('requirementDefinition/acceptanceCases/@id=MEDIA-REQ-CAP-RULES-AC-01'),
    exactCampaignExtensionRef('requirementDefinition/acceptanceCases/@id=MEDIA-REQ-CAP-RULES-AC-02'),
    exactCampaignExtensionRef('compileAcceptance'),
    exactCampaignExtensionRef('validationCoverage'),
    exactCampaignExtensionRef('validationCoverage/compileEquivalenceAndFingerprint'),
  ];
  const spec020Handoffs = new Map((spec020?.laterPhaseHandoffs ?? []).map(handoff => [handoff.phase, handoff]));
  const compileAcceptance = sourceMeaning(exactCampaignExtensionRef('compileAcceptance'));
  const validationCoverage = sourceMeaning(exactCampaignExtensionRef('validationCoverage'));
  const coverageDimensions = Object.keys(validationCoverage?.auditValidationDimensions ?? {});
  const compileCoverage = validationCoverage?.compileEquivalenceAndFingerprint;
  if (!spec020 || spec020RequiredRefs.some(ref => !hasEvidence(spec020, ref))
      || spec020.pdp0EvidenceRefs.some(ref => /MEDIA-REQ-CAP-PROFILE-AC-03/.test(ref))
      || compileAcceptance?.id !== 'AUD-SPEC-020-P0-COMPILE-AC-01'
      || !/equivalent normalized semantic graph/i.test(compileAcceptance?.criterion ?? '')
      || !/stable semantic fingerprint/i.test(compileAcceptance?.criterion ?? '')
      || !/invalid or unauthorized input produces no effects/i.test(compileAcceptance?.criterion ?? '')
      || !compileAcceptance?.outputs?.normalizedSemanticGraph
      || !compileAcceptance?.outputs?.semanticFingerprint
      || !compileAcceptance?.invalidOrUnauthorizedInput?.forbiddenEffects?.includes('operation-execution')
      || !['positive', 'negative', 'unavailable', 'UNKNOWN_or_explicit_NA', 'rights_license', 'manual_agent_parity_when_applicable', 'source_version_and_provenance'].every(key => coverageDimensions.includes(key))
      || compileCoverage?.compileAcceptanceId !== compileAcceptance?.id
      || compileCoverage?.compileAcceptanceRef !== exactCampaignExtensionRef('compileAcceptance')
      || compileCoverage?.criterionRef !== exactCampaignExtensionRef('compileAcceptance/criterion')
      || compileCoverage?.boundToNormalizedSemanticGraph !== true
      || compileCoverage?.boundToStableSemanticFingerprint !== true
      || !['PDP-1', 'PDP-2', 'PDP-3'].every(phase => spec020Handoffs.has(phase))) {
    addError(errors, 'AUD-SPEC-020 must bind campaign-extensions proposal, exact compile/equivalence/fingerprint acceptance and validation coverage map, omit PROFILE-AC-03, and hand off PDP-1/2/3');
  }
  for (const id of ['AUD-SPEC-013', 'AUD-SPEC-019', 'AUD-SPEC-020', 'AUD-DUB-002']) {
    const row = rows?.find(item => item.auditId === id);
    if (row?.decisionRef?.id !== 'PXD-185'
        || row?.decisionRef?.path !== '.product-experience/decision-log.md#PXD-185'
        || row?.decisionRef?.ownerApproval !== 'NOT_CLAIMED') {
      addError(errors, `${id} must cite PXD-185 as a coordinator source review with owner approval unclaimed`);
    }
  }
  const dub002 = rows?.find(row => row.auditId === 'AUD-DUB-002');
  const dubAc06 = sourceMeaning(requiredAuditCases['AUD-DUB-002']);
  const dubHandoffs = new Map((dub002?.laterPhaseHandoffs ?? []).map(handoff => [handoff.phase, handoff]));
  if (!dub002 || !/absent or unknown/i.test(dubAc06?.then ?? '')
      || !/not applicable only with an explicit reason/i.test(dubAc06?.then ?? '')
      || !['PDP-2', 'PDP-3'].every(phase => dubHandoffs.has(phase))
      || !/selection controls/i.test(dubHandoffs.get('PDP-2')?.scope ?? '')
      || !/complete translation journey/i.test(dubHandoffs.get('PDP-3')?.scope ?? '')) {
    addError(errors, 'AUD-DUB-002 must preserve strengthened AC-06 absent/unknown evidence and split PDP-2 selection from PDP-3 journey handoffs');
  }
  const exactClauseCaseRefs = {
    'AUD-EDIT-007': exactRecorderClauseRef('MEDIA-REC-P0-AC-080'),
    'AUD-INTER-005': exactClauseRef('MEDIA-DECL-P0-AC-061'),
    'AUD-TRUST-016': exactClauseRef('MEDIA-DECL-P0-AC-057'),
    'AUD-OPS-016': exactClauseRef('MEDIA-DECL-P0-AC-058'),
    'AUD-OPS-018': exactClauseRef('MEDIA-DECL-P0-AC-057'),
  };
  for (const [id, ref] of Object.entries(exactClauseCaseRefs)) {
    if (!hasEvidence(rows?.find(item => item.auditId === id), ref)) addError(errors, `${id} must bind the exact PDP-0 product boundary ${ref}`);
  }
  const edit007 = rows?.find(row => row.auditId === 'AUD-EDIT-007');
  const soloCapabilityRef = exactCapabilityRef('media.animation.editing.track.solo');
  if (!edit007 || !hasEvidence(edit007, soloCapabilityRef)
      || edit007.disposition !== 'BOUND_EXISTING'
      || !/does not define track lock or effects bypass/i.test(edit007.phaseLocalRationale ?? '')
      || edit007.laterPhaseHandoffs?.ownerPhase !== 'PDP-1'
      || !/track-lock-and-effects-bypass-operation-semantics/.test(edit007.laterPhaseHandoffs?.gap ?? '')) {
    addError(errors, 'AUD-EDIT-007 must scope AC-080 and the exact track-solo capability to solo meaning while preserving lock/effects-bypass and all-edit parity in the PDP-1 handoff');
  }
  const exchangePackageRef = '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.animation.output.output.exchange-package';
  if (!hasEvidence(rows?.find(item => item.auditId === 'AUD-ANIM3-016'), exchangePackageRef)) {
    addError(errors, 'AUD-ANIM3-016 must bind the editable exchange-package capability, not composited-video output alone');
  }
  for (const id of ['AUD-CROSS3-007','AUD-OPS-020']) {
    const row = rows?.find(item => item.auditId === id);
    if (row?.disposition !== 'POST_PDP_IMPLEMENTATION_ONLY' || (row.pdp0EvidenceRefs ?? []).length !== 0
        || !(row.laterPhaseHandoffs ?? []).some(handoff => /BUILD/.test(handoff.phase ?? ''))) {
      addError(errors, `${id} is implementation/reproducibility work and must not be represented as a PDP-0 semantic match`);
    }
  }

  const derivedHandoffCounts = {};
  for (const row of rows ?? []) {
    const raw = row.laterPhaseHandoffs;
    const handoffs = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const labels = [...new Set(handoffs.map(handoff => handoff.ownerPhase ?? handoff.phase ?? handoff.stage).filter(Boolean))].sort();
    const key = labels.join('/') || 'UNSPECIFIED';
    derivedHandoffCounts[key] = (derivedHandoffCounts[key] ?? 0) + 1;
  }
  if (JSON.stringify(derivedHandoffCounts) !== JSON.stringify(ledger.laterPhaseHandoffs?.countsByPhase)) {
    addError(errors, 'laterPhaseHandoffs.countsByPhase must equal the current per-row handoff-label aggregation');
  }
  const derivedCounts = Object.fromEntries([...dispositions].map(disposition => [disposition, rows?.filter(row => row.disposition === disposition).length ?? 0]));
  for (const [disposition, count] of Object.entries(derivedCounts)) {
    if (ledger.dispositionCounts?.[disposition] !== count) addError(errors, `dispositionCounts mismatch for ${disposition}`);
  }
  if (Object.keys(ledger.dispositionCounts ?? {}).some(disposition => !dispositions.has(disposition))) addError(errors, 'dispositionCounts contains unsupported vocabulary');
  if (ledger.denominator?.expectedOriginalAuditIds !== 428 || ledger.denominator?.expectedThirdPassAuditIds !== 73 || ledger.denominator?.expectedUniqueIds !== 501) addError(errors, 'denominator must declare exact 428 + 73 = 501 source populations');

  return {errors, stats:{original:originalIds.length, focused:focusedIds.length, total:seen.size,
    dispositionCounts:Object.fromEntries([...dispositions].map(d=>[d, rows?.filter(r=>r.disposition===d).length ?? 0])),
    coordinatorReview:ledger.coordinatorReview?.status ?? 'MISSING'}};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = validatePdp0AuditDispositions();
  if (result.errors.length) {
    for (const error of result.errors) console.error(error);
    console.error(JSON.stringify({status:'FAIL', ...result.stats}, null, 2));
    process.exitCode = 1;
  } else console.log(JSON.stringify({status:'SOURCE_DISPOSITION_VALIDATION_PASS', ...result.stats}, null, 2));
}
