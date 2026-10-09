import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  loadCompositionCatalogs,
  validateAllScreenCompositionSources,
  validateCatalogRelations,
  validateComposition as validateSourceComposition,
} from "../scripts/lib/pdp-design-composition-validator.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const base = ".product-experience/pdp-2-design-interface-system/gui";
const experience = ".product-experience/pdp-3-product-experience";
const registry = readYaml(`${experience}/screen-registry.yaml`);
const templates = readYaml(`${base}/templates/catalog.yaml`).templates;
const patterns = readYaml(`${base}/patterns/catalog.yaml`).patterns;
const layouts = readYaml(`${base}/layout.yaml`).layouts;
const components = readYaml(".product-experience/pdp-2-design-interface-system/component-contracts.yaml").components;
const actions = readYaml(`${experience}/action-registry.yaml`).actions;
const templateById = new Map(templates.map((item) => [item.id, item]));
const patternById = new Map(patterns.map((item) => [item.id, item]));
const layoutById = new Map(layouts.map((item) => [item.id, item]));
const componentById = new Map(components.map((item) => [item.id, item]));
const actionById = new Map(actions.map((item) => [item.id, item]));
const views = [...registry.screens, ...registry.laneViews];
const compositionCatalogs = loadCompositionCatalogs(root);

function validateComposition(contract, componentRecords = componentById) {
  return validateSourceComposition(contract, compositionCatalogs, componentRecords);
}

test("all 47 selected screen compositions resolve central patterns, layouts, components, actions, and responsive grammar", () => {
  assert.equal(views.length, 47);
  assert.equal(new Set(views.map((view) => view.id)).size, 47);
  for (const view of views) {
    assert.equal(view.contractRefs.length, 1, `${view.id} needs one canonical source contract`);
    const path = `${experience}/${view.contractRefs[0]}`;
    assert.ok(existsSync(resolve(root, path)), `${view.id} contract source exists`);
    const contract = readYaml(path);
    assert.equal(contract.screenId, view.id);
    assert.deepEqual(validateComposition(contract), [], `${view.id} composition source must be structurally complete against central PDP-2 grammar`);
    assert.equal(contract.validation?.status, "proposal-validation-pending-owner-review", `${view.id} stays a candidate, not an admitted screen`);
    assert.equal(contract.verification?.status, "not-run", `${view.id} cannot claim rendered or keyboard acceptance`);
    assert.equal(contract.responsiveBehavior.status, "proposal-unverified", `${view.id} keeps viewport verification open`);
  }
});

test("the reusable composition validator is part of actual source validation and enforces reciprocal catalogs", () => {
  assert.deepEqual(validateAllScreenCompositionSources(root), []);
  const rules = compositionCatalogs.grammar.normativeRuleRecords;
  assert.equal(new Set(rules.map(({ id }) => id)).size, rules.length);
  assert.equal(rules.length,
    Object.keys(compositionCatalogs.grammar.linkRules).length
    + Object.keys(compositionCatalogs.grammar.accessibilityRules).length
    + compositionCatalogs.templates.length
    + compositionCatalogs.patterns.length,
    "the authored rule census includes every grammar and ordered region contract");
  for (const rule of rules) {
    assert.ok(existsSync(resolve(root, rule.sourceRef.split("#")[0])), `${rule.id} source file exists`);
    assert.equal(rule.authorityRef, ".product-experience/decision-log.md#PXD-076");
    assert.ok(rule.normativeRequirement.trim());
  }
  const catalogs = structuredClone(compositionCatalogs);
  catalogs.templates[0].recipeRefs = [];
  assert.ok(validateCatalogRelations(catalogs).some((error) => error.includes("recipeRefs must be nonempty")));

  const missingNormativeRecord = structuredClone(compositionCatalogs);
  missingNormativeRecord.grammar.normativeRuleRecords.pop();
  assert.ok(validateCatalogRelations(missingNormativeRecord).some((error) => error.includes("normativeRuleRecords must uniquely enumerate")));

  const brokenBackLink = structuredClone(compositionCatalogs);
  const template = brokenBackLink.templates.find((item) => item.compatibleLayoutRefs.length > 0);
  const layout = brokenBackLink.layouts.find((item) => item.id === template.compatibleLayoutRefs[0]);
  layout.compatibleTemplateRefs = layout.compatibleTemplateRefs.filter((id) => id !== template.id);
  assert.ok(validateCatalogRelations(brokenBackLink).some((error) => error.includes("does not reciprocally list the template")));

  const brokenRecipe = structuredClone(compositionCatalogs);
  const recipeTemplate = brokenRecipe.templates.find((item) => item.recipeRefs.length > 0);
  const recipe = brokenRecipe.recipes.find((item) => item.id === recipeTemplate.recipeRefs[0]);
  recipe.templateRef = "media.gui.template.not-registered";
  assert.ok(validateCatalogRelations(brokenRecipe).some((error) => error.includes("unknown template")));

  const missingRecipeBacklink = structuredClone(compositionCatalogs);
  const backlinkTemplate = missingRecipeBacklink.templates.find((item) => item.recipeRefs.length > 0);
  const backlinkRecipeId = backlinkTemplate.recipeRefs[0];
  backlinkTemplate.recipeRefs = backlinkTemplate.recipeRefs.filter((id) => id !== backlinkRecipeId);
  assert.ok(validateCatalogRelations(missingRecipeBacklink).some((error) => error.includes("does not reciprocally list the recipe")));
});

