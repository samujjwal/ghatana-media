import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function checkWithScreenMutation(mutate, contract = "create-media.yaml") {
  const fixture = mkdtempSync(`${tmpdir()}/media-pdp-check-`);
  try {
    for (const path of [".product-experience", "apps/media-experience-explorer", "docs", "libs/media-experience-simulation"]) {
      cpSync(resolve(repositoryRoot, path), resolve(fixture, path), { recursive: true });
    }
    const contractPath = resolve(fixture, `.product-experience/pdp-3-product-experience/${contract.includes("journey-contracts/") ? contract : `screen-contracts/${contract}`}`);
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

function checkWithTransitionMutation(mutate) {
  const fixture = mkdtempSync(`${tmpdir()}/media-pdp-check-`);
  try {
    for (const path of [".product-experience", "apps/media-experience-explorer", "docs", "libs/media-experience-simulation"]) {
      cpSync(resolve(repositoryRoot, path), resolve(fixture, path), { recursive: true });
    }
    const transitionPath = resolve(fixture, ".product-experience/pdp-1-domain-data/transitions.yaml");
    const source = readFileSync(transitionPath, "utf8");
    const mutated = mutate(source);
    assert.notEqual(mutated, source, "test mutation must change the fixture");
    writeFileSync(transitionPath, mutated);
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
  assert.match(output, /31 PDP-2 components/u);
  assert.match(output, /47 PDP-3 screen contracts/u);
  assert.match(output, /28 baseline plus J-29\/J-30 extensions/u);
  assert.match(output, /currentness\.yaml is absent/u);
  assert.match(output, /47 required shapes/u);
  assert.match(output, /21 of 47 screen views have direct action-capability requirement crosswalks/u);
  assert.match(output, /20 of 20 action-bearing journey steps map through direct Action Registry capability refs/u);
  assert.match(output, /Tools Product Definition\/Experience validation and lifecycle currentness outputs are not bound in this checkout/u);
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

test("screen binding statuses decode quoted, folded, and multiline YAML scalars exactly", () => {
  const cases = [
    [
      "surfaceId: candidate-pending-acceptance",
      "surfaceId: >-\n    candidate-pending-acceptance",
      "folded",
    ],
    [
      "surfaceId: candidate-pending-acceptance",
      'surfaceId: "candidate-pending-acceptance"',
      "quoted",
    ],
    [
      'fixtures: "NO_APPLICABLE_FIXTURE_FOR_P3B_CONTRACT_PREVIEW; P3-F permits honest\n    definition-only previews',
      'fixtures: "NO_APPLICABLE_FIXTURE_FOR_P3B_CONTRACT_PREVIEW; P3-F permits honest definition-only\n    previews',
      "multiline quoted",
    ],
  ];
  for (const [before, after, style] of cases) {
    const result = checkWithScreenMutation((source) => source.replace(before, after));
    assert.doesNotMatch(result.stderr, /unknown fieldBindingStatus for surfaceId|lacks a fieldBindingStatus entry for surfaceId/u, `${style} scalar should parse to its exact allowed status`);
    assert.doesNotMatch(result.stderr, /unknown fieldBindingStatus for fixtures|lacks a fieldBindingStatus entry for fixtures/u, `${style} scalar should not cause a fixtures status parse error`);
  }
});

test("nested triggerCases IDs are not parsed as top-level transitions", () => {
  const result = checkWithTransitionMutation((source) => source.replace(
    "  - id: media-job/T01\n    sourceMachineId: media-job",
    "  - id: media-job/T01\n    triggerCases:\n      - id: media.transition-trigger-edge.fixture.v1\n    sourceMachineId: media-job",
  ));
  assert.doesNotMatch(result.stderr, /Transition media\.transition-trigger-edge\.fixture\.v1/u);
  assert.doesNotMatch(result.stderr, /has an unresolved state-machine reference/u);
});

test("action-capability crosswalk accepts valid block-list and multiline flow-list refs", () => {
  const blockListResult = checkWithScreenMutation((source) => source.replace(
    "surfaceId: media.surface.web",
    'surfaceId: "media.surface.web"',
  ), "select-source.yaml");
  assert.doesNotMatch(blockListResult.stderr, /media\.view\.select-source(?: action .* (?:lacks a|do not match)| (?:lacks a|do not match))/u);

  const flowListResult = checkWithScreenMutation((source) => source.replace(
    "surfaceId: media.surface.web",
    'surfaceId: "media.surface.web"',
  ), "work-with-speech.yaml");
  assert.doesNotMatch(flowListResult.stderr, /media\.view\.work-with-speech(?: action .* (?:lacks a|do not match)| (?:lacks a|do not match)| has a malformed)/u);
});

test("mismatched block-list capability refs still fail exact crosswalk validation", () => {
  const result = checkWithScreenMutation((source) => source.replace(
    "  - actionId: media.action.choose-source\n    capabilityRefs:\n      - media.artifact.inspect",
    "  - actionId: media.action.choose-source\n    capabilityRefs:\n      - media.project.inspect",
  ), "select-source.yaml");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /media\.view\.select-source action media\.action\.choose-source capabilityRefs do not match the PDP-3 Action Registry/u);
});

test("screen requirement references must equal the direct action-capability crosswalk", () => {
  const result = checkWithScreenMutation((source) => source
    .replace(/^requirementRefs:[ \t]*\[[^\]]+\]$/mu, "requirementRefs: []")
    .replace(/^requirementRefs:[ \t]*\n(?:^[ \t]+-[^\n]*\n)+/mu, "requirementRefs: []\n"), "correct-captions.yaml");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /media\.view\.correct-captions requirementRefs do not match/u);
});

test("journey step requirement references must equal the direct action-capability crosswalk", () => {
  const result = checkWithScreenMutation((source) => source.replace(
    /^\s+requirementRefs: \[\s*MEDIA-REQ-CAP-ARTIFACT\s*\]$/mu,
    "        requirementRefs: []",
  ), "journey-contracts/transcribe-and-correct-captions.yaml");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Journey step media\.action\.choose-source requirementRefs do not match/u);
});
