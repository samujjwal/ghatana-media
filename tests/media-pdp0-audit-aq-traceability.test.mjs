import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildPdp0AuditAqTraceability, validatePdp0AuditAqTraceability, PDP0_AUDIT_AQ_TRACEABILITY_PATH} from '../scripts/check-media-pdp0-audit-aq-traceability.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('audit traceability preserves all 501 source IDs and has no missing exact PDP-0 joins', () => {
  const artifact = JSON.parse(fs.readFileSync(path.join(root, PDP0_AUDIT_AQ_TRACEABILITY_PATH), 'utf8'));
  const crosswalk = JSON.parse(fs.readFileSync(path.join(root, 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json'), 'utf8'));
  const expected = buildPdp0AuditAqTraceability();
  assert.equal(artifact.rows.length, 501);
  assert.deepEqual(artifact.rows.filter(row => row.proposalDefinition).map(row => row.auditId).sort(), ['AUD-OPS-021', 'AUD-SPEC-020']);
  for (const row of artifact.rows.filter(item => item.proposalDefinition)) {
    assert.equal(row.traceabilityStatus, 'SOURCE_BOUND_COORDINATOR_PDP0_PROPOSAL_PENDING_OWNER_REVIEW');
    assert.deepEqual(row.canonicalCapabilityRefs, [], `${row.auditId} proposal is not a canonical capability claim`);
    assert.deepEqual(row.canonicalRequirementRefs, [], `${row.auditId} proposal is not a canonical requirement claim`);
    assert.equal(row.proposalDefinition.ownerApproval, 'NOT_CLAIMED');
    assert.equal(row.proposalDefinition.independentAcceptance, 'NOT_CLAIMED');
  }
  assert.deepEqual(artifact.rows.map(row => row.auditId), expected.rows.map(row => row.auditId));
  assert.deepEqual(artifact.rows, expected.rows);
  assert.equal(new Set(artifact.rows.map(row => row.auditId)).size, 501);
  assert.ok(artifact.rows.every(row => row.sourceTextRef && row.sourceFeatureText && row.sourceAcceptanceText));
  for (const source of crosswalk.rows) {
    const projected = artifact.rows.find(row => row.auditId === source.auditId);
    assert.equal(projected.sourceFeatureText, source.sourceText, `${source.auditId} feature text`);
    assert.equal(projected.sourceAcceptanceText, source.sourceAcceptanceText, `${source.auditId} acceptance text`);
    assert.equal(projected.disposition, source.disposition, `${source.auditId} disposition`);
    assert.deepEqual(projected.laterPhaseHandoffs, source.laterPhaseHandoffs ?? null, `${source.auditId} phase ownership`);
  }
});

test('exact requirement cases and capability scoped Recorder/declarative cases retain their relation class', () => {
  const artifact = JSON.parse(fs.readFileSync(path.join(root, PDP0_AUDIT_AQ_TRACEABILITY_PATH), 'utf8'));
  const productDemo = artifact.rows.find(row => row.auditId === 'AUD-SPEC-001');
  assert.ok(productDemo.canonicalCapabilityRefs.includes('.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.recipe.specification.compile'));
  assert.ok(productDemo.acceptanceCaseRefs.includes('.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE/acceptanceCases/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-07'));
  assert.equal(productDemo.acceptanceCaseRelation, 'EXACT_AUDIT_ROW_EVIDENCE');
  assert.ok(productDemo.canonicalRequirementRefs.includes('.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-RECIPE-TEMPLATE'));
  assert.ok(artifact.rows.every(row => row.acceptanceCaseCandidates === undefined));
});

test('PDP-0 joins, family scope, implementation handoffs, and A–Q recommendations remain distinct', () => {
  const artifact = JSON.parse(fs.readFileSync(path.join(root, PDP0_AUDIT_AQ_TRACEABILITY_PATH), 'utf8'));
  const expected = buildPdp0AuditAqTraceability();
  assert.deepEqual(artifact.clusters, expected.clusters);
  assert.deepEqual(artifact.denominators, expected.denominators);
  assert.equal(artifact.clusters.length, expected.denominators.blueprintClusters);
  assert.ok(artifact.clusters.every(cluster => cluster.mappingStatus === 'COORDINATOR_RECOMMENDATION_PENDING_OWNER_ACCEPTANCE'));
  assert.equal(artifact.denominators.originalRowsWithClusterRecommendation,
    artifact.rows.filter(row => row.clusterMembership.status === 'COORDINATOR_RECOMMENDATION_PENDING_OWNER_ACCEPTANCE').length);
  assert.equal(artifact.denominators.focusedRowsOutsideClusterTaxonomy,
    artifact.rows.filter(row => row.clusterMembership.status === 'EXPLICIT_OUTSIDE_ORIGINAL_AQ_AUDIT_SCOPE').length);
  assert.equal(artifact.denominators.canonicalCapabilityLeaves, artifact.capabilityMappings.length);
  assert.equal(artifact.denominators.proposalExtensionLeaves, artifact.definitionExtensions.length);
  assert.equal(artifact.denominators.capabilityLeavesWithClusterRecommendation + artifact.denominators.capabilityLeavesWithoutClusterRecommendation,
    artifact.capabilityMappings.length);
  assert.equal(artifact.denominators.capabilityLeavesWithExactAuditClusterTrace + artifact.denominators.capabilityLeavesWithoutExactAuditClusterTrace,
    artifact.capabilityMappings.length);
  assert.equal(artifact.denominators.rowsWithCoordinatorProposalDefinitionJoin,
    artifact.rows.filter(row => row.proposalDefinition).length);
  assert.equal(artifact.denominators.rowsOutsidePdp0DefinitionJoinAsImplementationOnly,
    artifact.rows.filter(row => row.traceabilityStatus === 'POST_PDP_IMPLEMENTATION_ONLY_OUTSIDE_PDP0_SEMANTIC_JOIN').length);
  assert.equal(artifact.denominators.rowsBlockedMissingExactJoin,
    artifact.rows.filter(row => row.traceabilityStatus === 'BLOCKED_MISSING_EXACT_JOIN').length);
  assert.equal(artifact.definitionExtensions.length, 7);
  assert.deepEqual(artifact.definitionExtensions.map(item => item.capabilityId), [
    'media.recipe.specification.compile',
    'media.project.scene.patch-merge',
    'media.quality.audio.content-similarity.assess',
    'media.generate.video.preset.manage',
    'media.generate.video.shot-condition',
    'media.job.schedule.manage',
    'media.master.audio.creative-effect.apply',
  ]);
  assert.ok(artifact.definitionExtensions.every(item => item.disposition === 'COORDINATOR_AUTHORED_PROPOSAL_PENDING_OWNER_REVIEW'
    && item.ownerApproval === 'NOT_CLAIMED' && item.independentAcceptance === 'NOT_CLAIMED'
    && item.admittedToHistoricalOwnerAdjudication === false && item.executionAdmission === 'NOT_ADMITTED'
    && item.acceptanceCaseRefs.length > 0 && item.sourceAuditIds.length > 0 && item.sourceAuditRefs.length === item.sourceAuditIds.length));
  assert.deepEqual(artifact.capabilityMappings.map(item => item.sourceOrder1Based), Array.from({length: artifact.capabilityMappings.length}, (_, index) => index + 1));
  assert.equal(new Set(artifact.capabilityMappings.map(item => item.capabilityId)).size, artifact.capabilityMappings.length);
  assert.ok(artifact.capabilityMappings.every(item => item.capabilitySourceRef === `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${item.capabilityId}`));
  assert.ok(artifact.capabilityMappings.every(item => item.parentRequirementSourceRef === `.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=${item.parentRequirementId}`));
  assert.ok(artifact.capabilityMappings.every(item => item.status === 'COORDINATOR_MAPPING_RECOMMENDATION_PENDING_OWNER_ACCEPTANCE' && item.ownerAcceptance === 'NOT_CLAIMED'));
  assert.ok(artifact.capabilityMappings.filter(item => !item.auditIds.length).every(item => item.auditTraceStatus === 'NO_EXACT_AUDIT_CAPABILITY_REFERENCE'));
  assert.ok(artifact.clusters.every(cluster => cluster.recommendedCapabilityIds.length > 0));
  assert.ok(artifact.rows.filter(row => row.sourcePartition === 'originalAudit').every(row =>
    row.clusterMembership.primaryCluster && row.clusterMembership.rationale && row.clusterMembership.ownerAcceptance === 'NOT_CLAIMED'));
  assert.ok(artifact.rows.filter(row => row.sourcePartition === 'focusedAudit').every(row =>
    row.clusterMembership.status === 'EXPLICIT_OUTSIDE_ORIGINAL_AQ_AUDIT_SCOPE'
      && /excludes it only from that original cluster taxonomy/u.test(row.clusterMembership.rationale)
      && /PDP-0 product applicability/u.test(row.clusterMembership.rationale)));
  const unbound = artifact.blockerSummary.unboundAcceptanceClauses.map(item => item.caseId);
  assert.deepEqual(unbound, []);
  const orphanFeature = artifact.rows.find(row => row.auditId === 'AUD-EDIT-007');
  assert.ok(orphanFeature.canonicalCapabilityRefs.includes('.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.animation.editing.track.solo'));
  assert.ok(orphanFeature.acceptanceCaseCandidateRefs.includes('.product-experience/pdp-0-product-truth/requirements.yaml#recorderStudioProfile/acceptanceClauses/@id=MEDIA-REC-P0-AC-080'));
  assert.equal(orphanFeature.sourceFeatureText, 'Clip/track mute solo lock and effects bypass');
  const clone = artifact.rows.find(row => row.auditId === 'AUD-CLONE-012');
  assert.ok(clone.canonicalCapabilityRefs.includes('.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.quality.inspect'));
  assert.equal(clone.capabilityScopeDisposition, 'PARENT_REQUIREMENT_FAMILY_SCOPE_ONLY');
  assert.equal(clone.traceabilityStatus, 'SOURCE_BOUND_FAMILY_SCOPE_ONLY_EXACT_CASE');
  assert.ok(clone.capabilityRefRelations.some(relation => relation.relation === 'PARENT_REQUIREMENT_FAMILY_SCOPE_ONLY'));
  assert.ok(clone.acceptanceCaseRefs.includes('.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-QUALITY/acceptanceCases/@id=MEDIA-REQ-CAP-QUALITY-AC-06'));
  assert.ok(clone.phaseLocalRationale.includes('no watermark-specific capability claim'));
  assert.deepEqual(artifact.capabilityMappings.find(item => item.capabilityId === 'media.quality.inspect').familyScopeAuditIds, ['AUD-CLONE-012']);
  const implementationOnly = ['AUD-OPS-020', 'AUD-CROSS3-007'].map(id => artifact.rows.find(row => row.auditId === id));
  for (const row of implementationOnly) {
    assert.equal(row.traceabilityStatus, 'POST_PDP_IMPLEMENTATION_ONLY_OUTSIDE_PDP0_SEMANTIC_JOIN');
    assert.deepEqual(row.canonicalCapabilityRefs, []);
    assert.deepEqual(row.canonicalRequirementRefs, []);
    assert.deepEqual(row.acceptanceCaseRefs, []);
    assert.deepEqual(row.excludedPdp0JoinTypes, ['canonicalCapability', 'canonicalRequirement', 'acceptanceCase']);
    assert.ok(row.laterPhaseHandoffs.some(handoff => handoff.phase === 'BUILD'));
  }
  const cross3 = artifact.rows.find(row => row.auditId === 'AUD-CROSS3-007');
  assert.match(cross3.clusterMembership.rationale, /excludes it only from that original cluster taxonomy/u);
  assert.match(cross3.clusterMembership.rationale, /post-PDP implementation with no PDP-0 joins/u);
  assert.doesNotMatch(cross3.clusterMembership.rationale, /retains its exact PDP-0 capability/u);
  assert.deepEqual(artifact.blockerSummary.auditCaseJoins, []);
  assert.deepEqual(artifact.blockerSummary.postPdpImplementationOnlyRows.map(item => item.auditId), ['AUD-OPS-020', 'AUD-CROSS3-007']);
  assert.deepEqual(artifact.blockerSummary.familyScopeOnlyRows.map(item => item.auditId), ['AUD-CLONE-012']);
  const creativeEffects = artifact.rows.find(row => row.auditId === 'AUD-DSP-007');
  assert.equal(creativeEffects.disposition, 'BOUND_EXISTING');
  assert.equal(creativeEffects.ownerApproval, 'NOT_CLAIMED');
  assert.equal(creativeEffects.traceabilityStatus, 'SOURCE_BOUND_COMPLETE');
  assert.deepEqual(creativeEffects.missingExactJoins, []);
  assert.ok(creativeEffects.canonicalCapabilityRefs.includes('.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.master.audio.creative-effect.apply'));
  assert.ok(creativeEffects.acceptanceCaseRefs.includes('.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-MASTER-AUDIO/acceptanceCases/@id=MEDIA-REQ-CAP-MASTER-AUDIO-AC-03'));
  assert.equal(artifact.rows.filter(row => row.traceabilityStatus === 'BLOCKED_MISSING_EXACT_JOIN').length, 0);
  assert.ok(artifact.definitionExtensions.every(item => item.ownerApproval === 'NOT_CLAIMED' && item.independentAcceptance === 'NOT_CLAIMED'));
  assert.ok(artifact.rows.every(row => row.ownerApproval === 'NOT_CLAIMED'));
  const captionImportExport = artifact.rows.find(row => row.auditId === 'AUD-ASSET-012');
  assert.equal(captionImportExport.disposition, 'BOUND_EXISTING');
  assert.ok(captionImportExport.canonicalCapabilityRefs.includes('.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.artifact.import'));
  assert.ok(captionImportExport.acceptanceCaseRefs.includes('.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-ARTIFACT/acceptanceCases/@id=MEDIA-REQ-CAP-ARTIFACT-AC-08'));
  assert.ok(captionImportExport.canonicalCapabilityRefs.includes('.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.deliver.subtitles'));
  assert.ok(captionImportExport.acceptanceCaseRefs.includes('.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-DELIVER/acceptanceCases/@id=MEDIA-REQ-CAP-DELIVER-AC-04'));
  assert.equal(captionImportExport.sourceAcceptanceText, 'Assets reopen by immutable version and hash; thumbnails and searchable indexes are derived under purpose/tenant controls, not duplicate sources.');
  assert.equal(captionImportExport.ownerApproval, 'NOT_CLAIMED');
});

test('context refs and canonical profile capabilityLeafId edges are retained with explicit relation classes', () => {
  const artifact = JSON.parse(fs.readFileSync(path.join(root, PDP0_AUDIT_AQ_TRACEABILITY_PATH), 'utf8'));
  const contextMapped = artifact.rows.find(row => row.capabilityRefRelations.some(relation => relation.relation === 'EXACT_PDP0_CONTEXT_REFERENCE'));
  const clauseMapped = artifact.rows.find(row => row.capabilityRefRelations.some(relation => relation.relation === 'EXACT_CAPABILITY_LEAF_ID_ON_PDP0_CASE'));
  assert.ok(contextMapped, 'at least one exact capability context ref is projected');
  assert.ok(clauseMapped, 'at least one exact capabilityLeafId case edge is projected');
  assert.ok(contextMapped.capabilityRefRelations.filter(relation => relation.relation === 'EXACT_PDP0_CONTEXT_REFERENCE').every(relation =>
    contextMapped.canonicalCapabilityRefs.includes(relation.sourceRef)));
  assert.ok(clauseMapped.capabilityRefRelations.filter(relation => relation.relation === 'EXACT_CAPABILITY_LEAF_ID_ON_PDP0_CASE').every(relation =>
    clauseMapped.canonicalCapabilityRefs.includes(relation.sourceRef)));
});

test('traceability validator verifies source pins and source disposition ledger', () => {
  const result = validatePdp0AuditAqTraceability();
  assert.deepEqual(result.errors, []);
  assert.equal(result.stats.totalRows, 501);
  assert.equal(result.stats.rowsWithPdp0DefinitionJoin, 499);
  assert.equal(result.stats.postPdpImplementationOnlyRows, 2);
  assert.equal(result.stats.familyScopeOnlyRows, 1);
  assert.equal(result.stats.blockedRows, 0);
  assert.equal(result.stats.unresolvedExactJoinRows, 0);
  const expected = buildPdp0AuditAqTraceability();
  assert.equal(result.stats.clusterMappingsPendingOwnerAcceptance, expected.clusters.length);
  assert.equal(result.stats.capabilityLeaves, expected.capabilityMappings.length);
  assert.equal(result.stats.proposalExtensionLeaves, expected.definitionExtensions.length);
  assert.equal(result.stats.dispositionCrosswalkValid, true);
  const modified = buildPdp0AuditAqTraceability();
  modified.rows[0].acceptanceCaseCandidateRefs = ['__invalid_acceptance_ref__'];
  assert.ok(validatePdp0AuditAqTraceability({artifact: modified}).errors.some(error => /audit row joins/u.test(error)));
});
