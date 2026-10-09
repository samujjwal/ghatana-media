import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const { parse } = createRequire(new URL("../../ghatana-tools/package.json", import.meta.url))("yaml");
const sourcePath = ".product-experience/pdp-2-design-interface-system/accessibility.yaml";
const source = parse(await readFile(sourcePath, "utf8"));
const rule = source.accessibilityRules.find(({ id }) => id === "media.a11y.text-spacing-and-target-size");

function conforms(candidate) {
  const spacing = candidate?.textSpacingOverride;
  const target = candidate?.pointerTargetMinimum;
  const reflow = candidate?.textResizeAndReflow;
  return candidate?.standard === "WCAG 2.2"
    && candidate?.level === "AA"
    && candidate?.sourceRefs?.includes("https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html")
    && candidate?.sourceRefs?.includes("https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html")
    && spacing?.lineHeightMinimum === "1.5em"
    && spacing?.paragraphAfterMinimum === "2em"
    && spacing?.letterSpacingMinimum === "0.12em"
    && spacing?.wordSpacingMinimum === "0.16em"
    && /No content or functionality is clipped/u.test(spacing?.invariant ?? "")
    && target?.width === "24 CSS pixels"
    && target?.height === "24 CSS pixels"
    && ["spacing", "equivalent", "inline", "user-agent"].every((name) => typeof target?.exceptions?.[name] === "string"
      && target.exceptions[name].length > 20)
    && /recorded per target/u.test(target?.invariant ?? "")
    && /200-percent text size/u.test(reflow?.requirement ?? "")
    && /Permit wrapping and container growth/u.test(reflow?.longLocalizedStrings ?? "")
    && /do not change canonical IDs/u.test(reflow?.stableIdentifiers ?? "")
    && candidate?.evidenceBoundary?.status === "DEFINITION_ONLY_NOT_MEASURED"
    && candidate?.evidenceBoundary?.nonClaims?.includes("no-specialist-accessibility-acceptance")
    && Array.isArray(candidate?.rejectionCases)
    && candidate.rejectionCases.length >= 5;
}

test("Media defines exact WCAG 2.2 text-spacing and pointer-target boundaries without claiming conformance", () => {
  assert.ok(rule, "the Media-owned rule is present");
  assert.equal(conforms(rule), true);
  assert.equal(rule.evidenceBoundary.status, "DEFINITION_ONLY_NOT_MEASURED");
  assert.ok(rule.evidenceBoundary.nonClaims.includes("no-rendered-conformance-finding"));
  assert.ok(rule.evidenceBoundary.nonClaims.includes("no-specialist-accessibility-acceptance"));
});

test("material mutations invalidate the complete text-spacing/target-size definition", () => {
  const mutations = [
    (value) => { delete value.textSpacingOverride.lineHeightMinimum; },
    (value) => { delete value.textSpacingOverride.paragraphAfterMinimum; },
    (value) => { delete value.textSpacingOverride.letterSpacingMinimum; },
    (value) => { delete value.textSpacingOverride.wordSpacingMinimum; },
    (value) => { value.pointerTargetMinimum.width = "16 CSS pixels"; },
    (value) => { value.pointerTargetMinimum.exceptions = ["all targets are exempt"]; },
    (value) => { value.textResizeAndReflow.longLocalizedStrings = "truncate on overflow"; },
    (value) => { value.textResizeAndReflow.stableIdentifiers = "IDs may be localized"; },
    (value) => { value.evidenceBoundary.status = "CONFORMANT"; },
  ];
  for (const mutate of mutations) {
    const weakened = structuredClone(rule);
    mutate(weakened);
    assert.equal(conforms(weakened), false, "each weakened criterion fails the source oracle");
  }
});
