#!/usr/bin/env node
/**
 * Generates the TypeScript-AST-derived SDK source-declaration crosswalk at
 * .product-experience/pdp-3-product-experience/sdk/declaration-crosswalk.v1.json.
 *
 * The crosswalk reconciles every public class-member declaration discovered
 * under libs/audio-video-client/src against the authored operation registry
 * without inventing new registry methods: registry-backed methods keep their
 * authored identities, repeated signatures on one class/method are overload
 * signatures, declarations on exported classes outside the registry are
 * unregistered public SDK surface (never silent parity gaps), and registry
 * rows with no matching declaration remain parser artifacts.
 *
 * `--check` verifies the checked-in artifact is current; the default mode
 * rewrites it deterministically (no timestamps) so it is byte-stable.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const requireClient = createRequire(resolve(root, "libs/audio-video-client/package.json"));
const ts = requireClient("typescript");

const SDK_SOURCE_DIR = "libs/audio-video-client/src";
const REGISTRY_PATH = ".product-experience/pdp-3-product-experience/sdk/operation-registry.yaml";
const ARTIFACT_PATH = ".product-experience/pdp-3-product-experience/sdk/declaration-crosswalk.v1.json";
const TEST_FILE_MARKERS = ["/__tests__/", ".test.ts", ".spec.ts", ".d.ts"];

export function* enumerateSdkSources(baseDir = join(root, SDK_SOURCE_DIR)) {
  for (const entry of readdirSync(baseDir).sort()) {
    const path = join(baseDir, entry);
    if (statSync(path).isDirectory()) {
      yield* enumerateSdkSources(path);
    } else if (entry.endsWith(".ts") && !TEST_FILE_MARKERS.some((marker) => path.endsWith(marker) || path.includes(marker))) {
      yield relative(root, path);
    }
  }
}

function memberIdentity(source, className, name) {
  return `${source}#${className}#${name}`;
}

function memberVisibility(member) {
  const modifiers = ts.getModifiers(member) ?? [];
  for (const modifier of modifiers) {
    if (modifier.kind === ts.SyntaxKind.PrivateKeyword) return "private";
    if (modifier.kind === ts.SyntaxKind.ProtectedKeyword) return "protected";
  }
  return "public";
}

/**
 * AST census of every named declaration under the SDK source tree. Returns
 * ordered declaration records; class members carry `kind: "classMethod"` or
 * `"classMethodSignature"` (implementation-less overload signatures), module
 * functions carry `kind: "exportedFunction"`/`"internalFunction"`, and
 * non-exported or non-public class members are retained as internal
 * declarations so the census denominator is complete.
 */
export function enumerateDeclarations(repositoryRoot = root) {
  const declarations = [];
  for (const source of [...enumerateSdkSources(join(repositoryRoot, SDK_SOURCE_DIR))].sort()) {
    const absolute = join(repositoryRoot, source);
    const ast = ts.createSourceFile(source, readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of ast.statements) {
      const exported = (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (ts.isClassDeclaration(statement) && statement.name) {
        const className = statement.name.text;
        for (const member of statement.members) {
          if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) continue;
          const name = member.name.text;
          if (name === "constructor") continue;
          const visibility = memberVisibility(member);
          declarations.push({
            id: memberIdentity(source, className, name),
            source,
            declaringClass: className,
            name,
            kind: member.body ? "classMethod" : "classMethodSignature",
            visibility,
            exported,
          });
        }
      } else if (ts.isFunctionDeclaration(statement) && statement.name) {
        declarations.push({
          id: `${source}#${statement.name.text}`,
          source,
          declaringClass: null,
          name: statement.name.text,
          kind: exported ? "exportedFunction" : "internalFunction",
          visibility: "module",
          exported,
        });
      } else if (ts.isVariableStatement(statement) && exported) {
        for (const decl of statement.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          const init = decl.initializer;
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
            declarations.push({
              id: `${source}#${decl.name.text}`,
              source,
              declaringClass: null,
              name: decl.name.text,
              kind: "exportedFunction",
              visibility: "module",
              exported: true,
            });
          }
        }
      }
    }
  }
  return declarations;
}

function parseRegistryRows(registrySource) {
  return registrySource.split(/(?=^  - id: )/mu).flatMap((record) => {
    const id = record.match(/^  - id: ([^\n]+)/mu)?.[1]?.trim();
    const method = record.match(/^    method: ([^\n]+)/mu)?.[1]?.trim();
    const visibility = record.match(/^    visibility: ([^\n]+)/mu)?.[1]?.trim();
    const source = record.match(/^    source: ([^\n]+)/mu)?.[1]?.trim();
    const declaringClass = record.match(/^    declaringClass: ([^\n]+)/mu)?.[1]?.trim();
    return id && method && visibility === "public" && source && declaringClass
      ? [{ id, method, source, declaringClass }]
      : [];
  });
}

