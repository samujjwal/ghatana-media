import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function checkWithScreenMutation(mutate) {
  const fixture = mkdtempSync(`${tmpdir()}/media-pdp-check-`);
  try {
    for (const path of [".product-experience", "apps/media-experience-explorer", "docs", "libs/media-experience-simulation"]) {
      cpSync(resolve(repositoryRoot, path), resolve(fixture, path), { recursive: true });
    }
    const contractPath = resolve(fixture, ".product-experience/pdp-3-product-experience/screen-contracts/create-media.yaml");
    const source = readFileSync(contractPath, "utf8");
    const mutated = mutate(source);
    assert.notEqual(mutated, source, "test mutation must change the fixture");
    writeFileSync(contractPath, mutated);
    return spawnSync(process.execPath, ["scripts/check-product-experience-local.mjs", `--root=${fixture}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test("Product Definition local invariant check covers all phase denominators", () => {
  const output = execFileSync(process.execPath, ["scripts/check-product-experience-local.mjs"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  assert.match(output, /Media Product Definition local check passed/u);
  assert.match(output, /462 PDP-0 capability leaves/u);
  assert.match(output, /28 PDP-2 components/u);
  assert.match(output, /47 PDP-3 screen contracts/u);
  assert.match(output, /28 baseline plus J-29\/J-30 extensions/u);
  assert.match(output, /currentness\.yaml is absent/u);
  assert.match(output, /47 required shapes/u);
  assert.match(output, /currentness authority is unavailable/u);
});

test("missing required screen refs/shapes fail closed", () => {
  const result = checkWithScreenMutation((source) => source.replace(/^operationRefs:.*\n/mu, ""));
  assert.notEqual(result.status, 0, "missing screen shape must not pass");
  assert.match(result.stderr, /missing required v2 shape:.*operationRefs/u);
});

test("unresolvable required screen schema reference fails closed", () => {
  const result = checkWithScreenMutation((source) => source.replace("contractSchemaRef: .product-experience/pdp-3-product-experience/screen-contract-schema.yaml", "contractSchemaRef: .product-experience/missing-schema.yaml"));
  assert.notEqual(result.status, 0, "unresolvable schema ref must not pass");
  assert.match(result.stderr, /unresolved contractSchemaRef/u);
});

test("unknown screen binding status fails closed", () => {
  const result = checkWithScreenMutation((source) => source.replace("surfaceId: candidate-pending-acceptance", "surfaceId: future-unreviewed-status"));
  assert.notEqual(result.status, 0, "unknown status must not pass");
  assert.match(result.stderr, /unknown fieldBindingStatus for surfaceId: future-unreviewed-status/u);
});

test("accepted or complete screen binding statuses are rejected", () => {
  for (const status of ["accepted", "complete"]) {
    const result = checkWithScreenMutation((source) => source.replace("surfaceId: candidate-pending-acceptance", `surfaceId: ${status}`));
    assert.notEqual(result.status, 0, `${status} status must not pass`);
    assert.match(result.stderr, /unapproved accepted\/complete fieldBindingStatus for surfaceId/u);
  }
});
