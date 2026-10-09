import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const parse = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url))('yaml').parse;
const pdp3 = '.product-experience/pdp-3-product-experience';
const registry = parse(await readFile(`${pdp3}/screen-registry.yaml`, 'utf8'));
const dispositions = parse(await readFile(`${pdp3}/view-state-binding-dispositions.yaml`, 'utf8'));
const p1 = parse(await readFile('.product-experience/pdp-1-domain-data/states.yaml', 'utf8'));
const actionsDoc = parse(await readFile(`${pdp3}/action-registry.yaml`, 'utf8'));
const actionsById = new Map([
  ...(actionsDoc.actions ?? []).map((action) => [action.id, { action, collection: 'actions' }]),
  ...(actionsDoc.ownerDefinedActions ?? []).map((action) => [action.id, { action, collection: 'ownerDefinedActions' }]),
]);
const screens = [...registry.screens, ...registry.laneViews];
const machines = new Map(p1.stateMachines.map((machine) => [machine.machineId, machine]));
const contracts = new Map();
for (const screen of screens) {
  const ref = (screen.contractRefs ?? [screen.contract])[0];
  const name = ref.split('/').at(-1);
  contracts.set(screen.id, { ref, document: parse(await readFile(`${pdp3}/${ref}`, 'utf8')) });
}

function validate(records = dispositions.views) {
  const errors = [];
  const byId = new Map(records.map((record) => [record.viewRef, record]));
  if (byId.size !== screens.length || records.length !== screens.length) errors.push('view population must exactly equal the 41 screens plus six contextual lane views');
  const dispositionIds = records.map((record) => record.dispositionId).filter(Boolean);
  if (dispositionIds.length !== records.length || new Set(dispositionIds).size !== records.length) errors.push('each view disposition needs a unique stable record ID');
  for (const screen of screens) {
    const record = byId.get(screen.id);
    if (!record) { errors.push(`${screen.id}: missing state disposition`); continue; }
    const { ref, document } = contracts.get(screen.id);
    if (record.screenContractRef !== `${pdp3}/${ref}`) errors.push(`${screen.id}: contract reference mismatch`);
    if (JSON.stringify(record.stateRefs) !== JSON.stringify(document.stateRefs ?? [])) errors.push(`${screen.id}: existing stateRefs drift`);
    if (JSON.stringify(record.displayedStates) !== JSON.stringify(document.states ?? [])) errors.push(`${screen.id}: display-state list drift`);
    const labelRecords = record.stateLabelDispositions;
    const representedLabels = new Set(record.canonicalStateBindings.map((binding) => binding.sourceStateLabel).filter(Boolean));
    const localLabels = record.otherStateDisposition?.localPresentationLabels ?? [];
    const explicitLabels = Array.isArray(labelRecords) ? labelRecords.map((item) => item.label) : [];
    if (!labelRecords || (new Set(explicitLabels).size !== explicitLabels.length
      || JSON.stringify(explicitLabels) !== JSON.stringify(record.displayedStates))) errors.push(`${screen.id}: per-label state dispositions must cover every displayed state exactly once and in source order`);
    if (labelRecords) {
      for (const item of labelRecords) {
        if (!item.kind || !item.meaning?.trim()) errors.push(`${screen.id}: label ${item.label} needs a typed, explicit evidence disposition`);
        if (!Array.isArray(item.evidenceOperationRefs)) errors.push(`${screen.id}: label ${item.label} must carry its exact evidence operation list, even when empty`);
        if (item.kind === 'UNRESOLVED_NO_EXACT_DOMAIN_OBSERVATION_BINDING') {
          const index = document.states.indexOf(item.label);
          if (item.sourceRef !== `${pdp3}/${ref}#/states/${index}`) errors.push(`${screen.id}: unresolved label ${item.label} needs its exact source selector`);
          if (JSON.stringify(item.candidateActionRefs) !== JSON.stringify(document.actions ?? [])) errors.push(`${screen.id}: unresolved label ${item.label} action candidates drift from the view contract`);
          if (JSON.stringify(item.evidenceOperationRefs) !== JSON.stringify(document.operationRefs ?? [])) errors.push(`${screen.id}: unresolved label ${item.label} operation refs drift from the view contract`);
          if (!/Do not infer persisted state, command finality, authorization, or a transition/u.test(item.meaning)) errors.push(`${screen.id}: unresolved label ${item.label} must explicitly prohibit unsupported conclusions`);
        }
        if (item.kind === 'UNKNOWN_EFFECT_NO_DOMAIN_STATE_ASSERTION') {
          const exactOps = new Set();
          for (const evidence of item.actionDefinitionEvidence ?? []) {
            const found = actionsById.get(evidence.actionRef);
            if (!found || evidence.sourceRef !== `${pdp3}/action-registry.yaml#${found.collection}/@id=${evidence.actionRef}`) {
              errors.push(`${screen.id}: unknown outcome action evidence must resolve to its exact registry record`);
              continue;
            }
            const typed = found.action.actionDefinitionSemantics?.typedDefinition;
            if (!typed || typed.effect !== evidence.effect || typed.finality !== evidence.finality
              || typed.failureRecovery !== evidence.failureRecovery || typed.runtimeAdmission !== 'NOT_ADMITTED'
              || JSON.stringify(typed.exactOperationRefs ?? []) !== JSON.stringify(evidence.operationRefs)) errors.push(`${screen.id}: unknown outcome evidence drifted from ${evidence.actionRef}`);
            for (const op of evidence.operationRefs ?? []) exactOps.add(op);
          }
          if (JSON.stringify([...exactOps]) !== JSON.stringify(item.evidenceOperationRefs)) errors.push(`${screen.id}: unknown outcome operation refs must be exact action bindings`);
          if (!/does not claim completion, failure, or domain-state mutation/u.test(item.meaning)
            || !item.nonClaims?.some((claim) => /Do not retry or submit a second request/u.test(claim))) errors.push(`${screen.id}: unknown outcome must retain its noncoercing recovery boundary`);
        }
      }
    }
    for (const binding of record.canonicalStateBindings) {
      const [machineId, ...stateParts] = binding.canonicalStateRef.split('/');
      const stateId = stateParts.at(-1);
      const machine = machines.get(machineId);
      const dimension = stateParts.length === 2 ? stateParts[0] : null;
      const ids = dimension
        ? (machine?.stateDefinitionsByDimension?.[dimension] ?? []).map(({ id }) => id)
        : machine?.stateIds ?? [];
      if (!ids.includes(stateId)) errors.push(`${screen.id}: unresolved canonical state ${binding.canonicalStateRef}`);
      if (!binding.canonicalSourceRef.startsWith('.product-experience/pdp-1-domain-data/states.yaml#stateMachines/')) errors.push(`${screen.id}: noncanonical state source ref`);
    }
    if (record.runtimeAdmission !== 'NOT_ADMITTED') errors.push(`${screen.id}: runtime admission cannot be inferred from a view binding`);
    if (record.stateTransitions !== 'NO_TRANSITION_AUTHORIZED_BY_VIEW; transitions require the exact action/operation and P1 guarded transition contract') errors.push(`${screen.id}: view binding must not authorize transitions`);
  }
  return errors;
}

