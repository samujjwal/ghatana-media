#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json';
export const PDP0_AUDIT_SOURCE_PATH = 'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json';
const dispositions = new Set([
  'BOUND_EXISTING', 'PDP0_MEANING_CHANGE_REQUIRED', 'EXPLICIT_NOT_APPLICABLE',
  'POST_PDP_IMPLEMENTATION_ONLY', 'BLOCKED_EXTERNAL_OWNER_DECISION',
]);
const requireFromTools = createRequire(path.resolve(root, '../ghatana-tools/package.json'));
const parseYaml = requireFromTools('yaml').parse;

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
        const expectedResolution = recommendation === 'REFINE_EXISTING_P0'
          ? 'RESOLVED_IN_CURRENT_PDP0_SOURCE'
          : recommendation === 'BOUND_EXISTING'
            ? 'NO_ADDITIONAL_PDP0_MEANING'
            : id === 'AUD-SIM3-010'
              ? 'CURRENT_SOURCE_MEANING_COVERED_QUALIFIED_CLAIM_VALIDATION_DOWNSTREAM'
              : 'CONDITIONAL_PDP0_MEANING_DOWNSTREAM_AUTHORITY_REQUIRED';
        if (!resolution || resolution.resolution !== expectedResolution
            || resolution.currentSourceReviewRef !== '.product-experience/decision-log.md#PXD-167'
            || resolution.ownerApproval !== 'NOT_CLAIMED'
            || JSON.stringify([...(resolution.currentSourceEvidenceRefs ?? [])].sort()) !== JSON.stringify([...evidenceRefs].sort())) {
          addError(errors, `${id}: independent QC disposition needs an exact current-source reconciliation, evidence set, PXD-167 review ref, and unclaimed owner approval`);
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
    for (const ref of [row.sourceTextRef, row.reviewProvenance, row.independentQcRef, ...(row.pdp0EvidenceRefs ?? []), ...(row.pdp0ContextRefs ?? [])]) {
      if (typeof ref === 'string' && ref.includes('#')) referencedFiles.add(ref.slice(0, ref.indexOf('#')));
    }
  }
  for (const file of referencedFiles) if (!Object.hasOwn(fingerprintMap ?? {}, file)) addError(errors, `referenced source is not fingerprinted: ${file}`);
  const originalIds = [...sourceRows].filter(([,v])=>v.partition==='originalAudit').map(([id])=>id);
  const focusedIds = [...sourceRows].filter(([,v])=>v.partition==='focusedAudit').map(([id])=>id);
  if (rows?.filter(r=>r.sourcePartition==='originalAudit').length !== 428) addError(errors, 'crosswalk must contain exactly 428 originalAudit rows');
  if (rows?.filter(r=>r.sourcePartition==='focusedAudit').length !== 73) addError(errors, 'crosswalk must contain exactly 73 focusedAudit rows');
  const softBody = rows?.find(row => row.auditId === 'AUD-SIM3-009');
  const specializedSimulationRefs = [
    '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.simulation.cloth',
    '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.simulation.soft-body',
    '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.simulation.rope',
    '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.simulation.particle',
    '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.simulation.fluid',
  ];
  if (!softBody || specializedSimulationRefs.some(ref => !(softBody.pdp0EvidenceRefs ?? []).includes(ref))) addError(errors, 'AUD-SIM3-009 must cite all five exact specialized PDP-0 simulation capability identities');
  const agentScope = rows?.find(row => row.auditId === 'AUD-SIM3-010');
  const agentQcRef = 'docs/implementation/observations/pdp0-semantic-audit-slices/meaning-gap-qc.json#records/@sourceAuditId=AUD-SIM3-010';
  const agentEvidenceRefs = [
    '.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-SIMULATION/acceptanceCases/@id=MEDIA-REQ-CAP-SIMULATION-AC-03',
    '.product-experience/pdp-0-product-truth/requirements.yaml#declarativeProductionProfile/acceptanceClauses/@id=MEDIA-DECL-P0-AC-034',
  ];
  if (!agentScope || agentScope.disposition !== 'BOUND_EXISTING'
      || agentScope.independentQcRef !== agentQcRef
      || agentEvidenceRefs.some(ref => !(agentScope.pdp0EvidenceRefs ?? []).includes(ref))
      || agentScope.independentQcDispositionResolution?.resolution !== 'CURRENT_SOURCE_MEANING_COVERED_QUALIFIED_CLAIM_VALIDATION_DOWNSTREAM'
      || agentScope.decisionRef?.id !== 'PXD-167'
      || !/UNQUALIFIED/i.test(agentScope.conditionalProductScope ?? '')
      || !(agentScope.laterPhaseHandoffs ?? []).some(handoff => handoff.phase === 'PDP-1' && /PRNG/.test(handoff.scope ?? ''))
      || !(agentScope.downstreamApprovalHandoffs ?? []).some(handoff => /qualified scientific validation/i.test(handoff.requiredAction ?? ''))) {
    addError(errors, 'AUD-SIM3-010 must cite exact current AC-03 and AC-034 meaning, keep unqualified scope explicit, and hand off typed PRNG and qualified-claim validation downstream');
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
