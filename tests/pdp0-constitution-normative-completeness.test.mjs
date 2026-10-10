import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = process.cwd();
const parse = createRequire(resolve(root, '../ghatana-tools/package.json'))('yaml').parse;
const p0 = '.product-experience/pdp-0-product-truth/';
const paths = [
  'constitution.yaml',
  'requirements.yaml',
  'goals-jtbd.yaml',
  'actors-responsibilities.yaml',
  'policy-authority-model.yaml',
  'profile-semantics.yaml',
  'qualification-policy.yaml',
];
const sources = Object.fromEntries(paths.map((name) => [name, parse(readFileSync(`${p0}${name}`, 'utf8'))]));
const contract = sources['constitution.yaml'];
const requiredFields = contract.normativeRecordContract.requiredFields;
const ids = new Set(contract.requirements.map((entry) => entry.id));

function resolveRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith(p0) || /\/pdp-[1-9]-/.test(ref)) return undefined;
  const hash = ref.indexOf('#');
  if (hash < 0) return undefined;
  const file = ref.slice(p0.length, hash);
  let value = sources[file];
  if (!value) return undefined;
  const pointer = ref.slice(hash + 1);
  if (pointer && !pointer.startsWith('/')) return undefined;
  for (const encodedSegment of pointer.split('/').slice(1)) {
    const segment = decodeURIComponent(encodedSegment.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (segment.startsWith('@id=')) {
      if (!Array.isArray(value)) return undefined;
      value = value.find((entry) => entry?.id === segment.slice(4));
    } else if (Array.isArray(value)) {
      if (!/^\d+$/.test(segment)) return undefined;
      value = value[Number(segment)];
    } else if (value && typeof value === 'object') {
      value = value[segment];
    } else {
      return undefined;
    }
    if (value === undefined) return undefined;
  }
  return value;
}

function validate(records) {
  const errors = [];
  if (records.length !== 32 || new Set(records.map((entry) => entry.id)).size !== 32 || records.some((entry) => !ids.has(entry.id))) {
    errors.push('must resolve exactly MEDIA-CONST-001..032');
  }
  for (const entry of records) {
    const refs = entry.normativeFieldRefs;
    if (!refs || requiredFields.some((field) => !Array.isArray(refs[field]) || refs[field].length === 0)) {
      errors.push(`${entry.id}: missing normative field reference`);
      continue;
    }
    if (Object.keys(refs).length !== requiredFields.length || Object.keys(refs).some((key) => !requiredFields.includes(key))) {
      errors.push(`${entry.id}: unexpected normative field`);
    }
    for (const [field, fieldRefs] of Object.entries(refs)) {
      for (const ref of fieldRefs) {
        if (resolveRef(ref) === undefined) errors.push(`${entry.id}: unresolved or foreign ${field} reference ${ref}`);
      }
    }
    const selfStatement = `${p0}constitution.yaml#/requirements/@id=${entry.id}/statement`;
    if (!refs.what.includes(selfStatement) || !refs.requiredBehavior.includes(selfStatement)) {
      errors.push(`${entry.id}: what and requiredBehavior must bind the owner's exact normative statement`);
    }
    const familyRef = refs.context.find((ref) => ref.startsWith(`${p0}requirements.yaml#/requirements/@id=MEDIA-REQ-CAP-`) && ref.endsWith('/capabilityIds'))?.replace(/\/capabilityIds$/, '');
    if (!familyRef || !refs.context.includes(`${familyRef}/traceToIntentIds`) ||
        !refs.preconditions.includes(`${familyRef}/preconditions`) ||
        !refs.requiredBehavior.includes(`${familyRef}/expectedBehavior`) ||
        !refs.outcome.includes(`${familyRef}/acceptanceCases`) ||
        !refs.importantConsequences.includes(`${familyRef}/consequences`) ||
        !refs.failureOrDegradedBehavior.includes(`${familyRef}/failureDegradationRecovery`)) {
      errors.push(`${entry.id}: family requirement does not supply its exact behavior/precondition/outcome/consequence/failure fields`);
    }
    if (entry.acceptanceState !== 'pending-human-review') errors.push(`${entry.id}: human review state must remain pending`);
    if (entry.id === 'MEDIA-CONST-005' || entry.id === 'MEDIA-CONST-006') {
      const rule = `${p0}constitution.yaml#/ownerDefinedExperienceRules/mechanismSelection`;
      if (!refs.requiredBehavior.includes(rule) || !refs.acceptanceCriteria.includes(`${rule}/negativeCases`)) {
        errors.push(`${entry.id}: missing product-owner mechanism selection rule and negative acceptance cases`);
      }
    }
  }
  return errors;
}

