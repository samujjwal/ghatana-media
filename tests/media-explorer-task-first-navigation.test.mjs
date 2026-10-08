import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../apps/media-experience-explorer/src/main.ts", import.meta.url), "utf8");

test("Explorer keeps the five task-first activities in primary navigation", () => {
  assert.match(source, /const primaryModeIds: readonly ExplorerMode\[\] = \["product", "explore", "specification", "traceability", "verify"\]/u);
  const navigation = source.slice(source.indexOf("function modeNavigation()"), source.indexOf("function explorerHeader()"));
  assert.match(navigation, /aria-label="Primary Explorer activities">\$\{primaryModes\.map/u);
  assert.doesNotMatch(navigation, /role="tablist"|role="tab"|aria-selected/u);
  assert.match(navigation, /aria-current="page"/u);
  assert.match(navigation, /Product Preview/u);
  assert.match(navigation, /Experience Inspection/u);
  assert.match(navigation, /Specifications/u);
  assert.match(navigation, /Trace \/ Impact/u);
  assert.match(navigation, /More Explorer views/u);
  assert.match(navigation, /secondaryModes\.map/u);
});

test("secondary workspaces stay reachable and arrow navigation stays in the primary activities", () => {
  assert.match(source, /const secondaryModes = supportedModes\.filter\(\(\{ id \}\) => !primaryModeIds\.includes\(id\)\)/u);
  const keyboard = source.slice(source.indexOf('root.addEventListener("keydown"'), source.indexOf("render();\nif (mode === \"tools-review\")"));
  assert.match(keyboard, /button\.mode-tab\[data-mode\]/u);
  assert.match(keyboard, /primaryModes\.findIndex/u);
  assert.match(keyboard, /supportedModes\.find\(\(item\) => item\.shortcut === event\.key\)/u);
  assert.match(source, /mode-more-item \$\{mode === id \? "is-selected"/u);
  assert.match(source, /role="region" aria-labelledby="mode-\$\{mode\}"/u);
  assert.doesNotMatch(source, /role="tabpanel"/u);
});