test("owner-defined PDP-3 actions participate in actual composition reference resolution", () => {
  const catalogs = loadCompositionCatalogs(root);
  const ownerAction = readYaml(`${experience}/action-registry.yaml`).ownerDefinedActions[0];
  assert.ok(ownerAction?.id, "the source-owned ownerDefinedActions population is present");
  assert.ok(catalogs.actions.some((action) => action.id === ownerAction.id), "composition catalog includes the exact owner-defined action record");
  const errors = validateSourceComposition({
    templateId: "missing-template",
    templateContract: { templateRef: "missing-template" },
    layoutIds: ["missing-layout"],
    patternIds: ["missing-pattern"],
    anatomy: ["candidate"],
    componentIds: [],
    actions: [ownerAction.id],
    actionConsequences: [],
    responsiveBehavior: { ref: ".product-experience/pdp-2-design-interface-system/gui/layout.yaml#layoutRules.responsive", screenOverrides: [] },
    accessibility: { status: "accessibility-intent-proposal-pending-owner-review" },
  }, catalogs);
  assert.ok(errors.some((error) => error.includes("unknown template")), "fixture demonstrates other catalog errors are still reported");
  assert.ok(!errors.some((error) => error === `unknown action ${ownerAction.id}`), "exact owner-defined action is resolved rather than misreported absent");
});

test("composition validation rejects stale patterns, missing keyboard semantics, and local responsive overrides", () => {
  const sourcePath = `${experience}/${registry.screens.find((view) => view.id === "media.view.job-status").contractRefs[0]}`;
  const original = readYaml(sourcePath);

  const stalePattern = structuredClone(original);
  stalePattern.patternIds = ["media.gui.pattern.not-registered"];
  assert.ok(validateComposition(stalePattern).some((error) => error.includes("unknown pattern")));

  const missingKeyboardSemantics = structuredClone(original);
  const componentId = missingKeyboardSemantics.componentIds[0];
  const componentRecords = new Map(componentById);
  componentRecords.set(componentId, { ...componentRecords.get(componentId), keyboard: null });
  assert.ok(validateComposition(missingKeyboardSemantics, componentRecords).some((error) => error.includes("lacks keyboard semantics")));

  const localOverride = structuredClone(original);
  localOverride.responsiveBehavior = {
    ref: `${base}/layout.yaml#layoutRules.responsive`,
    status: "proposal-unverified",
    screenOverrides: ["hide-unknown-finality-on-mobile"],
  };
  assert.ok(validateComposition(localOverride).some((error) => error.includes("screen-local responsive overrides")));

  const badAction = structuredClone(original);
  badAction.actions = ["media.action.not-registered"];
  assert.ok(validateComposition(badAction).some((error) => error.includes("unknown action")));

  const brokenTemplateBinding = structuredClone(original);
  brokenTemplateBinding.templateContract.templateRef = "media.gui.template.other";
  assert.ok(validateComposition(brokenTemplateBinding).some((error) => error.includes("templateContract.templateRef")));

  const missingFocus = structuredClone(compositionCatalogs);
  missingFocus.grammar.accessibilityRules.screenFocus = "preserve reading order only";
  assert.ok(validateSourceComposition(original, missingFocus).some((error) => error.includes("central screen accessibility grammar must preserve focus and reading order")));

  const missingComponentDisposition = structuredClone(compositionCatalogs);
  const sharedOnlyPattern = missingComponentDisposition.patterns.find((item) => item.id === "media.gui.pattern.safe-confirmation-and-unknown-outcome");
  delete sharedOnlyPattern.componentDisposition;
  delete sharedOnlyPattern.noMediaComponentRationale;
  const sharedOnlyScreen = readYaml(`${experience}/screen-contracts/review-workspace-settings.yaml`);
  assert.ok(validateSourceComposition(sharedOnlyScreen, missingComponentDisposition).some((error) => error.includes("needs component bindings or an explicit Shared-primitives-only disposition")));

  const missingPatternRegions = structuredClone(compositionCatalogs);
  const selectedPattern = missingPatternRegions.patterns.find((item) => item.id === original.patternIds[0]);
  selectedPattern.anatomy = selectedPattern.anatomy.slice(0, -1);
  const regionErrors = validateSourceComposition(original, missingPatternRegions);
  assert.ok(regionErrors.some((error) => error.includes("required-region sequence differs from central composition grammar")));

  const missingTemplateRegion = structuredClone(compositionCatalogs);
  const templateRegionSequence = missingTemplateRegion.templates.find((item) => item.id === original.templateId).regions;
  templateRegionSequence.pop();
  assert.ok(validateCatalogRelations(missingTemplateRegion).some((error) => error.includes("template required-region sequence differs from central composition grammar")));
});

