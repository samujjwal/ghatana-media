import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { analyzeDesignConformance } from "../scripts/check-media-design-conformance.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { parse: parseYaml } = createRequire(resolve(repositoryRoot, "../ghatana-tools/package.json"))("yaml");

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

test("pinned public Shared CSS variables resolve without local shadow declarations", () => withFixture({ css: ".sample { color: var(--shared-body-size); }" }, (root) => {
  const aliasPath = ".product-experience/pdp-2-design-interface-system/media-token-aliases.yaml";
  const aliases = `status: MEDIA_OWNER_ACCEPTED_INTENT_ONLY
aliases:
  - id: media.token.content.primary
    cssVariable: --text
    sharedTokenRef: "@ghatana/tokens/semantic-roles#semanticColorRoles.light.contentPrimary"
sharedPublicContract:
  pinnedDevelopmentSnapshotQualification:
    sourceRevision: c6d182af472c8954438f219c08d0202d1faa63a3
cssVariableBindings:
  sourcePackage: "@ghatana/tokens"
  publicExport: "@ghatana/tokens#./tokens.css"
  sourceRepository: samujjwal/ghatana-shared
  sourceRevision: c6d182af472c8954438f219c08d0202d1faa63a3
  resolutionStatus: VERIFIED_AGAINST_PINNED_PUBLIC_SOURCE_SNAPSHOT; registry-publication-and-immutable-release-pending
  bindings:
    - id: media.shared-css.typography.body.font-size
      cssVariable: --shared-body-size
      publicCssRef: "@ghatana/tokens/tokens.css#--shared-body-size"
      semanticSource: sibling-repository:ghatana-shared/platform/typescript/tokens/src/semantic.ts#semanticTokens.typography.body.fontSize
      valueType: CSS-length-rem
      consumerBinding: media.token.css.typography.body.font-size
`;
  write(root, aliasPath, aliases);
  const result = analyzeDesignConformance(root);
  assert.ok(!result.findings.some((item) => item.kind === "unknown-token-provenance" && item.detail.includes("--shared-body-size")));

  write(root, aliasPath, aliases.replace("@ghatana/tokens/tokens.css#--shared-body-size", "@ghatana/tokens/private.css#--shared-body-size"));
  const malformed = analyzeDesignConformance(root);
  assert.ok(malformed.findings.some((item) => item.kind === "unknown-token-provenance" && item.detail.includes("--shared-body-size")));
  assert.ok(malformed.blockers.some((item) => item.includes("design-token CSS binding")));
}));

test("unregistered local component implementation fails", () => withFixture({ extraSource: "export function LocalCard() { return null; }" }, (root) => {
  const result = analyzeDesignConformance(root);
  assert.ok(result.findings.some((item) => item.kind === "unregistered-local-component" && item.detail.includes("LocalCard")));
}));

test("private helper used by an exact registered screen is implementation detail, while unknown exports still fail", () => withFixture({
  extraSource: "export function DevProjectTimelineWorkspaceScreen() { return <PrivateWorkspace />; }\nfunction PrivateWorkspace() { return null; }\nexport function LocalCard() { return null; }",
}, (root) => {
  write(root, ".product-experience/executable-representation/export-map.yaml", `exports:\n  - subpath: ./screens/dev-project-timeline\n    publicNames: [DevProjectTimelineWorkspaceScreen]\n    source: libs/audio-video-ui/src/Local.tsx\n    layer: screen-composition\n`);
  const result = analyzeDesignConformance(root);
  assert.ok(!result.findings.some((item) => item.kind === "unregistered-local-component" && item.detail.includes("PrivateWorkspace")));
  assert.ok(result.findings.some((item) => item.kind === "unregistered-local-component" && item.detail.includes("LocalCard")));
}));

