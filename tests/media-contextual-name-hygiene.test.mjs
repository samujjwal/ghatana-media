import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);

test("every Gradle projectDir in settings.gradle.kts resolves to a real directory", () => {
  const missing = [];
  for (const m of read("settings.gradle.kts").matchAll(/projectDir = File\(rootDir, "([^"]+)"\)/g)) {
    if (!existsSync(join(ROOT, m[1]))) missing.push(m[1]);
  }
  assert.deepEqual(missing, []);
});

test("no orphan modules: every package dir is inside a workspace glob", () => {
  const workspacePatterns = [
    /^apps\/[^/]+$/, /^libs\/[^/]+$/,
    /^modules\/.+\/libs\/[^/]+$/, /^modules\/.+\/clients\/[^/]+$/,
  ];
  const matchesGlob = (dir) => workspacePatterns.some((re) => re.test(dir));
  const offenders = [];
  for (const file of tracked.filter((p) => p.endsWith("package.json") && !p.includes("archive/") && !p.includes("dist") && p !== "package.json")) {
    const dir = file.split("/").slice(0, -1).join("/");
    if (!matchesGlob(dir)) offenders.push(dir);
  }
  assert.deepEqual(offenders, []);
});

test("no dated/batch/phase scaffolding directories in source paths", () => {
  const offenders = tracked.filter((p) =>
    !p.startsWith("docs/") && !p.startsWith("archive/") && !p.startsWith(".product-experience/")
    && !p.startsWith("migration/") && !p.startsWith("review/")
    && /(^|\/)(batch|r\d+|phase-\d+|wave-\d+)[-_/]/i.test(p));
  assert.deepEqual(offenders, []);
});

test("no dead production mocks outside test source", () => {
  const offenders = tracked.filter((p) =>
    /src\/main\/.*\.(ts|java)$/.test(p)
    && /\b(mock|stub|fake)[A-Za-z]*(Adapter|Provider|Engine|Service|Store|Client|Handler)\b/.test(read(p)));
  assert.deepEqual(offenders, []);
});

test("no unsupported preview deployment path is registered", () => {
  const scripts = JSON.parse(read("package.json")).scripts ?? {};
  const offenders = Object.keys(scripts).filter((k) =>
    /deploy|publish:(prod|live)/i.test(k) && !/pack|prepare/i.test(k));
  assert.deepEqual(offenders, []);
});
