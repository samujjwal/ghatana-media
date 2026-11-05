import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const tracked = new Set(
  execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean),
);
const trackedDirs = new Set();
for (const f of tracked) {
  const seg = f.split("/");
  for (let i = 1; i < seg.length; i++) trackedDirs.add(seg.slice(0, i).join("/"));
}

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
function* relativeLinks(markdown, from) {
  for (const m of markdown.matchAll(LINK_RE)) {
    const raw = m[1];
    if (raw.startsWith("!")) continue;
    const target = raw.split("#")[0].split("?")[0];
    if (!target || /^[a-z][a-z0-9+.-]*:|\/\//iu.test(raw)) continue;
    const abs = resolve(ROOT, dirname(from), target);
    if (!abs.startsWith(ROOT)) continue; // outside repo: provenance, not navigation
    yield { raw, rel: abs.slice(ROOT.length).replace(/^\/+/, "") };
  }
}

const MAINTAINED = ["README.md", "docs/README.md", "AGENTS.md", "docs/development/SURFACE-IMPLEMENTATION-PLAN.md", "docs/development/REMAINING-WORK.md"];

test("every relative link in maintained entry docs resolves to a tracked path", () => {
  const broken = [];
  for (const file of MAINTAINED) {
    const text = read(file);
    for (const { raw, rel } of relativeLinks(text, file)) {
      if (!tracked.has(rel) && !trackedDirs.has(rel)) {
        broken.push(`${file}: ${raw} -> ${rel}`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

test("one intent-based entrypoint: README Start-here selects the implementation plan + register", () => {
  const readme = read("README.md");
  const startIdx = readme.indexOf("## Start here");
  assert.ok(startIdx > -1, "README keeps a Start here selector");
  const section = readme.slice(startIdx, readme.indexOf("\n## ", startIdx + 1));
  assert.match(section, /docs\/development\/SURFACE-IMPLEMENTATION-PLAN\.md/u);
  assert.match(section, /docs\/development\/REMAINING-WORK\.md/u);
  // The selector must exist exactly once — no duplicate active plan entrypoints.
  assert.equal(readme.split("## Start here").length - 1, 1);
});

test("docs index separates the implementation plan from the formal BUILD lane", () => {
  const idx = read("docs/README.md");
  assert.match(idx, /implementation-only/u);
  assert.match(idx, /BUILD \/ Plan Implementation|MEDIA-BUILD-IMPLEMENTATION-PLAN/u);
  assert.match(idx, /development\/remaining-work\.json/u);
});

test("no stale dated 'do next' instructions remain in maintained docs", () => {
  for (const file of MAINTAINED) {
    const text = read(file);
    for (const m of text.matchAll(/^.*(?:implement next|your next task is|start by implementing|work on .* next).*$/gim)) {
      assert.fail(`${file}: stale do-next instruction — '${m[0].trim()}'`);
    }
  }
});
