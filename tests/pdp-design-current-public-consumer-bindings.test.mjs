import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const shared = resolve(root, "../ghatana-shared/platform/typescript");
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const mediaPackage = JSON.parse(read("libs/audio-video-ui/package.json"));
const lock = read("pnpm-lock.yaml");
const style = parse(read(".product-experience/pdp-2-design-interface-system/gui/style-authority.yaml"));
const aliases = parse(read(".product-experience/pdp-2-design-interface-system/media-token-aliases.yaml"));
const consumer = style.currentConsumerBindingObservation;

function assertPublicExport(packageName, exportName) {
  const manifest = JSON.parse(readFileSync(resolve(shared, packageName, "package.json"), "utf8"));
  assert.ok(Object.hasOwn(manifest.exports ?? {}, exportName), `${packageName} must expose ${exportName} publicly`);
  assert.equal(manifest.version, consumer.mediaPackage.declaredVersions[`@ghatana/${packageName}`]);
}

test("the Media source observation names only public Shared exports that current source actually consumes", () => {
  assert.equal(consumer.observationKind, "CURRENT_PUBLIC_EXPORT_AND_IMPORT_SOURCE_FACTS");
  assert.deepEqual(consumer.mediaPackage.declaredVersions, {
    "@ghatana/tokens": "0.1.0-SNAPSHOT",
    "@ghatana/theme": "0.1.0-SNAPSHOT",
    "@ghatana/design-system": "0.1.0-SNAPSHOT",
  });
  const importer = lock.slice(lock.indexOf("  libs/audio-video-ui:"), lock.indexOf("\n  libs/media-experience-simulation:"));
  for (const name of ["design-system", "theme", "tokens"]) {
    assert.match(importer, new RegExp(`'@ghatana/${name}':[\\s\\S]*?specifier: 0\\.1\\.0-SNAPSHOT[\\s\\S]*?version: link:`));
    assertPublicExport(name, name === "design-system" ? "./strict-csp-controls.css" : name === "tokens" ? "./tokens.css" : "./react");
  }

  const tokenManifest = JSON.parse(readFileSync(resolve(shared, "tokens/package.json"), "utf8"));
  assert.ok(tokenManifest.exports["./semantic-roles"]);
  const mediaEntry = read("libs/audio-video-ui/src/index.tsx");
  assert.match(mediaEntry, /export \* from "@ghatana\/tokens"/u);
  assert.match(consumer.tokenConsumers.semanticRoleTypeApi.importSite, /src\/index\.tsx/u);
  assert.equal(consumer.tokenConsumers.semanticRoleTypeApi.publicExport, "@ghatana/tokens#./semantic-roles");

  const mediaStyles = read("libs/audio-video-ui/src/styles.css");
  assert.match(mediaStyles, /@import "@ghatana\/tokens\/tokens\.css";/u);
  assert.match(mediaStyles, /@import "@ghatana\/design-system\/strict-csp-controls\.css";/u);
  assert.equal(consumer.designSystemConsumers.selectedControls.structuralCss.publicExport, "@ghatana/design-system#./strict-csp-controls.css");

  const designSystem = JSON.parse(readFileSync(resolve(shared, "design-system/package.json"), "utf8"));
  const rootEntry = readFileSync(resolve(shared, "design-system/src/index.ts"), "utf8");
  assert.ok(designSystem.exports["."]?.types && designSystem.exports["."]?.import);
  assert.match(rootEntry, /export \* from '\.\/atoms\/index\.js'/u);
  assert.match(rootEntry, /export \* from '\.\/molecules\/index\.js'/u);
  for (const name of consumer.designSystemConsumers.selectedControls.exports) {
    assert.match(read("libs/audio-video-ui/src/foundations/index.ts"), new RegExp(`\\b${name}\\b`, "u"));
    const sourceIndex = name === "EmptyState"
      ? readFileSync(resolve(shared, "design-system/src/molecules/index.ts"), "utf8")
      : readFileSync(resolve(shared, "design-system/src/atoms/index.ts"), "utf8");
    assert.match(sourceIndex, new RegExp(`\\b${name}\\b`, "u"), `${name} is exported from the corresponding public root barrel`);
  }
  assert.match(read("libs/audio-video-ui/src/components/MediaComponentFamilies.tsx"), /from "@ghatana\/design-system"/u);
  assert.match(read("libs/audio-video-ui/src/screens/FirstUseProjectScreen.tsx"), /from "\.\.\/foundations"/u);
  assert.match(read("libs/audio-video-ui/src/screens/ArtifactIntakeScreen.tsx"), /from "\.\.\/foundations"/u);
});

