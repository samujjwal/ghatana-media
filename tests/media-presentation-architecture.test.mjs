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
function fixture({ presentation = "export const Screen = () => null;", explorer = "", production = "", consumer = "", admission = "", pdp2 = "", exportMap = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "media-presentation-architecture-"));
  write(root, "libs/audio-video-ui/package.json", JSON.stringify({ name: "@audio-video/ui", exports: { ".": "./dist/index.js", "./screens": "./dist/screens/index.js" } }));
  write(root, "libs/audio-video-ui/src/index.ts", presentation);
  write(root, "apps/media-experience-explorer/src/main.ts", explorer);
  write(root, "apps/web/src/routes/screen.ts", production);
  if (consumer) write(root, "modules/consumer/src/index.ts", consumer);
  if (admission) write(root, ".product-experience/executable-representation/admissions/screen.yaml", admission);
  if (pdp2) write(root, ".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml", pdp2);
  if (exportMap) write(root, ".product-experience/executable-representation/export-map.yaml", exportMap);
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
