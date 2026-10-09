import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(require("node:fs").readFileSync(resolve(root, path), "utf8"));

const typographyPath = ".product-experience/pdp-2-design-interface-system/typography-layout.yaml";
const responsivePath = ".product-experience/pdp-2-design-interface-system/responsive-adaptive.yaml";
const accessibilityPath = ".product-experience/pdp-2-design-interface-system/accessibility.yaml";
const stylePath = ".product-experience/pdp-2-design-interface-system/gui/style-authority.yaml";

function presentationDefinitionIsComplete(typography, responsive, accessibility, style) {
  const density = Object.fromEntries((typography.densityProfiles ?? []).map((entry) => [entry.sourceMode, entry]));
  const layout = (typography.layoutRules ?? []).join(" ");
  const responsiveRules = (responsive.invariants ?? []).join(" ");
  const requirements = (accessibility.requirements ?? []).join(" ");
  const a11y = new Map((accessibility.accessibilityRules ?? []).map((entry) => [entry.id, entry.requirement]));
  return Boolean(
    density.simple?.description?.includes("next safe action") &&
    density.guided?.description?.includes("rights") &&
    density.guided?.description?.includes("review evidence") &&
    density.expert?.description?.includes("provenance") &&
    density.expert?.description?.includes("without changing domain meaning") &&
    (typography.disclosureInvariants ?? []).some((rule) => rule.includes("Density affects presentation only")) &&
    (typography.disclosureInvariants ?? []).some((rule) => rule.includes("Keyboard and screen-reader equivalents")) &&
    layout.includes("Transcript text and its source-time reference stay adjacent") &&
    layout.includes("Long localized labels wrap; they do not clip") &&
    responsive.variants?.mobile?.workMode?.includes("supported-edit-actions-remain-operable") &&
    responsiveRules.includes("do not hide recovery actions") &&
    responsiveRules.includes("non-drag alternatives") &&
    responsiveRules.includes("200-percent text") &&
    requirements.includes("Reduced-motion preferences remove decorative movement") &&
    requirements.includes("Forced-colors mode preserves") &&
    a11y.get("media.a11y.keyboard-equivalence")?.includes("visible focus") &&
    a11y.get("media.a11y.movement-and-status")?.includes("focus restoration") &&
    style.semanticRule?.includes("Media owns semantic names and composition") &&
    style.semanticRule?.includes("Shared owns primitive values, tokens, themes") &&
    style.sharedBinding?.status === "EXTERNAL_PACKAGE_AND_OWNER_REVIEW_PENDING" &&
    style.conformance?.status === "NOT_RUN"
  );
}

test("PDP-2 visual source keeps density, responsive safety, and accessibility meaning aligned", () => {
  const typography = readYaml(typographyPath);
  const responsive = readYaml(responsivePath);
  const accessibility = readYaml(accessibilityPath);
  const style = readYaml(stylePath);
  assert.equal(presentationDefinitionIsComplete(typography, responsive, accessibility, style), true);
  assert.equal(typography.proposedResponsiveViewports.status, "proposed-fixtures-not-browser-acceptance");
  assert.equal(responsive.statusNote, "viewport values are proposed verification fixtures, not supported-device claims.");
  assert.equal(accessibility.acceptance, "review-required; no conformance result is asserted");
});

test("presentation checks reject loss of guided choices, recovery visibility, or Shared authority boundaries", () => {
  const base = {
    typography: readYaml(typographyPath),
    responsive: readYaml(responsivePath),
    accessibility: readYaml(accessibilityPath),
    style: readYaml(stylePath),
  };
  const mutations = [
    (copy) => { copy.typography.densityProfiles.find(({ sourceMode }) => sourceMode === "guided").description = "Adds style choices"; },
    (copy) => { copy.responsive.invariants[1] = "Narrow layouts may hide recovery actions"; },
    (copy) => { copy.accessibility.requirements = copy.accessibility.requirements.filter((rule) => !rule.startsWith("Reduced-motion preferences")); },
    (copy) => { copy.style.semanticRule = "Shared owns all Media semantic names and composition"; },
    (copy) => { copy.style.sharedBinding.status = "ACCEPTED"; },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(base);
    mutate(copy);
    assert.equal(presentationDefinitionIsComplete(copy.typography, copy.responsive, copy.accessibility, copy.style), false);
  }
});
