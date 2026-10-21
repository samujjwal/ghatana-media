import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'yaml';

const contractPath = '.product-experience/pdp-3-product-experience/journey-contracts/inspect-quality-and-optimize-within-bounds.yaml';
const contract = YAML.parse(fs.readFileSync(contractPath, 'utf8'));
const pairSchema = '.product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.candidate-metric-pair.v1/resultSchema';
const p0Catalog = YAML.parse(fs.readFileSync('.product-experience/pdp-0-product-truth/journey-catalog.yaml', 'utf8'));
const p0J19 = p0Catalog.journeys.find((journey) => journey.id === 'J-19');
const purposes = YAML.parse(fs.readFileSync('.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml', 'utf8'));
const j19ComparePurpose = purposes.records.find((record) => record.id === 'media.pdp3.step-purpose-binding.j19-step-03.v1');
const j19ChoiceBinding = j19ComparePurpose.relatedActionBindings.find((binding) => binding.id === 'media.pdp3.action-binding.j19-successor-choice.v1');
const oracles = YAML.parse(fs.readFileSync('.product-experience/pdp-3-product-experience/step-definition-oracles.yaml', 'utf8'));
const j19Oracle = oracles.journeys.find((journey) => journey.journeyId === 'J-19');
const channelBindings = YAML.parse(fs.readFileSync('.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml', 'utf8'));
const j19WebEdge = channelBindings.edges.find((edge) => edge.id === 'media.pdp3.channel-binding.j19.web.v1');

test('J19 ends with an explicit local choice over the exact measured pair', () => {
  assert.equal(contract.journeyId, 'J-19');
  assert.deepEqual(p0J19.viewRefs, ['M-QUALITY', 'M-PLAN', 'M-COMPARE', 'M-RENDER']);
  assert.equal(contract.steps.length, 4);
  const comparison = contract.steps[2];
  const optionalRender = contract.steps[3];
  assert.equal(comparison.actionRef, 'media.action.compare-candidate-on-metric');
  assert.equal(comparison.view, 'media.view.compare-results');
  assert.equal(comparison.canonicalOperationRef, 'media.operation.action.compare-candidate-on-metric');
  assert.equal(j19ComparePurpose.ordinal, 3);
  assert.equal(j19ComparePurpose.actionRef, 'media.action.compare-candidate-on-metric');
  assert.equal(j19ChoiceBinding.journeyStepTransition, false);
  assert.equal(j19ChoiceBinding.actionRef, 'media.action.select-exact-candidates');
  assert.equal(j19ChoiceBinding.semanticRole, 'LOCAL_SELECTION_OR_SESSION_DRAFT');
  assert.deepEqual(j19ChoiceBinding.actionExactOperationRefs, []);
  assert.deepEqual(j19ChoiceBinding.operationRefs, []);
  assert.equal(j19ChoiceBinding.inputObservationRef, pairSchema);
  assert.deepEqual(j19ChoiceBinding.allowedChoices, ['SELECT_SUCCESSOR', 'DECLINE_SUCCESSOR']);
  assert.match(j19ChoiceBinding.otherwise, /UNKNOWN or NOT_COMPARABLE/);
  assert.match(j19ChoiceBinding.effect, /do not commit or mutate the source object/);
  assert.equal(contract.terminalOutcomeBinding.terminalStepRef, `${contractPath}#/steps/2`);
  assert.equal(contract.terminalOutcomeBinding.terminalActionBindingRef,
    '.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=media.pdp3.step-purpose-binding.j19-step-03.v1/relatedActionBindings/@id=media.pdp3.action-binding.j19-successor-choice.v1');
  assert.equal(contract.terminalOutcomeBinding.exactComparisonResultRef, pairSchema);
  assert.deepEqual(contract.terminalOutcomeBinding.exactChoice.allowedValues, ['SELECT_SUCCESSOR', 'DECLINE_SUCCESSOR']);
  assert.match(contract.terminalOutcomeBinding.disclosure.estimatedOrReconstructed, /UNKNOWN/);
  assert.match(contract.terminalOutcomeBinding.eligibility.otherwise, /NOT_COMPARABLE and UNKNOWN/);
  assert.match(contract.terminalOutcomeBinding.eligibility.otherwise, /do not record a terminal choice/);
  assert.equal(optionalRender.legacyViewRef, 'M-RENDER');
  assert.equal(optionalRender.actionRef, 'media.action.submit-render');
  assert.equal(optionalRender.optionalAfterTerminalOutcome, true);
  assert.match(optionalRender.completionEffect, /NONE/);
  assert.match(optionalRender.success.meaning, /admission only/);
  assert.match(optionalRender.success.meaning, /does not establish render completion or link the logicalJobId/);
  assert.equal(optionalRender.stepDefinitionSemantics.stepSourceFacts.resultDisposition, 'SOURCE_BOUND_IMMEDIATE_RESULT');
  assert.equal(optionalRender.stepDefinitionSemantics.stepSourceFacts.resultSourceRef,
    '.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.action.submit-render/resultSchema');
  assert.match(optionalRender.stepDefinitionSemantics.stepSourceFacts.success.status, /ADMISSION_ONLY/);
  assert.match(optionalRender.stepDefinitionSemantics.stepSourceFacts.success.meaning,
    /durableAdmissionReceipt confirms job admission only/);
  assert.match(optionalRender.stepDefinitionSemantics.stepSourceFacts.success.meaning,
    /does not establish render completion or link the logicalJobId to the selected candidate version/);
  assert.match(optionalRender.stepDefinitionSemantics.stepSourceFacts.success.evidenceBoundary,
    /does not revise J-19's already-recorded selection or decline/);
  assert.equal(contract.terminalOutcomeBinding.terminalStepRef, `${contractPath}#/steps/2`);
  assert.equal(j19Oracle.stepCount, 4);
  assert.equal(j19Oracle.steps.length, 4);
  assert.equal(purposes.recordCount, 130);
  assert.doesNotMatch(JSON.stringify(contract), /render completion is evidenced/);
  assert.equal(j19WebEdge.logicalDefinitionDisposition, 'SOURCE_BOUND_DEFINITION_ONLY');
  assert.deepEqual(j19WebEdge.logicalDefinitionBlockers, []);
  assert.equal(j19WebEdge.purposeBindingRefs.includes(contract.terminalOutcomeBinding.terminalActionBindingRef), true);
  assert.equal(j19WebEdge.fixtureIds.length, 4);
  const optionalRenderProof = j19WebEdge.p1OperationStateProofs.find((proof) => proof.operationRef === 'media.operation.action.submit-render');
  assert.deepEqual(optionalRenderProof.journeyResultBindingRefs, [`${contractPath}#/pdp1ResultEvidence/operationResultBindings/3`]);
});