test("token aliases resolve light and dark roles while current theme and ui-styles use remain explicitly absent", () => {
  assert.equal(aliases.sharedPublicContract.pinnedDevelopmentSnapshotQualification.sourceRevision, "c6d182af472c8954438f219c08d0202d1faa63a3");
  assert.equal(aliases.aliases.length, 9);
  for (const alias of aliases.aliases) {
    assert.match(alias.sharedTokenRef, /^@ghatana\/tokens\/semantic-roles#semanticColorRoles\.light\./u);
    assert.match(alias.darkModeEquivalent, /^@ghatana\/tokens\/semantic-roles#semanticColorRoles\.dark\./u);
  }
  assert.equal(consumer.themeConsumer.disposition, "DECLARED_BUT_NO_CURRENT_MEDIA_SOURCE_CONSUMER");
  assert.deepEqual(consumer.themeConsumer.currentImportSites, []);
  const sources = read("libs/audio-video-ui/src/index.tsx") + read("libs/audio-video-ui/src/styles.css")
    + read("libs/audio-video-ui/src/foundations/index.ts") + read("libs/audio-video-ui/src/components/MediaComponentFamilies.tsx");
  const mediaStyles = read("libs/audio-video-ui/src/styles.css");
  assert.doesNotMatch(sources, /@ghatana\/theme/u, "declared Theme package is not represented as an active source binding");
  assert.equal(consumer.excludedStyles["@ghatana/ui-styles"].currentDependency, false);
  assert.equal(consumer.excludedStyles["@ghatana/ui-styles"].disposition, "NOT_CONSUMED");
  assert.doesNotMatch(sources, /@ghatana\/ui-styles/u);
  assert.match(consumer.evidenceLimit, /does not establish[\s\S]*Shared owner approval/u);

  const presentation = style.hostPresentationContract;
  assert.equal(presentation.id, "media.gui.host-theme-and-semantic-fallback.v1");
  assert.deepEqual(presentation.hostInputs.colorMode, ["light", "dark", "forced-colors", "system"]);
  assert.match(presentation.hostInputs.colorModeMeaning, /cannot change Media state, permission, action, effect, finality/u);
  assert.equal(presentation.roleResolution.source, ".product-experience/pdp-2-design-interface-system/media-token-aliases.yaml#aliases");
  assert.equal(presentation.roleResolution.missingOrUnsupportedRole, "fall-back-to-native-semantic-system-colors; do-not-invent-a-private-token-or-hex-substitute");
  assert.match(presentation.roleResolution.redundancy, /color-is-not-the-only-signal/u);
  assert.equal(presentation.themeRuntime.sourceConsumer, "NONE");
  assert.match(presentation.themeRuntime.rule, /does not consume or validate that runtime/u);
  const typography = presentation.typographyAndGeometry.typography;
  assert.equal(typography.publicSubpath, "./tokens.css");
  assert.equal(typography.roleBindings.pageTitle.sharedRole, "pageTitle");
  assert.equal(typography.roleBindings.sectionTitle.sharedRole, "sectionTitle");
  assert.match(mediaStyles, /font-weight:\s*var\(--gh-semantic-typography-body-font-weight\)/u);
  assert.match(mediaStyles, /h2\s*\{[^}]*font-weight:\s*var\(--media-weight-emphasis\)/u);
  assert.match(mediaStyles, /\.media-step-state\s*\{[^}]*line-height:\s*var\(--media-line-supporting\)/u);
  assert.ok(typography.rules.some((rule) => /200-percent-text-zoom/u.test(rule)));
  assert.ok(typography.rules.some((rule) => /information-density-only/u.test(rule)));
  const geometry = presentation.typographyAndGeometry.geometry;
  assert.equal(geometry.units, "Shared-semantic-gutter-and-rhythm-values-are-numeric-pixels; Media-CSS-projects-them-to-px-through-calc");
  assert.equal(geometry.roleBindings.minimumInteractiveTarget.cssVariable, "--gh-breakpoints-touch-targets-minimum");
  assert.ok(geometry.layoutApplicability.zoom.includes("browser-page-zoom"));
  assert.match(presentation.typographyAndGeometry.noCompetingAuthority, /primitive values and public CSS variable spellings remain owned by Shared/u);
  assert.equal(presentation.typographyAndGeometry.unresolvedBindings, undefined);
  assert.deepEqual(presentation.negativeCases.length, 7);
  for (const color of presentation.nativeFallback.allowedPublicCssColors) assert.match(mediaStyles, new RegExp(`\\b${color}\\b`, "u"));
  assert.match(mediaStyles, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.doesNotMatch(mediaStyles, /forced-color-adjust\s*:\s*none/u);
  const tokenCss = readFileSync(resolve(shared, "tokens/dist/tokens.css"), "utf8");
  const expectedVariables = [
    "--gh-semantic-typography-body-font-size", "--gh-semantic-typography-body-line-height",
    "--gh-semantic-typography-page-title-font-size", "--gh-semantic-typography-section-title-font-size",
    "--gh-semantic-typography-supporting-font-size", "--gh-semantic-typography-metadata-font-size",
    "--gh-semantic-geometry-gutter-compact", "--gh-semantic-geometry-gutter-standard",
    "--gh-semantic-geometry-gutter-comfortable", "--gh-semantic-geometry-section-rhythm-compact",
    "--gh-semantic-geometry-section-rhythm-standard", "--gh-semantic-geometry-section-rhythm-comfortable",
    "--gh-breakpoints-touch-targets-minimum",
  ];
  for (const variable of expectedVariables) {
    assert.match(tokenCss, new RegExp(`${variable}:\\s*[^;]+;`, "u"), `${variable} resolves in the built public tokens CSS`);
  }
  for (const variable of expectedVariables.slice(0, 6)) assert.match(mediaStyles, new RegExp(`var\\(${variable}\\)`, "u"));
  for (const variable of expectedVariables.slice(6)) assert.match(mediaStyles, new RegExp(`var\\(${variable}\\)`, "u"));
  assert.match(mediaStyles, /--media-space-standard:\s*calc\(var\(--gh-semantic-geometry-gutter-standard\) \* 1px\)/u);
  assert.match(mediaStyles, /min-height:\s*var\(--media-interactive-target\)/u);
  assert.deepEqual(style.normativeRuleRecords.map(({ id }) => id), ["media.p2.rule.host-theme-and-semantic-fallback.v1"]);
});
