import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateMediaDefaultNavigationRule } from "../scripts/lib/media-navigation-contract-validation.mjs";

const path = ".product-experience/pdp-3-product-experience/navigation-contracts.yaml";
const source = await readFile(path, "utf8");
const rule = {
  id: "media.navigation.default-global-and-utility-placement.v1",
  scope: "default-product-navigation-placement",
  primaryNavigation: ["media.navigation.destination.home", "media.navigation.destination.projects", "media.navigation.destination.assets", "media.navigation.destination.activity"],
  utilityNavigation: ["media.navigation.utility.settings", "media.navigation.utility.account", "media.navigation.utility.help"],
  guardrailIds: ["media.navigation.guard.authorization-before-protected-load", "media.navigation.guard.no-provider-global-destination", "media.navigation.guard.navigation-does-not-dispatch", "media.navigation.guard.identity-and-workspace-are-separate"],
  negativeCases: ["provider", "utility", "access", "dispatch"],
  status: "MEDIA_OWNER_DEFINITION_ONLY; independent-PDP3-review-open; runtime-NOT_ADMITTED",
};
const informationArchitecture = { normativeRuleRecords: [rule] };

test("Media default global and utility destinations are exact and distinct", () => {
  assert.ok(source.includes(`id: ${rule.id}`));
  for (const destination of [...rule.primaryNavigation, ...rule.utilityNavigation]) assert.ok(source.includes(`- ${destination}`));
  assert.equal(validateMediaDefaultNavigationRule(informationArchitecture), true);
  assert.deepEqual(rule.primaryNavigation, [
    "media.navigation.destination.home", "media.navigation.destination.projects",
    "media.navigation.destination.assets", "media.navigation.destination.activity",
  ]);
  assert.deepEqual(rule.utilityNavigation, [
    "media.navigation.utility.settings", "media.navigation.utility.account", "media.navigation.utility.help",
  ]);
});

test("provider exposure, utility misclassification, and authorization bypass are rejected", () => {
  const cases = [
    { ...rule, primaryNavigation: [...rule.primaryNavigation, "media.navigation.destination.providers"] },
    { ...rule, utilityNavigation: rule.utilityNavigation.filter((item) => item !== "media.navigation.utility.settings") },
    { ...rule, guardrailIds: rule.guardrailIds.filter((item) => item !== "media.navigation.guard.authorization-before-protected-load") },
  ];
  for (const candidate of cases) {
    assert.throws(() => validateMediaDefaultNavigationRule({ normativeRuleRecords: [candidate] }));
  }
});
