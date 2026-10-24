import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {buildAudSpec002SourceAmendmentV5, audSpec002V5Population} from '../scripts/lib/media-pdp0-aud-spec-002-source-amendment-v5.mjs';
import {readSources, validatePdp0SurfaceDenominator, projectPdp0DefinitionExtensionApplicability} from '../scripts/check-media-pdp0-surface-denominator.mjs';
import {resolvePdp0CurrentCapabilityPopulation} from '../scripts/lib/media-product-definition-residuals.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const require = createRequire(path.resolve(root, '../ghatana-tools/package.json'));
const yaml = require('yaml');
const Ajv2020 = require('ajv/dist/2020');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = ref => fs.readFileSync(path.join(root, ref));
const refs = {
  crosswalk: `${folder}/pdp0-501-disposition-crosswalk.json`,
  audit: 'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json',
  capabilities: '.product-experience/pdp-0-product-truth/capabilities.yaml',
  requirements: '.product-experience/pdp-0-product-truth/requirements.yaml',
  capabilityLeafReview: '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
  applicationsChannels: '.product-experience/pdp-0-product-truth/applications-channels.yaml',
  campaignExtensions: '.product-experience/pdp-0-product-truth/campaign-extensions.yaml',
  decisionLog: '.product-experience/decision-log.md',
  rootDecision: '../ghatana-lifecycle/docs/engineering/reviews/gtool-critical-2026-10-23/media-aud-spec-002-version-population-root-decision.json',
  observedV2Candidate: `${folder}/AUD-SPEC-002-source-amendment-candidate.v2.json`,
  observedV2SourceAmendment: `${folder}/AUD-SPEC-002-source-amendment-postimage.v2.json`,
  observedV2Crosswalk: `${folder}/AUD-SPEC-002-crosswalk-postimage.v2.json`,
  observedV4Candidate: `${folder}/AUD-SPEC-002-source-amendment-candidate.v4.json`,
  v4FreezeManifest: `${folder}/AUD-SPEC-002-source-amendment-v4-freeze-manifest.v1.json`,
  v4SourceAmendment: `${folder}/AUD-SPEC-002-source-amendment-postimage.v4.json`,
  v4CapabilityPostimage: `${folder}/AUD-SPEC-002-capabilities-file-postimage.v4.yaml`,
  v4RequirementPostimage: `${folder}/AUD-SPEC-002-requirements-file-postimage.v4.yaml`,
  v4CrosswalkPostimage: `${folder}/AUD-SPEC-002-crosswalk-postimage.v4.json`,
  v4ReviewPostimage: `${folder}/AUD-SPEC-002-capability-leaf-review-postimage.v4.yaml`,
};
const inputs = () => ({
  crosswalkBytes: read(refs.crosswalk), auditBytes: read(refs.audit), capabilitiesBytes: read(refs.capabilities),
  requirementsBytes: read(refs.requirements), capabilityLeafReviewBytes: read(refs.capabilityLeafReview),
  applicationsChannelsBytes: read(refs.applicationsChannels), campaignExtensionsBytes: read(refs.campaignExtensions), decisionLogBytes: read(refs.decisionLog),
  rootDecisionBytes: read(refs.rootDecision), observedV2CandidateBytes: read(refs.observedV2Candidate),
  observedV2SourceAmendmentBytes: read(refs.observedV2SourceAmendment), observedV2CrosswalkBytes: read(refs.observedV2Crosswalk),
  observedV4CandidateBytes: read(refs.observedV4Candidate),
  v4FreezeManifestBytes: read(refs.v4FreezeManifest), frozenV4SourceAmendmentBytes: read(refs.v4SourceAmendment),
  frozenV4PostimageBytes: {
    [refs.capabilities]: read(refs.v4CapabilityPostimage), [refs.requirements]: read(refs.v4RequirementPostimage),
    [refs.crosswalk]: read(refs.v4CrosswalkPostimage), [refs.capabilityLeafReview]: read(refs.v4ReviewPostimage),
  },
});
const result = buildAudSpec002SourceAmendmentV5(inputs());
const sourceSnapshot = readSources(root);
const candidateAuthority = prospectiveAuthority(result);

