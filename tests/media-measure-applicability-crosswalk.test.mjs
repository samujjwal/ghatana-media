import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { validateOwnerMeasureApplicabilityCrosswalk as validate, validateBusinessMeasureDefinitions } from '../scripts/lib/product-definition-domain-rule-mapping.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const requireYaml = createRequire(resolve(root, '../ghatana-tools/package.json'));
const { parse: parseYaml } = requireYaml('yaml');
const readSourceYaml = (path) => parseYaml(readFileSync(resolve(root, path), 'utf8'));

const capabilities = ['media.example.first', 'media.example.second'];
const measures = ['media.business.reuse-media-capabilities.measure', 'media.business.trustworthy-versioned-outputs.measure', 'media.business.bounded-provider-execution.measure', 'media.business.safe-recoverable-operations.measure'];
function fixture() {
  const dispositions = ['TRACE_ONLY_NOT_A_MEASURE_UNIT', 'NOT_APPLICABLE_READ_ONLY_OR_NO_OUTPUT_OPERATION', 'NOT_APPLICABLE_NOT_EXECUTION_PROFILE_OPERATION', 'NOT_APPLICABLE_SYNCHRONOUS_OPERATION'];
  const rows = capabilities.flatMap(capabilityRef => measures.map((measureRef, i) => ({
    id: `media.measure-applicability.${measureRef.replaceAll('.', '-')}.${capabilityRef.replaceAll('.', '-')}`,
    capabilityRef, measureRef, disposition: dispositions[i], reason: 'Exact source definition excludes this candidate from the measurement unit.', sourceRefs: [`source.yaml#${capabilityRef}`],
    baseline: 'NOT_EVALUATED', target: 'NOT_SET', qualification: 'NOT_EVALUATED', admission: 'NOT_ADMITTED', sourceDisposition: 'OWNER_DEFINED_DEFINITION_ONLY',
  })));
  return {
    baseline: 'NOT_EVALUATED', target: 'NOT_SET', qualification: 'NOT_EVALUATED', executionAdmission: 'NOT_ADMITTED',
    capabilityCount: 2, uniqueCapabilityCount: 2, completeCrosswalkCount: 2, measureRefs: measures,
    applicableCandidateCounts: Object.fromEntries(measures.map((id, i) => [id, i === 0 ? 2 : 0])),
    measureApplicabilityRecords: { recordCount: 8, uniqueRecordIds: 8, records: rows },
    records: capabilities.map(capabilityRef => ({ capabilityRef, bindingProjectionOnly: true, sourceDisposition: 'OWNER_DEFINITION_ONLY', admission: 'NOT_ADMITTED', baseline: 'NOT_EVALUATED', target: 'NOT_SET', qualification: 'NOT_EVALUATED', measureApplicability: Object.fromEntries(rows.filter(row => row.capabilityRef === capabilityRef).map(({measureRef,id,disposition,reason,sourceRefs}) => [measureRef, {id,disposition,reason,sourceRefs}])) })),
  };
}
test('source applicability validates the exact Cartesian population without admitting measurement', () => {
  assert.equal(validate(fixture(), capabilities, measures).length, 8);
});
test('actual PDP-0 owner applicability source closes all pairs and exact binding projections', () => {
  const goals = readSourceYaml('.product-experience/pdp-0-product-truth/goals-jtbd.yaml');
  const caps = readSourceYaml('.product-experience/pdp-0-product-truth/capabilities.yaml').capabilities;
  const crosswalk = goals.successMeasureContracts.ownerCapabilityApplicabilityCrosswalk;
  const measureIds = goals.successMeasureContracts.records.map(({ id }) => id);
  const rows = validate(crosswalk, caps.map(({ id }) => id), measureIds);
  const counts = Object.fromEntries(measureIds.map((id) => [id, rows.filter((row) => row.measureRef === id
    && (row.disposition.startsWith('APPLICABLE_') || row.disposition === 'TRACE_ONLY_NOT_A_MEASURE_UNIT')).length]));

  assert.equal(rows.length, 1848);
  assert.deepEqual(counts, {
    'media.business.reuse-media-capabilities.measure': 462,
    'media.business.trustworthy-versioned-outputs.measure': 430,
    'media.business.bounded-provider-execution.measure': 394,
    'media.business.safe-recoverable-operations.measure': 445,
  });
  for (const { capabilityRef, measureApplicability } of crosswalk.records.filter(({ capabilityRef }) => capabilityRef.startsWith('media.recipe.template.'))) {
    assert.equal(measureApplicability['media.business.safe-recoverable-operations.measure'].disposition, 'APPLICABLE_ASYNCHRONOUS_OPERATION_CANDIDATE');
  }
  assert.equal(crosswalk.executionAdmission, 'NOT_ADMITTED');
  assert.equal(crosswalk.baseline, 'NOT_EVALUATED');
  assert.equal(crosswalk.target, 'NOT_SET');
  assert.equal(crosswalk.qualification, 'NOT_EVALUATED');
});
test('same-count substitution, duplicates and stale binding projections are rejected', () => {
  for (const mutate of [
    x => { x.measureApplicabilityRecords.records[1] = structuredClone(x.measureApplicabilityRecords.records[0]); },
    x => { x.measureApplicabilityRecords.records[0].capabilityRef = 'media.foreign'; },
    x => { x.measureApplicabilityRecords.records[0].id = 'invented'; },
    x => { x.records[0].measureApplicability[measures[0]].reason = 'Copied stale claim'; },
    x => { delete x.records[0].measureApplicability[measures[1]]; },
    x => { x.applicableCandidateCounts[measures[0]] = 1; },
    x => { x.measureApplicabilityRecords.records.pop(); },
  ]) { const x = fixture(); mutate(x); assert.throws(() => validate(x, capabilities, measures)); }
});
test('unknown applicability, missing evidence and invented measurements remain errors', () => {
  for (const mutate of [
    x => { x.measureApplicabilityRecords.records[0].disposition = 'APPLICABLE_VERSIONED_OUTPUT_CANDIDATE'; },
    x => { x.measureApplicabilityRecords.records[2].disposition = 'NOT_APPLICABLE_NO_DECLARED_EXTERNAL_EXECUTION_DEPENDENCY'; },
    x => { x.measureApplicabilityRecords.records[3].disposition = 'NOT_APPLICABLE_NOT_AN_ASYNCHRONOUS_SUBMISSION'; },
    x => { x.measureApplicabilityRecords.records[0].sourceRefs = []; },
    x => { x.measureApplicabilityRecords.records[0].qualification = 'PASS'; },
    x => { x.records[0].admission = 'ADMITTED'; },
    x => { x.baseline = '100'; },
    x => { x.executionAdmission = 'ADMITTED'; },
  ]) { const x = fixture(); mutate(x); assert.throws(() => validate(x, capabilities, measures)); }
});