const UNREGISTERED_KINDS = {
  "MediaCanonicalClient": "canonicalClientMethod",
  "MediaHttpTransport": "clientTransportMethod",
  "MediaFileCaptureAdapter": "captureAdapterMethod",
  "HttpApiCaptureAdapter": "captureAdapterMethod",
  "CaptionDraftSession": "captionDraftSessionMethod",
};

export function buildCrosswalk(repositoryRoot = root) {
  const declarations = enumerateDeclarations(repositoryRoot);
  const registry = readFileSync(join(repositoryRoot, REGISTRY_PATH), "utf8");
  const registryRows = parseRegistryRows(registry);

  const registryByPair = new Map(registryRows.map((row) => [`${row.source}#${row.declaringClass}#${row.method}`, row.id]));
  const declaredPairs = new Map();
  for (const decl of declarations) {
    if (decl.kind === "classMethod" || decl.kind === "classMethodSignature") {
      if (!declaredPairs.has(decl.id)) declaredPairs.set(decl.id, []);
      declaredPairs.get(decl.id).push(decl);
    }
  }

  const parserArtifacts = registryRows.filter((row) => !declaredPairs.has(`${row.source}#${row.declaringClass}#${row.method}`));
  const records = [];
  for (const decl of declarations) {
    let classification;
    let registryId = null;
    if (decl.kind === "classMethod" || decl.kind === "classMethodSignature") {
      if (decl.visibility !== "public" || !decl.exported) {
        classification = "internalDeclaration";
      } else if (declaredPairs.get(decl.id).length > 1 && decl.kind === "classMethodSignature") {
        classification = "overloadSignature";
        registryId = registryByPair.get(decl.id) ?? null;
      } else if (registryByPair.has(decl.id)) {
        classification = "registryBackedPublicMethod";
        registryId = registryByPair.get(decl.id);
      } else {
        classification = "unregisteredPublicMethod";
      }
      records.push({ ...decl, classification, registryId, unregisteredKind: classification === "unregisteredPublicMethod" ? (UNREGISTERED_KINDS[decl.declaringClass] ?? "unclassifiedPublicMethod") : null });
    } else {
      records.push({ ...decl, classification: decl.exported ? "exportedFunction" : "internalDeclaration", registryId: null, unregisteredKind: null });
    }
  }

  const count = (predicate) => records.filter(predicate).length;
  const artifact = {
    schemaVersion: "media.sdk.declaration-crosswalk.v1",
    purpose: "AST-derived reconciliation of every SDK source declaration against the authored operation registry; unregistered public surface is classified, never silently promoted into method rows.",
    censusBasis: "typescript-ast; libs/audio-video-client/node_modules/typescript",
    registry: `${REGISTRY_PATH}#methods`,
    sources: [...enumerateSdkSources(join(repositoryRoot, SDK_SOURCE_DIR))].sort(),
    summary: {
      sourceFileCount: [...enumerateSdkSources(join(repositoryRoot, SDK_SOURCE_DIR))].length,
      publicClassMemberDeclarations: count((r) => (r.kind === "classMethod" || r.kind === "classMethodSignature") && r.visibility === "public" && r.exported),
      registryBackedPublicMethods: count((r) => r.classification === "registryBackedPublicMethod"),
      overloadSignatures: count((r) => r.classification === "overloadSignature"),
      unregisteredPublicMethods: count((r) => r.classification === "unregisteredPublicMethod"),
      exportedFunctions: count((r) => r.classification === "exportedFunction"),
      internalDeclarations: count((r) => r.classification === "internalDeclaration"),
      registryRows: registryRows.length,
      parserArtifactRows: parserArtifacts.length,
    },
    parserArtifacts: parserArtifacts.map((row) => row.id),
    declarations: records,
  };
  return artifact;
}

function render(artifact) {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const checkOnly = process.argv.includes("--check");
  const artifact = buildCrosswalk();
  const rendered = render(artifact);
  const current = (() => { try { return readFileSync(join(root, ARTIFACT_PATH), "utf8"); } catch { return ""; } })();
  if (checkOnly) {
    if (current !== rendered) {
      console.error(`SDK declaration crosswalk is stale: regenerate with node scripts/generate-media-sdk-declaration-crosswalk.mjs`);
      process.exit(1);
    }
    console.log(`SDK declaration crosswalk: current (${artifact.summary.publicClassMemberDeclarations} public class-member declarations, ${artifact.summary.registryBackedPublicMethods} registry-backed, ${artifact.summary.unregisteredPublicMethods} unregistered, ${artifact.summary.parserArtifactRows} parser artifacts)`);
  } else {
    writeFileSync(join(root, ARTIFACT_PATH), rendered);
    console.log(`wrote ${ARTIFACT_PATH}: ${artifact.summary.publicClassMemberDeclarations} public class-member declarations (${artifact.summary.registryBackedPublicMethods} registry-backed, ${artifact.summary.overloadSignatures} overload signatures, ${artifact.summary.unregisteredPublicMethods} unregistered)`);
  }
}
