import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const components = parse(readFileSync(resolve(root, ".product-experience/pdp-2-design-interface-system/component-contracts.yaml"), "utf8")).components;
const audit = parse(readFileSync(resolve(root, ".product-experience/pdp-2-design-interface-system/gui/reuse-audit.yaml"), "utf8"));
const generated = JSON.parse(readFileSync(resolve(root, ".product-experience/pdp-3-product-experience/generated/experience-specification.candidate.json"), "utf8"));
const candidate = generated.candidateModel;
const expectedContractOnly = new Set(audit.publicExportInventory.unboundFamilies);

test("experience candidate projects the exact PXD-083 Media required-prop source set", () => {
  const projected = new Map(candidate.componentContracts.map((component) => [component.id, component]));
  assert.equal(projected.size, components.length);
  for (const source of components) {
    const expected = expectedContractOnly.has(source.id)
      ? source.typedDefinition.props.filter((prop) => prop.required === true).map((prop) => prop.name)
      : source.requiredProps ?? [];
    assert.deepEqual(projected.get(source.id)?.requiredProps, expected, `${source.id} required prop projection must be exact`);
    if (expectedContractOnly.has(source.id)) {
      assert.ok(source.typedDefinition, `${source.id} has Media-owned typed source definition`);
      assert.ok(source.typedDefinition.inputSchema && source.typedDefinition.sourceRefs?.length, `${source.id} schema provenance must resolve`);
    }
  }
  assert.match(generated.candidateMappingReview.fieldDispositions.componentContracts.status, /PXD-083-BOUNDED-MEDIA-SOURCE/u);
  assert.equal(generated.candidateFieldSources.componentContracts.decisionRef,
    ".product-experience/decision-log.md#PXD-083");
  assert.equal(generated.fieldMappingBlockers.some(({ field }) => field === "componentContracts"), false,
    "PXD-083 clears the source projection blocker; public implementation and admission remain separately gated");
  assert.match(generated.candidateMappingReview.fieldDispositions.componentContracts.status,
    /^PXD-083-BOUNDED-MEDIA-SOURCE-REQUIRED-PROP-CANDIDATES/u);
});

test("existing public prop projection remains exactly source-bound", () => {
  const publicBound = components.filter((component) => !expectedContractOnly.has(component.id));
  assert.equal(publicBound.length, 3);
  for (const source of publicBound) {
    assert.deepEqual(candidate.componentContracts.find((component) => component.id === source.id).requiredProps, source.requiredProps);
  }
});
