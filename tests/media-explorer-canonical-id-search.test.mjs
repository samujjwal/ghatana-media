import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../apps/media-experience-explorer/src/main.ts", import.meta.url), "utf8");

test("Specification search includes the canonical artifact ID used by trace metadata", () => {
  assert.match(source, /`\$\{artifact\.artifactId\} \$\{artifact\.title\} \$\{artifact\.path\}`/u);
  assert.match(source, /Search IDs, titles, and filenames/u);
  assert.match(source, /Canonical artifact ID/u);
});

test("initial Specification rendering exposes cross-phase search results and counts", () => {
  const render = source.slice(source.indexOf("function specificationSurface()"), source.indexOf("function verificationSurface()"));
  assert.match(render, /const visibleArtifacts = specificationSearchResults\(phaseArtifacts\)/u);
  assert.match(render, /specificationSearchCount\(visibleArtifacts, phaseArtifacts\)/u);
  assert.match(render, /aria-label="\$\{escapeHtml\(specificationArtifactNavLabel\(\)\)\}"/u);
});

test("typing updates cross-phase Specification results, counts, and accessible navigation label", () => {
  const inputHandler = source.slice(source.indexOf('root.addEventListener("input"'), source.indexOf('} else if (target instanceof HTMLInputElement && target.id === "source-position")'));
  assert.match(inputHandler, /const visibleArtifacts = specificationSearchResults\(phaseArtifacts\)/u);
  assert.match(inputHandler, /artifactCount\.textContent = specificationSearchCount\(visibleArtifacts, phaseArtifacts\)/u);
  assert.match(inputHandler, /setAttribute\("aria-label", specificationArtifactNavLabel\(\)\)/u);
  assert.match(source, /Matching source records across all phases/u);
  assert.match(source, /selectedPhase = artifact\.phase/u);
});