function writeEmbeddedSurfaceBinding(root, {
  id = "media.gui.embedded-surface.interactive-demo-player.v1",
  implementationExport = "InteractiveDemoPlayer",
  implementationCandidate = "libs/audio-video-ui/src/player/interactiveDemoPlayer.tsx",
  surfaceId = "media.surface.interactive-demo-player",
  experienceKey = "interactiveDemoPlayerExperience",
  status = "candidate-source-observation-only; route-runtime-admission-not-recorded",
  omitSurfaceRef = false,
  omitExperienceRef = false,
  surfaceRefOverride,
  experienceRefOverride,
  includePublicExport = true,
} = {}) {
  const definedSurfaceRef = `.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml#surfaceInterfaces/${surfaceId}`;
  const surfaceRef = surfaceRefOverride ?? definedSurfaceRef;
  const experienceRef = experienceRefOverride ?? `.product-experience/pdp-3-product-experience/recorder-studio-experience.yaml#${experienceKey}`;
  const record = {
    id,
    implementationExport,
    implementationCandidate,
    surfaceId,
    surfaceSourceRef: omitSurfaceRef ? undefined : surfaceRef,
    experienceSourceRef: omitExperienceRef ? undefined : experienceRef,
    status,
  };
  const { id: recordId, ...recordFields } = record;
  const fields = Object.entries(recordFields).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `    ${key}: ${value}`).join("\n");
  write(root, ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml", `embeddedSurfaceBindings:\n  - id: ${recordId}\n${fields}\n`);
  write(root, ".product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml", `surfaceInterfaces:\n  - surfaceId: ${surfaceId}\n    kind: EMBEDDED_GUI\n`);
  write(root, ".product-experience/pdp-3-product-experience/recorder-studio-experience.yaml", `${experienceKey}:\n  surfaceId: ${surfaceId}\n  sourcePdp2Ref: ${definedSurfaceRef}\n`);
  write(root, record.implementationCandidate, `export function ${implementationExport}() { return null; }`);
  write(root, "libs/audio-video-ui/src/index.ts", 'export * from "./player";');
  const leafModule = implementationCandidate.slice("libs/audio-video-ui/src/player/".length).replace(/\.(?:tsx?|jsx?)$/u, "");
  write(root, "libs/audio-video-ui/src/player/index.ts", `export * from "./${leafModule}";`);
  const publicNames = includePublicExport ? `[${implementationExport}]` : "[]";
  write(root, ".product-experience/executable-representation/export-map.yaml", `exports:\n  - subpath: .\n    publicNames: ${publicNames}\n    source: libs/audio-video-ui/src/index.ts\n    status: candidate; admission-not-recorded\n`);
}

test("embedded player source binding requires exact PDP-2, PDP-3, and implementation references", () => withFixture({}, (root) => {
  writeEmbeddedSurfaceBinding(root);
  const result = analyzeDesignConformance(root);
  assert.ok(!result.findings.some((item) => item.kind === "unregistered-local-component" && item.detail.includes("InteractiveDemoPlayer")));
  assert.equal(result.blockers.some((item) => item.includes("embedded surface")), false);
}));

test("embedded surface binding is generic across exact source identities", () => withFixture({}, (root) => {
  writeEmbeddedSurfaceBinding(root, {
    id: "media.gui.embedded-surface.training-demo.v1",
    implementationExport: "TrainingDemo",
    implementationCandidate: "libs/audio-video-ui/src/player/trainingDemo.tsx",
    surfaceId: "media.surface.training-demo",
    experienceKey: "trainingDemoExperience",
  });
  const result = analyzeDesignConformance(root);
  assert.ok(!result.findings.some((item) => item.kind === "unregistered-local-component" && item.detail.includes("TrainingDemo")));
  assert.equal(result.blockers.some((item) => item.includes("semantic component bindings:")), false, result.blockers.join("\n"));
}));

