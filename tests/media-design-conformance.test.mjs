import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeDesignConformance } from "../scripts/check-media-design-conformance.mjs";

const write = (root, path, content) => {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
};
function fixture({ css = ".sample { color: var(--text); }", extraSource = "", screen = "templateId: media.gui.template.collection\nlayoutIds: [media.gui.layout.standard]\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "media-design-gate-"));
  write(root, ".product-experience/pdp-2-design-interface-system/gui/style-authority.yaml", `scopeStatus: ACCEPTED\nsemanticAuthority: true\nsharedBinding:\n  status: VERIFIED\nconformance:\n  status: VERIFIED\n`);
  write(root, ".product-experience/pdp-2-design-interface-system/media-token-aliases.yaml", `status: accepted\naliases:\n  - id: media.token.content.primary\n    cssVariable: --text\n    sharedTokenRef: "@ghatana/tokens/semantic-roles#semanticColorRoles.light.contentPrimary"\n`);
  write(root, ".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml", `scopeStatus: accepted\ntemplates:\n  - id: media.gui.template.collection\n`);
  write(root, ".product-experience/pdp-2-design-interface-system/gui/layout.yaml", `status: accepted\nlayoutRules:\n  standard: columns\n  layouts:\n    - media.gui.layout.standard\n`);
  write(root, ".product-experience/pdp-2-design-interface-system/component-contracts.yaml", `components:\n  - id: media.component.sample\n`);
  write(root, ".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml", `states:\n  - stateRef: media-job.COMPLETED\n`);
  write(root, ".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml", `patterns:\n  - id: media.gui.pattern.sample\n`);
  write(root, ".product-experience/pdp-3-product-experience/screen-contracts/sample.yaml", screen);
  write(root, "apps/media-experience-explorer/src/styles.css", `:root { --text: var(--text); }\n${css}\n`);
  if (extraSource) write(root, "apps/media-experience-explorer/src/Local.tsx", extraSource);
  return root;
}
const withFixture = (options, fn) => {
  const root = fixture(options);
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

test("accepted, fully bound semantic CSS fixture passes", () => withFixture({ screen: "templateId: media.gui.template.collection\nlayoutIds: [media.gui.layout.standard]\n" }, (root) => {
  const result = analyzeDesignConformance(root);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.summary.unexplained, 0);
}));

test("literal colors are reported and fail closed", () => withFixture({ css: ".sample { color: #123456; background: rgb(1 2 3); }" }, (root) => {
  const result = analyzeDesignConformance(root);
  assert.equal(result.ok, false);
  assert.equal(result.findings.filter((item) => item.kind === "literal-color").length, 2);
  assert.ok(result.blockers.some((item) => item.includes("unexplained")));
}));

test("literal colors in custom properties are reported and remain unexplained without the explicit exception", () => withFixture({ css: ":root { --brand: #123456; }" }, (root) => {
  const result = analyzeDesignConformance(root);
  const finding = result.findings.find((item) => item.kind === "literal-color" && item.detail.includes("custom property --brand"));
  assert.ok(finding, "custom-property color must be source-observable");
  assert.equal(finding.disposition, "unexplained");
  assert.equal(result.ok, false);
}));

test("unknown token provenance fails", () => withFixture({ css: ".sample { color: var(--missing); }" }, (root) => {
  const result = analyzeDesignConformance(root);
  assert.ok(result.findings.some((item) => item.kind === "unknown-token-provenance" && item.detail.includes("--missing")));
  assert.equal(result.ok, false);
}));

test("unregistered local component implementation fails", () => withFixture({ extraSource: "export function LocalCard() { return null; }" }, (root) => {
  const result = analyzeDesignConformance(root);
  assert.ok(result.findings.some((item) => item.kind === "unregistered-local-component" && item.detail.includes("LocalCard")));
}));

test("missing template and layout bindings fail", () => withFixture({ screen: "templateId: null\nlayoutIds: []\n" }, (root) => {
  const result = analyzeDesignConformance(root);
  assert.ok(result.findings.some((item) => item.kind === "missing-template-binding"));
  assert.ok(result.findings.some((item) => item.kind === "missing-layout-binding"));
}));

test("unknown semantic state styling and one-off interaction fail", () => withFixture({ css: ".job.is-mystery { color: var(--text); }\n.orphan:hover { color: var(--text); }" }, (root) => {
  const result = analyzeDesignConformance(root);
  assert.ok(result.findings.some((item) => item.kind === "invalid-semantic-state-styling"));
  assert.ok(result.findings.some((item) => item.kind === "one-off-interaction-behavior"));
}));

test("repository reports observable fixture exceptions but never claims conformance", () => {
  const result = analyzeDesignConformance();
  assert.equal(result.ok, false);
  assert.ok(result.summary.literalColors > 0);
  assert.ok(result.summary.documentedFixtureExceptions > 0);
  assert.ok(result.findings.some((item) => item.kind === "literal-color" && item.detail.includes("custom property --canvas") && item.disposition === "documented-local-fixture-exception-not-product-authority"));
  assert.ok(result.blockers.some((item) => item.includes("Shared package binding is unresolved")));
  assert.ok(result.blockers.some((item) => item.includes("template catalog is proposal")));
  assert.ok(result.findings.some((item) => item.kind === "missing-template-binding"));
});
