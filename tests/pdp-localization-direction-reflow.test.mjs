import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const file = ".product-experience/pdp-2-design-interface-system/localization-content.yaml";
const source = parse(readFileSync(resolve(root, file), "utf8"));
const rule = source.ownerDefinedLocalizationRules.find(({ id }) => id === "media.localization.direction-and-reflow.v1");
const norm = source.normativeRuleRecords.find(({ id }) => id === "media.p2.rule.localization-direction-and-reflow.v1");

function resolveRef(ref) {
  const [path, pointer] = ref.split("#");
  let value = path ? parse(readFileSync(resolve(root, path), "utf8")) : source;
  for (const raw of (pointer ?? "").split("/").filter(Boolean)) {
    const token = raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
    const match = token.match(/^@id=(.+)$/u);
    value = match ? value.find?.((row) => row?.id === match[1]) : value?.[token];
  }
  return value;
}

function complete(candidate) {
  const text = candidate?.rule ?? "";
  return candidate?.id === "media.localization.direction-and-reflow.v1"
    && candidate.sourceRefs?.includes(".product-experience/pdp-2-design-interface-system/typography-layout.yaml#responsiveCompositionReferences")
    && candidate.sourceRefs?.includes(".product-experience/pdp-2-design-interface-system/accessibility.yaml#/accessibilityRules/@id=media.a11y.readability-reflow")
    && ["selected locale's explicit direction metadata", "ltr", "rtl", "canonical Media identifiers", "field names", "reason codes", "version refs", "time values", "200%", "320 CSS-pixel reference", "horizontal scrolling", "runtime locale support"].every((fact) => text.includes(fact))
    && candidate.invariants?.includes("canonical-identifiers-are-bidi-isolated")
    && candidate.invariants?.includes("320-css-pixel-reflow-preserves-controls-and-actions")
    && candidate.negativeCases?.includes("rtl-direction-inferred-from-script")
    && candidate.negativeCases?.includes("canonical-id-reordered-by-bidirectional-copy")
    && candidate.negativeCases?.includes("200-percent-text-resize-hides-required-fact")
    && candidate.negativeCases?.includes("unsupported-locale-marked-runtime-supported")
    && candidate.scopeStatus?.includes("browser, assistive-technology, native-language, and runtime locale acceptance remain separate")
    && norm?.acceptanceEffect === "none"
    && resolveRef(norm.ruleRef)?.id === rule.id
    && resolveRef(".product-experience/pdp-2-design-interface-system/typography-layout.yaml#responsiveCompositionReferences")?.widthBands?.narrow?.widthsCssPx?.includes(320)
    && resolveRef(".product-experience/pdp-2-design-interface-system/accessibility.yaml#/accessibilityRules/@id=media.a11y.readability-reflow")?.requirement?.includes("reflow and long localization");
}

test("Media localization direction and reflow bind explicit RTL, canonical IDs, and responsive accessibility requirements", () => {
  assert.ok(rule);
  assert.ok(norm);
  assert.equal(complete(rule), true);
  for (const mutate of [
    (x) => { x.rule = x.rule.replace("`rtl`", ""); },
    (x) => { x.rule = x.rule.replace("canonical Media identifiers", "translated labels"); },
    (x) => { x.rule = x.rule.replace("200%", "100%"); },
    (x) => { x.rule = x.rule.replace("320 CSS-pixel reference", "wide reference"); },
    (x) => { x.negativeCases = x.negativeCases.filter((item) => item !== "canonical-id-reordered-by-bidirectional-copy"); },
    (x) => { x.scopeStatus = "runtime locale support and accessibility accepted"; },
  ]) {
    const candidate = structuredClone(rule);
    mutate(candidate);
    assert.equal(complete(candidate), false, "missing or weakened locale/reflow predicates must fail");
  }
});
