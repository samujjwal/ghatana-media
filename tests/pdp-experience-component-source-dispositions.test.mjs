import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { buildPdp3ComponentSourceDispositions } from "../scripts/lib/pdp3-component-source-dispositions.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const components = parse(readFileSync(resolve(root, ".product-experience/pdp-2-design-interface-system/component-contracts.yaml"), "utf8")).components;
const audit = parse(readFileSync(resolve(root, ".product-experience/pdp-2-design-interface-system/gui/reuse-audit.yaml"), "utf8"));

test("PDP-3 component projection preserves contract-only and observed export identity as separate dispositions", () => {
  const rows = buildPdp3ComponentSourceDispositions(components, audit);
  assert.equal(rows.length, 31);
  assert.equal(rows.filter((row) => row.disposition === "MEDIA_CONTRACT_ONLY_DEFINITION").length, 28);
  assert.equal(rows.filter((row) => row.disposition === "EXACT_SOURCE_AND_PUBLIC_EXPORT_IDENTITY_OBSERVED").length, 3);
  for (const row of rows) {
    assert.equal(row.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(row.qualification, "NOT_EVALUATED");
    if (row.disposition === "MEDIA_CONTRACT_ONLY_DEFINITION") {
      assert.match(row.typedDefinitionRef, /component-contracts\.yaml#components\/@id=media\.component\./u);
    }
  }
});

test("component source disposition rejects missing, overlapping, and implementation-promoting records", () => {
  const omitted = structuredClone(audit);
  omitted.publicExportInventory.unboundFamilies.pop();
  assert.throws(() => buildPdp3ComponentSourceDispositions(components, omitted), /source disposition/u);

  const overlap = structuredClone(audit);
  overlap.publicExportInventory.unboundFamilies.push(overlap.publicExportInventory.exactBindings[0]);
  assert.throws(() => buildPdp3ComponentSourceDispositions(components, overlap), /exactly one source disposition/u);

  const promoted = structuredClone(components);
  promoted.find((component) => audit.publicExportInventory.unboundFamilies.includes(component.id)).typedDefinition.runtimeAdmission = "ADMITTED";
  assert.throws(() => buildPdp3ComponentSourceDispositions(promoted, audit), /NOT_ADMITTED/u);
});
