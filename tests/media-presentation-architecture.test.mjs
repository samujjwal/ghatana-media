import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeMediaPresentationArchitecture, validateDesignChain } from "../scripts/check-media-presentation-architecture.mjs";

const write = (root, path, content) => {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
};
function fixture({ presentation = "export const Screen = () => null;", explorer = "", production = "", consumer = "", admission = "", pdp2 = "", exportMap = "", screenContract = "", templateCatalog = "", patternCatalog = "", componentCatalog = "", semanticBindings = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "media-presentation-architecture-"));
  write(root, "libs/audio-video-ui/package.json", JSON.stringify({ name: "@audio-video/ui", exports: { ".": "./dist/index.js", "./screens": "./dist/screens/index.js" } }));
  write(root, "libs/audio-video-ui/src/index.ts", presentation);
  write(root, "apps/media-experience-explorer/src/main.ts", explorer);
  write(root, "apps/web/src/routes/screen.ts", production);
  if (consumer) write(root, "modules/consumer/src/index.ts", consumer);
  if (admission) write(root, ".product-experience/executable-representation/admissions/screen.yaml", admission);
  if (pdp2) {
    write(root, ".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml", pdp2);
    write(root, ".product-experience/pdp-2-design-interface-system/gui/layout.yaml", pdp2);
    write(root, ".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml", pdp2);
    write(root, ".product-experience/pdp-2-design-interface-system/component-contracts.yaml", pdp2);
    write(root, ".product-experience/pdp-2-design-interface-system/media-token-aliases.yaml", pdp2);
  }
  if (templateCatalog) write(root, ".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml", templateCatalog);
  if (patternCatalog) write(root, ".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml", patternCatalog);
  if (componentCatalog) write(root, ".product-experience/pdp-2-design-interface-system/component-contracts.yaml", componentCatalog);
  if (semanticBindings) write(root, ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml", semanticBindings);
  if (exportMap) write(root, ".product-experience/executable-representation/export-map.yaml", exportMap);
  if (screenContract) write(root, ".product-experience/pdp-3-product-experience/screen-contracts/sample.yaml", screenContract);
  return root;
}
const run = (options, fn) => {
  const root = fixture(options);
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const admitted = `representationId: media.representation.screen.sample
scope: media.gui.screen.sample
platform: WEB
surfaceIds: [media.surface.web]
publicExport: "@audio-video/ui/screens#SampleScreen"
package: "@audio-video/ui"
acceptanceState: admitted
boundPdp2Records:
  - media.gui.template.sample
`;

test("missing admissions pass with zero exact identities proven", () => run({
  explorer: `import { SampleScreen } from "@audio-video/ui/screens";`,
  production: `import { SampleScreen } from "@audio-video/ui/screens";`,
}, (root) => {
  const result = analyzeMediaPresentationArchitecture({ repoRoot: root });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.summary.admittedWebRecords, 0);
  assert.equal(result.summary.exactImportIdentityProven, 0);
}));

test("the review host imports the exact candidate product-renderer export intended for production", () => run({
  explorer: `import { MediaProductRenderer } from "@audio-video/ui";`,
  production: `import { MediaProductRenderer } from "@audio-video/ui";`,
  exportMap: `exports:\n  - subpath: .\n    publicNames: [MediaProductRenderer]\nrendererAdapters:\n  - id: media.adapter.product-renderer\n    package: "@audio-video/ui"\n    subpath: .\n    exportName: MediaProductRenderer\n    source: libs/audio-video-ui/src/screens/MediaProductRenderer.tsx\n`,
}, (root) => {
  write(root, "libs/audio-video-ui/src/screens/MediaProductRenderer.tsx", "export function MediaProductRenderer() { return null; }");
  const result = analyzeMediaPresentationArchitecture({ repoRoot: root });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.summary.candidateProductRendererCount, 1);
  assert.equal(result.summary.explorerProductRendererImports, 1);
  assert.equal(result.summary.productionHostsPresent, true);
  assert.equal(result.summary.productionProductRendererImports, 1);
}));