test("every uncertain action retains a template-level unknown-finality recovery pattern", () => {
  const actionMap = new Map(actions.map((action) => [action.id, action]));
  const uncertainViews = [];
  for (const view of views) {
    const contractPath = `${experience}/${view.contractRefs[0]}`;
    const contract = readYaml(contractPath);
    const hasUncertainAction = contract.actions.some((id) => {
      const finality = actionMap.get(id)?.actionDefinitionSemantics?.typedDefinition?.finality ?? actionMap.get(id)?.finality ?? "";
      return /unknown|uncertain|pending|acknowledgment-required/iu.test(finality);
    });
    if (!hasUncertainAction) continue;
    uncertainViews.push(view.id);
    assert.deepEqual(validateComposition(contract), [], `${view.id} preserves unknown-finality treatment`);

    const brokenSelection = structuredClone(contract);
    const keepNonRecovery = (id) => {
      const pattern = patternById.get(id);
      return !((pattern?.states ?? []).some((state) => /unknown/iu.test(state))
        && (pattern?.anatomy ?? []).some((region) => /recovery|outcome|finality/iu.test(region)));
    };
    brokenSelection.patternIds = brokenSelection.patternIds.filter(keepNonRecovery);
    brokenSelection.patternOverlayIds = (brokenSelection.patternOverlayIds ?? []).filter(keepNonRecovery);
    const patternErrors = validateComposition(brokenSelection);
    assert.ok(patternErrors.some((error) => error.includes("lacks an approved required region for unknown finality")), `${view.id} rejects removal of the selected unknown-finality pattern`);
  }
  assert.ok(uncertainViews.length > 0, "the current catalog exercises unknown-finality validation");
});

test("central layout and accessibility rules retain critical facts at every density and color mode", () => {
  const layout = readYaml(`${base}/layout.yaml`);
  const typography = readYaml(".product-experience/pdp-2-design-interface-system/typography-layout.yaml");
  const responsive = readYaml(".product-experience/pdp-2-design-interface-system/responsive-adaptive.yaml");
  const accessibility = readYaml(".product-experience/pdp-2-design-interface-system/accessibility.yaml");
  assert.ok(layout.layoutRules.hierarchy.includes("state-and-finality"));
  assert.ok(layout.layoutRules.hierarchy.includes("next-safe-action"));
  assert.ok(layout.layoutRules.forbidden.includes("hidden unknown-finality warning"));
  assert.equal(new Set(typography.densityProfiles.map((profile) => profile.density)).size, 3);
  assert.ok(typography.disclosureInvariants.some((rule) => rule.includes("uncertainty")));
  assert.ok(responsive.invariants.some((rule) => rule.includes("reflow")));
  assert.ok(responsive.invariants.some((rule) => rule.includes("Timeline and waveform gestures have non-drag alternatives")));
  assert.ok(accessibility.requirements.some((rule) => rule.includes("Reduced-motion preferences")));
  assert.ok(accessibility.requirements.some((rule) => rule.includes("Forced-colors mode")));
  assert.ok(accessibility.verificationEvidenceRequired.includes("keyboard-only-observation"));
  assert.match(accessibility.acceptance, /review-required/);
});
