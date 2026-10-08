import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const gui = ".product-experience/pdp-2-design-interface-system/gui";
const experience = ".product-experience/pdp-3-product-experience";
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
function assertKnownUniqueRefs(refs, known, label) {
  assert.equal(new Set(refs).size, refs.length, `${label} has duplicate refs`);
  for (const ref of refs) assert.ok(known.has(ref), `${label} has stale or cross-domain ref ${ref}`);
}

test("PDP-2 recipe review keeps recipe identity distinct from template, pattern, and layout IDs", () => {
  const review = readYaml(`${gui}/recipe-chain-review.yaml`);
  const templateCatalog = readYaml(`${gui}/templates/catalog.yaml`);
  const patternCatalog = readYaml(`${gui}/patterns/catalog.yaml`);
  const layoutCatalog = readYaml(`${gui}/layout.yaml`);
  const compositionSchema = readYaml(`${gui}/screen-composition-schema.yaml`);
  const screenRegistry = readYaml(`${experience}/screen-registry.yaml`);
  const processingCapabilities = readYaml(".product-experience/pdp-0-product-truth/capabilities.yaml");
  const recipeCatalogPath = `${gui}/recipes/catalog.yaml`;

  assert.equal(existsSync(resolve(root, recipeCatalogPath)), true, "the owner-approved GUI recipe catalog defines recipe IDs");
  const recipeCatalog = readYaml(recipeCatalogPath);
  assert.equal(recipeCatalog.status, "OWNER_APPROVED_AS_DEFINITION_RECIPES; SHARED_COMPONENT_AND_SCREEN_INSTANCE_ADMISSION_PENDING");
  assert.equal(review.recipeCatalog.status, "OWNER_APPROVED_AS_DEFINITION_RECIPES");
  assert.equal(review.recipeCatalog.records.length, recipeCatalog.recipes.length);
  assert.ok(review.sourceRefs.includes(`${gui}/screen-composition-schema.yaml`));
  assert.equal(review.chains.length, 8);
  assert.match(review.residuals.join(" "), /PDP-0 media\.recipe\.template capability records.*do not explicitly bind/u);

  const processingRecipeIds = new Set(processingCapabilities.families
    .filter((family) => family.id === "media.recipe.template")
    .flatMap((family) => family.capabilityIds));
  assert.ok(processingRecipeIds.size > 0, "PDP-0 contains processing recipe capabilities");
  assert.ok([...processingRecipeIds].every((id) => id.startsWith("media.recipe.template.")),
    "PDP-0 recipe IDs are processing capabilities, not GUI recipe records");
  assert.ok([...processingRecipeIds].every((id) => !id.startsWith("media.gui.recipe.")));

  assert.ok(!compositionSchema.requiredFields.includes("recipeRef"),
    "the composition contract requires a template but does not define a recipe binding");
  assert.ok(!Object.hasOwn(compositionSchema.fieldRules, "recipeRef"));
  assert.ok(!Object.hasOwn(compositionSchema.example, "recipeRef"));

  const templates = new Map(templateCatalog.templates.map((record) => [record.id, record]));
  const patterns = new Set(patternCatalog.patterns.map((record) => record.id));
  const layouts = new Set(layoutCatalog.layouts.map((record) => record.id));
  const recipes = new Map(recipeCatalog.recipes.map((record) => [record.id, record]));
  const reviewedRecipes = new Map(review.recipeCatalog.records.map((record) => [record.id, record]));
  assert.equal(recipes.size, 8, "each template has an owner-approved GUI recipe identity");
  assert.equal(reviewedRecipes.size, recipes.size, "review records every catalog recipe exactly once");
  for (const recipe of recipes.values()) {
    assert.ok(templates.has(recipe.templateRef), `${recipe.id} has a canonical template`);
    assert.ok(patterns.has(recipe.semanticPattern), `${recipe.id} has a canonical primary pattern`);
    assert.ok(templates.get(recipe.templateRef).patterns.includes(recipe.semanticPattern), `${recipe.id} selects a pattern declared by its template`);
    assert.deepEqual(reviewedRecipes.get(recipe.id), {
      id: recipe.id,
      templateRef: recipe.templateRef,
      semanticPattern: recipe.semanticPattern,
    }, `${recipe.id} chain review exactly matches the owner-approved catalog`);
  }
  const chainsByTemplate = new Map(review.chains.map((chain) => [chain.templateRef, chain]));
  assert.equal(chainsByTemplate.size, 8, "each template has exactly one review chain");
  assert.deepEqual([...chainsByTemplate.keys()].sort(), [...templates.keys()].sort());

  for (const template of templateCatalog.templates) {
    const chain = chainsByTemplate.get(template.id);
    const recipe = [...recipes.values()].find((record) => record.templateRef === template.id);
    assert.ok(recipe, `${template.id} has an exact recipe binding`);
    assert.equal(chain.recipeRef, recipe.id, `${template.id} chain review preserves its catalog recipe`);
    assert.equal(new Set(chain.patternRefs).size, chain.patternRefs.length, `${template.id} has duplicate pattern refs`);
    assert.deepEqual(chain.patternRefs, template.patterns, `${template.id} pattern chain must be copied exactly`);
    assert.ok(chain.patternRefs.length > 0, `${template.id} must keep its registered pattern chain`);
    for (const patternRef of chain.patternRefs) assert.ok(patterns.has(patternRef), `${template.id} has stale pattern ${patternRef}`);
    for (const layoutRef of chain.screenDerivedLayoutRefs) assert.ok(layouts.has(layoutRef), `${template.id} has noncanonical layout ${layoutRef}`);
  }

  const taskSetup = templates.get("media.gui.template.task-setup");
  const importMedia = readYaml(`${experience}/screen-contracts/import-media.yaml`);
  assert.equal(importMedia.templateId, taskSetup.id);
  assert.ok(importMedia.patternIds.includes("media.gui.pattern.upload-and-verification"));
  assert.ok(taskSetup.patterns.includes("media.gui.pattern.upload-and-verification"),
    "the reusable task-setup chain includes the registered upload pattern selected by its exact import-media view");

  const views = [...screenRegistry.screens, ...screenRegistry.laneViews];
  assert.equal(views.length, 47);
  let screenLayoutLinkCount = 0;
  const layoutsByTemplate = new Map();
  for (const view of views) {
    assert.equal(view.contractRefs.length, 1, `${view.id} should have one exact contract`);
    const contract = readYaml(`${experience}/${view.contractRefs[0]}`);
    assert.equal(contract.screenId, view.id);
    assert.equal(Object.hasOwn(contract, "recipeId"), false, `${view.id} must not invent a recipe ID`);
    assert.equal(Object.hasOwn(contract, "recipeRef"), false, `${view.id} must not invent a recipe ref`);
    assert.equal(Object.hasOwn(contract, "recipeBinding"), false, `${view.id} must not infer a recipe binding`);
    assert.ok(templates.has(contract.templateId), `${view.id} template is not canonical`);
    assert.ok(Array.isArray(contract.layoutIds) && contract.layoutIds.length > 0, `${view.id} has no layout binding`);
    for (const layoutId of contract.layoutIds) {
      assert.ok(layouts.has(layoutId), `${view.id} layout is not canonical: ${layoutId}`);
      screenLayoutLinkCount++;
      if (!layoutsByTemplate.has(contract.templateId)) layoutsByTemplate.set(contract.templateId, new Set());
      layoutsByTemplate.get(contract.templateId).add(layoutId);
    }
    for (const patternId of contract.patternIds ?? []) {
      assert.ok(patterns.has(patternId), `${view.id} has stale pattern: ${patternId}`);
    }
  }
  assert.equal(screenLayoutLinkCount, 47);
  assert.deepEqual([...new Set([...layoutsByTemplate.values()].flatMap((refs) => [...refs]))].sort(), [...layouts].sort(),
    "every canonical layout has at least one exact screen-contract binding");
  for (const template of templateCatalog.templates) {
    const observed = [...(layoutsByTemplate.get(template.id) ?? [])].sort();
    assert.deepEqual([...chainsByTemplate.get(template.id).screenDerivedLayoutRefs].sort(), observed,
      `${template.id} review layout list must match exact screen contract bindings`);
  }

  assert.deepEqual(chainsByTemplate.get("media.gui.template.review-and-compare").screenDerivedLayoutRefs.sort(), [
    "media.gui.layout.record-detail", "media.gui.layout.review",
  ], "preserve both source-backed Review-and-Compare layouts");
  assert.deepEqual(chainsByTemplate.get("media.gui.template.lifecycle-confirmation").screenDerivedLayoutRefs, [],
    "do not infer a layout when no screen selects lifecycle-confirmation");
  assert.deepEqual(patternCatalog.patterns.filter((pattern) => !templateCatalog.templates.some((template) => template.patterns.includes(pattern.id))).map((pattern) => pattern.id).sort(), [
    "media.gui.pattern.project-context-header",
  ], "keep the registered-but-unreferenced project-context pattern visible as a residual");
  assert.equal(review.acceptance, "NOT_CLAIMED");
  assert.match(review.admissionResiduals.join(" "), /Shared public-package binding/u);
  assert.match(review.admissionResiduals.join(" "), /All 47 screen-instance admissions/u);
});

test("PDP-2 rejects stale, duplicate, and cross-domain chain references", () => {
  const templateRefs = new Set(["media.gui.template.collection"]);
  const patternRefs = new Set(["media.gui.pattern.project-browser"]);
  const layoutRefs = new Set(["media.gui.layout.collection"]);
  assert.throws(() => assertKnownUniqueRefs(["media.gui.recipe.collection"], templateRefs, "templateRefs"), /stale or cross-domain/u,
    "a recipe ID cannot satisfy a template reference");
  const recipeRefs = new Set();
  assert.throws(() => assertKnownUniqueRefs(["media.gui.template.collection"], recipeRefs, "recipeRefs"), /stale or cross-domain/u,
    "a template ID cannot satisfy a recipe reference");
  assert.throws(() => assertKnownUniqueRefs(["media.gui.pattern.unknown"], patternRefs, "patternRefs"), /stale or cross-domain/u);
  assert.throws(() => assertKnownUniqueRefs(["media.gui.layout.unknown"], layoutRefs, "layoutRefs"), /stale or cross-domain/u);
  assert.throws(() => assertKnownUniqueRefs([
    "media.gui.pattern.project-browser", "media.gui.pattern.project-browser",
  ], patternRefs, "patternRefs"), /duplicate/u);
});