function prospectiveAuthority(built) {
  const capabilitySource = sourceSnapshot?.authority?.capabilities;
  const capabilityRows = structuredClone(capabilitySource?.capabilities ?? []);
  const currentCompile = capabilityRows.find(row => row.id === 'media.recipe.specification.compile');
  if (currentCompile) currentCompile.scopeStatus = 'TARGET';
  return {
    ...sourceSnapshot.authority,
    capabilities: {...capabilitySource, capabilities: capabilityRows},
    requirements: yaml.parse(built.postimages[refs.requirements].toString('utf8')),
    capabilityLeafReview: yaml.parse(built.postimages[refs.capabilityLeafReview].toString('utf8')),
    campaignExtensions: yaml.parse(built.postimages[refs.campaignExtensions].toString('utf8')),
  };
}

test('v5 preserves the declared 462 base, selects exactly one extension, and retains six future identities', () => {
  const campaign = yaml.parse(result.postimages[refs.campaignExtensions].toString('utf8'));
  const version = campaign.currentDefinitionPopulation.versionDisposition;
  assert.deepEqual(audSpec002V5Population, {historicalBase: 462, currentExtension: 1, futureProposals: 6, currentVersionTotal: 463, totalDefinitions: 469});
  assert.equal(version.historicalCanonicalCapabilityLeaves, 462);
  assert.equal(version.currentVersionCapabilityLeaves, 463);
  assert.equal(version.futureVersionProposalCapabilityLeaves, 6);
  assert.equal(version.totalSourceCapabilityDefinitions, 469);
  assert.deepEqual(version.currentVersionExtensionCapabilityIds, ['media.recipe.specification.compile']);
  assert.equal(version.futureVersionProposals.length, 6);
  assert.ok(!version.futureVersionProposals.some(row => row.capabilityId === 'media.recipe.specification.compile'));
  const capabilityText = result.postimages[refs.capabilities].toString('utf8');
  const compileStart = capabilityText.indexOf('  - id: media.recipe.specification.compile\n');
  const compileEnd = capabilityText.indexOf('\n  - id:', compileStart + 1);
  const capability = yaml.parse(`capabilities:\n${capabilityText.slice(compileStart, compileEnd)}`).capabilities[0];
  assert.equal(capability.scopeStatus, 'TARGET');
  assert.equal(capability.ownerDefinition.successOutputs.find(output => output.artifactType === 'normalized-semantic-graph-and-reviewable-project-plan-candidate').requiredOnSuccess, true);
  assert.equal(capability.ownerDefinition.successOutputs.find(output => output.artifactType === 'reviewable-version-bound-schema-migration-candidate-and-semantic-diff').requiredOnSuccess, false);
});

test('v5 keeps historical owner/trust arrays byte-identical and stores the current extension separately', () => {
  const before = inputs().capabilityLeafReviewBytes.toString('utf8');
  const after = result.postimages[refs.capabilityLeafReview].toString('utf8');
  const beforeOwner = before.slice(before.indexOf('ownerCapabilityLeafAdjudication:\n'), before.indexOf('currentOwnerDefinitionCensus:\n'));
  const afterOwner = after.slice(after.indexOf('ownerCapabilityLeafAdjudication:\n'), after.indexOf('currentOwnerDefinitionCensus:\n'));
  const beforeTrust = before.slice(before.indexOf('ownerTrustReconstructionDispositions:\n'), before.indexOf('pdp0ToPdp1ConsumerHandoff:\n'));
  const afterTrust = after.slice(after.indexOf('ownerTrustReconstructionDispositions:\n'), after.indexOf('pdp0ToPdp1ConsumerHandoff:\n'));
  assert.equal(afterOwner, beforeOwner);
  assert.equal(afterTrust, beforeTrust);
  assert.equal((afterOwner.match(/^    - capabilityRef:/gmu) ?? []).length, 462);
  assert.equal((afterTrust.match(/^    - id:/gmu) ?? []).length, 462);
  const extension = yaml.parse(after.slice(after.indexOf('currentVersionExtensionOwnerAndTrust:\n'))).currentVersionExtensionOwnerAndTrust;
  assert.equal(extension.ownerAdjudications.length, 1);
  assert.equal(extension.trustReconstructionDispositions.length, 1);
  assert.equal(extension.population.currentVersionTotal, 463);
  assert.equal(extension.population.futureVersionExtensionCount, 6);
  assert.equal(extension.ownerAdjudications[0].capabilityRef, 'media.recipe.specification.compile');
  assert.equal(extension.trustReconstructionDispositions[0].capabilityRef, 'media.recipe.specification.compile');
  assert.equal(extension.qualityApplicability.status, 'UNKNOWN_PENDING_SEPARATE_SOURCE_BOUND_QUALITY_REVIEW');
  assert.equal(extension.qualityApplicability.currentExtensionIncludedInExistingQualityReview, false);
  assert.equal(extension.downstreamPdp1.operationContractRef, null);
  assert.equal(extension.downstreamPdp1.historicalCapabilityOperationCount, 462);
});

