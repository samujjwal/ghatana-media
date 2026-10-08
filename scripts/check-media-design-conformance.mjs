#!/usr/bin/env node
/**
 * Fail-closed design-authority gate for Media product presentation sources.
 * Explorer chrome is reported as host-only evidence and is never used as
 * product design authority. Candidate mappings are not PDP-2 acceptance.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { parse: parseYaml } = createRequire(resolve(DEFAULT_ROOT, "../ghatana-tools/package.json"))("yaml");
const PATHS = Object.freeze({
  style: ".product-experience/pdp-2-design-interface-system/gui/style-authority.yaml",
  governance: ".product-experience/pdp-2-design-interface-system/design-governance.json",
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

const GOVERNANCE_GATES = Object.freeze({
  "style-semantics-source": { source: PATHS.style, field: "scopeStatus", sourceStatus: "MEDIA_OWNER_ACCEPTED", disposition: "RESOLVED_OWNER" },
  "shared-artifact-binding": { source: PATHS.style, field: "sharedBinding.status", sourceStatus: "EXTERNAL_PACKAGE_AND_OWNER_REVIEW_PENDING", disposition: "EXTERNAL_PENDING" },
  "conformance-and-specialist-review": { source: PATHS.style, field: "conformance.status", sourceStatus: "NOT_RUN", disposition: "INDEPENDENT_PENDING" },
  "semantic-token-aliases": { source: PATHS.aliases, field: "status", sourceStatus: "MEDIA_OWNER_ACCEPTED_INTENT_ONLY", disposition: "RESOLVED_OWNER" },
  "concrete-component-bindings": { source: PATHS.semanticBindings, field: "status", sourceStatus: "SOURCE_INCOMPLETE", disposition: "SOURCE_INCOMPLETE" },
  "template-catalog-admission": { source: PATHS.templates, field: "scopeStatus", sourceStatus: "MEDIA_OWNER_ACCEPTED", disposition: "RESOLVED_OWNER" },
  "layout-admission": { source: PATHS.layout, field: "scopeStatus", sourceStatus: "MEDIA_OWNER_ACCEPTED", disposition: "RESOLVED_OWNER" },
});

/** Validate definition source completeness without admitting any implementation. */
export function validateComponentDefinitionBindings(bindings, contracts, root = DEFAULT_ROOT) {
  const errors = [];
  const review = bindings?.definitionBindingReview;
  const records = bindings?.definitionBindings;
  const components = contracts?.components;
  if (!Array.isArray(records) || !Array.isArray(components)) return ["missing exact component definition population"];
  if (review?.componentDenominator !== components.length || components.length !== 31 || records.length !== components.length) errors.push("component definition denominator changed or incomplete");
  if (review?.authority !== "User-delegated Media owner decision" || review?.decisionRef !== ".product-experience/decision-log.md#PXD-047") errors.push("definition binding review lacks its exact owner decision");
  if (review?.implementationAdmission !== "NOT_ADMITTED" || review?.independentConformance !== "NOT_RUN") errors.push("definition review invents implementation or independent admission");
  const byId = new Map(components.map((component) => [component.id, component]));
  const reuseText = read(root, ".product-experience/pdp-2-design-interface-system/gui/reuse-audit.yaml");
  const reuse = new Map((reuseText ? parseYaml(reuseText).componentFamilyCrosswalk ?? [] : []).map((item) => [item.componentRef, item]));
  const ids = new Set();
  let publicContracts = 0;
  for (const record of records) {
    const component = byId.get(record.componentRef);
    if (!component || ids.has(record.componentRef)) { errors.push(`unknown or duplicate component definition: ${record.componentRef}`); continue; }
    ids.add(record.componentRef);
    if (record.contractRef !== `${PATHS.components}#${component.id}`) errors.push(`stale component contract: ${component.id}`);
    if (record.role !== (component.semanticRole ?? component.purpose) || !record.role) errors.push(`stale component role: ${component.id}`);
    for (const [field, sourceField] of [["anatomySource", "anatomy"], ["interactionSource", "keyboard"], ["accessibilitySource", "accessibility"]]) {
      if (record[field] !== `component-contracts.yaml#${component.id}.${sourceField}` || !component[sourceField]?.length) errors.push(`missing exact ${sourceField} definition: ${component.id}`);
    }
    if (record.implementationAdmission !== "NOT_ADMITTED" || typeof record.rationale !== "string" || record.rationale.length < 40) errors.push(`unqualified component disposition: ${component.id}`);
    if (record.disposition === "PUBLIC_COMPONENT_CONTRACT") {
      publicContracts++;
      const observed = reuse.get(component.id);
      if (!observed || record.publicExport !== observed.publicExport || JSON.stringify(record.publicExportEvidence) !== JSON.stringify(observed.publicExportEvidence)) errors.push(`stale public export identity: ${component.id}`);
      if (!record.publicExport || record.propsSourceRef !== component.propsSourceRef || JSON.stringify(record.requiredProps) !== JSON.stringify(component.requiredProps) || !Array.isArray(record.requiredProps)) errors.push(`stale public props binding: ${component.id}`);
      const [sourcePath, interfaceName] = (record.propsSourceRef ?? "").split("#");
      const source = sourcePath ? read(root, sourcePath) : null;
      const body = source?.match(new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`, "u"))?.[1];
      const actual = [...(body?.matchAll(/^\s*readonly\s+([A-Za-z_$][\w$]*)(\?)?\s*:/gmu) ?? [])].filter((field) => !field[2]).map((field) => field[1]).sort();
      if (!body || JSON.stringify(actual) !== JSON.stringify([...record.requiredProps].sort())) errors.push(`public prop source drift: ${component.id}`);
      const exportName = record.publicExport?.split("#")[1];
      if (!exportName || !source?.includes(`export function ${exportName}(`)) errors.push(`public component export source drift: ${component.id}`);
      if (!Array.isArray(record.publicExportEvidence) || !record.publicExportEvidence.length || !exportName) errors.push(`missing public export evidence: ${component.id}`);
      else for (const ref of record.publicExportEvidence) {
        const evidence = read(root, ref.split("#")[0]);
        if (!evidence) errors.push(`missing public export source: ${ref}`);
      }
    } else if (record.disposition === "CONTRACT_ONLY") {
      if (record.publicExport || record.requiredProps || record.propsSourceRef) errors.push(`contract-only component invents public props/export: ${component.id}`);
    } else errors.push(`unrecognized component definition disposition: ${component.id}`);
  }
  if (publicContracts !== 3) errors.push("observed public component subset changed without source review");
  for (const id of byId.keys()) if (!ids.has(id)) errors.push(`unbound component definition: ${id}`);
  return errors;
}

function sourceStatusValue(source, field) {
  const [section, key] = field.split(".");
  return key ? sectionScalar(source, section, key) : scalar(source, section);
}

function validateDesignGovernance(governance, sourceByPath, root) {
  const errors = [];
  const records = governance?.gates;
  if (!Array.isArray(records)) return ["canonical design-governance registry has no gates array"];
  if (governance.schemaVersion !== "media.pdp-2.design-governance.v1") errors.push("canonical design-governance registry has stale schemaVersion");
  if (governance.authority !== "Media-owned design decisions only; Shared package, conformance, specialist visualization, and accessibility acceptance remain separately gated") {
    errors.push("canonical design-governance registry has stale authority boundary");
  }
  const ids = records.map((record) => record.id);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  for (const id of duplicates) errors.push(`duplicate design-governance gate record: ${id}`);
  if (governance.gateDenominator !== Object.keys(GOVERNANCE_GATES).length) {
    errors.push(`design-governance gate denominator must be ${Object.keys(GOVERNANCE_GATES).length}`);
  }
  for (const id of Object.keys(GOVERNANCE_GATES)) if (!ids.includes(id)) errors.push(`missing design-governance gate: ${id}`);
  for (const id of ids) if (!Object.hasOwn(GOVERNANCE_GATES, id)) errors.push(`stale design-governance gate: ${id}`);

  for (const record of records) {
    let expected = GOVERNANCE_GATES[record.id];
    if (record.id === "concrete-component-bindings" && record.sourceStatus === "MEDIA_OWNER_ACCEPTED_DEFINITION_BINDINGS") {
      expected = { ...expected, sourceStatus: "MEDIA_OWNER_ACCEPTED_DEFINITION_BINDINGS", disposition: "RESOLVED_OWNER" };
      try {
        const bindings = parseYaml(sourceByPath[PATHS.semanticBindings]);
        const contracts = parseYaml(read(root, PATHS.components));
        errors.push(...validateComponentDefinitionBindings(bindings, contracts, root));
      } catch (error) { errors.push(`invalid component definition source: ${error.message}`); }
    }
    if (!expected) continue;
    if (record.source !== expected.source) errors.push(`${record.id}: stale governance source path`);
    if (record.sourceField !== expected.field) errors.push(`${record.id}: stale governance source field`);
    if (record.disposition !== expected.disposition) errors.push(`${record.id}: invalid or stale governance disposition`);
    const actual = sourceStatusValue(sourceByPath[expected.source], expected.field);
    if (record.sourceStatus !== expected.sourceStatus) errors.push(`${record.id}: invalid or stale approval status`);
    if (record.sourceStatus !== actual) errors.push(`${record.id}: stale source approval status (recorded=${record.sourceStatus ?? "missing"}; source=${actual ?? "missing"})`);
    if (expected.disposition === "RESOLVED_OWNER") {
      if (record.decision?.authority !== "User-delegated Media owner decision"
        || typeof record.decision?.rationale !== "string" || record.decision.rationale.length < 40
        || !Array.isArray(record.evidenceRefs) || record.evidenceRefs.length === 0) {
        errors.push(`${record.id}: Media owner disposition lacks decision rationale or source evidence`);
      }
      const evidence = record.evidenceRefs ?? [];
      if (new Set(evidence).size !== evidence.length) errors.push(`${record.id}: duplicate owner evidence reference`);
      for (const ref of evidence) {
        const sourcePath = ref.split("#", 1)[0];
        if (!sourcePath || !existsSync(join(root, sourcePath))) errors.push(`${record.id}: stale owner evidence reference ${ref}`);
      }
    } else if (record.decision) {
      errors.push(`${record.id}: pending gate must not contain a Media approval decision`);
    }
  }
  return errors;
}

/** Analyze a repository root. Findings are observations, never acceptance. */
export function analyzeDesignConformance(root = DEFAULT_ROOT) {
  const findings = [];
  const blockers = [];
  const add = (kind, path, line, detail, disposition = "unexplained", rootCauseKey = `${kind}:${path}`) => findings.push({ kind, path, line, detail, disposition, rootCauseKey });
  const block = (detail) => blockers.push(detail);
  const style = read(root, PATHS.style);
  const governanceText = read(root, PATHS.governance);
  let governance = null;
  if (governanceText) {
    try { governance = JSON.parse(governanceText); } catch (error) { block(`canonical design-governance registry is invalid JSON: ${error.message}`); }
  }
  const aliases = read(root, PATHS.aliases);
  const semanticBindings = read(root, PATHS.semanticBindings);
  const templateCatalog = read(root, PATHS.templates);
  const layout = read(root, PATHS.layout);
  const componentContracts = read(root, PATHS.components);
  const stateGrammar = read(root, PATHS.states);

  for (const [path, value] of [[PATHS.style, style], [PATHS.governance, governanceText], [PATHS.aliases, aliases], [PATHS.semanticBindings, semanticBindings], [PATHS.templates, templateCatalog], [PATHS.layout, layout], [PATHS.components, componentContracts], [PATHS.states, stateGrammar]]) {
    if (value === null) block(`required PDP-2 authority source is missing: ${path}`);
  }

  const sourceByPath = {
    [PATHS.style]: style, [PATHS.aliases]: aliases, [PATHS.semanticBindings]: semanticBindings,
    [PATHS.templates]: templateCatalog, [PATHS.layout]: layout,
  };
  for (const error of validateDesignGovernance(governance, sourceByPath, root)) block(`design-governance: ${error}`);
  if (Array.isArray(governance?.gates)) {
    const pending = governance.gates.filter((gate) => gate.disposition !== "RESOLVED_OWNER");
    for (const gate of pending) block(`design-governance gate ${gate.id} remains ${gate.disposition}`);
  }

  if (style) {
    if (scalar(style, "authority") !== PATHS.aliases
      || sectionScalar(style, "currentProjection", "semanticAuthority") !== PATHS.semanticBindings) {
      block("style authority must reference canonical Media aliases and component binding sources");
    }
  }

  const acceptedExtensions = [".css", ".scss", ".sass", ".tsx", ".jsx", ".ts", ".js"];
  const productSourceFiles = PATHS.productSources.flatMap((directory) => filesUnder(root, directory))
    .filter((file) => acceptedExtensions.includes(extname(file)) && !/(?:\.test|\.spec)\.[^.]+$/u.test(file));
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
  const governanceGates = Array.isArray(governance?.gates) ? governance.gates : [];
  const openGates = governanceGates.filter((gate) => gate.disposition !== "RESOLVED_OWNER");
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
    governanceGateCount: governanceGates.length,
    resolvedOwnerGates: governanceGates.filter((gate) => gate.disposition === "RESOLVED_OWNER").length,
    openGovernanceGates: openGates.map((gate) => ({ id: gate.id, disposition: gate.disposition })),
  } };
}

function main() {
  const result = analyzeDesignConformance();
  console.log(`Media design conformance ${result.ok ? "passed" : "BLOCKED"}`);
  console.log(`  scanned ${result.summary.productSourceFiles} product source files and ${result.summary.explorerFixtureFiles} Explorer fixture files (${result.summary.productCssFiles} product stylesheets; ${result.summary.explorerFixtureCssFiles} fixture stylesheets), ${result.summary.screenContracts} canonical screen contracts`);
  console.log(`  design governance: ${result.summary.resolvedOwnerGates}/${result.summary.governanceGateCount} Media owner decisions resolved; ${result.summary.openGovernanceGates.length} external, independent, or source-incomplete gates remain open`);
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
