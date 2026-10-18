import test from 'node:test';
import assert from 'node:assert/strict';
import { readSources, validatePdp0SurfaceDenominator } from '../scripts/check-media-pdp0-surface-denominator.mjs';

const sourceBaseline = readSources();
const cloneSources = () => structuredClone(sourceBaseline);
const codes = (result) => result.findings.map((finding) => finding.code);

test('PDP-0 denominator recomputes exact source populations and validates current source refs', () => {
  const { registry, topology } = cloneSources();
  const result = validatePdp0SurfaceDenominator(registry, topology);
  assert.equal(result.ok, true);
  assert.deepEqual(result.stats, {
      physicalManifestCandidates: 26,
      compositions: 7,
      logicalConsumers: 21,
      registrySurfaces: 21,
      archivedConsumers: 1,
      activeLogicalConsumers: 20,
      activeLogicalScopesResolved: 20,
      applicablePhysicalPdp0: 15,
      notApplicableSupportPhysicalPdp0: 8,
      noImplementationAdmittedPhysicalPdp0: 3,
      denominator: 54,
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.consumerScopes.length, 20);
});

test('rejects duplicate consumer identities', () => {
  const { registry, topology } = cloneSources();
  topology.consumerCrosswalk.push(structuredClone(topology.consumerCrosswalk[0]));
  assert.ok(codes(validatePdp0SurfaceDenominator(registry, topology)).includes('CONSUMER_ID_DUPLICATE'));
});

test('rejects a missing consumer surface and a missing registry mapping', () => {
  const { registry, topology } = cloneSources();
  const missing = topology.consumerCrosswalk.findIndex((row) => row.surfaceId === 'media.surface.sdk');
  topology.consumerCrosswalk.splice(missing, 1);
  const result = validatePdp0SurfaceDenominator(registry, topology);
  assert.ok(codes(result).includes('REGISTRY_CONSUMER_UNMAPPED'));
  const { registry: registry2, topology: topology2 } = cloneSources();
  topology2.consumerCrosswalk[0].surfaceId = 'media.surface.missing';
  assert.ok(codes(validatePdp0SurfaceDenominator(registry2, topology2)).includes('CONSUMER_REGISTRY_MISSING'));
});

test('rejects missing and unknown physical PDP-0 dispositions', () => {
  for (const disposition of [undefined, 'PDP-1_ONLY']) {
    const { registry, topology } = cloneSources();
    const physical = topology.manifestCandidates[0];
    if (disposition === undefined) delete physical.phaseApplicability['PDP-0'];
    else physical.phaseApplicability['PDP-0'].disposition = disposition;
    assert.ok(codes(validatePdp0SurfaceDenominator(registry, topology)).includes('PHYSICAL_PDP0_DISPOSITION'));
  }
});

test('rejects non-applicable physical/composite rows without rationale', () => {
  const { registry, topology } = cloneSources();
  const support = topology.manifestCandidates.find((row) => row.phaseApplicability['PDP-0'].disposition === 'NOT_APPLICABLE_SUPPORT');
  support.phaseApplicability['PDP-0'].rationale = '  ';
  const result = validatePdp0SurfaceDenominator(registry, topology);
  assert.ok(codes(result).includes('PHYSICAL_PDP0_RATIONALE'));
  const { registry: registry2, topology: topology2 } = cloneSources();
  topology2.compositions[1].phaseApplicability['PDP-0'].rationale = '';
  assert.ok(codes(validatePdp0SurfaceDenominator(registry2, topology2)).includes('COMPOSITION_PDP0_RATIONALE'));
});

test('requires source-backed direct meaning refs for applicable compositions', () => {
  const { registry, topology } = cloneSources();
  const composite = topology.compositions.find((row) => row.phaseApplicability['PDP-0'].disposition === 'DIRECT_CROSS_CHILD_MEANING');
  composite.phaseApplicability['PDP-0'].requirementIds = [];
  composite.phaseApplicability['PDP-0'].capabilityFamilyIds = [];
  composite.phaseApplicability['PDP-0'].capabilityIntentIds = [];
  composite.phaseApplicability['PDP-0'].intentIds = [];
  const result = validatePdp0SurfaceDenominator(registry, topology);
  assert.ok(codes(result).includes('COMPOSITION_PDP0_REFS'));
});

test('requires physical authority source refs to exist', () => {
  const { registry, topology } = cloneSources();
  const physical = topology.manifestCandidates.find((row) => row.phaseApplicability['PDP-0'].disposition === 'APPLICABLE');
  physical.phaseApplicability['PDP-0'].authorityRef = '.product-experience/not-a-real-pdp0-authority.yaml';
  assert.ok(codes(validatePdp0SurfaceDenominator(registry, topology)).includes('SOURCE_REF_MISSING'));
});

test('resolves all active logical consumers through source-current exact PDP-0 scopes', () => {
  const { registry, topology, authority } = cloneSources();
  const result = validatePdp0SurfaceDenominator(registry, topology, authority);
  assert.equal(result.stats.activeLogicalConsumers, 20);
  assert.equal(result.stats.activeLogicalScopesResolved, 20);
  assert.equal(result.ok, true);
});

test('keeps generic Web partition exact and records delegated Studio scope without owner-approval claims', () => {
  const { registry, topology, authority } = cloneSources();
  const web = authority.applications.channels.find((channel) => channel.id === 'media.channel.web').ownerDefinitionApplicability;
  const applicable = web.familyConsumers.flatMap((family) => family.webApplicableCapabilityRefs ?? []);
  const nonApplicable = web.familyConsumers.flatMap((family) => family.webNonApplicableCapabilityRefs ?? []);
  const studioRecord = web.consumerSpecificApplicability.records.find((record) => record.surfaceRef === 'media.surface.production-studio');
  const studioScope = authority.applications.logicalConsumerPdp0Scope.records.find((record) => record.surfaceRef === 'media.surface.production-studio');
  const profileGroups = [...new Set(authority.recorderStudio.featureProfiles
    .filter((profile) => profile.ownerSurface === 'media.surface.production-studio')
    .map((profile) => profile.ownerCapabilityGroup))];
  const profileLeafIds = [...new Set(profileGroups.flatMap((group) => authority.recorderStudio.capabilityBindings[group] ?? []))];
  assert.equal(applicable.length, 77);
  assert.equal(nonApplicable.length, 385);
  assert.equal(new Set([...applicable, ...nonApplicable]).size, 462);
  assert.equal(applicable.some((id) => nonApplicable.includes(id)), false);
  assert.deepEqual([...studioRecord.capabilityIntentRefs].sort(), [...profileLeafIds].filter((id) => nonApplicable.includes(id)).sort());
  assert.equal(studioRecord.capabilityIntentRefs.length, 15);
  assert.equal(studioRecord.status, 'DELEGATED_SOURCE_DEFINITION_SELECTION; DEFINITION_ONLY');
  assert.match(studioRecord.rationale, /owner approval.*not implied/i);
  assert.match(authority.applications.logicalConsumerPdp0Scope.authority, /source-definition-coordinator/);
  assert.match(authority.applications.logicalConsumerPdp0Scope.status, /owner-acceptance-and-runtime-admission-pending/);
  assert.match(studioScope.consumerApplicabilityRef, /consumerSpecificApplicability/);
  assert.equal(validatePdp0SurfaceDenominator(registry, topology, authority).ok, true);

  const mutation = cloneSources();
  mutation.authority.applications.channels.find((channel) => channel.id === 'media.channel.web')
    .ownerDefinitionApplicability.consumerSpecificApplicability.records[0].capabilityIntentRefs.pop();
  assert.ok(codes(validatePdp0SurfaceDenominator(mutation.registry, mutation.topology, mutation.authority)).includes('PDP0_WEB_CONSUMER_APPLICABILITY'));

  const falseOwnerApproval = cloneSources();
  falseOwnerApproval.authority.applications.logicalConsumerPdp0Scope.status = 'OWNER_APPROVED';
  assert.ok(codes(validatePdp0SurfaceDenominator(falseOwnerApproval.registry, falseOwnerApproval.topology, falseOwnerApproval.authority)).includes('PDP0_SCOPE_AUTHORITY_BOUNDARY'));

  const staleScopeContract = cloneSources();
  staleScopeContract.authority.applications.logicalConsumerPdp0Scope.status = 'SOURCE_CURRENT_DEFINITION_SCOPE; acceptance-and-admission-pending';
  const staleResult = validatePdp0SurfaceDenominator(staleScopeContract.registry, staleScopeContract.topology, staleScopeContract.authority);
  assert.ok(codes(staleResult).includes('PDP0_SCOPE_AUTHORITY_BOUNDARY'));
  assert.equal(staleResult.stats.activeLogicalScopesResolved, 0);
});

test('rejects a missing or duplicate logical-consumer scope record', () => {
  const missing = cloneSources();
  missing.authority.applications.logicalConsumerPdp0Scope.records = missing.authority.applications.logicalConsumerPdp0Scope.records.filter((record) => record.surfaceRef !== 'media.surface.agent-tools');
  const missingResult = validatePdp0SurfaceDenominator(missing.registry, missing.topology, missing.authority);
  assert.ok(codes(missingResult).includes('CONSUMER_PDP0_SCOPE_MISSING'));
  assert.equal(missingResult.stats.activeLogicalScopesResolved, 19);

  const duplicate = cloneSources();
  duplicate.authority.applications.logicalConsumerPdp0Scope.records.push(structuredClone(duplicate.authority.applications.logicalConsumerPdp0Scope.records[0]));
  assert.ok(codes(validatePdp0SurfaceDenominator(duplicate.registry, duplicate.topology, duplicate.authority)).includes('CONSUMER_PDP0_SCOPE_DUPLICATE'));
});

test('rejects duplicate channel candidates and missing agent/event surface bindings', () => {
  const duplicate = cloneSources();
  duplicate.registry.channelSurfaceProposals.mappings.find((mapping) => mapping.channelRef === 'media.channel.agent').candidateSurfaceRefs.push('media.surface.agent-tools');
  assert.ok(codes(validatePdp0SurfaceDenominator(duplicate.registry, duplicate.topology, duplicate.authority)).includes('CHANNEL_CANDIDATE_DUPLICATE'));

  const missing = cloneSources();
  missing.registry.channelSurfaceProposals.mappings = missing.registry.channelSurfaceProposals.mappings.filter((mapping) => mapping.channelRef !== 'media.channel.event');
  assert.ok(codes(validatePdp0SurfaceDenominator(missing.registry, missing.topology, missing.authority)).includes('CONSUMER_PDP0_CHANNEL_UNMAPPED'));
});

test('rejects a Recorder capability leaf treated as applicable when its P0 channel row says N/A', () => {
  const { registry, topology, authority } = cloneSources();
  const leaf = authority.capabilityLeafReview.ownerCapabilityLeafAdjudication.records.find((record) => record.capabilityRef === 'media.deliver.interactive-scene-bundle');
  leaf.channelApplicability.find((row) => row.channelRef === 'media.channel.embedded').disposition = 'OWNER_SELECTED_NOT_APPLICABLE_TO_THIS_LEAF';
  const result = validatePdp0SurfaceDenominator(registry, topology, authority);
  assert.ok(result.findings.some((finding) => finding.code === 'CONSUMER_PDP0_CHANNEL_LEAF_MISMATCH' && finding.owner === 'media.surface.interactive-demo-player'));
});

test('requires all 462 exact leaf records and complete unique channel matrices', () => {
  const { registry, topology, authority } = cloneSources();
  authority.capabilityLeafReview.ownerCapabilityLeafAdjudication.records[0].channelApplicability.pop();
  const result = validatePdp0SurfaceDenominator(registry, topology, authority);
  assert.ok(codes(result).includes('PDP0_LEAF_CHANNEL_MATRIX'));
  assert.equal(result.stats.activeLogicalScopesResolved, 0);
});

test('rejects a changed exact scope count and an inherited physical leaf outside all inherited channels', () => {
  const countMutation = cloneSources();
  countMutation.authority.capabilityLeafReview.ownerCapabilityLeafAdjudication.records
    .find((record) => record.capabilityRef === 'media.artifact.inspect')
    .channelApplicability.find((row) => row.channelRef === 'media.channel.agent').disposition = 'OUTSIDE_SELECTED_ACTOR_SCOPE';
  const countResult = validatePdp0SurfaceDenominator(countMutation.registry, countMutation.topology, countMutation.authority);
  assert.ok(countResult.findings.some((finding) => finding.code === 'CONSUMER_PDP0_LEAF_COUNT' && finding.owner === 'media.surface.agent-tools'));

  const inheritedMutation = cloneSources();
  inheritedMutation.authority.applications.logicalConsumerPdp0Scope.records
    .find((record) => record.surfaceRef === 'media.surface.types-library').inheritedChannelRefs = ['media.channel.web'];
  const inheritedResult = validatePdp0SurfaceDenominator(inheritedMutation.registry, inheritedMutation.topology, inheritedMutation.authority);
  assert.ok(inheritedResult.findings.some((finding) => finding.code === 'INHERITED_SCOPE_CHANNEL_LEAF_MISMATCH' && finding.owner === 'media.surface.types-library'));
});
