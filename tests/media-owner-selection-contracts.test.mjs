import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toolsRequire = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = toolsRequire("yaml");
const source = (p) => parse(readFileSync(join(root, p), "utf8"));
const paths = {
  goals: ".product-experience/pdp-0-product-truth/goals-jtbd.yaml",
  typography: ".product-experience/pdp-2-design-interface-system/typography-layout.yaml",
  accessibility: ".product-experience/pdp-2-design-interface-system/accessibility.yaml",
  finality: ".product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml",
  recipes: ".product-experience/pdp-2-design-interface-system/gui/recipes/catalog.yaml",
  templates: ".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml",
  patterns: ".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml",
  toolConventions: ".product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml",
  toolRegistry: ".product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml",
  operations: ".product-experience/pdp-1-domain-data/operations.yaml",
  searchInspection: ".product-experience/pdp-3-product-experience/search-inspection-contracts.yaml",
  domainObjects: ".product-experience/pdp-1-domain-data/domain-objects.yaml",
};
const unique = (items, field = "id") => new Set(items.map(x => x[field])).size === items.length;

test("PDP-0 explicitly classifies non-goals and business intents from owner source", () => {
  const goals = source(paths.goals);
  assert.ok(goals.nonGoals.length >= 5);
  assert.ok(goals.businessIntents.length >= 4);
  assert.ok(unique(goals.nonGoals));
  assert.ok(unique(goals.businessIntents));
  for (const goal of goals.nonGoals) {
    assert.match(goal.id, /^media\.non-goal\./u);
    assert.ok(goal.description && goal.reason);
  }
  for (const intent of goals.businessIntents) {
    assert.match(intent.id, /^media\.business\./u);
    assert.ok(intent.description && intent.measuredBy);
  }
});

test("density and presentation profiles match Tools enum and explicit references", () => {
  const typography = source(paths.typography);
  assert.ok(unique(typography.densityProfiles));
  assert.ok(unique(typography.presentationProfiles));
  const densities = new Set(typography.densityProfiles.map(x => x.id));
  for (const d of typography.densityProfiles) {
    assert.ok(["minimal", "compact", "standard", "rich"].includes(d.density));
    assert.ok(d.name && d.description && d.sourceMode);
  }
  for (const p of typography.presentationProfiles) {
    assert.ok(densities.has(p.densityRef), `unknown densityRef: ${p.densityRef}`);
  }
  assert.ok(typography.progressiveDisclosureRules.length >= 3);
  for (const x of typography.progressiveDisclosureRules) assert.ok(x.trigger && x.reveals && x.conceals);
  assert.ok(typography.disclosureInvariants.some(x => /Never conceal identity/u.test(x)));
});

test("WCAG 2.2 AA is a normative target, not fabricated accessible-technology evidence", () => {
  const a11y = source(paths.accessibility);
  assert.equal(a11y.selectedPolicy.standard, "WCAG 2.2");
  assert.equal(a11y.selectedPolicy.level, "AA");
  assert.equal(a11y.selectedPolicy.policyStatus, "SELECTED_AS_ACCEPTANCE_TARGET_NOT_CERTIFIED");
  assert.ok(a11y.accessibilityRules.length > 0);
  assert.ok(unique(a11y.accessibilityRules));
  for (const x of a11y.accessibilityRules) {
    assert.equal(x.standard, "WCAG 2.2");
    assert.equal(x.level, "AA");
    assert.ok(x.requirement);
  }
  assert.ok(a11y.verificationEvidenceRequired.includes("screen-reader-observation"));
});

test("automatic recovery is limited to safe observation, not resubmission", () => {
  const finality = source(paths.finality);
  assert.ok(finality.recoveryPatterns.length > 0);
  assert.ok(unique(finality.recoveryPatterns));
  const safeAutomaticIds = new Set(["media.recovery.observer-reconnect", "media.recovery.cancel-requested"]);
  for (const p of finality.recoveryPatterns) {
    assert.equal(typeof p.automaticRecovery, "boolean");
    assert.ok(p.description);
    if (p.automaticRecovery) assert.ok(safeAutomaticIds.has(p.id),
      `unauthorized automatic effect recovery: ${p.id}`);
  }
});

test("every selected GUI template has an exact owned composition recipe and registered pattern", () => {
  const recipes = source(paths.recipes).recipes;
  const templates = source(paths.templates).templates;
  const patterns = source(paths.patterns).patterns;
  const templateIds = new Set(templates.map(x => x.id));
  const patternIds = new Set(patterns.map(x => x.id));
  assert.equal(recipes.length, templates.length);
  assert.ok(unique(recipes));
  assert.ok(unique(recipes, "templateRef"));
  for (const recipe of recipes) {
    assert.ok(templateIds.has(recipe.templateRef), `stale template: ${recipe.templateRef}`);
    assert.ok(patternIds.has(recipe.semanticPattern), `stale pattern: ${recipe.semanticPattern}`);
    assert.equal(recipe.screenInstanceAdmission, "PENDING");
    assert.equal(recipe.sharedPublicBinding, "PENDING");
  }
});

test("all four Agent Tool semantic selections resolve existing observed IDs and PDP-1 families without execution admission", () => {
  const selections = source(paths.toolConventions).ownerSemanticSelections;
  const registry = source(paths.toolRegistry);
  const operations = source(paths.operations);
  const observed = new Set(registry.tools.map(x => x.id));
  const canonical = new Set((operations.operations ?? []).map(x => x.id));
  assert.equal(selections.tools.length, observed.size);
  assert.ok(unique(selections.tools, "toolId"));
  for (const tool of selections.tools) {
    assert.ok(observed.has(tool.toolId), `no actual Agent Tool handler for ${tool.toolId}`);
    assert.ok(canonical.has(tool.canonicalOperationFamily), `unregistered canonical operation family for ${tool.toolId}`);
    assert.equal(tool.executionAdmitted, false);
    assert.ok(Array.isArray(tool.requiredProof) && tool.requiredProof.length >= 5);
    assert.ok(tool.inputBoundary && tool.effectSemantics);
  }
  assert.match(selections.status, /CONTRACT_AND_EXECUTION_ADMISSION_PENDING/);
});

test("PDP-3 search and inspection contracts are source-owned, typed and fail closed", () => {
  const catalog = source(paths.searchInspection);
  const domainIds = new Set(source(paths.domainObjects).objects.map(x => x.id));
  assert.equal(catalog.searches.length, 3);
  assert.equal(catalog.inspections.length, 5);
  assert.ok(unique(catalog.searches) && unique(catalog.inspections));
  for (const item of catalog.searches) {
    assert.ok(item.searchableTypes?.length > 0);
    assert.ok(item.searchableTypes.every(id => domainIds.has(id)), `unknown searchable domain type for ${item.id}`);
    assert.ok(item.authorization && item.pagination && item.absentResults);
    assert.equal(item.runtimeBinding, "NOT_ADMITTED");
  }
  for (const item of catalog.inspections) {
    assert.ok(["specification", "authority", "evidence", "trace", "simulation"].includes(item.projectionKind));
    assert.ok(item.authorityRefs?.length > 0 && item.requiredContext?.length > 0);
    assert.ok(["NOT_ADMITTED", "DEFINITION_ONLY"].includes(item.runtimeBinding));
  }
  assert.ok(catalog.policy.some(rule => /alternate authorization side channels/u.test(rule)));
});
