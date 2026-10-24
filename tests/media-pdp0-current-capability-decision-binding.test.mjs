import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolvePdp0CurrentCapabilityPopulation } from '../scripts/lib/media-product-definition-residuals.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const parseYaml = createRequire(resolve(root, '../ghatana-tools/package.json'))('yaml').parse;
const readYaml = (path) => parseYaml(readFileSync(resolve(root, path), 'utf8'));

test('future capability decision refs are bound to the exact capability identity', () => {
  const capabilityLeafReview = readYaml('.product-experience/pdp-0-product-truth/capability-leaf-review.yaml');
  const capabilitiesDocument = readYaml('.product-experience/pdp-0-product-truth/capabilities.yaml');
  const campaignExtensionsDocument = readYaml('.product-experience/pdp-0-product-truth/campaign-extensions.yaml');
  const input = { capabilityLeafReview, capabilitiesDocument, campaignExtensionsDocument };

  assert.equal(resolvePdp0CurrentCapabilityPopulation(input).ok, true);

  const missingCurrentCompileDecision = structuredClone(campaignExtensionsDocument);
  missingCurrentCompileDecision.currentDefinitionPopulation.versionDisposition.decisionRefs = [
    '.product-experience/decision-log.md#PXD-220',
    '.product-experience/decision-log.md#PXD-221',
  ];
  assert.equal(resolvePdp0CurrentCapabilityPopulation({ ...input, campaignExtensionsDocument: missingCurrentCompileDecision }).ok, false);

  const wrongDecision = structuredClone(campaignExtensionsDocument);
  wrongDecision.currentDefinitionPopulation.versionDisposition.futureVersionProposals
    .find((row) => row.capabilityId === 'media.project.scene.patch-merge').decisionRef = '.product-experience/decision-log.md#PXD-226';
  assert.equal(resolvePdp0CurrentCapabilityPopulation({ ...input, campaignExtensionsDocument: wrongDecision }).ok, false);

  const deferredCompile = structuredClone(campaignExtensionsDocument);
  const version = deferredCompile.currentDefinitionPopulation.versionDisposition;
  version.currentVersionExtensionCapabilityIds = [];
  version.currentVersionCapabilityLeaves = 462;
  version.futureVersionProposalCapabilityLeaves = 7;
  version.decisionRefs = ['.product-experience/decision-log.md#PXD-220', '.product-experience/decision-log.md#PXD-221'];
  version.futureVersionProposals.push({
    capabilityId: 'media.recipe.specification.compile', scopeStatus: 'DEFERRED',
    version: 'later-governed-version', decisionRef: '.product-experience/decision-log.md#PXD-220',
  });
  deferredCompile.currentDefinitionPopulation.extensionDisposition = 'SIX_COORDINATOR_AUTHORED_MEANING_PROPOSALS_AND_ONE_USER_DELEGATED_CREATIVE_EFFECT_DEFINITION; ALL_SEVEN_FUTURE_VERSION; INDEPENDENT_ACCEPTANCE_NOT_CLAIMED';
  deferredCompile.currentDefinitionPopulation.versionDisposition.futureVersionProposals
    .sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
  const deferredReview = structuredClone(capabilityLeafReview);
  delete deferredReview.currentVersionExtensionOwnerAndTrust;
  const deferredCapabilities = structuredClone(capabilitiesDocument);
  deferredCapabilities.capabilities.find((row) => row.id === 'media.recipe.specification.compile').scopeStatus = 'DEFERRED';
  const deferredInput = { capabilityLeafReview: deferredReview, capabilitiesDocument: deferredCapabilities, campaignExtensionsDocument: deferredCompile };
  assert.equal(resolvePdp0CurrentCapabilityPopulation(deferredInput).ok, true);
  const strayCurrentDecision = structuredClone(deferredCompile);
  strayCurrentDecision.currentDefinitionPopulation.versionDisposition.decisionRefs.push('.product-experience/decision-log.md#PXD-226');
  assert.equal(resolvePdp0CurrentCapabilityPopulation({ ...deferredInput, campaignExtensionsDocument: strayCurrentDecision }).ok, false);
});