function projectionFixture() {
  const crosswalk = fixture();
  const candidates = ['TRACE_ONLY_NOT_A_MEASURE_UNIT', 'APPLICABLE_OUTPUT_PRODUCER_CANDIDATE', 'APPLICABLE_PROVIDER_PROFILE_CANDIDATE', 'APPLICABLE_ASYNCHRONOUS_OPERATION_CANDIDATE'];
  for (const row of crosswalk.measureApplicabilityRecords.records) {
    row.disposition = candidates[measures.indexOf(row.measureRef)];
    row.reason = 'Produces an output; incomplete version identity remains a denominator candidate, not a passing result.';
    Object.assign(crosswalk.records.find(binding => binding.capabilityRef === row.capabilityRef).measureApplicability[row.measureRef], {disposition:row.disposition,reason:row.reason});
  }
  crosswalk.applicableCandidateCounts = Object.fromEntries(measures.map(id => [id,2]));
  crosswalk.ownerDecisionRef = '.product-experience/decision-log.md#PXD-081';
  const records = measures.map(id => ({
    id, businessIntentRef: id.slice(0,-'.measure'.length), description: `Exact definition for ${id}`,
    metric:'source contract conformance', unit:'operation/profile pair', outcomeRefs:['outcome'], capabilityRefs:[...capabilities], profileAxisRefs:['axis'],
    numerator:'Passing pairs', denominator:'Every scoped producing pair including missing or incomplete contracts',
    calculation:'100 * numerator / denominator; zero denominator is NOT_APPLICABLE; evidence is NOT_EVALUATED',
    profileBinding:'Exact frozen profile required', applicability:'Source candidate only', acceptanceCriterion:'Identity and provenance required in numerator',
    evidenceMethod:'Qualified contract review', baselinePolicy:'No measured baseline', targetPolicy:'No selected target',
    capabilityCrosswalkStatus:'Definition enumeration; qualified measurements NOT_EVALUATED', populationEnumeration:'Admitted cohort NOT_EVALUATED',
    baseline:'NOT_EVALUATED', target:'NOT_SET', qualification:'NOT_EVALUATED',
    ownerApplicabilityDefinition:{sourceApplicabilityStatus:'COMPLETE_DEFINITION_ONLY',admittedPopulationStatus:'NOT_EVALUATED',sourceCandidateCount:2,normativeCrosswalkRef:'.product-experience/pdp-0-product-truth/goals-jtbd.yaml#/successMeasureContracts/ownerCapabilityApplicabilityCrosswalk/measureApplicabilityRecords/records'},
  }));
  return {goals:{businessIntents:records.map(row => ({id:row.businessIntentRef,measuredBy:row.description})),outcomes:[{id:'outcome'}],successMeasureContracts:{ownerDecisionRef:'.product-experience/decision-log.md#PXD-048',ownerApplicabilityDecisionRef:crosswalk.ownerDecisionRef,records,ownerCapabilityApplicabilityCrosswalk:crosswalk}}, capabilities:{capabilities:capabilities.map(id => ({id}))}, profiles:{profileAxes:[{id:'axis'}]}};
}
test('explicit applicability decision keeps missing output identity in scope without qualified measurements', () => {
  const x=projectionFixture();
  assert.equal(validateBusinessMeasureDefinitions(x.goals,x.capabilities,x.profiles).length,4);
  for (const mutate of [
    y=>{y.goals.successMeasureContracts.ownerApplicabilityDecisionRef='forged';},
    y=>{y.goals.successMeasureContracts.ownerCapabilityApplicabilityCrosswalk.ownerDecisionRef='forged';},
    y=>{y.goals.successMeasureContracts.records[1].capabilityRefs.pop();},
    y=>{y.goals.successMeasureContracts.records[1].ownerApplicabilityDefinition.admittedPopulationStatus='COMPLETE';},
    y=>{y.goals.successMeasureContracts.records[1].ownerApplicabilityDefinition.sourceCandidateCount=1;},
    y=>{y.goals.successMeasureContracts.records[1].qualification='PASS';},
  ]) {const y=projectionFixture();mutate(y);assert.throws(()=>validateBusinessMeasureDefinitions(y.goals,y.capabilities,y.profiles));}
});
