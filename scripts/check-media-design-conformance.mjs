#!/usr/bin/env node
/**
 * Fail-closed design-authority gate for Media product presentation sources.
 * Explorer chrome is reported as host-only evidence and is never used as
 * product design authority. Candidate mappings are not PDP-2 acceptance.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PATHS = Object.freeze({
  style: ".product-experience/pdp-2-design-interface-system/gui/style-authority.yaml",
  aliases: ".product-experience/pdp-2-design-interface-system/media-token-aliases.yaml",
  semanticBindings: ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml",
  templates: ".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml",
  layout: ".product-experience/pdp-2-design-interface-system/gui/layout.yaml",
  components: ".product-experience/pdp-2-design-interface-system/component-contracts.yaml",
  states: ".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml",
  screens: ".product-experience/pdp-3-product-experience/screen-contracts",
  productSources: [
    "libs/audio-video-ui/src",
    "modules/intelligence/ai-voice/libs/ai-voice-ui-react/src",
  ],
  explorerFixtureSource: "apps/media-experience-explorer/src",
});

const read = (root, path) => {
  const file = join(root, path);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
};
const filesUnder = (root, directory) => {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const path = join(absolute, entry.name);
    return entry.isDirectory() ? filesUnder(root, relative(root, path)) : [path];
  });
};
const lineAt = (source, offset) => source.slice(0, offset).split("\n").length;
const scalar = (source, key) => source?.match(new RegExp(`^${key}:[ \\t]*([^\\r\\n#]+)`, "mu"))?.[1]?.trim() ?? null;
/** Read a child scalar only within the named top-level YAML authority section. */
const sectionScalar = (source, section, key) => {
  if (!source) return null;
  const start = new RegExp(`^${section}:\\s*$`, 'm').exec(source);
  if (!start) return null;
  const remainder = source.slice(start.index + start[0].length);
  const nextTopLevel = remainder.search(/^[A-Za-z][A-Za-z0-9_-]*:\s*/m);
  const body = nextTopLevel >= 0 ? remainder.slice(0, nextTopLevel) : remainder;
  return body.match(new RegExp(`^  ${key}:\\s*([^\\r\\n#]+)`, 'm'))?.[1]?.trim() ?? null;
};
const listIds = (source, key) => [...(source?.matchAll(new RegExp(`^\\s*- ${key}:\\s*([^\\r\\n#]+)`, "gmu")) ?? [])].map((match) => match[1].trim());

