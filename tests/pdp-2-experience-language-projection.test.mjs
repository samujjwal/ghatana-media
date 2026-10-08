import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const candidate = JSON.parse(await readFile('.product-experience/pdp-2-design-interface-system/generated/experience-language.candidate.json', 'utf8'));
const model = candidate.candidateModel;
const templateRefsAndPatterns = [
  ['media.gui.template.collection', 'media.gui.pattern.project-browser'],
  ['media.gui.template.workbench', 'media.gui.pattern.transcript-and-playback, media.gui.pattern.caption-editor'],
  ['media.gui.template.job-observation', 'media.gui.pattern.job-status-and-recovery, media.gui.pattern.activity-attention, media.gui.pattern.safe-confirmation-and-unknown-outcome'],
  ['media.gui.template.review-and-compare', 'media.gui.pattern.version-comparison, media.gui.pattern.review-approval, media.gui.pattern.quality-and-uncertainty, media.gui.pattern.provenance-and-lineage'],
  ['media.gui.template.consent-gate', 'media.gui.pattern.rights-and-consent-review'],
  ['media.gui.template.render-preparation-and-review', 'media.gui.pattern.rendering, media.gui.pattern.review-approval, media.gui.pattern.provenance-and-lineage'],
  ['media.gui.template.lifecycle-confirmation', 'media.gui.pattern.destructive-lifecycle-action, media.gui.pattern.safe-confirmation-and-unknown-outcome'],
  ['media.gui.template.task-setup', 'media.gui.pattern.intent-launcher, media.gui.pattern.creation-plan-review, media.gui.pattern.source-picker, media.gui.pattern.safe-confirmation-and-unknown-outcome'],
];
const outcomeIds = [
  'media.action-outcome.applied', 'media.action-outcome.completed', 'media.action-outcome.partial',
  'media.action-outcome.cancellation-pending', 'media.action-outcome.unknown', 'media.action-outcome.blocked',
];

test('PDP-2 disclosure density mapping follows the selected simple/guided/expert taxonomy', () => {
  assert.deepEqual(model.densityProfiles.map(({ name, density }) => [name, density]), [
    ['simple', 'minimal'], ['guided', 'standard'], ['expert', 'rich'],
  ]);
  assert.deepEqual(model.presentationProfiles.map(({ name, densityRef }) => [name, densityRef]), [
    ['simple', 'media.language.density.simple'],
    ['guided', 'media.language.density.guided'],
    ['expert', 'media.language.density.expert'],
  ]);
  assert.equal(model.progressiveDisclosureRules.length, 3);
  assert.match(model.progressiveDisclosureRules[0].trigger, /selects Simple/);
  assert.match(model.progressiveDisclosureRules[0].reveals, /intent and safe defaults/);
  assert.equal(model.progressiveDisclosureRules.every((rule) => !Object.hasOwn(rule, 'conceals')), true);
});

test('PDP-2 recovery and accessibility projections preserve their authored scope', () => {
  assert.deepEqual(model.recoveryPatterns.map(({ id }) => id), outcomeIds);
  assert.deepEqual(model.recoveryPatterns.filter(({ automaticRecovery }) => automaticRecovery).map(({ id }) => id), [
    'media.action-outcome.cancellation-pending', 'media.action-outcome.unknown',
  ]);
  assert.equal(model.accessibilityRules.length, 8);
  assert.ok(model.accessibilityRules.every(({ standard, level }) => standard === 'WCAG 2.2' && level === 'AA'));
  assert.match(candidate.candidateMappingReview.ownerDecisionStatus, /PENDING/);
  assert.equal(candidate.acceptance, 'NOT_CLAIMED');
});