test("embedded surface binding rejects wrong or missing refs, status, and public exports", () => {
  for (const options of [
    { surfaceRefOverride: ".product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml#surfaceInterfaces/media.surface.other" },
    { omitSurfaceRef: true },
    { experienceRefOverride: ".product-experience/pdp-3-product-experience/recorder-studio-experience.yaml#missingExperience" },
    { omitExperienceRef: true },
    { status: "accepted-and-runtime-admitted" },
    { includePublicExport: false },
  ]) withFixture({}, (root) => {
    writeEmbeddedSurfaceBinding(root, options);
    const result = analyzeDesignConformance(root);
    assert.ok(result.blockers.some((item) => item.includes("semantic component bindings:")), result.blockers.join("\n"));
    assert.ok(result.findings.some((item) => item.kind === "unregistered-local-component" && item.detail.includes("InteractiveDemoPlayer")));
  });
  withFixture({}, (root) => {
    writeEmbeddedSurfaceBinding(root);
    write(root, ".product-experience/pdp-3-product-experience/recorder-studio-experience.yaml", "interactiveDemoPlayerExperience: {}\n");
    const result = analyzeDesignConformance(root);
    assert.ok(result.blockers.some((item) => item.includes("PDP-3 source ref")));
    assert.ok(result.findings.some((item) => item.kind === "unregistered-local-component" && item.detail.includes("InteractiveDemoPlayer")));
  });
  withFixture({}, (root) => {
    writeEmbeddedSurfaceBinding(root);
    const bindingPath = ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml";
    const binding = readFileSync(join(root, bindingPath), "utf8");
    write(root, bindingPath, `${binding}${binding.replace("embeddedSurfaceBindings:\n", "")}`);
    const result = analyzeDesignConformance(root);
    assert.ok(result.blockers.some((item) => item.includes("unique exact identities")));
    assert.ok(result.findings.some((item) => item.kind === "unregistered-local-component" && item.detail.includes("InteractiveDemoPlayer")));
  });
});

test("candidate-first semantic bindings register exports and their interaction selectors only with valid sources and component refs", () => {
  const semanticPath = ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml";
  const binding = (candidate, componentRef = "media.component.sample") => `status: SOURCE_INCOMPLETE\nbindings:\n  - implementationCandidate: ${candidate}\n    componentRefs: [${componentRef}]\n    implementationExport: MediaTaskFlow\n`;
  const source = "export function MediaTaskFlow() { return null; }";

  withFixture({ css: ".media-task-flow:hover { color: var(--text); }", extraSource: source }, (root) => {
    write(root, semanticPath, binding("libs/audio-video-ui/src/Local.tsx"));
    const result = analyzeDesignConformance(root);
    assert.ok(!result.findings.some((item) => item.kind === "unregistered-local-component" && item.detail.includes("MediaTaskFlow")));
    assert.ok(!result.findings.some((item) => item.kind === "one-off-interaction-behavior" && item.detail.includes(".media-task-flow:hover")));
  });

  for (const [candidate, componentRef] of [
    ["libs/audio-video-ui/src/Missing.tsx", "media.component.sample"],
    ["libs/audio-video-ui/src/Local.tsx", "media.component.missing"],
  ]) {
    withFixture({ css: ".media-task-flow:hover { color: var(--text); }", extraSource: source }, (root) => {
      write(root, semanticPath, binding(candidate, componentRef));
      const result = analyzeDesignConformance(root);
      assert.ok(result.findings.some((item) => item.kind === "unregistered-local-component" && item.detail.includes("MediaTaskFlow")));
      assert.ok(result.findings.some((item) => item.kind === "one-off-interaction-behavior" && item.detail.includes(".media-task-flow:hover")));
    });
  }
});

test("root renderer-adapter bindings register exports and interaction selectors only with valid sources and component refs", () => {
  const semanticPath = ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml";
  const adapterBinding = (candidate, componentRef = "media.component.sample") => `status: SOURCE_INCOMPLETE\nrendererAdapterBindings:\n  - id: media.gui.renderer-adapter.fixture.v1\n    implementationExport: MediaFamily\n    implementationCandidate: ${candidate}\n    componentRefs: [${componentRef}]\n`;
  const source = "export function MediaFamily() { return null; }";

  withFixture({ css: ".media-family:focus-visible { color: var(--text); }", extraSource: source }, (root) => {
    write(root, semanticPath, adapterBinding("libs/audio-video-ui/src/Local.tsx"));
    const result = analyzeDesignConformance(root);
    assert.ok(!result.findings.some((item) => item.kind === "unregistered-local-component" && item.detail.includes("MediaFamily")));
    assert.ok(!result.findings.some((item) => item.kind === "one-off-interaction-behavior" && item.detail.includes(".media-family:focus-visible")));
  });

  for (const [candidate, componentRef] of [
    ["libs/audio-video-ui/src/Missing.tsx", "media.component.sample"],
    ["libs/audio-video-ui/src/Local.tsx", "media.component.missing"],
  ]) {
    withFixture({ css: ".media-family:focus-visible { color: var(--text); }", extraSource: source }, (root) => {
      write(root, semanticPath, adapterBinding(candidate, componentRef));
      const result = analyzeDesignConformance(root);
      assert.ok(result.findings.some((item) => item.kind === "unregistered-local-component" && item.detail.includes("MediaFamily")));
      assert.ok(result.findings.some((item) => item.kind === "one-off-interaction-behavior" && item.detail.includes(".media-family:focus-visible")));
    });
  }
});

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
  assert.equal(result.summary.productLiteralColors, 0);
  assert.equal(result.summary.unexplained, 0);
  assert.ok(result.summary.explorerFixtureObservations > 0);
  assert.ok(result.blockers.some((item) => item.includes("shared-artifact-binding remains EXTERNAL_PENDING")));
  assert.ok(result.blockers.some((item) => item.includes("conformance-and-specialist-review remains INDEPENDENT_PENDING")));
  assert.equal(result.summary.resolvedOwnerGates, 5);
  assert.equal(result.summary.openGovernanceGates.length, 2);
  assert.ok(!result.blockers.some((item) => item.includes("concrete-component-bindings")), result.blockers.join("\n"));
  assert.deepEqual(result.findings.filter((item) => item.disposition === "unexplained").map((item) => item.rootCauseKey), []);
});

