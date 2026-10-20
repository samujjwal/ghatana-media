import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = require('yaml');
const p0Root = '.product-experience/pdp-0-product-truth';
const [capabilities, requirements, leafReview, applications] = await Promise.all([
  readFile(`${p0Root}/capabilities.yaml`, 'utf8').then(parse),
  readFile(`${p0Root}/requirements.yaml`, 'utf8').then(parse),
  readFile(`${p0Root}/capability-leaf-review.yaml`, 'utf8').then(parse),
  readFile(`${p0Root}/applications-channels.yaml`, 'utf8').then(parse),
]);

const extensionIds = [
  'media.recipe.specification.compile',
  'media.project.scene.patch-merge',
  'media.quality.audio.content-similarity.assess',
  'media.generate.video.preset.manage',
  'media.generate.video.shot-condition',
  'media.job.schedule.manage',
  'media.master.audio.creative-effect.apply',
];

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const capabilityById = new Map(capabilities.capabilities.map((leaf) => [leaf.id, leaf]));
const requirementById = new Map(requirements.requirements.map((row) => [row.id, row]));
const channelIds = new Set([
  ...applications.channels.map((channel) => channel.id),
  ...applications.ownerDefinedChannels.records.map((channel) => channel.id),
]);
const normalizedChannelRef = (channel) => channel.startsWith('media.channel.')
  ? channel
  : `media.channel.${channel}`;