test('all 32 constitutional requirements resolve all twelve normative fields from P0 sources', () => {
  assert.equal(contract.requirements.length, 32);
  assert.equal(contract.status, 'MEDIA_OWNER_DEFINITION_COMPLETE; HUMAN_REVIEW_PENDING; P0-010_INDEPENDENT_REVIEW_PENDING');
  assert.deepEqual(validate(contract.requirements), []);
  assert.match(contract.contractRealizationRule.knownGaps[0], /All 32 constitutional records provide source-bound references/);
  assert.match(contract.contractRealizationRule.knownGaps[0], /acceptance gates, not unestablished definition fields/);
});

test('mechanism selection is predeclared, evidence-based and fail-closed', () => {
  const rule = contract.ownerDefinedExperienceRules.mechanismSelection;
  assert.match(rule.rule, /predeclared decision rule and materiality criterion/);
  assert.match(rule.rule, /capability\/profile acceptance criteria/);
  assert.match(rule.missingEvidenceDisposition, /NOT_ADMITTED/);
  assert.deepEqual(rule.negativeCases.map((entry) => entry.id), [
    'category-is-not-benefit-evidence', 'missing-criterion-or-baseline', 'noncomparable-candidate-evidence',
    'deterministic-candidate-satisfies', 'ai-candidate-without-measured-acceptance', 'evidence-does-not-satisfy-hard-constraint',
  ]);
});

test('preservation profile meaning maps to the qualification dimension without claiming leaf qualification', () => {
  const profile = sources['profile-semantics.yaml'];
  const axis = profile.profileAxes.find((entry) => entry.id === 'PROFILE-AXIS-PRESERVATION');
  assert.equal(axis.qualificationPolicyDimension, 'preservation-policy');
  assert.match(axis.qualificationPolicyMappingState, /^DEFINED;/);
  assert.equal(resolveRef(axis.qualificationPolicyMappingRef), sources['qualification-policy.yaml'].profileDimensions);
  assert.ok(sources['qualification-policy.yaml'].profileDimensions.includes('preservation-policy'));
  assert.ok(profile.semanticCompletion.completed.includes('preservation-qualification-dimension-mapping'));
  assert.ok(profile.semanticCompletion.laterBindingWork.includes('per-capability-profile-qualification-evidence'));
  assert.deepEqual(profile.semanticCompletion.ownerPendingSemantics, []);
});

test('validator rejects missing, foreign and contradictory/repinned references', () => {
  const missing = structuredClone(contract.requirements);
  delete missing[0].normativeFieldRefs.why;
  assert.ok(validate(missing).some((error) => error.includes('MEDIA-CONST-001: missing normative field reference')));

  const foreign = structuredClone(contract.requirements);
  foreign[1].normativeFieldRefs.context[0] = '.product-experience/pdp-1-domain-data/operations.yaml#/operations';
  assert.ok(validate(foreign).some((error) => error.includes('unresolved or foreign context reference')));

  const contradictory = structuredClone(contract.requirements);
  contradictory[4].normativeFieldRefs.requiredBehavior = [
    `${p0}profile-semantics.yaml#/fallbackSemantics/defaultPermission`,
    `${p0}requirements.yaml#/requirements/@id=MEDIA-REQ-CAP-CAPABILITY/expectedBehavior`,
  ];
  assert.ok(validate(contradictory).some((error) => error.includes('MEDIA-CONST-005: what and requiredBehavior must bind')));
  assert.ok(validate(contradictory).some((error) => error.includes('MEDIA-CONST-005: missing product-owner mechanism selection rule')));
});