test("public component evidence uses the current package export barrel", () => {
  const bindings = readFileSync(join(repositoryRoot, ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml"), "utf8");
  const reuse = readFileSync(join(repositoryRoot, ".product-experience/pdp-2-design-interface-system/gui/reuse-audit.yaml"), "utf8");
  const exportMap = readFileSync(join(repositoryRoot, ".product-experience/executable-representation/export-map.yaml"), "utf8");
  assert.doesNotMatch(bindings, /libs\/audio-video-ui\/src\/index\.tsx#export\*from-components/u);
  assert.doesNotMatch(reuse, /libs\/audio-video-ui\/src\/index\.tsx#export\*from-components/u);
  assert.doesNotMatch(exportMap, /libs\/audio-video-ui\/src\/index\.tsx/u);
  assert.match(exportMap, /source: libs\/audio-video-ui\/src\/index\.ts\n/u);
  assert.match(bindings, /libs\/audio-video-ui\/src\/components\/index\.ts#MediaProgress/u);
  assert.match(bindings, /libs\/audio-video-ui\/src\/components\/index\.ts#MediaTaskFlow/u);
  assert.match(exportMap, /publicNames: \[[^\]]*ArtifactInspectionScreen/u);
  const componentBarrel = readFileSync(join(repositoryRoot, "libs/audio-video-ui/src/components/index.ts"), "utf8");
  assert.doesNotMatch(componentBarrel, /MediaActionFeedback|mediaActionFeedbackForResult|MediaActionFeedbackValue/u);
  const candidates = parseYaml(exportMap).exports;
  const rootCandidate = candidates.find(({ subpath }) => subpath === ".");
  const componentCandidate = candidates.find(({ subpath }) => subpath === "./components");
  const screenCandidate = candidates.find(({ subpath }) => subpath === "./screens");
  for (const name of [
    "InteractiveDemoPlayer",
    "ArtifactInspectionScreen",
    "DevProjectTimelineWorkspaceScreen",
  ]) {
    assert.ok(rootCandidate.publicNames.includes(name), `${name} is indexed at the package root`);
  }
  for (const name of ["MediaActionFeedback", "mediaActionFeedbackForResult"]) {
    assert.ok(!rootCandidate.publicNames.includes(name), `${name} is absent from the root API`);
    assert.ok(!componentCandidate.publicNames.includes(name), `${name} is absent from ./components`);
  }
  assert.equal(rootCandidate.status, "active-public-api; admission-not-recorded");
  assert.equal(componentCandidate.status, "active-public-api; candidate; admission-not-recorded");
  assert.equal(screenCandidate.status, "active-public-api; candidate; admission-not-recorded");
});

test("current product presentation CSS uses accepted semantic or native system colors", () => {
  const result = analyzeDesignConformance();
  assert.equal(result.summary.productLiteralColors, 0);
  assert.equal(result.findings.filter((item) => item.kind === "literal-color" && item.disposition === "unexplained").length, 0);
});

test("definition-only mode defers external gates but still blocks incomplete Media definitions", () => withFixture({}, (root) => {
  const result = analyzeDesignConformance(root, { definitionOnly: true });
  assert.equal(result.mode, "DEFINITION_ONLY");
  assert.equal(result.acceptanceClaim, "NONE");
  assert.equal(result.ok, false);
  assert.deepEqual(result.deferredAdmissionGates, [
    { id: "shared-artifact-binding", disposition: "EXTERNAL_PENDING" },
    { id: "conformance-and-specialist-review", disposition: "INDEPENDENT_PENDING" },
  ]);
  assert.ok(!result.blockers.some((item) => item.includes("shared-artifact-binding remains")));
  assert.ok(!result.blockers.some((item) => item.includes("conformance-and-specialist-review remains")));
  assert.ok(result.blockers.some((item) => item.includes("concrete-component-bindings remains SOURCE_INCOMPLETE")));
}));

test("definition-only mode defers external acceptance after internal helper cleanup", () => {
  const result = analyzeDesignConformance(undefined, { definitionOnly: true, includeP3ScreenInstances: false });
  assert.equal(result.mode, "DEFINITION_ONLY");
  assert.equal(result.screenInstanceScope, "DEFERRED_PDP3_INSTANCE_VALIDATION");
  assert.equal(result.acceptanceClaim, "NONE");
  assert.equal(result.ok, true);
  assert.equal(result.summary.unexplained, 0);
  assert.ok(!result.blockers.some((item) => item.includes("source-observable design-authority finding(s) are unexplained")));
  assert.equal(result.summary.screenContracts, 0, "PDP-2 scope must not scan downstream screen instances");
  assert.deepEqual(result.deferredAdmissionGates, [
    { id: "shared-artifact-binding", disposition: "EXTERNAL_PENDING" },
    { id: "conformance-and-specialist-review", disposition: "INDEPENDENT_PENDING" },
  ]);
  assert.deepEqual(result.deferredP3ScreenCompositionFindings, []);
});

test("default full conformance keeps screen-instance checks enabled", () => withFixture({ screen: "templateId: null\nlayoutIds: []\n" }, (root) => {
  const result = analyzeDesignConformance(root);
  assert.equal(result.mode, "STRICT_CONFORMANCE");
  assert.equal(result.screenInstanceScope, "FULL_PDP3_INSTANCE_VALIDATION");
  assert.ok(result.findings.some(({ kind, path }) => kind === "missing-template-binding"
    && path === ".product-experience/pdp-3-product-experience/screen-contracts/sample.yaml"));
}));

test("PDP-2 scoped conformance still blocks a broken typed component contract", () => {
  const fixtureRoot = mkdtempSync(join(repositoryRoot, ".tmp-pdp2-component-scope-"));
  try {
    const experienceRoot = join(fixtureRoot, ".product-experience");
    mkdirSync(experienceRoot, { recursive: true });
    const p2Source = join(repositoryRoot, ".product-experience/pdp-2-design-interface-system");
    const p2Fixture = join(experienceRoot, "pdp-2-design-interface-system");
    cpSync(p2Source, p2Fixture, { recursive: true });
    for (const directory of ["pdp-0-product-truth", "pdp-1-domain-data", "pdp-3-product-experience", "interface-parity"]) {
      symlinkSync(join(repositoryRoot, ".product-experience", directory), join(experienceRoot, directory), "dir");
    }

    const contractsPath = join(p2Fixture, "component-contracts.yaml");
    const contracts = parseYaml(readFileSync(contractsPath, "utf8"));
    const typedContract = contracts.components.find(({ typedDefinition }) => typedDefinition);
    assert.ok(typedContract, "fixture includes a PDP-2 typed component contract");
    typedContract.typedDefinition.invariants = [];
    writeFileSync(contractsPath, `${JSON.stringify(contracts, null, 2)}\n`);

    const result = analyzeDesignConformance(fixtureRoot, { definitionOnly: true, includeP3ScreenInstances: false });
    assert.equal(result.screenInstanceScope, "DEFERRED_PDP3_INSTANCE_VALIDATION");
    assert.equal(result.summary.screenContracts, 0);
    assert.deepEqual(result.deferredP3ScreenCompositionFindings, []);
    assert.ok(result.blockers.some((blocker) => blocker.includes(`${typedContract.id}: at least one material family invariant is required`)));
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
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
