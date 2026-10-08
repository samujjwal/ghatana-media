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
  write(root, ".product-experience/pdp-2-design-interface-system/gui/style-authority.yaml", `scopeStatus: ACCEPTED\nauthority: .product-experience/pdp-2-design-interface-system/media-token-aliases.yaml\ncurrentProjection:\n  semanticAuthority: .product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml\nsharedBinding:\n  status: VERIFIED\nconformance:\n  status: VERIFIED\nexplorerFixtureSource: apps/media-experience-explorer/src/styles.css\nexplorerFixtureSemanticAuthority: false\nexceptionPolicy: >-\n  Raw values in the Explorer fixture stylesheet remain Explorer-owned and carry no Media product meaning.\n`);
  write(root, ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml", "status: VERIFIED\n");
  write(root, ".product-experience/pdp-2-design-interface-system/media-token-aliases.yaml", `status: accepted\naliases:\n  - id: media.token.content.primary\n    cssVariable: --text\n    sharedTokenRef: "@ghatana/tokens/semantic-roles#semanticColorRoles.light.contentPrimary"\n`);
  write(root, ".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml", `scopeStatus: accepted\ntemplates:\n  - id: media.gui.template.collection\n`);
  write(root, ".product-experience/pdp-2-design-interface-system/gui/layout.yaml", `status: accepted\nlayoutRules:\n  standard: columns\n  layouts:\n    - media.gui.layout.standard\n`);
  write(root, ".product-experience/pdp-2-design-interface-system/component-contracts.yaml", `components:\n  - id: media.component.sample\n`);
  write(root, ".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml", `states:\n  - stateRef: media-job.COMPLETED\n`);
  write(root, ".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml", `patterns:\n  - id: media.gui.pattern.sample\n`);
  write(root, ".product-experience/pdp-3-product-experience/screen-contracts/sample.yaml", screen);
  write(root, "libs/audio-video-ui/src/styles.css", `:root { --text: var(--text); }\n${css}\n`);
  write(root, "apps/media-experience-explorer/src/styles.css", ".fixture { color: #123456; }\n");
  if (extraSource) write(root, "libs/audio-video-ui/src/Local.tsx", extraSource);
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
  assert.equal(result.findings.filter((item) => item.kind === "literal-color" && item.disposition === "unexplained").length, 2);
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

test("Explorer CSS remains visible as fixture-only and does not become product authority", () => withFixture({}, (root) => {
  const result = analyzeDesignConformance(root);
  assert.equal(result.summary.productLiteralColors, 0);
  assert.equal(result.summary.unexplained, 0);
  assert.ok(result.summary.explorerFixtureObservations > 0);
  assert.ok(result.findings.some((item) => item.path === "apps/media-experience-explorer/src/styles.css"
    && item.kind === "literal-color"
    && item.disposition === "explorer-chrome-or-fixture-only-not-product-authority"));
}));

test("repository keeps owner-gated blockers separate from source findings", () => {
  const result = analyzeDesignConformance();
  assert.equal(result.ok, false);
  assert.equal(result.summary.unexplained, 0);
  assert.ok(result.summary.explorerFixtureObservations > 0);
  assert.ok(result.blockers.some((item) => item.includes("Shared package binding is unresolved")));
  assert.ok(result.blockers.some((item) => item.includes("Shared component bindings are unresolved")));
  assert.ok(result.blockers.some((item) => item.includes("template catalog is proposal")));
});

test("style authority must reference actual canonical Media alias and component sources", () => withFixture({}, (root) => {
  write(root, ".product-experience/pdp-2-design-interface-system/gui/style-authority.yaml",
    "scopeStatus: ACCEPTED\nauthority: wrong.yaml\ncurrentProjection:\n  semanticAuthority: wrong-bindings.yaml\nsharedBinding:\n  status: VERIFIED\nconformance:\n  status: VERIFIED\n");
  const result = analyzeDesignConformance(root);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((item) => item.includes("canonical Media aliases and component")));
}));

test("nested conformance status cannot impersonate verified Shared binding", () => withFixture({}, (root) => {
  write(root, ".product-experience/pdp-2-design-interface-system/gui/style-authority.yaml",
    "scopeStatus: ACCEPTED\nauthority: .product-experience/pdp-2-design-interface-system/media-token-aliases.yaml\ncurrentProjection:\n  semanticAuthority: .product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml\nsharedBinding:\n  status: PENDING\nconformance:\n  status: VERIFIED\n");
  const result = analyzeDesignConformance(root);
  assert.ok(result.blockers.some((item) => item.includes("Shared package binding is unresolved")));
}));

test("component binding registry status must independently resolve", () => withFixture({}, (root) => {
  write(root, ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml",
    "status: semantic-intent-recorded; shared-consumer-binding-unverified; owner-review-pending\n");
  const result = analyzeDesignConformance(root);
  assert.ok(result.blockers.some((item) => item.includes("Shared component bindings are unresolved")));
}));

test("Shared success cannot impersonate independent PDP-2 review", () => withFixture({}, (root) => {
  write(root, ".product-experience/pdp-2-design-interface-system/gui/style-authority.yaml",
    "scopeStatus: ACCEPTED\nauthority: .product-experience/pdp-2-design-interface-system/media-token-aliases.yaml\ncurrentProjection:\n  semanticAuthority: .product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml\nsharedBinding:\n  status: VERIFIED\nconformance:\n  status: NOT_RUN\n");
  const result = analyzeDesignConformance(root);
  assert.ok(result.blockers.some((item) => item.includes("conformance review is not verified")));
}));
