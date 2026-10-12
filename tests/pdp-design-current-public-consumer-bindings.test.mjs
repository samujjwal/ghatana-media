import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
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
  const expectedVariables = aliases.cssVariableBindings.bindings
    .filter(({ id }) => /^media\.shared-css\.(?:typography|geometry)\./u.test(id))
    .map(({ cssVariable }) => cssVariable);
  assert.equal(expectedVariables.length, 18, "all declared public typography/geometry variables are covered");
  for (const variable of expectedVariables) {
    assert.match(tokenCss, new RegExp(`${variable}:\\s*[^;]+;`, "u"), `${variable} resolves in the built public tokens CSS`);
    assert.match(mediaStyles, new RegExp(`${variable}`, "u"), `${variable} is consumed by the Media stylesheet`);
  }
  assert.match(mediaStyles, /--media-space-standard:\s*calc\(var\(--gh-semantic-geometry-gutter-standard\) \* 1px\)/u);
  assert.match(mediaStyles, /min-height:\s*var\(--media-interactive-target\)/u);
  assert.deepEqual(style.normativeRuleRecords.map(({ id }) => id), ["media.p2.rule.host-theme-and-semantic-fallback.v1"]);
});

test("foundation consumer keeps typed geometry, RTL, forced colors, reduced motion, and strict CSP compatible", () => {
  const mediaStyles = read("libs/audio-video-ui/src/styles.css");
  const screen = read("libs/audio-video-ui/src/screens/MediaTaskScreen.tsx");
  const explorerPolicy = read("apps/media-experience-explorer/vite.config.mjs");
  const primitives = parse(read(".product-experience/pdp-2-design-interface-system/gui/primitives.yaml"));
  const statusPrimitive = primitives.bindings.find(({ id }) => id === "media.gui.primitive.status");
  const motion = parse(read(".product-experience/pdp-2-design-interface-system/motion.yaml"));
  const tokenSource = readFileSync(resolve(shared, "tokens/src/semantic.ts"), "utf8");

  // Shared token geometry is numeric CSS-pixel data and is converted once at the Media CSS boundary.
  assert.match(tokenSource, /gutter: Object\.freeze\(\{ compact: spacing\[2\], standard: spacing\[4\], comfortable: spacing\[6\] \}\)/u);
  assert.match(tokenSource, /interactiveTarget: touchTargets\.minimum/u);
  assert.match(tokenSource, /fontSize: fontSize\.base/u);
  assert.match(mediaStyles, /--media-space-standard:\s*calc\(var\(--gh-semantic-geometry-gutter-standard\) \* 1px\)/u);
  assert.doesNotMatch(mediaStyles, /--media-space-standard:\s*var\(--gh-semantic-geometry-gutter-standard\)px/u,
    "numeric Shared pixel values must not be unit-appended twice");

  // Direction is an explicit host input and structural CSS uses logical properties.
  assert.match(screen, /dir=\{context\.direction\}/u);
  assert.match(mediaStyles, /margin-inline/u);
  assert.match(mediaStyles, /padding-inline-start/u);
  assert.doesNotMatch(mediaStyles, /(?:margin|padding)-(?:left|right)\s*:/u);

  // Forced/system colors remain available; reduced motion removes animation without removing meaning.
  assert.match(mediaStyles, /@media\s*\(forced-colors:\s*active\)/u);
  assert.doesNotMatch(mediaStyles, /forced-color-adjust\s*:\s*none/u);
  assert.match(mediaStyles, /@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
  assert.ok(motion.rules.some((rule) => /Reduced-motion mode removes nonessential transitions/u.test(rule)));
  assert.ok(motion.rules.some((rule) => /Progress is represented by state and text/u.test(rule)));

  // The only generic Progress exclusion is explicit: native progress is used because style attributes are blocked.
  assert.match(explorerPolicy, /style-src-attr 'none'/u);
  assert.match(statusPrimitive.progressExclusion, /native HTML progress/u);
  assert.match(statusPrimitive.progressExclusion, /unknown or absent measurements/u);
});

test("Media light/dark progress colors consume exact public Shared roles and retain system fallbacks", () => {
  const mediaStyles = read("libs/audio-video-ui/src/styles.css");
  const tokenCss = readFileSync(resolve(shared, "tokens/dist/tokens.css"), "utf8");
  const result = spawnSync(process.execPath, [
    "--input-type=module", "-e",
    "import { semanticColorRoles } from '@ghatana/tokens/semantic-roles'; process.stdout.write(JSON.stringify(semanticColorRoles));",
  ], { cwd: resolve(root, "libs/audio-video-ui"), encoding: "utf8" });
  assert.equal(result.status, 0, `load public @ghatana/tokens semantic roles: ${result.stderr}`);
  const roles = JSON.parse(result.stdout);
  const projections = aliases.aliases.filter(({ currentCssConsumer }) => currentCssConsumer);
  assert.deepEqual(projections.map(({ id }) => id), [
    "media.token.state.completed", "media.token.state.in-progress", "media.token.state.needs-review",
  ]);
  const colorBindings = aliases.cssVariableBindings.bindings.filter(({ id }) => id.startsWith("media.shared-css.color."));
  const colorProjections = aliases.cssVariableBindings.bindings.filter(({ id }) => id.startsWith("media.token.css.color."));
  assert.equal(colorBindings.length, 6);
  assert.equal(colorProjections.length, 3);
  const publicCssValue = (variable) => tokenCss.match(new RegExp(`${variable}:\\s*([^;]+);`, "u"))?.[1]?.trim();
  for (const alias of projections) {
    const lightRole = alias.sharedTokenRef.split("#semanticColorRoles.")[1];
    const darkRole = alias.darkModeEquivalent.split("#semanticColorRoles.")[1];
    const [lightMode, lightName] = lightRole.split(".");
    const [darkMode, darkName] = darkRole.split(".");
    const { lightCssVariable, darkCssVariable, usedBy } = alias.currentCssConsumer;
    const mediaVariable = alias.id === "media.token.state.completed"
      ? "--media-color-state-completed"
      : alias.id === "media.token.state.in-progress"
        ? "--media-color-state-in-progress"
        : "--media-color-state-needs-review";
    assert.equal(publicCssValue(lightCssVariable), roles[lightMode][lightName], `${alias.id} light CSS projection matches its public role`);
    assert.equal(publicCssValue(darkCssVariable), roles[darkMode][darkName], `${alias.id} dark CSS projection matches its public role`);
    const lightBinding = colorBindings.find(({ cssVariable }) => cssVariable === lightCssVariable);
    const darkBinding = colorBindings.find(({ cssVariable }) => cssVariable === darkCssVariable);
    assert.equal(lightBinding?.publicCssRef, `@ghatana/tokens/tokens.css#${lightCssVariable}`);
    assert.equal(darkBinding?.publicCssRef, `@ghatana/tokens/tokens.css#${darkCssVariable}`);
    assert.equal(lightBinding?.semanticSource, `sibling-repository:ghatana-shared/platform/typescript/tokens/src/semantic-roles.ts#semanticColorRoles.${lightRole}`);
    assert.equal(darkBinding?.semanticSource, `sibling-repository:ghatana-shared/platform/typescript/tokens/src/semantic-roles.ts#semanticColorRoles.${darkRole}`);
    assert.equal(lightBinding?.valueType, "CSS-color");
    assert.equal(darkBinding?.valueType, "CSS-color");
    const projection = colorProjections.find(({ id }) => id === `media.token.css.color.${alias.id.slice("media.token.".length)}`);
    assert.equal(projection?.sharedCssVariableRef, lightCssVariable);
    assert.equal(projection?.cssVariable, mediaVariable);
    assert.match(tokenCss, new RegExp(`${lightCssVariable}:\\s*[^;]+;`, "u"));
    assert.match(tokenCss, new RegExp(`${darkCssVariable}:\\s*[^;]+;`, "u"));
    assert.match(mediaStyles, new RegExp(`${mediaVariable}:\\s*var\\(${lightCssVariable}\\)`, "u"), `${usedBy} uses the light public role`);
    assert.match(mediaStyles, new RegExp(`${mediaVariable}:\\s*var\\(${darkCssVariable}\\)`, "u"), `${usedBy} uses the dark public role`);
  }
  assert.match(mediaStyles, /\.media-progress--success\s*\{\s*color:\s*var\(--media-color-state-completed, LinkText\)/u);
  assert.match(mediaStyles, /\.media-progress--info,[\s\S]*?color:\s*var\(--media-color-state-in-progress, Highlight\)/u);
  assert.match(mediaStyles, /\.media-progress--warning\s*\{\s*color:\s*var\(--media-color-state-needs-review, Mark\)/u);
  assert.match(mediaStyles, /@media \(forced-colors: active\)[\s\S]*?\.media-progress--success\s*\{\s*color: LinkText/u);
  assert.match(mediaStyles, /@media \(forced-colors: active\)[\s\S]*?\.media-progress--warning\s*\{\s*color: Mark/u);
  assert.doesNotMatch(mediaStyles, /#[0-9a-f]{3,8}\b/iu, "Media does not copy Shared hex values into its stylesheet");
});