test('PDP-0 preserves required capability-family scope and explicit dispositions', () => {
  assert.equal(capabilities.families.length, 38, 'all required capability families remain in scope');
  assert.equal(capabilities.capabilities.length, 469, 'canonical leaf denominator includes all seven definition extensions');
  assert.equal(new Set(capabilities.families.map((family) => family.id)).size, 38, 'family IDs are unique');
  assert.equal(new Set(capabilities.capabilities.map((leaf) => leaf.id)).size, 469, 'capability leaf IDs are unique');

  const familyMemberships = capabilities.families.flatMap((family) => family.capabilityIds.map((id) => ({ family, id })));
  const membershipCount = new Map();
  for (const { family, id } of familyMemberships) {
    membershipCount.set(id, (membershipCount.get(id) ?? 0) + 1);
    assert.ok(capabilityById.has(id), `${family.id} member ${id} resolves to a stable leaf`);
    assert.equal(capabilityById.get(id).familyId, family.id, `${id} names its exact owning family`);
  }
  assert.equal(familyMemberships.length, 469, 'each canonical capability leaf is listed in the family denominator');

  for (const leaf of capabilities.capabilities) {
    assert.equal(membershipCount.get(leaf.id), 1, `${leaf.id} joins exactly one family`);
    const family = capabilities.families.find(({ id }) => id === leaf.familyId);
    assert.ok(family, `${leaf.id} resolves its owning family`);
    const requirement = requirementById.get(family.requirementId);
    assert.ok(requirement, `${family.id} resolves its exact family requirement`);
    assert.ok(nonEmpty(requirement.priority), `${family.id} requirement has an explicit priority`);
    assert.ok(requirement.capabilityIds.includes(leaf.id), `${leaf.id} is linked by the exact family requirement`);
    assert.ok(leaf.requirementIds.includes(requirement.id), `${leaf.id} links back to the family requirement`);

    assert.ok(Array.isArray(leaf.supportedChannels) && leaf.supportedChannels.length > 0, `${leaf.id} declares intended channel(s)`);
    for (const channel of leaf.supportedChannels) {
      assert.ok(channelIds.has(normalizedChannelRef(channel)), `${leaf.id} channel ${channel} resolves in applications-channels.yaml`);
    }

    const availability = leaf.ownerDefinition?.availability;
    assert.ok(availability, `${leaf.id} has a separate availability record`);
    assert.equal(availability.implementationState, 'UNKNOWN', `${leaf.id} does not infer implementation from definition`);
    assert.equal(availability.licenseAdmissionState, 'UNKNOWN', `${leaf.id} does not infer license admission`);
    assert.equal(availability.qualificationState, 'NOT_EVALUATED', `${leaf.id} does not claim qualification`);
    assert.equal(availability.runtimeAvailability, 'UNKNOWN', `${leaf.id} does not infer runtime availability`);
    assert.equal(availability.executionAdmission, 'NOT_ADMITTED', `${leaf.id} remains non-dispatchable`);
  }

  const adjudications = leafReview.ownerCapabilityLeafAdjudication.records;
  assert.equal(leafReview.ownerCapabilityLeafAdjudication.exactLeafCount, 462);
  assert.equal(adjudications.length, 462, 'the owner-adjudicated population is kept distinct from extensions');
  const adjudicationById = new Map(adjudications.map((record) => [record.capabilityRef, record]));
  assert.equal(adjudicationById.size, 462, 'owner adjudication IDs are unique');
  const extensionSet = new Set(extensionIds);

  for (const leaf of capabilities.capabilities) {
    const record = adjudicationById.get(leaf.id);
    if (extensionSet.has(leaf.id)) {
      assert.equal(record, undefined, `${leaf.id} remains outside the historical owner-adjudicated population`);
      continue;
    }
    assert.ok(record, `${leaf.id} has exact owner applicability`);
    const rows = record.channelApplicability;
    assert.equal(rows.length, channelIds.size, `${leaf.id} has a disposition for every declared channel`);
    assert.equal(new Set(rows.map(({ channelRef }) => channelRef)).size, channelIds.size, `${leaf.id} channel dispositions are unique`);
    for (const row of rows) {
      assert.ok(channelIds.has(row.channelRef), `${leaf.id} applicability resolves channel ${row.channelRef}`);
      assert.ok(nonEmpty(row.disposition), `${leaf.id}/${row.channelRef} has an explicit applicability disposition`);
    }
  }

  const actualExtensions = capabilities.capabilities
    .map(({ id }) => id)
    .filter((id) => !adjudicationById.has(id))
    .sort();
  assert.deepEqual(actualExtensions, [...extensionIds].sort(), 'the only non-adjudicated leaves are the seven declared PXD-207 extensions');

  const implementationLaneById = new Map(leafReview.leaves.map((record) => [record.id, record.implementation]));
  assert.equal(leafReview.leaves.length, 462, 'leaf implementation records retain the historical denominator');
  for (const id of adjudicationById.keys()) {
    const implementation = implementationLaneById.get(id);
    assert.ok(implementation, `${id} has an implementation-lane record`);
    assert.equal(implementation.implementationLane, 'NOT_SELECTED_IN_PDP0', `${id} has an explicit non-selected PDP-0 lane disposition`);
    assert.ok(nonEmpty(implementation.implementationLaneRationale), `${id} lane disposition has a rationale`);
    assert.equal(implementation.implementationLaneOwnerPhase, 'BUILD', `${id} assigns lane selection to Build`);
  }

  const extensionLanes = leafReview.extensionImplementationLaneDispositions.records;
  const extensionLaneById = new Map(extensionLanes.map((record) => [record.capabilityRef, record]));
  assert.equal(extensionLanes.length, 7, 'each PXD-207 extension has a separate implementation-lane disposition');
  assert.equal(extensionLaneById.size, 7, 'extension lane records are unique');
  for (const id of extensionIds) {
    const disposition = extensionLaneById.get(id);
    assert.ok(disposition, `${id} has an extension lane disposition`);
    assert.equal(disposition.implementationLane, 'NOT_SELECTED_IN_PDP0');
    assert.ok(nonEmpty(disposition.rationale), `${id} lane disposition includes a rationale`);
    assert.equal(disposition.ownerPhase, 'BUILD');
    assert.equal(disposition.implementationState, 'UNKNOWN');
    assert.equal(disposition.executionAdmission, 'NOT_ADMITTED');
    assert.equal(disposition.ownerApproval, 'NOT_CLAIMED');
    assert.equal(disposition.acceptanceEffect, 'none');
    assert.ok(nonEmpty(disposition.sourceRef), `${id} lane disposition is source-bound`);
  }

  const extensionApplicability = applications.coordinatorDefinitionExtensionApplicability;
  assert.equal(extensionApplicability.denominator.capabilityDefinitionExtensions, 7);
  assert.equal(extensionApplicability.records.length, 7);
  const applicabilityById = new Map(extensionApplicability.records.map((record) => [record.capabilityRef, record]));
  assert.equal(applicabilityById.size, 7, 'extension channel decisions are unique per exact leaf');
  for (const id of extensionIds) {
    const record = applicabilityById.get(id);
    assert.ok(record, `${id} has an exact PXD-207 applicability decision`);
    const leafChannels = capabilityById.get(id).supportedChannels.map(normalizedChannelRef).sort();
    assert.deepEqual(record.declaredSupportedChannelRefs.slice().sort(), leafChannels, `${id} channel proposal matches its capability declaration`);
    assert.equal(record.decision.status, 'DELEGATED_PDP0_APPLICABILITY_DECISION');
    assert.equal(record.decision.ownerApproval, 'NOT_CLAIMED', `${id} proposal is not represented as owner approval`);
    assert.equal(record.decision.independentAcceptance, 'NOT_CLAIMED');
    assert.equal(record.decision.executionAdmission, 'NOT_ADMITTED');
    assert.ok(nonEmpty(record.decision.includeRationale), `${id} included channel has a rationale`);
    const included = record.decision.includedChannelRef;
    const excluded = record.decision.excludedChannelRefs.map(({ channelRef, rationale }) => {
      assert.ok(nonEmpty(rationale), `${id}/${channelRef} exclusion has a rationale`);
      return channelRef;
    });
    assert.ok(leafChannels.includes(included), `${id} selected channel is declared for the leaf`);
    assert.equal(new Set([included, ...excluded]).size, channelIds.size, `${id} channel applicability decisions are unique`);
    assert.deepEqual(new Set([included, ...excluded]), channelIds, `${id} every channel is included or explicitly excluded`);
  }
});