test('PDP-2 projects exact owner-approved recipe identities while admission stays pending', () => {
  assert.deepEqual(model.recipeBindings.map(({ id, recipeRef, semanticPattern }) => [id, recipeRef, semanticPattern]), [
    ['media.language.recipe-binding.collection', 'media.gui.recipe.collection', 'media.gui.pattern.project-browser'],
    ['media.language.recipe-binding.workbench', 'media.gui.recipe.workbench', 'media.gui.pattern.transcript-and-playback'],
    ['media.language.recipe-binding.job-observation', 'media.gui.recipe.job-observation', 'media.gui.pattern.job-status-and-recovery'],
    ['media.language.recipe-binding.review-and-compare', 'media.gui.recipe.review-and-compare', 'media.gui.pattern.version-comparison'],
    ['media.language.recipe-binding.consent-gate', 'media.gui.recipe.consent-gate', 'media.gui.pattern.rights-and-consent-review'],
    ['media.language.recipe-binding.render-preparation-and-review', 'media.gui.recipe.render-preparation-and-review', 'media.gui.pattern.rendering'],
    ['media.language.recipe-binding.lifecycle-confirmation', 'media.gui.recipe.lifecycle-confirmation', 'media.gui.pattern.destructive-lifecycle-action'],
    ['media.language.recipe-binding.task-setup', 'media.gui.recipe.task-setup', 'media.gui.pattern.intent-launcher'],
  ]);
  const disposition = candidate.candidateMappingReview.fieldDispositions.recipeBindings;
  assert.match(disposition.status, /OWNER_APPROVED_MEDIA_RECIPE_MAPPING/u);
  assert.match(disposition.status, /SHARED_AND_SCREEN_INSTANCE_ADMISSION_PENDING/u);
  assert.match(disposition.source, /gui\/recipes\/catalog\.yaml#recipes/u);
  assert.equal(candidate.fieldMappingBlockers.some(({ field }) => field === 'recipeBindings'), false);
  assert.deepEqual(templateRefsAndPatterns.map(([templateRef]) => templateRef), [
    'media.gui.template.collection', 'media.gui.template.workbench', 'media.gui.template.job-observation',
    'media.gui.template.review-and-compare', 'media.gui.template.consent-gate',
    'media.gui.template.render-preparation-and-review', 'media.gui.template.lifecycle-confirmation',
    'media.gui.template.task-setup',
  ]);
});

test('PDP-3 search and inspection source records project to the public schema shape', async () => {
  const specification = JSON.parse(await readFile('.product-experience/pdp-3-product-experience/generated/experience-specification.candidate.json', 'utf8'));
  const sourceText = await readFile('.product-experience/pdp-3-product-experience/search-inspection-contracts.yaml', 'utf8');
  const model = specification.candidateModel;
  assert.deepEqual(model.search.map(({ id }) => id), [
    'media.search.authorized-projects', 'media.search.authorized-artifacts', 'media.search.authorized-jobs',
  ]);
  assert.deepEqual(model.search.map(({ searchableTypes }) => searchableTypes), [
    ['media.domain.project'],
    ['media.domain.artifact-version'],
    ['media.domain.processing-job', 'media.domain.artifact-verification-job'],
  ]);
  assert.deepEqual(model.inspections.map(({ id, projectionKind }) => [id, projectionKind]), [
    ['media.inspection.specification', 'specification'],
    ['media.inspection.authority', 'authority'],
    ['media.inspection.evidence', 'evidence'],
    ['media.inspection.trace', 'trace'],
    ['media.inspection.synthetic-simulation', 'simulation'],
  ]);
  assert.ok(model.search.every((entry) => ['id', 'name', 'searchableTypes', 'description'].every((key) => Object.hasOwn(entry, key))));
  assert.ok(model.inspections.every((entry) => ['id', 'projectionKind', 'description'].every((key) => Object.hasOwn(entry, key))));
  for (const { id } of [...model.search, ...model.inspections]) assert.ok(sourceText.includes(id), `${id} exists in authored source`);
  assert.ok(specification.sourceAuthorities.some(({ sourceRef }) => sourceRef === '.product-experience/pdp-3-product-experience/search-inspection-contracts.yaml'));
  assert.match(specification.candidateMappingReview.ownerDecisionStatus, /PXD-027|PENDING/);
  assert.equal(specification.acceptance, 'NOT_CLAIMED');
});

test('residual report drops mapped PDP-2 and search/inspection fields while retaining other PDP-3 gaps', () => {
  const report = JSON.parse(execFileSync('node', ['scripts/report-media-definition-residuals.mjs', '--json'], { encoding: 'utf8' }));
  const pdp2 = report.projections.find(({ phase }) => phase === 'PDP-2');
  const pdp3 = report.projections.find(({ phase }) => phase === 'PDP-3');
  assert.equal(pdp2.unresolvedFieldCount, 0);
  assert.deepEqual(pdp2.unresolvedFields.map(({ field }) => field), []);
  assert.equal(pdp3.unresolvedFieldCount, 10);
  assert.deepEqual(pdp3.unresolvedFields.map(({ field }) => field), [
    'actions', 'componentContracts', 'effects', 'finality', 'fixtures',
    'journeys', 'recovery', 'scenarios', 'transitions', 'views',
  ]);
});