test('v5 runs actual PXD-207 applicability projection over all 54 identities and 4,158 channel cells', () => {
  const projection = projectPdp0DefinitionExtensionApplicability(sourceSnapshot.registry, sourceSnapshot.topology, candidateAuthority);
  assert.equal(projection.ok, true, JSON.stringify(projection.findings));
  assert.equal(projection.surfaceCellCount, 378);
  assert.equal(projection.records.length, 4158);
  assert.equal(projection.versionDisposition.currentVersionExtensionCount, 1);
  assert.deepEqual(projection.versionDisposition.currentVersionExtensionCapabilityIds, ['media.recipe.specification.compile']);
  assert.equal(projection.versionDisposition.futureVersionProposalCount, 6);
  assert.equal(new Set(projection.records.map(row => row.surfaceId)).size, 54);
  assert.equal(new Set(projection.records.map(row => `${row.surfaceId}\0${row.capabilityRef}\0${row.channelRef}`)).size, 4158);
  const current = projection.records.filter(row => row.capabilityRef === 'media.recipe.specification.compile');
  assert.equal(current.length, 594);
  assert.equal(new Set(current.map(row => row.surfaceId)).size, 54);
  assert.ok(current.every(row => row.versionScopeStatus === 'CURRENT_VERSION_EXTENSION'));
  assert.equal(current.filter(row => row.disposition === 'OWNER_DECIDED_APPLICABLE').length, 2);
  assert.equal(current.filter(row => row.disposition === 'DERIVED_AGGREGATE_OWNER_DECISION').length, 3);
  assert.equal(current.filter(row => row.channelRef === 'media.channel.cli' && ['OWNER_DECIDED_APPLICABLE', 'DERIVED_AGGREGATE_OWNER_DECISION'].includes(row.disposition)).length, 5);
});

test('v5 injects proposed sources into the actual denominator validator without changing the 462 historical leaf partition', () => {
  const validation = validatePdp0SurfaceDenominator(sourceSnapshot.registry, sourceSnapshot.topology, candidateAuthority, {root});
  assert.equal(validation.ok, true, JSON.stringify(validation.findings.slice(0, 30)));
  assert.equal(validation.stats.denominator, 54);
  assert.equal(validation.proposalApplicability.surfaceCellCount, 378);
  assert.equal(validation.proposalApplicability.versionDisposition.currentVersionExtensionCount, 1);
  assert.equal(validation.proposalApplicability.versionDisposition.futureVersionProposalCount, 6);
  assert.equal(result.sourceAmendment.applicability.surfaceIdentityCount, 54);
  assert.equal(result.sourceAmendment.applicability.phaseCellCount, 216);
});

