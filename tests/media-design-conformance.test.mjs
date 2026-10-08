import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  write(root, ".product-experience/pdp-2-design-interface-system/gui/style-authority.yaml", `scopeStatus: MEDIA_OWNER_ACCEPTED\nauthority: .product-experience/pdp-2-design-interface-system/media-token-aliases.yaml\ncurrentProjection:\n  semanticAuthority: .product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml\nsharedBinding:\n  status: EXTERNAL_PACKAGE_AND_OWNER_REVIEW_PENDING\nconformance:\n  status: NOT_RUN\nexplorerFixtureSource: apps/media-experience-explorer/src/styles.css\nexplorerFixtureSemanticAuthority: false\nexceptionPolicy: >-\n  Raw values in the Explorer fixture stylesheet remain Explorer-owned and carry no Media product meaning.\n`);
  write(root, ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml", "status: SOURCE_INCOMPLETE\n");
  write(root, ".product-experience/pdp-2-design-interface-system/media-token-aliases.yaml", `status: MEDIA_OWNER_ACCEPTED_INTENT_ONLY\naliases:\n  - id: media.token.content.primary\n    cssVariable: --text\n    sharedTokenRef: "@ghatana/tokens/semantic-roles#semanticColorRoles.light.contentPrimary"\n`);
  write(root, ".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml", `scopeStatus: MEDIA_OWNER_ACCEPTED\ntemplates:\n  - id: media.gui.template.collection\n`);
  write(root, ".product-experience/pdp-2-design-interface-system/gui/layout.yaml", `scopeStatus: MEDIA_OWNER_ACCEPTED\nlayoutRules:\n  standard: columns\n  layouts:\n    - media.gui.layout.standard\n`);
  write(root, ".product-experience/pdp-2-design-interface-system/component-contracts.yaml", `components:\n  - id: media.component.sample\n`);
  write(root, ".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml", `states:\n  - stateRef: media-job.COMPLETED\n`);
  const evidence = (id, source, sourceField, sourceStatus, disposition, resolved = false) => ({
    id, source, sourceField, sourceStatus, disposition,
    ...(resolved ? { decision: { authority: "User-delegated Media owner decision", rationale: "Fixture decision includes an explicit source-grounded owner rationale that is long enough to validate." }, evidenceRefs: [`${source}#fixture`] } : { evidenceRefs: [`${source}#fixture`] }),
  });
  write(root, ".product-experience/pdp-2-design-interface-system/design-governance.json", JSON.stringify({
    schemaVersion: "media.pdp-2.design-governance.v1",
    authority: "Media-owned design decisions only; Shared package, conformance, specialist visualization, and accessibility acceptance remain separately gated",
    gateDenominator: 7,
    gates: [
      evidence("style-semantics-source", ".product-experience/pdp-2-design-interface-system/gui/style-authority.yaml", "scopeStatus", "MEDIA_OWNER_ACCEPTED", "RESOLVED_OWNER", true),
      evidence("shared-artifact-binding", ".product-experience/pdp-2-design-interface-system/gui/style-authority.yaml", "sharedBinding.status", "EXTERNAL_PACKAGE_AND_OWNER_REVIEW_PENDING", "EXTERNAL_PENDING"),
      evidence("conformance-and-specialist-review", ".product-experience/pdp-2-design-interface-system/gui/style-authority.yaml", "conformance.status", "NOT_RUN", "INDEPENDENT_PENDING"),
      evidence("semantic-token-aliases", ".product-experience/pdp-2-design-interface-system/media-token-aliases.yaml", "status", "MEDIA_OWNER_ACCEPTED_INTENT_ONLY", "RESOLVED_OWNER", true),
      evidence("concrete-component-bindings", ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml", "status", "SOURCE_INCOMPLETE", "SOURCE_INCOMPLETE"),
      evidence("template-catalog-admission", ".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml", "scopeStatus", "MEDIA_OWNER_ACCEPTED", "RESOLVED_OWNER", true),
      evidence("layout-admission", ".product-experience/pdp-2-design-interface-system/gui/layout.yaml", "scopeStatus", "MEDIA_OWNER_ACCEPTED", "RESOLVED_OWNER", true),
    ],
  }));
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

test("clean semantic CSS does not close external, independent, or incomplete source gates", () => withFixture({ screen: "templateId: media.gui.template.collection\nlayoutIds: [media.gui.layout.standard]\n" }, (root) => {
  const result = analyzeDesignConformance(root);
  assert.equal(result.ok, false);
  assert.equal(result.summary.unexplained, 0);
  assert.ok(result.blockers.some((item) => item.includes("shared-artifact-binding remains EXTERNAL_PENDING")));
  assert.ok(result.blockers.some((item) => item.includes("conformance-and-specialist-review remains INDEPENDENT_PENDING")));
  assert.ok(result.blockers.some((item) => item.includes("concrete-component-bindings remains SOURCE_INCOMPLETE")));
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
  assert.equal(result.summary.governanceGateCount, 7);
  assert.equal(result.summary.resolvedOwnerGates, 4);
  assert.deepEqual(result.summary.openGovernanceGates, [
    { id: "shared-artifact-binding", disposition: "EXTERNAL_PENDING" },
    { id: "conformance-and-specialist-review", disposition: "INDEPENDENT_PENDING" },
    { id: "concrete-component-bindings", disposition: "SOURCE_INCOMPLETE" },
  ]);
  assert.ok(result.findings.some((item) => item.path === "apps/media-experience-explorer/src/styles.css"
    && item.kind === "literal-color"
    && item.disposition === "explorer-chrome-or-fixture-only-not-product-authority"));
}));

test("repository keeps owner-gated blockers separate from source findings", () => {
  const result = analyzeDesignConformance();
  assert.equal(result.ok, false);
  assert.equal(result.summary.unexplained, 0);
  assert.ok(result.summary.explorerFixtureObservations > 0);
  assert.ok(result.blockers.some((item) => item.includes("shared-artifact-binding remains EXTERNAL_PENDING")));
  assert.ok(result.blockers.some((item) => item.includes("conformance-and-specialist-review remains INDEPENDENT_PENDING")));
  assert.equal(result.summary.resolvedOwnerGates, 5);
  assert.equal(result.summary.openGovernanceGates.length, 2);
  assert.ok(!result.blockers.some((item) => item.includes("concrete-component-bindings")), result.blockers.join("\n"));
});

test("style authority must reference actual canonical Media alias and component sources", () => withFixture({}, (root) => {
  write(root, ".product-experience/pdp-2-design-interface-system/gui/style-authority.yaml",
    "scopeStatus: ACCEPTED\nauthority: wrong.yaml\ncurrentProjection:\n  semanticAuthority: wrong-bindings.yaml\nsharedBinding:\n  status: VERIFIED\nconformance:\n  status: VERIFIED\n");
  const result = analyzeDesignConformance(root);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((item) => item.includes("canonical Media aliases and component")));
}));

test("a stale Shared package approval status fails against the canonical gate record", () => withFixture({}, (root) => {
  write(root, ".product-experience/pdp-2-design-interface-system/gui/style-authority.yaml",
    "scopeStatus: ACCEPTED\nauthority: .product-experience/pdp-2-design-interface-system/media-token-aliases.yaml\ncurrentProjection:\n  semanticAuthority: .product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml\nsharedBinding:\n  status: PENDING\nconformance:\n  status: VERIFIED\n");
  const result = analyzeDesignConformance(root);
  assert.ok(result.blockers.some((item) => item.includes("shared-artifact-binding: stale source approval status")));
}));

test("component binding source status must match its canonical source-incomplete gate", () => withFixture({}, (root) => {
  write(root, ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml",
    "status: semantic-intent-recorded; shared-consumer-binding-unverified; owner-review-pending\n");
  const result = analyzeDesignConformance(root);
  assert.ok(result.blockers.some((item) => item.includes("concrete-component-bindings: stale source approval status")));
}));

test("Shared success cannot impersonate independent PDP-2 review", () => withFixture({}, (root) => {
  write(root, ".product-experience/pdp-2-design-interface-system/gui/style-authority.yaml",
    "scopeStatus: MEDIA_OWNER_ACCEPTED\nauthority: .product-experience/pdp-2-design-interface-system/media-token-aliases.yaml\ncurrentProjection:\n  semanticAuthority: .product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml\nsharedBinding:\n  status: EXTERNAL_PACKAGE_AND_OWNER_REVIEW_PENDING\nconformance:\n  status: NOT_RUN\n");
  const result = analyzeDesignConformance(root);
  assert.ok(result.blockers.some((item) => item.includes("conformance-and-specialist-review remains INDEPENDENT_PENDING")));
}));

test("canonical governance rejects duplicate gate approvals and stale or unknown approval states", () => withFixture({}, (root) => {
  const path = ".product-experience/pdp-2-design-interface-system/design-governance.json";
  const registry = JSON.parse(readFileSync(join(root, path), "utf8"));
  registry.gates.push({ ...registry.gates[0] });
  write(root, path, JSON.stringify(registry));
  let result = analyzeDesignConformance(root);
  assert.ok(result.blockers.some((item) => item.includes("duplicate design-governance gate record: style-semantics-source")));

  registry.gates.pop();
  registry.gates[0].disposition = "ACCEPTED";
  write(root, path, JSON.stringify(registry));
  result = analyzeDesignConformance(root);
  assert.ok(result.blockers.some((item) => item.includes("style-semantics-source: invalid or stale governance disposition")));
}));

test("a source and registry cannot jointly promote the external Shared gate to local VERIFIED", () => withFixture({}, (root) => {
  const governancePath = ".product-experience/pdp-2-design-interface-system/design-governance.json";
  const registry = JSON.parse(readFileSync(join(root, governancePath), "utf8"));
  const sharedGate = registry.gates.find((gate) => gate.id === "shared-artifact-binding");
  sharedGate.sourceStatus = "VERIFIED";
  write(root, governancePath, JSON.stringify(registry));
  write(root, ".product-experience/pdp-2-design-interface-system/gui/style-authority.yaml",
    "scopeStatus: MEDIA_OWNER_ACCEPTED\nauthority: .product-experience/pdp-2-design-interface-system/media-token-aliases.yaml\ncurrentProjection:\n  semanticAuthority: .product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml\nsharedBinding:\n  status: VERIFIED\nconformance:\n  status: NOT_RUN\n");
  const result = analyzeDesignConformance(root);
  assert.ok(result.blockers.some((item) => item.includes("shared-artifact-binding: invalid or stale approval status")));
  assert.ok(result.blockers.some((item) => item.includes("shared-artifact-binding remains EXTERNAL_PENDING")));
}));
