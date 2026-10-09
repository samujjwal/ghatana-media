import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const layout = readYaml(".product-experience/pdp-2-design-interface-system/typography-layout.yaml");
const screens = readYaml(".product-experience/pdp-3-product-experience/screen-registry.yaml");
const factsByView = {
  "media.view.review-rights-and-consent": [
    ["affected-source-identity-and-version", "#/anatomy/0"], ["requested-purpose", "#/contextGoalNowNext/context"],
    ["rights-and-consent-scope", "#/anatomy/2"], ["validity-and-revocation", "#/anatomy/3"],
    ["decision-and-safe-next-action", "#/contextGoalNowNext/next"],
  ],
  "media.view.job-status": [
    ["job-and-attempt-identity", "#/anatomy/0"], ["observed-state", "#/anatomy/2"], ["effect-finality", "#/anatomy/5"],
    ["unknown-outcome-warning", "#/anatomy/5"], ["safe-recovery-action", "#/anatomy/6"],
  ],
  "media.view.review-transcript": [
    ["source-version", "#/contextGoalNowNext/context"], ["transcript-version", "#/domainObjectRefs/0"],
    ["source-time-reference", "#/anatomy/3"], ["recognition-uncertainty", "#/contextGoalNowNext/now"],
    ["edit-and-review-actions", "#/contextGoalNowNext/next"],
  ],
  "media.view.work-in-project": [
    ["project-identity-and-version", "#/anatomy/1"], ["source-and-output-identities", "#/anatomy/2"],
    ["pending-work-finality", "#/anatomy/3"], ["primary-safe-action", "#/contextGoalNowNext/next"], ["recovery-path", "#/anatomy/5"],
  ],
};

function resolvePointer(value, pointer) {
  return pointer.replace(/^#\/?/u, "").split("/").filter(Boolean).reduce((node, segment) => {
    const key = segment.replace(/~1/gu, "/").replace(/~0/gu, "~");
    return Array.isArray(node) ? node[Number(key)] : node?.[key];
  }, value);
}

function validatePresentationGrammar(document, registry) {
  const errors = [];
  const widths = document.responsiveCompositionReferences?.widthBands;
  const bandLimits = { narrow: [320, 480], medium: [481, 1279], wide: [1280, 2560] };
  for (const [band, [minimum, maximum]] of Object.entries(bandLimits)) {
    const samples = widths?.[band]?.widthsCssPx;
    if (!Array.isArray(samples) || samples.length < 2 || new Set(samples).size !== samples.length
        || samples.some((value) => !Number.isInteger(value) || value < minimum || value > maximum)) {
      errors.push(`${band} widths must be unique finite CSS pixel values inside ${minimum}..${maximum}`);
    }
  }
  const screenById = new Map([...(registry.screens ?? []), ...(registry.laneViews ?? []), ...(registry.contextualSpecializations ?? [])]
    .map((screen) => [screen.id, screen]));
  for (const reference of document.responsiveCompositionReferences?.representativeViews ?? []) {
    const screen = screenById.get(reference.viewRef);
    if (!screen) errors.push(`unresolved view ${reference.viewRef}`);
    if (!reference.sourceContractRef || !screen?.contractRefs?.includes(reference.sourceContractRef.replace(".product-experience/pdp-3-product-experience/", ""))) {
      errors.push(`view ${reference.viewRef} does not bind its exact screen contract`);
    }
    if (!Array.isArray(reference.requiredVisibleFacts) || reference.requiredVisibleFacts.length < 4) {
      errors.push(`view ${reference.viewRef} lacks required visible facts`);
    }
    const expectedFacts = factsByView[reference.viewRef];
    const bindings = reference.factBindings ?? [];
    if (!expectedFacts || JSON.stringify(reference.requiredVisibleFacts) !== JSON.stringify(expectedFacts.map(([fact]) => fact))
        || JSON.stringify(bindings.map(({ fact, sourcePointer }) => [fact, sourcePointer])) !== JSON.stringify(expectedFacts)) {
      errors.push(`view ${reference.viewRef} critical facts do not match their exact source-contract bindings`);
    }
    const contractPath = reference.sourceContractRef?.replace(".product-experience/pdp-3-product-experience/", ".product-experience/pdp-3-product-experience/");
    let contract;
    try { contract = readYaml(contractPath); } catch { errors.push(`view ${reference.viewRef} source contract cannot be read`); }
    for (const binding of bindings) {
      const sourceValue = contract && resolvePointer(contract, binding.sourcePointer);
      if (sourceValue === undefined || sourceValue === null || sourceValue === "") errors.push(`view ${reference.viewRef} source field ${binding.sourcePointer} does not resolve`);
    }
  }
  const invariants = document.responsiveCompositionReferences?.invariants ?? [];
  if (invariants.length < 3 || !invariants.some((rule) => /same source identities, domain state, permissions, actions, and finality/u.test(rule))) {
    errors.push("responsive layout must preserve source, state, permissions, actions, and finality");
  }
  if (!invariants.some((rule) => /horizontal scrolling, pointer hover, or color interpretation/u.test(rule))) {
    errors.push("responsive keyboard/accessibility exclusions are incomplete");
  }
  const rubric = document.comprehensionRubric;
  if (!rubric || rubric.status !== "REVIEW_PROTOCOL_DEFINED; participant study NOT_RUN") errors.push("comprehension status must remain unrun");
  if ((rubric?.taskPrompts ?? []).length !== 5 || (rubric?.evidenceRecordFields ?? []).length < 10) errors.push("comprehension tasks or evidence fields are incomplete");
  if (!/Every safety-critical fact is identified accurately without facilitator prompting/u.test(rubric?.passRule ?? "")) errors.push("comprehension pass rule is missing");
  if (!rubric?.nonClaims?.includes("no measured usability or comprehension acceptance")) errors.push("rubric must not claim measured acceptance");
  const density = document.density ?? {};
  if (!/same state and actions/u.test(density.simple ?? "")) errors.push("simple density changes the underlying state/action set");
  for (const field of ["quality", "style", "duration", "reference", "output", "privacy", "timing", "rights status", "decision inputs", "review evidence"]) {
    if (!new RegExp(field, "iu").test(density.guided ?? "")) errors.push(`guided density drops ${field}`);
  }
  for (const field of ["typed graph", "curves", "solver limits", "generation", "color", "audio", "encoding controls", "measurements", "provenance"]) {
    if (!new RegExp(field, "iu").test(density.expert ?? "")) errors.push(`expert density drops ${field}`);
  }
  if (!/no hidden change to action meaning or authority/u.test(density.expert ?? "")) errors.push("expert density may alter action meaning or authority");
  return errors;
}

