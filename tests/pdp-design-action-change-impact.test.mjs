import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const file = ".product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml";
const source = parse(readFileSync(resolve(root, file), "utf8"));
const rule = source.changeImpactRule;
const required = [
  "exactCapabilityAndCanonicalOperationIdentitiesAndVersions",
  "affectedActionIdsAndTypedRequestAndResultBranches",
  "authorityRightsConsentAndPolicyGuardsAtTheEffectBoundary",
  "stateTransitionReceiptEventAndUnknownOutcomeSemantics",
  "affectedChannelsViewsAndKeyboardAccessibleControls",
  "recoveryAndIdempotencyConsequencesIncludingRacingOrPartialEffects",
];

test("new capabilities and changed action consequences require exact owner impact bindings", () => {
  assert.equal(rule.id, "media.action.change-impact.v1");
  assert.match(rule.trigger, /new capability is added/u);
  assert.match(rule.trigger, /action consequence, guard, finality, recovery path/u);
  assert.deepEqual(rule.requiredImpactBindings, required);
  assert.match(rule.rule, /do not infer behavior from a capability name, UI label, route, implementation/u);
  assert.match(rule.rule, /exact effect finality and authority scope/u);
  assert.equal(rule.acceptanceEffect, "none");
  assert.deepEqual(source.normativeRuleRecords, [{
    id: "media.p2.rule.action-change-impact.v1",
    ruleRef: `${file}#changeImpactRule`,
    sourceAuthority: `${file}#authority`,
    acceptanceEffect: "none",
  }]);
});

test("impact review fails closed when an effect-changing dimension is omitted", () => {
  const valid = (candidate) => required.every((binding) => candidate.requiredImpactBindings.includes(binding))
    && /do not infer behavior from a capability name/u.test(candidate.rule)
    && /exact effect finality and authority scope/u.test(candidate.rule);
  for (const binding of required) {
    const weakened = structuredClone(rule);
    weakened.requiredImpactBindings = weakened.requiredImpactBindings.filter((entry) => entry !== binding);
    assert.equal(valid(weakened), false, `missing ${binding} must invalidate completeness`);
  }
  const inferredByLabel = structuredClone(rule);
  inferredByLabel.rule = "A matching UI label establishes the action consequence.";
  assert.equal(valid(inferredByLabel), false);
});