test('v5 current capability residual selector joins the current extension separately and retains historical/future scopes', () => {
  const extension = yaml.parse(result.postimages[refs.capabilityLeafReview].toString('utf8')
    .slice(result.postimages[refs.capabilityLeafReview].toString('utf8').indexOf('currentVersionExtensionOwnerAndTrust:\n'))).currentVersionExtensionOwnerAndTrust;
  const review = structuredClone(sourceSnapshot.authority.capabilityLeafReview);
  review.currentVersionExtensionOwnerAndTrust = extension;
  const capabilities = structuredClone(sourceSnapshot.authority.capabilities);
  capabilities.capabilities.find(row => row.id === 'media.recipe.specification.compile').scopeStatus = 'TARGET';
  const campaignExtensions = yaml.parse(result.postimages[refs.campaignExtensions].toString('utf8'));
  const population = resolvePdp0CurrentCapabilityPopulation({capabilityLeafReview: review, capabilitiesDocument: capabilities, campaignExtensionsDocument: campaignExtensions});
  assert.equal(population.ok, true, JSON.stringify(population.diagnostics));
  assert.equal(population.historicalOwnerRows.length, 462);
  assert.equal(population.extensionOwnerRows.length, 1);
  assert.equal(population.currentRows.length, 463);
  assert.equal(population.currentCapabilityIds.length, 463);
  assert.equal(population.futureIds.length, 6);
  const missingExtension = structuredClone(review);
  missingExtension.currentVersionExtensionOwnerAndTrust.ownerAdjudications = [];
  assert.equal(resolvePdp0CurrentCapabilityPopulation({capabilityLeafReview: missingExtension, capabilitiesDocument: capabilities, campaignExtensionsDocument: campaignExtensions}).ok, false);
  const baseRewrite = structuredClone(review);
  baseRewrite.ownerCapabilityLeafAdjudication.records.push(structuredClone(baseRewrite.ownerCapabilityLeafAdjudication.records[0]));
  assert.equal(resolvePdp0CurrentCapabilityPopulation({capabilityLeafReview: baseRewrite, capabilitiesDocument: capabilities, campaignExtensionsDocument: campaignExtensions}).ok, false);
});

test('v5 rejects population drift, overlap, or failure to keep extension populations separate', () => {
  const overlap = structuredClone(candidateAuthority);
  overlap.campaignExtensions.currentDefinitionPopulation.versionDisposition.futureVersionProposals.push({capabilityId: 'media.recipe.specification.compile', scopeStatus: 'DEFERRED', version: 'later-governed-version', decisionRef: '.product-experience/decision-log.md#PXD-220'});
  const overlapResult = projectPdp0DefinitionExtensionApplicability(sourceSnapshot.registry, sourceSnapshot.topology, overlap);
  assert.equal(overlapResult.ok, false);
  assert.ok(overlapResult.findings.some(row => row.code === 'PDP0_VERSION_SCOPE_PARTITION'));
  const overlapCurrent = structuredClone(candidateAuthority);
  overlapCurrent.campaignExtensions.currentDefinitionPopulation.versionDisposition.currentVersionExtensionCapabilityIds.push('media.project.scene.patch-merge');
  const overlapCurrentResult = projectPdp0DefinitionExtensionApplicability(sourceSnapshot.registry, sourceSnapshot.topology, overlapCurrent);
  assert.equal(overlapCurrentResult.ok, false);
  assert.ok(overlapCurrentResult.findings.some(row => row.code === 'PDP0_VERSION_SCOPE_PARTITION'));
});

test('v5 candidate JSON schemas bind all six complete target postimages and fail closed on denominator tampering', () => {
  const candidateValidator = new Ajv2020({strict: true}).compile(result.candidateSchema);
  assert.equal(candidateValidator(result.candidate), true, JSON.stringify(candidateValidator.errors));
  for (const row of result.candidate.exactFileTargets) {
    const bytes = result.postimages[row.targetRef];
    assert.ok(bytes);
    assert.equal(row.postimageSha256, sha(bytes));
  }
  assert.equal(result.candidate.exactFileTargets.length, 6);
  assert.equal(candidateValidator({...result.candidate, population: {...result.candidate.population, historicalBase: 463}}), false);
  assert.equal(candidateValidator({...result.candidate, effects: {...result.candidate.effects, sourceCurrentness: 'CURRENT'}}), false);
  const amendmentValidator = new Ajv2020({strict: true}).compile(result.sourceAmendmentSchema);
  assert.equal(amendmentValidator(result.sourceAmendment), true, JSON.stringify(amendmentValidator.errors));
  assert.equal(amendmentValidator({...result.sourceAmendment, applicability: {...result.sourceAmendment.applicability, qualityDisposition: 'NOT_APPLICABLE'}}), false);
  assert.equal(amendmentValidator({...result.sourceAmendment, exactTargets: result.sourceAmendment.exactTargets.slice(0, 5)}), false);
});
