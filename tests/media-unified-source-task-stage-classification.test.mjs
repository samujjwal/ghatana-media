import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ledgerPath = new URL('../docs/implementation/observations/media-unified-source-task-and-experiment-crosswalk-2026-10-18.json', import.meta.url);
const blueprintPath = new URL('../docs/implementation/references/MEDIA-UNIFIED-DATA-DRIVEN-PRODUCTION-BLUEPRINT-V3-2026-10-17.md', import.meta.url);
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
const blueprint = readFileSync(blueprintPath, 'utf8');
const rows = new Map(ledger.items.map(row => [row.sourceTaskId, row]));
const category = {
  definition: 'DEFINITION_WORK',
  build: 'BUILD_IMPLEMENTATION',
  qualification: 'QUALIFICATION',
  approval: 'INDEPENDENT_PRODUCT_APPROVAL',
  closure: 'PDP_CLOSURE',
  delivery: 'DELIVERY',
};
const group = (ids, ...categories) => Object.fromEntries(ids.split(/\s+/).map(id => [id, categories]));
const expected = {
  ...group('M-00 M-01 M-02 M-03 INV-01 INV-02 INV-03 INV-04 INV-05 DAS-01', category.definition),
  ...group('M-04 M-07 M-09 M-11', category.build),
  ...group('M-05 M-06 M-08 M-10', category.build, category.qualification),
  ...group('M-12', category.build, category.qualification),
  ...group('M-13', category.qualification, category.approval, category.delivery),
  ...group('M-14', category.qualification, category.approval),
  ...group('M-15', category.build, category.closure, category.delivery),
  ...group('INV-06 INV-07 INV-08 INV-09 INV-10 INV-11', category.build, category.qualification),
  ...group('INV-12', category.build, category.qualification, category.approval),
  ...group('DAS-02 DAS-03 DAS-04 DAS-05 DAS-06 DAS-07 DAS-09 DAS-10 DAS-11', category.build, category.qualification),
  ...group('DAS-08', category.qualification),
  ...group('DAS-12', category.build, category.qualification, category.approval, category.delivery),
  ...group('C-01', category.qualification, category.approval),
  ...group('C-02 C-03 C-04 C-05 C-06 C-07 C-08 C-09 C-10 C-11 C-12 C-13 C-14 C-15 C-16 C-17 C-18 C-19 C-20', category.qualification),
  ...group('C-21', category.qualification, category.delivery),
  ...group('C-22 C-23 C-24 C-25 C-26 C-27 C-28', category.qualification),
  ...group('DAS-A01', category.qualification, category.approval),
  ...group('DAS-A02 DAS-A03 DAS-A04 DAS-A05 DAS-A06 DAS-A07 DAS-A08 DAS-A09 DAS-A10 DAS-A11 DAS-A12', category.qualification),
  ...group('DAS-A13', category.qualification, category.approval),
  ...group('DAS-A14 DAS-A15 DAS-A16 DAS-A17 DAS-A18', category.qualification),
};

test('all 86 original planning and experiment IDs have exact stage categories without claiming execution', () => {
  assert.equal(ledger.items.length, 86);
  assert.equal(rows.size, 86);
  assert.deepEqual([...rows.keys()].sort(), Object.keys(expected).sort());
  assert.equal(ledger.stageClassificationSchema.field, 'items[].stageClassification');
  assert.deepEqual(ledger.stageClassificationSchema.allowedCategories, Object.values(category));
  assert.match(ledger.stageClassificationSchema.statusGuard, /does not record execution, qualification, owner approval, closure, or delivery/);

  for (const [id, expectedCategories] of Object.entries(expected)) {
    const row = rows.get(id);
    assert.deepEqual(row.stageClassification, expectedCategories, `${id} categories`);
    assert.ok(row.stageClassificationRationale.trim(), `${id} rationale`);
    assert.equal(row.completionStatus, 'NOT_ASSERTED_BY_THIS_RECONCILIATION', `${id} completion status`);
    assert.ok(blueprint.includes(row.exactSourceMarkdownRow), `${id} exact source row preserved`);
  }
});

test('multi-stage items call out distinct gates and split-sensitive source rows', () => {
  const splitIds = ['DAS-01', 'M-13', 'M-14', 'M-15', 'C-01', 'C-11', 'C-21', 'DAS-A01', 'DAS-A13', 'DAS-12', 'INV-12'];
  for (const id of splitIds) assert.ok(rows.get(id).splitTreatment, `${id} split treatment`);
  assert.deepEqual(rows.get('M-15').stageClassification, [category.build, category.closure, category.delivery]);
  assert.deepEqual(rows.get('M-13').stageClassification, [category.qualification, category.approval, category.delivery]);
  assert.deepEqual(rows.get('DAS-12').stageClassification, [category.build, category.qualification, category.approval, category.delivery]);
  assert.equal(ledger.status, 'LOSSLESS_SOURCE_TASKS_RECORDED_NO_BUILD_ADMISSION_OR_EXPERIMENT_EXECUTION');
});
