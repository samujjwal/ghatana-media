import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { loadCompositionCatalogs, validateCatalogRelations } from "../scripts/lib/pdp-design-composition-validator.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const gui = ".product-experience/pdp-2-design-interface-system/gui";
const catalogs = loadCompositionCatalogs(root);

test("PDP-2 reusable composition catalogs preserve the exact template/layout/recipe/pattern populations", () => {
  assert.equal(catalogs.templates.length, 13);
  assert.equal(catalogs.layouts.length, 11);
  assert.equal(catalogs.recipes.length, 13);
  assert.equal(catalogs.patterns.length, 19);
  assert.deepEqual(validateCatalogRelations(catalogs), []);

  const review = readYaml(`${gui}/recipe-chain-review.yaml`);
  const chains = new Map(review.chains.map((chain) => [chain.templateRef, chain]));
  assert.equal(chains.size, 13);
  for (const template of catalogs.templates) {
    const recipe = catalogs.recipes.find(({ id }) => template.recipeRefs.includes(id));
    const chain = chains.get(template.id);
    assert.ok(recipe, `${template.id} has an exact recipe link`);
    assert.equal(recipe.templateRef, template.id);
    assert.ok(template.patterns.includes(recipe.semanticPattern), `${recipe.id} chooses a primary pattern of its template`);
    assert.deepEqual(chain.patternRefs, template.patterns, `${template.id} preserves its exact ordered pattern chain`);
    for (const layoutId of chain.screenDerivedLayoutRefs) {
      assert.ok(template.compatibleLayoutRefs.includes(layoutId), `${template.id} chain layout ${layoutId} is compatible`);
    }
  }
});

test("PDP-2 reusable composition validator rejects broken reciprocal and semantic chains", () => {
  const missingRecipe = structuredClone(catalogs);
  missingRecipe.templates[0].recipeRefs = [];
  assert.ok(validateCatalogRelations(missingRecipe).some((error) => error.includes("recipeRefs must be nonempty")));

  const brokenLayoutBacklink = structuredClone(catalogs);
  const template = brokenLayoutBacklink.templates.find(({ compatibleLayoutRefs }) => compatibleLayoutRefs.length > 0);
  const layout = brokenLayoutBacklink.layouts.find(({ id }) => id === template.compatibleLayoutRefs[0]);
  layout.compatibleTemplateRefs = layout.compatibleTemplateRefs.filter((id) => id !== template.id);
  assert.ok(validateCatalogRelations(brokenLayoutBacklink).some((error) => error.includes("does not reciprocally list the template")));

  const wrongRecipeTemplate = structuredClone(catalogs);
  wrongRecipeTemplate.recipes[0].templateRef = "media.gui.template.not-registered";
  assert.ok(validateCatalogRelations(wrongRecipeTemplate).some((error) => error.includes("unknown template")));

  const wrongRecipePattern = structuredClone(catalogs);
  wrongRecipePattern.recipes[0].semanticPattern = "media.gui.pattern.not-registered";
  assert.ok(validateCatalogRelations(wrongRecipePattern).some((error) => error.includes("unknown semantic pattern")));

  const missingRequiredRegion = structuredClone(catalogs);
  missingRequiredRegion.templates[0].regions.pop();
  assert.ok(validateCatalogRelations(missingRequiredRegion).some((error) => error.includes("required-region sequence differs from central composition grammar")));
});
