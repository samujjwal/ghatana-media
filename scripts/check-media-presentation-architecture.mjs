#!/usr/bin/env node
/** Deterministic source/admission checks for shared Media presentation boundaries. */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const walk = (dir) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
  });
};
const read = (path) => readFileSync(path, "utf8");
const slash = (path) => path.split(sep).join("/");
const rel = (path) => slash(relative(root, path));

function importsFrom(source) {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const found = [];
  const named = /\bimport\s+(?:type\s+)?\{([^}]+)\}\s+from\s+(['"])([^'"\n]+)\2/g;
  for (const match of code.matchAll(named)) {
    const names = match[1].split(",").map((item) => item.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    found.push({ specifier: match[3], names });
  }
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?(['"])([^'"\n]+)\1/g,
    /\bexport\s+[^'";]*?\s+from\s+(['"])([^'"\n]+)\1/g,
    /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
    /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) found.push({ specifier: match[2], names: [] });
  return [...new Map(found.map((item) => [`${item.specifier}\0${item.names.join(",")}`, item])).values()];
}

function yamlScalars(text) {
  // Read scalar and inline-list fields needed by admissions without pretending
  // to implement general YAML. Each admission file is expected to be one record.
  const result = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^\s*([A-Za-z][\w-]*):\s*(.*?)\s*$/);
    if (!match || match[2] === "|" || match[2] === ">-") continue;
    if (!match[2]) {
      const indent = line.match(/^\s*/)[0].length;
      const items = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        const item = lines[next].match(/^(\s*)-\s+(.*?)\s*$/);
        if (!item || item[1].length <= indent) break;
        items.push(item[2].replace(/^(['"])(.*)\1$/, "$2"));
      }
      if (items.length) result[match[1]] = items;
      continue;
    }
    const raw = match[2].replace(/\s+#.*$/, "");
    const val = raw.replace(/^(['"])(.*)\1$/, "$2");
    result[match[1]] = val.startsWith("[") && val.endsWith("]")
      ? val.slice(1, -1).split(",").map((item) => item.trim().replace(/^(['"])(.*)\1$/, "$2")).filter(Boolean)
      : val;
  }
  return result;
}

function readAdmissions(repoRoot) {
  const dir = join(repoRoot, ".product-experience/executable-representation/admissions");
  return walkYaml(dir).map((path) => ({ path: relFrom(repoRoot, path), ...yamlScalars(readFileSync(path, "utf8")) }));
}
function readExportMap(repoRoot) {
  const path = join(repoRoot, ".product-experience/executable-representation/export-map.yaml");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const rows = [];
  for (const block of text.split(/(?=^  - subpath:)/m).slice(1)) {
    const row = yamlScalars(block);
    if (row.subpath) rows.push({ subpath: row.subpath, publicNames: Array.isArray(row.publicNames) ? row.publicNames : [] });
  }
  return rows;
}
function walkYaml(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walkYaml(path) : entry.name.endsWith(".yaml") || entry.name.endsWith(".yml") ? [path] : [];
  });
}
function relFrom(repoRoot, path) { return slash(relative(repoRoot, path)); }

const isAdmitted = (record) => String(record.acceptanceState ?? record.status ?? "").toUpperCase() === "ADMITTED";
const isWeb = (record) => {
  const platforms = [record.platform, record.scope, ...(Array.isArray(record.platforms) ? record.platforms : [])]
    .filter(Boolean).join(" ").toUpperCase();
  const surfaces = Array.isArray(record.surfaceIds) ? record.surfaceIds : String(record.surfaceIds ?? "").split(/[ ,]+/);
  return platforms.includes("WEB") || surfaces.some((id) => id === "media.surface.web");
};
function exportIdentity(record, defaultPackage) {
  const declaration = String(record.publicExport ?? record.export ?? "");
  const hash = declaration.lastIndexOf("#");
  const colon = declaration.lastIndexOf("::");
  const splitAt = hash >= 0 ? hash : colon;
  const specifier = splitAt >= 0 ? declaration.slice(0, splitAt) : declaration;
  const exportName = (splitAt >= 0 ? declaration.slice(splitAt + (hash >= 0 ? 1 : 2)) : record.exportName ?? record.publicExportName ?? "").trim();
  const packageName = record.package ?? defaultPackage;
  const moduleSpecifier = specifier.startsWith(packageName) ? specifier : `${packageName}${specifier.startsWith(".") ? `/${specifier.slice(1)}` : ""}`;
  return { declaration, moduleSpecifier, exportName, packageName };
}
const importsExport = (imports, identity) => imports.some(({ specifier, names }) =>
  specifier === identity.moduleSpecifier && (!identity.exportName || names.includes(identity.exportName)));

/** Check explicit candidate design edges against the corresponding PDP-2 inventories. */
export function validateDesignChain(chain, inventories) {
  const issues = [];
  const check = (kind, values) => {
    const known = inventories[kind] ?? new Set();
    for (const value of values ?? []) if (!known.has(value)) issues.push(`${chain.screenRef ?? "screen"} ${kind} link does not resolve: ${value}`);
  };
  check("templates", chain.templateRefs);
  check("layouts", chain.layoutRefs);
  check("patterns", chain.patternRefs);
  check("components", chain.componentRefs);
  check("tokens", chain.tokenRefs);
  return issues;
}

function idsFrom(text, prefix) {
  return new Set([...text.matchAll(new RegExp(`^\\s*-?\\s*(?:id|componentRef):\\s*["']?(${prefix}[A-Za-z0-9._-]+)`, "gm"))].map((match) => match[1]));
}
function declaredRefs(text, key, pattern) {
  const values = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(new RegExp(`^(\\s*)${key}:\\s*(.*)$`));
    if (!match) continue;
    values.push(...(match[2].match(pattern) ?? []));
    const indent = match[1].length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const item = lines[j].match(/^(\s*)-\s+(.*)$/);
      if (item && item[1].length > indent) values.push(...(item[2].match(pattern) ?? []));
      else if (lines[j].trim() && lines[j].match(/^\s*/)[0].length <= indent) break;
    }
  }
  return [...new Set(values)];
}
function recordsById(text) {
  return text.split(/(?=^\s*- id:)/m).slice(1);
}

export function analyzeMediaPresentationArchitecture({ repoRoot = root, admissions = readAdmissions(repoRoot) } = {}) {
  const issues = [];
  const presentationRoot = join(repoRoot, "libs/audio-video-ui/src");
  const presentationFiles = walk(presentationRoot);
  const explorerRoot = join(repoRoot, "apps/media-experience-explorer/src");
  const explorerFiles = walk(explorerRoot);
  const productionRoot = join(repoRoot, "apps/web/src");
  const productionFiles = walk(productionRoot);
  const code = (files) => files.flatMap((path) => importsFrom(readFileSync(path, "utf8")).map((item) => ({ path, ...item })));

  for (const { path, specifier } of code(presentationFiles)) {
    if (specifier.includes("media-experience-explorer") || /(^|\/)apps\/media-experience-explorer\//.test(specifier))
      issues.push(`${rel(path)} imports Explorer implementation ${specifier}`);
    if (specifier.includes("media-experience-simulation") || /(^|\/)libs\/media-experience-simulation\//.test(specifier))
      issues.push(`${rel(path)} imports review/simulation infrastructure ${specifier}`);
  }
  for (const { path, specifier } of code(productionFiles)) {
    if (specifier.includes("media-experience-explorer") || /(^|\/)apps\/media-experience-explorer\//.test(specifier))
      issues.push(`${rel(path)} imports Explorer implementation ${specifier}`);
    if (/scenario[-_/]?fixtures|scenario[-_/]?catalog|media-experience-simulation/i.test(specifier))
      issues.push(`${rel(path)} imports review/scenario infrastructure ${specifier}`);
  }

  const uiPackagePath = join(repoRoot, "libs/audio-video-ui/package.json");
  const uiPackage = existsSync(uiPackagePath) ? JSON.parse(readFileSync(uiPackagePath, "utf8")) : {};
  const exportKeys = new Set(Object.keys(uiPackage.exports ?? {}));
  const packageName = uiPackage.name ?? "@audio-video/ui";
  const exportMap = readExportMap(repoRoot);
  const consumerFiles = walk(join(repoRoot, "apps")).concat(walk(join(repoRoot, "modules")))
    .filter((path) => !path.startsWith(presentationRoot));
  for (const { path, specifier } of code(consumerFiles)) {
    if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
      const subpath = specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
      if (!exportKeys.has(subpath)) issues.push(`${rel(path)} imports unexported UI package path ${specifier}`);
    }
    if (specifier.startsWith(".") && /(?:^|\/)libs\/audio-video-ui\/src\//.test(resolve(join(path, ".."), specifier)))
      issues.push(`${rel(path)} deep-imports private UI source ${specifier}`);
  }

  const admittedWeb = admissions.filter((record) => isAdmitted(record) && isWeb(record));
  const explorerImports = code(explorerFiles);
  const productionImports = code(productionFiles);
  for (const record of admittedWeb) {
    const identity = exportIdentity(record, packageName);
    if (!identity.declaration) {
      issues.push(`${record.representationId ?? record.path ?? "admitted Web record"} has no publicExport`);
      continue;
    }
    if (!importsExport(explorerImports, identity)) issues.push(`Explorer does not import admitted export identity ${identity.declaration}`);
    if (!importsExport(productionImports, identity)) issues.push(`Production Web does not import admitted export identity ${identity.declaration}`);
    if (identity.packageName === packageName) {
      const subpath = identity.moduleSpecifier === packageName ? "." : identity.moduleSpecifier.startsWith(`${packageName}/`) ? `.${identity.moduleSpecifier.slice(packageName.length)}` : null;
      if (!subpath || !exportKeys.has(subpath)) issues.push(`admitted export ${identity.declaration} is not a public export of ${packageName}`);
      if (exportMap && identity.exportName) {
        const row = exportMap.find((item) => item.subpath === subpath);
        if (!row || !row.publicNames.includes(identity.exportName))
          issues.push(`admitted export identity ${identity.declaration} is absent from executable-representation/export-map.yaml`);
      }
    }
  }

  const pdp2Files = walkYaml(join(repoRoot, ".product-experience/pdp-2-design-interface-system"));
  const pdp2Text = pdp2Files.map((path) => readFileSync(path, "utf8")).join("\n");
  const readPdp2 = (path) => existsSync(join(repoRoot, path)) ? readFileSync(join(repoRoot, path), "utf8") : "";
  const inventories = {
    templates: idsFrom(readPdp2(".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml"), "media.gui.template."),
    layouts: idsFrom(readPdp2(".product-experience/pdp-2-design-interface-system/gui/layout.yaml"), "media.gui.layout."),
    patterns: idsFrom(readPdp2(".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml"), "media.gui.pattern."),
    components: idsFrom(readPdp2(".product-experience/pdp-2-design-interface-system/component-contracts.yaml"), "media.component."),
    tokens: idsFrom(readPdp2(".product-experience/pdp-2-design-interface-system/media-token-aliases.yaml"), "media.token."),
  };
  const screenFiles = walkYaml(join(repoRoot, ".product-experience/pdp-3-product-experience/screen-contracts"));
  const candidateDesignIssues = [];
  const templateText = readPdp2(".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml");
  for (const block of recordsById(templateText)) {
    const templateRef = block.match(/^\s*- id:\s*([^\s#]+)/m)?.[1];
    const patternRefs = declaredRefs(block, "patterns", /media\.gui\.pattern\.[A-Za-z0-9._-]+/g);
    candidateDesignIssues.push(...validateDesignChain({ screenRef: templateRef, patternRefs }, inventories));
  }
  const patternText = readPdp2(".product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml");
  for (const block of recordsById(patternText)) {
    const patternRef = block.match(/^\s*- id:\s*([^\s#]+)/m)?.[1];
    const sourceRef = block.match(/^\s*sourceRef:\s*([^\s#]+)/m)?.[1];
    if (!sourceRef?.startsWith(".product-experience/")) continue;
    const [sourcePath, sourceId] = sourceRef.split("#");
    if (!existsSync(join(repoRoot, sourcePath))) candidateDesignIssues.push(`${patternRef} source record does not resolve: ${sourcePath}`);
    if (sourceId && sourceId.startsWith("media.component.") && !inventories.components.has(sourceId)) candidateDesignIssues.push(`${patternRef} component source link does not resolve: ${sourceId}`);
  }
  let screensWithDeclaredDesignLinks = 0;
  for (const path of screenFiles) {
    const source = readFileSync(path, "utf8");
    const templateRefs = declaredRefs(source, "templateRef", /media\.(?:gui\.)?template\.[A-Za-z0-9._-]+/g);
    const layoutRefs = [
      ...declaredRefs(source, "layoutRef", /media\.gui\.layout\.[A-Za-z0-9._-]+/g),
      ...declaredRefs(source, "layoutRefs", /media\.gui\.layout\.[A-Za-z0-9._-]+/g),
    ];
    const patternRefs = declaredRefs(source, "patternRefs", /media\.gui\.pattern\.[A-Za-z0-9._-]+/g);
    const componentRefs = declaredRefs(source, "componentRefs", /media\.component\.[A-Za-z0-9._-]+/g);
    const tokenRefs = declaredRefs(source, "tokenRefs", /media\.token\.[A-Za-z0-9._-]+/g);
    if (templateRefs.length || layoutRefs.length || patternRefs.length || componentRefs.length || tokenRefs.length) screensWithDeclaredDesignLinks += 1;
    const screenRef = source.match(/^screenId:\s*([^\s#]+)/m)?.[1] ?? relFrom(repoRoot, path);
    candidateDesignIssues.push(...validateDesignChain({ screenRef, templateRefs, layoutRefs, patternRefs, componentRefs, tokenRefs }, inventories));
  }
  const semanticBindingsPath = join(repoRoot, ".product-experience/pdp-2-design-interface-system/gui/semantic-component-bindings.yaml");
  if (existsSync(semanticBindingsPath)) {
    const source = readFileSync(semanticBindingsPath, "utf8");
    const boundComponents = new Set();
    for (const block of source.split(/(?=^  - componentRef:)/m).slice(1)) {
      const componentRef = block.match(/^  - componentRef:\s*([^\s#]+)/m)?.[1];
      if (componentRef) boundComponents.add(componentRef);
      const sourceRef = block.match(/^\s+source:\s*([^\s#]+)/m)?.[1];
      if (componentRef && !inventories.components.has(componentRef)) candidateDesignIssues.push(`semantic component binding component does not resolve: ${componentRef}`);
      if (sourceRef && !existsSync(join(repoRoot, sourceRef))) candidateDesignIssues.push(`semantic component binding source file does not exist: ${sourceRef}`);
      const tokenRefs = [...block.matchAll(/\b(media\.token\.[A-Za-z0-9._-]+)/g)].map((match) => match[1]);
      for (const token of tokenRefs) if (!inventories.tokens.has(token)) candidateDesignIssues.push(`semantic component binding token does not resolve: ${token}`);
    }
    for (const path of screenFiles) {
      const screen = readFileSync(path, "utf8");
      const screenRef = screen.match(/^screenId:\s*([^\s#]+)/m)?.[1] ?? relFrom(repoRoot, path);
      for (const componentRef of declaredRefs(screen, "componentRefs", /media\.component\.[A-Za-z0-9._-]+/g))
        if (!boundComponents.has(componentRef)) candidateDesignIssues.push(`${screenRef} component has no semantic-component-bindings entry: ${componentRef}`);
    }
  }
  for (const record of admittedWeb) {
    const provenance = record.designProvenance ?? record.designProvenanceRefs ?? record.designRefs ?? record.boundPdp2Records;
    if (provenance === undefined) continue;
    const refs = Array.isArray(provenance) ? provenance : String(provenance).split(/[ ,]+/).filter(Boolean);
    for (const ref of refs) if (!pdp2Text.includes(ref)) issues.push(`${record.representationId ?? record.path} design provenance reference not found in PDP-2: ${ref}`);
  }

  return {
    ok: issues.length === 0,
    issues,
    summary: {
      presentationSourceFiles: presentationFiles.length,
      productionSourceFiles: productionFiles.length,
      explorerSourceFiles: explorerFiles.length,
      admittedWebRecords: admittedWeb.length,
      screensWithDeclaredDesignLinks,
      admittedScreenDesignChainsProven: 0,
      candidateDesignLinkIssues: candidateDesignIssues.length,
      exactImportIdentityProven: admittedWeb.length === 0 ? 0 : admittedWeb.filter((record) => {
        const identity = exportIdentity(record, packageName);
        return identity.declaration && importsExport(explorerImports, identity) && importsExport(productionImports, identity);
      }).length,
    },
    candidateDesignIssues,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = analyzeMediaPresentationArchitecture();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