test('all 47 PDP-3 view identities have exact P1 state bindings or explicit noncanonical presentation dispositions', () => {
  assert.equal(dispositions.viewCount, 47);
  assert.equal(dispositions.views.length, 47);
  assert.deepEqual(validate(), []);
  assert.ok(dispositions.views.some(({ viewRef }) => viewRef === 'media.view.monitor-transcription'));
  assert.ok(dispositions.views.some(({ viewRef }) => viewRef === 'media.view.check-job-outcome'));
  assert.ok(dispositions.views.some(({ viewRef }) => viewRef === 'media.view.compare-caption-versions'));
});

test('find-projects outcome labels have exact scoped query and create-receipt predicates', () => {
  const record = dispositions.views.find(({ viewRef }) => viewRef === 'media.view.find-projects');
  const byLabel = new Map(record.stateLabelDispositions.map((item) => [item.label, item]));
  assert.equal(record.dispositionId, 'media.view-state-disposition.find-projects.v1');
  assert.match(byLabel.get('create-confirmed').meaning, /authoritative atomic commit receipt/u);
  assert.match(byLabel.get('create-outcome-unknown').meaning, /do not assert project creation or absence/u);
  assert.deepEqual(byLabel.get('create-outcome-unknown').evidenceOperationRefs, ['media.operation-slice.create-project', 'media.operation-slice.inspect-project']);
  assert.match(byLabel.get('workspace-empty').meaning, /not a claim about workspace membership or global project absence/u);
  assert.equal(byLabel.get('offline').evidenceOperationRefs.length, 0);
});

test('view-state validation rejects omitted views, invented states, drifted labels and automatic transitions', () => {
  const missing = structuredClone(dispositions.views);
  missing.pop();
  assert.ok(validate(missing).some((error) => error.includes('view population')));
  const forged = structuredClone(dispositions.views);
  forged[0].canonicalStateBindings.push({ canonicalStateRef: 'media-job/NOT_A_STATE', canonicalSourceRef: '.product-experience/pdp-1-domain-data/states.yaml#stateMachines/x', bindingKind: 'EXACT_OWNER_ADJUDICATED_STATE_MEANING' });
  assert.ok(validate(forged).some((error) => error.includes('unresolved canonical state')));
  const drifted = structuredClone(dispositions.views);
  drifted[0].displayedStates.push('fabricated-state');
  assert.ok(validate(drifted).some((error) => error.includes('display-state list drift')));
  const transition = structuredClone(dispositions.views);
  transition[0].stateTransitions = 'automatic-transition';
  assert.ok(validate(transition).some((error) => error.includes('must not authorize transitions')));
});
