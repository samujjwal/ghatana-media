import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const read = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const gui = ".product-experience/pdp-2-design-interface-system/gui";
const semantic = read(`${gui}/semantic-component-bindings.yaml`);
const contracts = read(".product-experience/pdp-2-design-interface-system/component-contracts.yaml");
const grammar = read(`${gui}/composition-validation-grammar.yaml`);
const componentIds = new Set(contracts.components.map(({ id }) => id));

function semanticBindingErrors(source) {
  const errors = [];
  const generatedIds = new Set();
  for (const [index, binding] of (source.bindings ?? []).entries()) {
    if (!Array.isArray(binding.componentRefs) || binding.componentRefs.length === 0) {
      errors.push(`binding ${index} has no componentRefs`);
      continue;
    }
    for (const ref of binding.componentRefs) {
      if (!componentIds.has(ref)) errors.push(`binding ${index} has unresolved componentRef ${ref}`);
      if (componentIds.has(ref) && binding.semanticRole) {
        const id = `media.language.component-binding.${ref.replaceAll(/[^a-zA-Z0-9]+/gu, ".")}`;
        if (generatedIds.has(id)) errors.push(`binding ${index} duplicates generated component binding id ${id}`);
        generatedIds.add(id);
      }
    }
  }
  return errors;
}

test("every GUI semantic binding resolves component identities and task-flow rules bind to its canonical contract", () => {
  assert.deepEqual(semanticBindingErrors(semantic), []);
  const taskFlowBindings = semantic.bindings.filter((binding) =>
    binding.implementationCandidate === "libs/audio-video-ui/src/components/MediaTaskFlow.tsx");
  assert.equal(taskFlowBindings.length, 1, "one canonical component binding carries task-flow presentation and interaction meaning");
  assert.ok(taskFlowBindings[0].componentRefs.includes("media.component.task-flow"));

  const detailedRules = taskFlowBindings[0];
  assert.ok(detailedRules, "task-flow state and operation rules remain one explicitly bound semantic record");
  assert.equal(detailedRules.implementationExport, "MediaTaskFlow");
  assert.deepEqual(detailedRules.componentRefs, ["media.component.task-flow"]);
  assert.ok(detailedRules.sharedReuseCandidate.components.includes("Badge"));
  assert.equal(detailedRules.sharedReuseCandidate.installedArtifactVerification, "pending");
  assert.ok(["available", "current", "complete", "blocked"].every((state) => state in detailedRules.stateBindings));
  assert.ok(["determinate", "indeterminate", "none", "unknown"].every((operation) => operation in detailedRules.operationBindings));
  assert.match(contracts.components.find(({ id }) => id === detailedRules.componentRefs[0]).semanticRole,
    /workflow-progress-and-operation-observation/u);
});

test("semantic binding source rejects missing or unresolved component identities", () => {
  const missing = structuredClone(semantic);
  delete missing.bindings.find((binding) => binding.stateBindings).componentRefs;
  assert.ok(semanticBindingErrors(missing).some((error) => error.includes("has no componentRefs")));

  const unresolved = structuredClone(semantic);
  unresolved.bindings.find((binding) => binding.stateBindings).componentRefs = ["media.component.not-registered"];
  assert.ok(semanticBindingErrors(unresolved).some((error) => error.includes("unresolved componentRef")));

  const duplicate = structuredClone(semantic);
  duplicate.bindings.push(structuredClone(duplicate.bindings.find((binding) => binding.stateBindings)));
  assert.ok(semanticBindingErrors(duplicate).some((error) => error.includes("duplicates generated component binding id")));
});

function motionRuleErrors(source) {
  const errors = [];
  const rule = source.accessibilityRules?.motion;
  const text = typeof rule === "string" ? rule : "";
  if (!source.sourceRefs?.motion || !source.sourceRefs?.accessibility) errors.push("motion and accessibility source refs are required");
  for (const term of ["motion-bearing", "reduced-motion", "static equivalent", "state", "progress", "focus", "sole indication"]) {
    if (!text.toLowerCase().includes(term.toLowerCase())) errors.push(`motion rule omits ${term}`);
  }
  const records = (source.normativeRuleRecords ?? []).filter(({ id }) => id === "media.gui.composition-rule.accessibility.motion");
  if (records.length !== 1 || records[0]?.sourceRef !== `${gui}/composition-validation-grammar.yaml#/accessibilityRules/motion`) {
    errors.push("motion accessibility rule needs one exact normative source record");
  }
  return errors;
}

test("motion-bearing GUI compositions link reduced-motion source requirements and preserve state, progress, and focus", () => {
  assert.deepEqual(motionRuleErrors(grammar), []);
  const motion = read(".product-experience/pdp-2-design-interface-system/motion.yaml");
  const accessibility = read(".product-experience/pdp-2-design-interface-system/accessibility.yaml");
  assert.ok(motion.rules.some((rule) => /Reduced-motion mode removes nonessential transitions and provides a static equivalent/u.test(rule)));
  assert.ok(accessibility.requirements.some((rule) => /preserving explicit state, progress, and focus indication/u.test(rule)));
});

test("motion source rule rejects missing source links or loss of preserved semantics", () => {
  const missingSource = structuredClone(grammar);
  delete missingSource.sourceRefs.motion;
  assert.ok(motionRuleErrors(missingSource).some((error) => error.includes("source refs are required")));

  const losesFocus = structuredClone(grammar);
  losesFocus.accessibilityRules.motion = losesFocus.accessibilityRules.motion.replace("focus indication", "decoration");
  assert.ok(motionRuleErrors(losesFocus).some((error) => error.includes("omits focus")));

  const losesProgress = structuredClone(grammar);
  losesProgress.accessibilityRules.motion = losesProgress.accessibilityRules.motion.replaceAll("progress", "movement");
  assert.ok(motionRuleErrors(losesProgress).some((error) => error.includes("omits progress")));
});
