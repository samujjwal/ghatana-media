#!/usr/bin/env node
/**
 * Fail-closed, source-observable design-authority gate for the Media Explorer.
 * This gate reports implementation observations separately from accepted PDP-2
 * authority. A proposal, local fixture exception, or source snapshot is not an
 * accepted Shared binding or proof of visual conformance.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PATHS = Object.freeze({
  style: ".product-experience/pdp-2-design-interface-system/gui/style-authority.yaml",
  aliases: ".product-experience/pdp-2-design-interface-system/media-token-aliases.yaml",
  templates: ".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml",
  layout: ".product-experience/pdp-2-design-interface-system/gui/layout.yaml",
  components: ".product-experience/pdp-2-design-interface-system/component-contracts.yaml",
  states: ".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml",
  screens: ".product-experience/pdp-3-product-experience/screen-contracts",
  source: "apps/media-experience-explorer/src",
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
const listIds = (source, key) => [...(source?.matchAll(new RegExp(`^\\s*- ${key}:\\s*([^\\r\\n#]+)`, "gmu")) ?? [])].map((match) => match[1].trim());

/** Analyze a repository root. Findings are observations, never acceptance. */
export function analyzeDesignConformance(root = DEFAULT_ROOT) {
  const findings = [];
  const blockers = [];
  const add = (kind, path, line, detail, disposition = "unexplained") => findings.push({ kind, path, line, detail, disposition });
  const block = (detail) => blockers.push(detail);
  const style = read(root, PATHS.style);
  const aliases = read(root, PATHS.aliases);
  const templateCatalog = read(root, PATHS.templates);
  const layout = read(root, PATHS.layout);
  const componentContracts = read(root, PATHS.components);
  const stateGrammar = read(root, PATHS.states);

  for (const [path, value] of [[PATHS.style, style], [PATHS.aliases, aliases], [PATHS.templates, templateCatalog], [PATHS.layout, layout], [PATHS.components, componentContracts], [PATHS.states, stateGrammar]]) {
    if (value === null) block(`required PDP-2 authority source is missing: ${path}`);
  }

  if (style) {
    if (scalar(style, "scopeStatus") !== "ACCEPTED") block(`PDP-2 style authority is not accepted (scopeStatus=${scalar(style, "scopeStatus") ?? "missing"})`);
    if (scalar(style, "semanticAuthority") !== "true") block("style authority does not explicitly grant accepted semantic authority");
    if (!/^\s*status:\s*(?:VERIFIED|CURRENT)$/mu.test(style)) block(`Shared package binding is unresolved (status=${style.match(/^\s*status:\s*(.+)$/mu)?.[1]?.trim() ?? "missing"})`);
    if (/status:\s*NOT_RUN\b/u.test(style)) block("PDP-2 conformance review is not run");
  }
  if (aliases && !/^status:\s*accepted\b/imu.test(aliases)) block(`semantic token aliases are not accepted (status=${scalar(aliases, "status") ?? "missing"})`);
  if (templateCatalog && !/^scopeStatus:\s*accepted\b/imu.test(templateCatalog)) block(`template catalog is proposal/pending review, not accepted composition authority (scopeStatus=${scalar(templateCatalog, "scopeStatus") ?? "missing"})`);
  if (layout && !/^\s*status:\s*accepted\b/imu.test(layout)) block("layout rules are proposal/pending review, not accepted layout authority");

  const sourceFiles = filesUnder(root, PATHS.source).filter((file) => [".css", ".scss", ".sass", ".tsx", ".jsx", ".ts", ".js"].includes(extname(file)));
  const sourceContent = sourceFiles.map((file) => ({ path: relative(root, file), content: readFileSync(file, "utf8") }));
  const cssFiles = sourceContent.filter(({ path }) => [".css", ".scss", ".sass"].includes(extname(path)));
  const css = cssFiles.map(({ content }) => content).join("\n");
  const aliasIds = new Set(listIds(aliases, "id"));
  const aliasCssVariables = new Set([...(aliases?.matchAll(/^\s*cssVariable:\s*(--[a-z][a-z0-9-]*)\s*$/gimu) ?? [])].map((match) => match[1]));
  const tokenVars = new Set([...css.matchAll(/(--[a-z][a-z0-9-]*)\s*:/giu)].map((match) => match[1]));
  const declaredTokenRefs = new Set([...css.matchAll(/var\((--[a-z][a-z0-9-]*)/giu)].map((match) => match[1]));
  const documentedFixtureException = Boolean(
    style && scalar(style, "currentProjection") === null &&
    /currentProjection:\s*\n(?:[^\n]*\n){0,8}\s*status:\s*LOCAL_ONLY/u.test(style) &&
    /Raw values in the local stylesheet are explicit projection exceptions/u.test(style),
  );

  const colorLiteralPattern = /#[\da-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b(?:black|white|red|blue|green|gray|grey|orange|purple|transparent)\b/gimu;
  const colorPropertyPattern = /(?:^|[;{\s])(?:color|background(?:-color)?|border(?:-color)?|outline(?:-color)?|fill|stroke)\s*:\s*([^;{}]+)/gimu;
  const customPropertyPattern = /(?:^|[;{\s])(--[a-z][a-z0-9-]*)\s*:\s*([^;{}]+)/gimu;
  for (const { path, content } of cssFiles) {
    // Scan values for both ordinary color-bearing declarations and custom
    // properties. Custom properties can carry raw colors just as directly as
    // `color:`/`background:`; they inherit only the documented exception that
    // explicitly names this local-only Explorer projection.
    for (const declarationPattern of [colorPropertyPattern, customPropertyPattern]) {
      for (const declaration of content.matchAll(declarationPattern)) {
        const value = declaration[declaration.length - 1];
        const valueOffset = declaration.index + declaration[0].lastIndexOf(value);
        for (const color of value.matchAll(colorLiteralPattern)) {
          const offset = valueOffset + color.index;
          const disposition = documentedFixtureException && path.endsWith("styles.css") ? "documented-local-fixture-exception-not-product-authority" : "unexplained";
          add("literal-color", path, lineAt(content, offset), `${color[0]} is directly authored in ${declaration[1]?.startsWith("--") ? `custom property ${declaration[1]}` : "CSS"}`, disposition);
        }
      }
    }
  }
  for (const variable of declaredTokenRefs) {
    if (!tokenVars.has(variable)) add("unknown-token-provenance", cssFiles[0]?.path ?? PATHS.source, null, `${variable} is referenced but has no local declaration or verified alias binding`);
  }
  for (const variable of tokenVars) {
    if (!aliasCssVariables.has(variable)) add("unknown-token-provenance", cssFiles[0]?.path ?? PATHS.source, null, `${variable} is locally defined but is not explicitly mapped from a PDP-2 semantic alias`);
  }
  if (aliases) {
    for (const [index, line] of aliases.split("\n").entries()) {
      if (/^\s*sharedTokenRef:/u.test(line)) {
        const tokenRef = line.split(":").slice(1).join(":").trim();
        if (!tokenRef || !tokenRef.includes("@ghatana/tokens/semantic-roles#")) add("unknown-token-provenance", PATHS.aliases, index + 1, `alias has unsupported or missing public token provenance: ${tokenRef || "empty"}`);
      }
    }
  }
  if (tokenVars.size && aliasIds.size === 0) add("unknown-token-provenance", cssFiles[0]?.path ?? PATHS.source, null, "local CSS custom properties exist but no semantic alias registry is available");

  // A local React component implementation is source-observable, but is only
  // registered when its exported name is explicitly listed by a contract.
  const registeredComponentNames = new Set(listIds(componentContracts, "id").map((id) => id.split(".").at(-1).replace(/-([a-z])/gu, (_, c) => c.toUpperCase())));
  for (const { path, content } of sourceContent.filter(({ path }) => /\.(?:tsx|jsx|ts|js)$/u.test(path))) {
    for (const match of content.matchAll(/(?:function\s+([A-Z][A-Za-z0-9_]*)\s*\(|const\s+([A-Z][A-Za-z0-9_]*)\s*=\s*(?:\([^)]*\)\s*=>|function\s*\())/gu)) {
      const name = match[1] ?? match[2];
      if (!registeredComponentNames.has(name)) add("unregistered-local-component", path, lineAt(content, match.index), `${name} has a local component implementation but no matching PDP-2 component contract`);
    }
  }

  const templateIds = new Set(listIds(templateCatalog, "id"));
  const screenDir = join(root, PATHS.screens);
  const screenFiles = existsSync(screenDir) ? readdirSync(screenDir).filter((name) => name.endsWith(".yaml")) : [];
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
  for (const { path, content } of cssFiles) {
    for (const match of content.matchAll(/\.((?:is|has)-([a-z][a-z0-9-]*))(?=[\s.:,#>{+~])/giu)) {
      const state = match[2].toLowerCase();
      if (!genericUiStates.has(state) && !stateRefs.has(state)) add("invalid-semantic-state-styling", path, lineAt(content, match.index), `${match[1]} has no state reference in the PDP-2 semantic-state grammar`);
    }
  }
  // One-off interactive CSS requires an explicit registered pattern/component
  // owner. Keep source observations separate from the unresolved authority.
  const componentIds = new Set(listIds(componentContracts, "id"));
  const patternCatalog = read(root, ".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml");
  const patternIds = new Set(listIds(patternCatalog, "id"));
  const registeredNames = new Set([...componentIds, ...patternIds].map((id) => id.split(".").at(-1).replace(/-([a-z])/gu, (_, c) => c.toUpperCase()).toLowerCase()));
  for (const { path, content } of cssFiles) {
    for (const match of content.matchAll(/([^{}]+):(hover|active|focus|focus-visible)\s*\{/giu)) {
      const selector = match[1].trim();
      const names = [...selector.matchAll(/\.([a-z][a-z0-9-]*)/giu)].map((item) => item[1].toLowerCase());
      if (names.length && !names.some((name) => registeredNames.has(name))) add("one-off-interaction-behavior", path, lineAt(content, match.index), `${selector}:${match[2]} has no registered component/pattern binding`);
    }
  }
  if (!patternCatalog) block("PDP-2 interaction pattern catalog is missing; one-off behavior cannot be reconciled");
  if (!componentContracts || !stateGrammar) block("semantic styling cannot be accepted without component and state authority");

  // A documented local fixture exception is retained as such, not promoted to
  // an accepted exemption. All source findings remain visible in the report.
  const unexplained = findings.filter(({ disposition }) => disposition !== "documented-local-fixture-exception-not-product-authority");
  if (findings.some(({ disposition }) => disposition === "documented-local-fixture-exception-not-product-authority")) {
    block("local-only fixture styling exception is documented, but still requires replacement/binding before product conformance");
  }
  if (unexplained.length) block(`${unexplained.length} source-observable design-authority finding(s) are unexplained`);
  return { ok: blockers.length === 0 && unexplained.length === 0, findings, blockers, summary: { sourceFiles: sourceFiles.length, cssFiles: cssFiles.length, screenContracts: screenFiles.length, literalColors: findings.filter((item) => item.kind === "literal-color").length, unexplained: unexplained.length, documentedFixtureExceptions: findings.filter((item) => item.disposition === "documented-local-fixture-exception-not-product-authority").length } };
}

function main() {
  const result = analyzeDesignConformance();
  console.log(`Media design conformance ${result.ok ? "passed" : "BLOCKED"}`);
  console.log(`  scanned ${result.summary.sourceFiles} source files (${result.summary.cssFiles} stylesheets), ${result.summary.screenContracts} screen contracts`);
  console.log(`  ${result.summary.literalColors} literal color(s), ${result.summary.documentedFixtureExceptions} documented local-fixture exception(s), ${result.summary.unexplained} unexplained finding(s)`);
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