test("admitted Web record passes only with identical public export and resolvable PDP-2 provenance", () => run({
  explorer: `import { SampleScreen } from "@audio-video/ui/screens";`,
  production: `import { SampleScreen } from "@audio-video/ui/screens";`,
  admission: admitted,
  pdp2: "- id: media.gui.template.sample\n",
}, (root) => {
  const result = analyzeMediaPresentationArchitecture({ repoRoot: root });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.summary.admittedWebRecords, 1);
  assert.equal(result.summary.exactImportIdentityProven, 1);
}));

test("rejects missing host identity and unresolved design provenance", () => run({
  explorer: `import { SampleScreen } from "@audio-video/ui/screens";`,
  production: `import { OtherScreen } from "@audio-video/ui/screens";`,
  admission: admitted,
  pdp2: "- id: media.gui.template.other\n",
}, (root) => {
  const result = analyzeMediaPresentationArchitecture({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes("Production Web does not import admitted export identity")));
  assert.ok(result.issues.some((issue) => issue.includes("design provenance reference not found")));
}));

test("rejects an admitted symbol absent from the representation export map", () => run({
  explorer: `import { SampleScreen } from "@audio-video/ui/screens";`,
  production: `import { SampleScreen } from "@audio-video/ui/screens";`,
  admission: admitted,
  pdp2: "- id: media.gui.template.sample\n",
  exportMap: `exports:\n  - subpath: ./screens\n    publicNames: [DifferentScreen]\n`,
}, (root) => {
  const result = analyzeMediaPresentationArchitecture({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes("absent from executable-representation/export-map.yaml")));
}));

test("rejects presentation-to-review dependencies and production scenario fixtures", () => run({
  presentation: `import { makeFixture } from "@ghatana/media-experience-simulation";`,
  production: `import { scenarios } from "../../scenario-fixtures/catalog.js";`,
}, (root) => {
  const result = analyzeMediaPresentationArchitecture({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes("review/simulation infrastructure")));
  assert.ok(result.issues.some((issue) => issue.includes("review/scenario infrastructure")));
}));

test("rejects deep source imports and package subpaths absent from exports", () => run({
  consumer: `import { x } from "@audio-video/ui/src/screens/Screen";\nimport { y } from "../../../libs/audio-video-ui/src/screens/Screen";`,
}, (root) => {
  const result = analyzeMediaPresentationArchitecture({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes("unexported UI package path")));
  assert.ok(result.issues.some((issue) => issue.includes("deep-imports private UI source")));
}));

test("validates declared screen-to-token design links and reports broken candidate links", () => {
  const inventories = {
    templates: new Set(["media.gui.template.sample"]),
    layouts: new Set(["media.gui.layout.sample"]),
    patterns: new Set(["media.gui.pattern.sample"]),
    components: new Set(["media.component.sample"]),
    tokens: new Set(["media.token.state.completed"]),
  };
  const chain = {
    screenRef: "media.view.sample",
    templateRefs: ["media.gui.template.sample"],
    layoutRefs: ["media.gui.layout.sample"],
    patternRefs: ["media.gui.pattern.sample"],
    componentRefs: ["media.component.sample"],
    tokenRefs: ["media.token.state.completed"],
  };
  assert.deepEqual(validateDesignChain(chain, inventories), []);
  const broken = validateDesignChain({ ...chain, componentRefs: ["media.component.missing"] }, inventories);
  assert.equal(broken.length, 1);
  assert.match(broken[0], /components link does not resolve/);
});

const admittedScreen = `representationId: media.representation.screen.sample
scope: media.view.sample
representationKind: screen
acceptanceState: admitted
boundPdp3Records:
  - .product-experience/pdp-3-product-experience/screen-contracts/sample.yaml#media.view.sample
`;
const resolvedScreenContract = `screenId: media.view.sample
templateId: media.gui.template.sample
layoutIds:
  - media.gui.layout.sample
patternIds:
  - media.gui.pattern.sample
componentIds:
  - media.component.sample
tokenDependencies:
  - media.token.state.completed
`;
const completePdp2 = `- id: media.gui.template.sample
- id: media.gui.layout.sample
- id: media.gui.pattern.sample
- id: media.component.sample
- id: media.token.state.completed
`;

