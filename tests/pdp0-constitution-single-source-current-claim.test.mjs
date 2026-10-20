import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = process.cwd();
const parseYaml = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const readYaml = (path) => parseYaml(readFileSync(resolve(root, path), "utf8"));
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));

const readablePath = ".product-experience/PRODUCT-CONSTITUTION.md";
const structuredPath = ".product-experience/pdp-0-product-truth/constitution.yaml";
const authorityMapPath = ".product-experience/authority-map.yaml";
const masterPlanPath = "docs/migration/expert-reviewed-master-plan.md";
const claimOverlayPath = "docs/migration/current-master-plan-claim-dispositions.json";

test("MSD-008 P0-03 single-register residual resolves to one structured constitution authority", () => {
  const readable = readFileSync(resolve(root, readablePath), "utf8");
  const structured = readYaml(structuredPath);
  const authorityMap = readYaml(authorityMapPath);
  const reference = authorityMap.phaseAuthorities
    .find(({ phase }) => phase === "PDP-0")
    ?.artifacts.find(({ id }) => id === "ART-P0-CONSTITUTION-REFERENCE");
  const canonical = authorityMap.phaseAuthorities
    .find(({ phase }) => phase === "PDP-0")
    ?.artifacts.find(({ id }) => id === "ART-P0-CONSTITUTION");

  assert.match(readable, /\*\*Canonical structured authority:\*\*\s*\[`pdp-0-product-truth\/constitution\.yaml`\]\(\.\/pdp-0-product-truth\/constitution\.yaml\)/u);
  assert.match(readable, /The structured register is the single source for Media's 32 proposed/u);
  assert.match(readable, /This page is a readable pointer to\s+that authority; it does not define a second editable set of requirements\./u);
  assert.equal(structured.schemaVersion, "media.product-constitution.v1");
  assert.equal(structured.requirements.length, 32);
  assert.equal(reference?.path, "PRODUCT-CONSTITUTION.md");
  assert.equal(reference?.role, "human-readable-reference");
  assert.equal(reference?.authority, "points-to-structured-register-and-is-not-an-editable-requirement-source");
  assert.equal(canonical?.path, "pdp-0-product-truth/constitution.yaml");
  assert.equal(canonical?.role, "authored-proposal");
});

test("MSD-008 current P0-03 claim trace retains its exact source and owner route", () => {
  const plan = readFileSync(resolve(root, masterPlanPath), "utf8").split(/\r?\n/u);
  const overlay = readJson(claimOverlayPath);
  const claim = overlay.records.find(({ claimId }) => claimId === "MSC-03-MSD-008-L0287-C02");
  const sourceLine = plan[286];

  assert.match(sourceLine, /PDP-0 owns them\. A readable `PRODUCT-CONSTITUTION\.md` is generated from, or unambiguously references, the single structured requirement register; it is not another editable set of rules\./u);
  assert.deepEqual(claim?.currentSourceLines, [287, 287]);
  assert.equal(claim?.exactClaim, "PDP-0 owns them.");
  assert.equal(claim?.ownerRef, ".product-experience/authority-map.yaml#/phaseAuthorities/0");
  assert.equal(claim?.acceptanceEffect, "none");
});