/** Analyze a repository root. Findings are observations, never acceptance. */
export function analyzeDesignConformance(root = DEFAULT_ROOT) {
  const findings = [];
  const blockers = [];
  const add = (kind, path, line, detail, disposition = "unexplained", rootCauseKey = `${kind}:${path}`) => findings.push({ kind, path, line, detail, disposition, rootCauseKey });
  const block = (detail) => blockers.push(detail);
  const style = read(root, PATHS.style);
  const aliases = read(root, PATHS.aliases);
  const semanticBindings = read(root, PATHS.semanticBindings);
  const templateCatalog = read(root, PATHS.templates);
  const layout = read(root, PATHS.layout);
  const componentContracts = read(root, PATHS.components);
  const stateGrammar = read(root, PATHS.states);

  for (const [path, value] of [[PATHS.style, style], [PATHS.aliases, aliases], [PATHS.semanticBindings, semanticBindings], [PATHS.templates, templateCatalog], [PATHS.layout, layout], [PATHS.components, componentContracts], [PATHS.states, stateGrammar]]) {
    if (value === null) block(`required PDP-2 authority source is missing: ${path}`);
  }

  if (style) {
    if (scalar(style, "scopeStatus") !== "ACCEPTED") block(`PDP-2 style authority is not accepted (scopeStatus=${scalar(style, "scopeStatus") ?? "missing"})`);
    if (scalar(style, "authority") !== PATHS.aliases
      || sectionScalar(style, "currentProjection", "semanticAuthority") !== PATHS.semanticBindings) {
      block("style authority must reference canonical Media aliases and component binding sources");
    }
    const sharedStatus = sectionScalar(style, "sharedBinding", "status");
    if (!["VERIFIED", "CURRENT"].includes(sharedStatus)) {
      block(`Shared package binding is unresolved (status=${sharedStatus ?? "missing"})`);
    }
    const conformanceStatus = sectionScalar(style, "conformance", "status");
    if (!["VERIFIED", "CURRENT"].includes(conformanceStatus)) {
      block(`PDP-2 conformance review is not verified (status=${conformanceStatus ?? "missing"})`);
    }
  }
  if (aliases && !/^status:\s*accepted\b/imu.test(aliases)) block(`semantic token aliases are not accepted (status=${scalar(aliases, "status") ?? "missing"})`);
  const semanticBindingStatus = scalar(semanticBindings, "status");
  if (semanticBindings && !/^(?:verified|current|accepted)$/iu.test(semanticBindingStatus ?? "")) {
    block(`Shared component bindings are unresolved (status=${semanticBindingStatus ?? "missing"})`);
  }
  if (templateCatalog && !/^scopeStatus:\s*accepted\b/imu.test(templateCatalog)) block(`template catalog is proposal/pending review, not accepted composition authority (scopeStatus=${scalar(templateCatalog, "scopeStatus") ?? "missing"})`);
  if (layout && !/^\s*status:\s*accepted\b/imu.test(layout)) block("layout rules are proposal/pending review, not accepted layout authority");

  const acceptedExtensions = [".css", ".scss", ".sass", ".tsx", ".jsx", ".ts", ".js"];
  const productSourceFiles = PATHS.productSources.flatMap((directory) => filesUnder(root, directory))
    .filter((file) => acceptedExtensions.includes(extname(file)));
  const explorerFixtureFiles = filesUnder(root, PATHS.explorerFixtureSource)
    .filter((file) => acceptedExtensions.includes(extname(file)));
  const sourceFiles = [...productSourceFiles, ...explorerFixtureFiles];
  const productSourceContent = productSourceFiles.map((file) => ({ path: relative(root, file), content: readFileSync(file, "utf8"), scope: "product" }));
  const fixtureSourceContent = explorerFixtureFiles.map((file) => ({ path: relative(root, file), content: readFileSync(file, "utf8"), scope: "explorer-fixture" }));
  const sourceContent = [...productSourceContent, ...fixtureSourceContent];
  const cssFiles = sourceContent.filter(({ path }) => [".css", ".scss", ".sass"].includes(extname(path)));
  const productCssFiles = cssFiles.filter(({ scope }) => scope === "product");
  const explorerFixtureCssFiles = cssFiles.filter(({ scope }) => scope === "explorer-fixture");
  const css = productCssFiles.map(({ content }) => content).join("\n");
  const aliasIds = new Set(listIds(aliases, "id"));
  const aliasCssVariables = new Set([...(aliases?.matchAll(/^\s*cssVariable:\s*(--[a-z][a-z0-9-]*)\s*$/gimu) ?? [])].map((match) => match[1]));
  const tokenVars = new Set([...css.matchAll(/(--[a-z][a-z0-9-]*)\s*:/giu)].map((match) => match[1]));
  const declaredTokenRefs = new Set([...css.matchAll(/var\((--[a-z][a-z0-9-]*)/giu)].map((match) => match[1]));
  const explorerFixturePath = style?.match(/^\s*explorerFixtureSource:\s*([^\s#]+)/mu)?.[1];
  const documentedFixtureException = Boolean(
    style && explorerFixturePath === `${PATHS.explorerFixtureSource}/styles.css` &&
    /^\s*explorerFixtureSemanticAuthority:\s*false\s*$/mu.test(style) &&
    /Raw values in the Explorer fixture stylesheet remain Explorer-owned/u.test(style),
  );

  const colorLiteralPattern = /#[\da-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b(?:black|white|red|blue|green|gray|grey|orange|purple|transparent)\b/gimu;
  const colorPropertyPattern = /(?:^|[;{\s])(?:color|background(?:-color)?|border(?:-color)?|outline(?:-color)?|fill|stroke)\s*:\s*([^;{}]+)/gimu;
  const customPropertyPattern = /(?:^|[;{\s])(--[a-z][a-z0-9-]*)\s*:\s*([^;{}]+)/gimu;
  for (const { path, content, scope } of cssFiles) {
    // Scan values for both ordinary color-bearing declarations and custom
    // properties. Custom properties can carry raw colors just as directly as
    // `color:`/`background:`. The Explorer stylesheet is reported separately
    // because its authority record explicitly excludes product meaning.
    for (const declarationPattern of [colorPropertyPattern, customPropertyPattern]) {
      for (const declaration of content.matchAll(declarationPattern)) {
        const value = declaration[declaration.length - 1];
        const valueOffset = declaration.index + declaration[0].lastIndexOf(value);
        for (const color of value.matchAll(colorLiteralPattern)) {
          const offset = valueOffset + color.index;
          const disposition = documentedFixtureException && scope === "explorer-fixture" && path === explorerFixturePath
            ? "explorer-chrome-or-fixture-only-not-product-authority"
            : "unexplained";
          const property = declaration[1]?.startsWith("--") ? `custom:${declaration[1]}` : "declaration";
          add("literal-color", path, lineAt(content, offset), `${color[0]} is directly authored in ${declaration[1]?.startsWith("--") ? `custom property ${declaration[1]}` : "CSS"}`, disposition, `${path}:literal-color:${property}`);
        }
      }
    }
  }
  for (const variable of declaredTokenRefs) {
    if (!tokenVars.has(variable)) add("unknown-token-provenance", productCssFiles[0]?.path ?? PATHS.productSources[0], null, `${variable} is referenced but has no local declaration or verified alias binding`, "unexplained", `unknown-token:${variable}`);
  }
  for (const variable of tokenVars) {
    if (!aliasCssVariables.has(variable)) add("unknown-token-provenance", productCssFiles[0]?.path ?? PATHS.productSources[0], null, `${variable} is locally defined but is not explicitly mapped from a PDP-2 semantic alias`, "unexplained", `unknown-token:${variable}`);
  }
  if (aliases) {
    for (const [index, line] of aliases.split("\n").entries()) {
      if (/^\s*sharedTokenRef:/u.test(line)) {
        const tokenRef = line.split(":").slice(1).join(":").trim();
        if (!tokenRef || !tokenRef.includes("@ghatana/tokens/semantic-roles#")) add("unknown-token-provenance", PATHS.aliases, index + 1, `alias has unsupported or missing public token provenance: ${tokenRef || "empty"}`);
      }
    }
  }
  if (tokenVars.size && aliasIds.size === 0) add("unknown-token-provenance", productCssFiles[0]?.path ?? PATHS.productSources[0], null, "local CSS custom properties exist but no semantic alias registry is available");

  // Product screen exports and renderer adapters are governed by their
  // dedicated PDP-3/host contracts. Reusable component implementations need
  // exact componentRef-to-export bindings in the semantic binding registry.
  const registeredComponentNames = new Set(listIds(componentContracts, "id").map((id) => id.split(".").at(-1).replace(/-([a-z])/gu, (_, c) => c.toUpperCase())));
  const exportMap = read(root, ".product-experience/executable-representation/export-map.yaml") ?? "";
  const publicExportBlocks = exportMap.split(/(?=^  - subpath:)/mu).slice(1);
  for (const block of publicExportBlocks) {
    if (!/^\s+layer:\s*screen-composition\s*$/mu.test(block)) continue;
    const names = block.match(/^\s+publicNames:\s*\[([^\]]*)\]/mu)?.[1] ?? "";
    for (const name of names.split(",").map((value) => value.trim()).filter(Boolean)) registeredComponentNames.add(name);
  }
  const rendererAdapters = exportMap.split(/(?=^rendererAdapters:)/mu).at(-1) ?? "";
  for (const match of rendererAdapters.matchAll(/^\s+exportName:\s*([A-Z][A-Za-z0-9_]*)\s*$/gmu)) registeredComponentNames.add(match[1]);
  const semanticBindingSource = semanticBindings ?? "";
  const componentIdSet = new Set(listIds(componentContracts, "id"));
  for (const block of semanticBindingSource.split(/(?=^  - )/mu).slice(1)) {
    const exportName = block.match(/^\s+implementationExport:\s*([A-Z][A-Za-z0-9_]*)\s*$/mu)?.[1];
    const componentRefs = [...block.matchAll(/\b(media\.component\.[A-Za-z0-9._-]+)/gu)].map((match) => match[1]);
    const sourcePath = block.match(/^\s+(?:implementationCandidate|externalComponentCandidate):\s*([^\s#]+)/mu)?.[1];
    if (!exportName || !sourcePath || !existsSync(join(root, sourcePath))) continue;
    if (componentRefs.some((componentRef) => componentIdSet.has(componentRef))) registeredComponentNames.add(exportName);
  }
  for (const { path, content } of productSourceContent.filter(({ path }) => /\.(?:tsx|jsx|ts|js)$/u.test(path))) {
    for (const match of content.matchAll(/(?:function\s+([A-Z][A-Za-z0-9_]*)\s*\(|const\s+([A-Z][A-Za-z0-9_]*)\s*=\s*(?:\([^)]*\)\s*=>|function\s*\())/gu)) {
      const name = match[1] ?? match[2];
      if (!registeredComponentNames.has(name)) add("unregistered-local-component", path, lineAt(content, match.index), `${name} has a product source implementation but no exact PDP-2 component, PDP-3 screen, or renderer-adapter binding`, "unexplained", `${path}:component:${name}`);
    }
  }

  // React styling is also source-visible even when a package keeps it in class
  // strings rather than a stylesheet. Treat palette utilities and raw values
  // as candidate design findings, and group repeats by source token.
  const paletteUtilityPattern = /\b(?:bg|text|border|ring|outline|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:\d{2,3})(?:\/\d{1,3})?\b/giu;
  const sourceColorPattern = /#[\da-f]{3,8}\b/giu;
  for (const { path, content } of productSourceContent.filter(({ path }) => /\.(?:tsx|jsx|ts|js)$/u.test(path))) {
    const code = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const match of code.matchAll(paletteUtilityPattern)) {
      add("unregistered-palette-utility", path, lineAt(code, match.index), `${match[0]} is a local palette class without a verified Shared semantic binding`, "unexplained", `${path}:palette:${match[0]}`);
    }
    for (const match of code.matchAll(sourceColorPattern)) {
      const line = code.slice(0, match.index).split("\n").at(-1) ?? "";
      if (!/(?:className|(?:fill|stroke)?Color|color\s*=|fillStyle|strokeStyle|backgroundColor)/iu.test(line)) continue;
      add("literal-color", path, lineAt(code, match.index), `${match[0]} is directly authored in a product presentation source`, "unexplained", `${path}:literal-color:${match[0].toLowerCase()}`);
    }
  }

  const templateIds = new Set(listIds(templateCatalog, "id"));
  const screenDir = join(root, PATHS.screens);
  const screenFiles = existsSync(screenDir) ? readdirSync(screenDir).filter((name) => name.endsWith(".yaml") && name !== "artifact-verification-job-family.yaml") : [];
  if (screenFiles.length === 0) block(`screen-contract inventory is missing or empty: ${PATHS.screens}`);
  for (const file of screenFiles) {
    const path = `${PATHS.screens}/${file}`;
    const content = read(root, path);
    const templateRef = content?.match(/^templateId:\s*([^\r\n#]+)/mu)?.[1]?.trim();
    if (!templateRef || /^(?:null|~|TBD|pending)$/iu.test(templateRef)) add("missing-template-binding", path, null, "screen has no concrete templateId");
    else if (!templateIds.has(templateRef)) add("missing-template-binding", path, null, `template ${templateRef} is not in the PDP-2 template catalog`);
    const layoutLine = content?.match(/^layoutIds:\s*(.*)$/mu)?.[1]?.trim() ?? "";
    const layoutRefs = [...layoutLine.matchAll(/([a-z][a-z0-9]*(?:[.-][a-z0-9]+)+)/giu)].map((match) => match[1]);
    if (!layoutRefs.length) add("missing-layout-binding", path, null, "screen has no concrete layoutIds");
    else for (const layoutRef of layoutRefs) if (!layout?.includes(layoutRef)) add("missing-layout-binding", path, null, `layout ${layoutRef} is not described by the PDP-2 layout authority`);
  }
  if (templateCatalog && templateIds.size === 0) add("missing-template-catalog", PATHS.templates, null, "template catalog contains no template identifiers");
  if (!layout || !/^layoutRules:/mu.test(layout)) add("missing-layout-authority", PATHS.layout, null, "PDP-2 layout rules are absent");

  // State-like visual selectors must name a state in the semantic grammar or
  // an explicitly registered semantic alias; generic interaction states do
  // not become product lifecycle states by CSS naming alone.
  const stateRefs = new Set(listIds(stateGrammar, "stateRef").map((value) => value.split(".").at(-1).toLowerCase().replace(/_/gu, "-")));
  const genericUiStates = new Set(["selected", "current", "complete", "open", "closed", "disabled", "active", "expanded", "collapsed", "error", "caution"]);
  for (const { path, content } of productCssFiles) {
    for (const match of content.matchAll(/\.((?:is|has)-([a-z][a-z0-9-]*))(?=[\s.:,#>{+~])/giu)) {
      const state = match[2].toLowerCase();
      if (!genericUiStates.has(state) && !stateRefs.has(state)) add("invalid-semantic-state-styling", path, lineAt(content, match.index), `${match[1]} has no state reference in the PDP-2 semantic-state grammar`, "unexplained", `${path}:state:${state}`);
    }
  }
  // One-off interactive CSS requires an explicit registered pattern/component
  // owner. Keep source observations separate from the unresolved authority.
  const componentIds = new Set(listIds(componentContracts, "id"));
  const patternCatalog = read(root, ".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml");
  const patternIds = new Set(listIds(patternCatalog, "id"));
  const kebab = (value) => value.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").toLowerCase();
  const registeredNames = new Set([
    ...[...componentIds, ...patternIds].map((id) => id.split(".").at(-1).replace(/-([a-z])/gu, (_, c) => c.toUpperCase()).toLowerCase()),
    ...[...registeredComponentNames].map(kebab),
  ]);
  for (const { path, content } of productCssFiles) {
    for (const match of content.matchAll(/([^{}]+):(hover|active|focus|focus-visible)\s*\{/giu)) {
      const selector = match[1].trim();
      const names = [...selector.matchAll(/\.([a-z][a-z0-9-]*)/giu)].map((item) => item[1].toLowerCase());
      if (names.length && !names.some((name) => registeredNames.has(name))) add("one-off-interaction-behavior", path, lineAt(content, match.index), `${selector}:${match[2]} has no registered component/pattern binding`, "unexplained", `${path}:interaction:${selector}`);
    }
  }
  if (!patternCatalog) block("PDP-2 interaction pattern catalog is missing; one-off behavior cannot be reconciled");
  if (!componentContracts || !stateGrammar) block("semantic styling cannot be accepted without component and state authority");

  // Explorer-only CSS observations remain visible for cleanup but cannot add
  // product blockers because the style-authority source excludes that tree.
  const unexplained = findings.filter(({ disposition }) => disposition === "unexplained");
  if (unexplained.length) block(`${unexplained.length} source-observable design-authority finding(s) are unexplained`);
  const rootCauseCount = new Set(unexplained.map((item) => item.rootCauseKey)).size;
  return { ok: blockers.length === 0 && unexplained.length === 0, findings, blockers, summary: {
    sourceFiles: sourceFiles.length,
    productSourceFiles: productSourceFiles.length,
    explorerFixtureFiles: explorerFixtureFiles.length,
    cssFiles: cssFiles.length,
    productCssFiles: productCssFiles.length,
    explorerFixtureCssFiles: explorerFixtureCssFiles.length,
    screenContracts: screenFiles.length,
    literalColors: findings.filter((item) => item.kind === "literal-color").length,
    productLiteralColors: findings.filter((item) => item.kind === "literal-color" && item.disposition === "unexplained").length,
    explorerFixtureObservations: findings.filter((item) => item.disposition === "explorer-chrome-or-fixture-only-not-product-authority").length,
    unexplained: unexplained.length,
    unexplainedRootCauses: rootCauseCount,
  } };
}

function main() {
  const result = analyzeDesignConformance();
  console.log(`Media design conformance ${result.ok ? "passed" : "BLOCKED"}`);
  console.log(`  scanned ${result.summary.productSourceFiles} product source files and ${result.summary.explorerFixtureFiles} Explorer fixture files (${result.summary.productCssFiles} product stylesheets; ${result.summary.explorerFixtureCssFiles} fixture stylesheets), ${result.summary.screenContracts} canonical screen contracts`);
  console.log(`  ${result.summary.productLiteralColors} product literal color(s), ${result.summary.explorerFixtureObservations} fixture-only observations, ${result.summary.unexplained} unexplained findings across ${result.summary.unexplainedRootCauses} root causes`);
  const byKind = new Map();
  for (const item of result.findings) byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item]);
  for (const [kind, items] of byKind) {
    console.log(`  FINDING [${kind}] ${items.length}`);
    for (const item of items.slice(0, 3)) console.log(`    ${item.path}${item.line ? `:${item.line}` : ""} — ${item.detail} (${item.disposition})`);
    if (items.length > 3) console.log(`    … ${items.length - 3} additional source observation(s)`);
  }
  for (const blocker of result.blockers) console.error(`  BLOCKER ${blocker}`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