test("responsive references bind real representative views and preserve one semantic experience across widths", () => {
  assert.deepEqual(validatePresentationGrammar(layout, screens), []);
  const refs = layout.responsiveCompositionReferences.representativeViews;
  assert.equal(new Set(refs.map(({ viewRef }) => viewRef)).size, 4);
  assert.deepEqual(layout.responsiveCompositionReferences.widthBands.narrow.widthsCssPx, [320, 390]);
  assert.deepEqual(layout.responsiveCompositionReferences.widthBands.medium.widthsCssPx, [768, 1024]);
  assert.deepEqual(layout.responsiveCompositionReferences.widthBands.wide.widthsCssPx, [1280, 1536]);
});

test("responsive and comprehension grammar rejects missing safety facts, false view bindings, and acceptance claims", () => {
  const missingUnknownFinality = structuredClone(layout);
  missingUnknownFinality.responsiveCompositionReferences.representativeViews
    .find(({ viewRef }) => viewRef === "media.view.job-status").requiredVisibleFacts = ["job-and-attempt-identity", "observed-state"];
  assert.match(validatePresentationGrammar(missingUnknownFinality, screens).join("\n"), /lacks required visible facts/u);

  const inventedView = structuredClone(layout);
  inventedView.responsiveCompositionReferences.representativeViews[0].viewRef = "media.view.synthetic";
  assert.match(validatePresentationGrammar(inventedView, screens).join("\n"), /unresolved view/u);

  const hiddenMeaning = structuredClone(layout);
  hiddenMeaning.responsiveCompositionReferences.invariants[0] = "Narrow layout may remove permission and finality to save space.";
  assert.match(validatePresentationGrammar(hiddenMeaning, screens).join("\n"), /must preserve source, state, permissions/u);

  const falseAcceptance = structuredClone(layout);
  falseAcceptance.comprehensionRubric.status = "REVIEWED_AND_ACCEPTED";
  assert.match(validatePresentationGrammar(falseAcceptance, screens).join("\n"), /status must remain unrun/u);

  const substitutedRecovery = structuredClone(layout);
  const job = substitutedRecovery.responsiveCompositionReferences.representativeViews.find(({ viewRef }) => viewRef === "media.view.job-status");
  job.requiredVisibleFacts[3] = "source-version-when-applicable";
  job.factBindings[3].fact = "source-version-when-applicable";
  assert.match(validatePresentationGrammar(substitutedRecovery, screens).join("\n"), /exact source-contract bindings/u);

  const invalidWidth = structuredClone(layout);
  invalidWidth.responsiveCompositionReferences.widthBands.narrow.widthsCssPx = [320, "wide"];
  assert.match(validatePresentationGrammar(invalidWidth, screens).join("\n"), /unique finite CSS pixel values/u);
});

test("density profiles preserve the same behavior while stating the task-specific detail at each level", () => {
  const { density, densityProfiles, disclosureInvariants } = layout;
  assert.match(density.simple, /same state and actions/u);
  assert.match(density.guided, /privacy choices/u);
  assert.match(density.expert, /typed graph, curves, solver limits, generation, color, audio, and encoding controls/u);
  assert.equal(densityProfiles.length, 3);
  assert.ok(disclosureInvariants.some((rule) => /Density affects presentation only/u.test(rule)));

  const weakened = { ...layout, density: { ...density, guided: density.guided.replace("privacy choices plus ", "") } };
  assert.match(validatePresentationGrammar(weakened, screens).join("\n"), /guided density drops privacy/u);
});
