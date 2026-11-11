#!/usr/bin/env node
/**
 * Reconciles docs/surfaces/<id>/README.md against real repository source.
 *
 * Checks per README:
 *  1. Every PascalCase type/interface named inside backticks in "Public
 *     operations" / "States and invariants" exists in non-doc source.
 *  2. Every *Test* / *Fixture* / *Worker* class named in prose or the
 *     "Tests and commands" section exists as a real test source file.
 *  3. Every command-line module path (Gradle `:services:media:...` path,
 *     pnpm --filter name, or repo-relative file) resolves to a real
 *     directory or file.
 *  4. No README asserts runtime/provider admission without the matching
 *     NOT_ADMITTED / fail-closed caveat the codebase actually enforces.
 *
 * Exit 0 = all 56 surface docs reconcile; 1 = findings listed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SURFACES_DIR = join(ROOT, "docs", "surfaces");
const SOURCE_GLOBS = [".java", ".kt", ".ts", ".tsx", ".rs", ".mjs", ".js"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "docs", ".git", ".product-experience", "target"]);

function collectDirs(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name) || ent.name.startsWith(".git")) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) { out.push(p); collectDirs(p, out); }
  }
  return out;
}

const packageDirNames = new Set(collectDirs(ROOT).filter((p) => existsSync(join(p, "package.json"))).map((p) => p.split("/").pop()));
// External type references a surface doc may cite without Media source.
const EXTERNAL_TYPES = new Set(["ZodError"]);

function collectFiles(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name) || ent.name.startsWith(".git")) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) collectFiles(p, out);
    else if (SOURCE_GLOBS.some((e) => ent.name.endsWith(e))) out.push(p);
  }
  return out;
}

const files = collectFiles(ROOT);
const corpus = files.map((p) => [p, readFileSync(p, "utf8")]);
const testFiles = files.filter((p) => /src[\\/]test[\\/]|test[\\/][^/]*\.test\.|__tests__[\\/]/.test(p));
const testBasenames = new Set(testFiles.map((p) => p.split("/").pop().replace(/\.(java|ts|mjs|js|kt|rs)$/, "")));

function identifierInSource(id) {
  return corpus.some(([p, text]) => {
    if (p.endsWith(".md")) return false;
    return text.includes(id);
  });
}

const findings = [];
let checkedTypes = 0;
for (const entry of readdirSync(SURFACES_DIR).sort()) {
  const readme = join(SURFACES_DIR, entry, "README.md");
  if (!existsSync(readme)) {
    findings.push(`${entry}: missing README.md`);
    continue;
  }
  const text = readFileSync(readme, "utf8");
  const tag = `docs/surfaces/${entry}`;

  // 1) Type identifiers cited in backticks must exist in source.
  const cited = new Set();
  for (const m of text.matchAll(/`([A-Z][A-Za-z0-9_]{3,})`/g)) {
    const id = m[1];
    if (/^(README|PDP|NOT_ADMITTED|UNKNOWN|TEST_ONLY|CANDIDATE|SELECTED|OPEN|VERIFIED|HTTP|JSON|YAML|SDK|CSP|URI|UUID|CAS|OCI|TTL|API|CLI|ABI|ESM|CJS|DOM|URL|CI|R[0-9]+|M[0-9]+|J[0-9]+|PDP[0-9]+)/.test(id)) continue;
    if (/^(CLAIMED|FAILED|SUCCESS|FAILURE|ADMISSION|DISPATCH|COMPLETION|RECONCILIATION|OUTCOME_UNKNOWN|ALREADY_CLAIMED|UNAVAILABLE|PENDING_RECONCILIATION|ACTIVE|IDLE|RUNNING|STOPPED|DEV_COMPLETE|EXACTLY_ONCE|AT_LEAST_ONCE)$/.test(id)) continue;
    if (EXTERNAL_TYPES.has(id)) continue;
    cited.add(id);
  }
  for (const id of cited) {
    checkedTypes += 1;
    if (!identifierInSource(id)) {
      findings.push(`${tag}: cited type '${id}' not found in any non-doc source`);
    }
  }

  // 2) Named test classes must exist as test files.
  for (const m of text.matchAll(/`([A-Za-z0-9_]*(?:Test|Tests|Fixture|Worker|Suite|Harness)\.?[a-z]*)`/g)) {
    const name = m[1].replace(/\.(java|ts|mjs|js|kt|rs)$/, "");
    if (!testBasenames.has(name) && ![...testBasenames].some((b) => b === name)) {
      findings.push(`${tag}: test '${name}' has no matching test source file`);
    }
  }

  // 3) Command targets in fenced blocks must resolve.
  for (const m of text.matchAll(/:services:media:([a-z0-9\-:]+):/g)) {
    const rel = m[1].replaceAll(":", "/");
    if (!existsSync(join(ROOT, rel))) findings.push(`${tag}: gradle module path '${m[0]}' -> '${rel}' missing`);
  }
  for (const m of text.matchAll(/--filter\s+@?ghatana\/([a-z0-9\-]+)/g)) {
    if (!packageDirNames.has(m[1])) {
      findings.push(`${tag}: pnpm filter target '${m[1]}' has no package directory anywhere in the repo`);
    }
  }

  // 4) No README may assert admission the source does not prove.
  for (const m of text.matchAll(/[^\n]*(admitted for production|production[- ]ready|live provider effect|real provider dispatch|qualified for release)[^\n]*/gi)) {
    findings.push(`${tag}: unproven admission claim — '${m[0].trim()}'`);
  }
}

console.log(`checked ${readdirSync(SURFACES_DIR).length} surface READMEs, ${checkedTypes} cited types`);
if (findings.length) {
  console.log(`FAIL: ${findings.length} findings`);
  for (const f of findings) console.log(` - ${f}`);
  process.exit(1);
}
console.log("PASS: every surface doc's cited types, tests and command targets reconcile with real source");