test("counts a resolved admitted screen design chain", () => run({
  admission: admittedScreen,
  screenContract: resolvedScreenContract,
  pdp2: completePdp2,
  templateCatalog: `templates:\n  - id: media.gui.template.sample\n    patterns: [media.gui.pattern.sample]\n`,
  patternCatalog: `patterns:\n  - id: media.gui.pattern.sample\n    sourceRef: .product-experience/pdp-2-design-interface-system/component-contracts.yaml#media.component.sample\n`,
  componentCatalog: `components:\n  - id: media.component.sample\n`,
  semanticBindings: `bindings:\n  - componentRefs: [media.component.sample]\n    semanticTokenRef: media.token.state.completed\n`,
}, (root) => {
  const result = analyzeMediaPresentationArchitecture({ repoRoot: root });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.summary.admittedScreenDesignChainsProven, 1);
}));

test("an unresolved admitted screen design link is a hard failure", () => run({
  admission: admittedScreen,
  screenContract: resolvedScreenContract.replace("media.gui.pattern.sample", "media.gui.pattern.missing"),
  pdp2: completePdp2,
}, (root) => {
  const result = analyzeMediaPresentationArchitecture({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.summary.admittedScreenDesignChainsProven, 0);
  assert.ok(result.issues.some((issue) => issue.includes("patterns link does not resolve")));
}));

test("unresolved candidate screen design links remain nonfatal", () => run({
  screenContract: resolvedScreenContract.replace("media.gui.pattern.sample", "media.gui.pattern.missing"),
  pdp2: completePdp2,
}, (root) => {
  const result = analyzeMediaPresentationArchitecture({ repoRoot: root });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.summary.admittedScreenDesignChainsProven, 0);
  assert.ok(result.candidateDesignIssues.some((issue) => issue.includes("patterns link does not resolve")));
}));

const templateOnlyScreenContract = `screenId: media.view.sample\ntemplateId: media.gui.template.sample\n`;
const templateWithMissingPattern = `templates:\n  - id: media.gui.template.sample\n    patterns: [media.gui.pattern.missing]\n`;

test("a missing pattern nested under an admitted screen template is a hard failure", () => run({
  admission: admittedScreen,
  screenContract: templateOnlyScreenContract,
  templateCatalog: templateWithMissingPattern,
}, (root) => {
  const result = analyzeMediaPresentationArchitecture({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.summary.admittedScreenDesignChainsProven, 0);
  assert.ok(result.issues.some((issue) => issue.includes("patterns link does not resolve: media.gui.pattern.missing")));
}));

test("a missing pattern nested under a candidate screen template stays nonfatal", () => run({
  screenContract: templateOnlyScreenContract,
  templateCatalog: templateWithMissingPattern,
}, (root) => {
  const result = analyzeMediaPresentationArchitecture({ repoRoot: root });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.ok(result.candidateDesignIssues.some((issue) => issue.includes("patterns link does not resolve: media.gui.pattern.missing")));
}));

test("a template pattern with an unresolved component source fails only when admitted", () => run({
  admission: admittedScreen,
  screenContract: templateOnlyScreenContract,
  templateCatalog: `templates:\n  - id: media.gui.template.sample\n    patterns: [media.gui.pattern.sample]\n`,
  patternCatalog: `patterns:\n  - id: media.gui.pattern.sample\n    sourceRef: .product-experience/pdp-2-design-interface-system/component-contracts.yaml#media.component.missing\n`,
  componentCatalog: "components: []\n",
}, (root) => {
  const result = analyzeMediaPresentationArchitecture({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes("component source link does not resolve: media.component.missing")));
  assert.ok(result.candidateDesignIssues.some((issue) => issue.includes("component source link does not resolve: media.component.missing")));
}));
