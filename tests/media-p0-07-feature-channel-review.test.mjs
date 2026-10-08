import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const readYaml = (path) => parse(read(path));

function requiredReviewRows(markdown) {
  const start = markdown.indexOf("## Capability review matrix");
  const end = markdown.indexOf("## Honest remaining coverage gaps", start);
  assert.notEqual(start, -1, "the product definition review matrix remains present");
  assert.notEqual(end, -1, "the matrix has an explicit end before the open gaps section");
  return markdown.slice(start, end).split(/\r?\n/u)
    .filter((line) => line.startsWith("| ") && !line.startsWith("| ---"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells[0] && cells[0] !== "Review dimension");
}

function normalizedChannelRefs(capability, aliases) {
  return [...new Set((capability.supportedChannels ?? []).map((alias) => {
    assert.ok(aliases[alias], `${capability.id} channel alias ${alias} has a canonical mapping`);
    return aliases[alias];
  }))].sort();
}

test("the complete product feature review matrix resolves to canonical sources and the cross-phase denominator", () => {
  const rows = requiredReviewRows(read("docs/PRODUCT-DEFINITION-COVERAGE.md"));
  assert.equal(rows.length, 15, "all documented mandatory feature review dimensions remain visible");
  assert.equal(new Set(rows.map(([dimension]) => dimension)).size, rows.length, "review dimensions are unique");

  const sourcePaths = new Set();
  const phaseRoots = [0, 1, 2, 3].map((phase) => `.product-experience/pdp-${phase}-${[
    "product-truth", "domain-data", "design-interface-system", "product-experience",
  ][phase]}`);
  for (const [dimension, sourceCell] of rows) {
    const references = [...sourceCell.matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
    assert.ok(references.length > 0, `${dimension} names canonical source evidence`);
    for (const reference of references) {
      if (!/^(?:pdp-[0-3]-|explorer\/)/u.test(reference) && !reference.includes("/") && !reference.endsWith(".yaml")) continue;
      const directPath = reference.startsWith("pdp-") ? `.product-experience/${reference}` : reference;
      let path = directPath;
      if (!existsSync(resolve(root, path))) {
        if (["api/", "grpc/", "sdk/", "cli/", "agent-tools/"].includes(reference)) {
          path = `.product-experience/pdp-3-product-experience/${reference}`;
        }
      }
      if (!existsSync(resolve(root, path))) {
        const contextualPaths = phaseRoots.map((phaseRoot) => `${phaseRoot}/${reference}`)
          .filter((candidate) => existsSync(resolve(root, candidate)));
        assert.equal(contextualPaths.length, 1, `${dimension} source ${reference} resolves in exactly one phase authority`);
        [path] = contextualPaths;
      }
      assert.ok(existsSync(resolve(root, path)), `${dimension} source ${reference} resolves at ${path}`);
      sourcePaths.add(path);
    }
  }
  assert.ok(sourcePaths.has(".product-experience/pdp-0-product-truth/capabilities.yaml"));
  assert.ok(sourcePaths.has(".product-experience/pdp-0-product-truth/requirements.yaml"));
  assert.ok(sourcePaths.has(".product-experience/pdp-0-product-truth/quality-policy.yaml"));

  const coverage = readYaml(".product-experience/vision-requirements-coverage.yaml");
  const capabilities = readYaml(".product-experience/pdp-0-product-truth/capabilities.yaml");
  const requirements = readYaml(".product-experience/pdp-0-product-truth/requirements.yaml");
  const journeys = readYaml(".product-experience/pdp-0-product-truth/journey-catalog.yaml");
  assert.equal(coverage.coverageChecks.capabilities.expected, capabilities.capabilities.length);
  assert.equal(coverage.coverageChecks.requirements.expected, requirements.requirements.length);
  assert.equal(coverage.coverageChecks.journeys.expected, journeys.journeys.length);
  assert.equal(capabilities.capabilities.length, 462);
  assert.equal(requirements.requirements.length, 38);
  assert.equal(journeys.journeys.length, 30);
});

test("every feature leaf has an exact proposal-time channel disposition, with unsupported admission left explicit", () => {
  const capabilities = readYaml(".product-experience/pdp-0-product-truth/capabilities.yaml").capabilities;
  const requirements = readYaml(".product-experience/pdp-0-product-truth/requirements.yaml").requirements;
  const channels = readYaml(".product-experience/pdp-0-product-truth/applications-channels.yaml");
  const review = readYaml(".product-experience/pdp-0-product-truth/capability-leaf-review.yaml");
  const channelIds = new Set(channels.channels.map(({ id }) => id));
  const aliases = channels.capabilityChannelAliases.mapping;
  const capabilityById = new Map(capabilities.map((capability) => [capability.id, capability]));
  const requirementRefs = new Map();
  for (const requirement of requirements) {
    for (const capabilityId of requirement.capabilityIds ?? []) {
      assert.ok(capabilityById.has(capabilityId), `${requirement.id} references an existing feature leaf`);
      assert.ok(!requirementRefs.has(capabilityId), `${capabilityId} has one requirement scope`);
      requirementRefs.set(capabilityId, requirement.id);
    }
  }
  assert.equal(requirementRefs.size, capabilities.length, "no feature leaf is hidden outside the requirement denominator");
  assert.equal(review.leaves.length, capabilities.length, "every feature leaf has a review row");
  const reviewById = new Map(review.leaves.map((leaf) => [leaf.id, leaf]));
  assert.equal(reviewById.size, capabilities.length, "the review contains no duplicate or omitted feature leaves");

  for (const capability of capabilities) {
    const row = reviewById.get(capability.id);
    assert.ok(row, `${capability.id} has a visible scope/channel review row`);
    assert.equal(row.coverageDecision.normativeRefs.includes(`.product-experience/pdp-0-product-truth/requirements.yaml#${requirementRefs.get(capability.id)}`), true,
      `${capability.id} is linked to its canonical requirement`);
    const proposedRefs = row.coverageDecision.proposedInterfaceRefs ?? [];
    assert.deepEqual([...proposedRefs].sort(), normalizedChannelRefs(capability, aliases),
      `${capability.id} review retains the complete source channel proposal without adding/removing a channel`);
    for (const channelId of proposedRefs) assert.ok(channelIds.has(channelId), `${capability.id} channel ${channelId} exists`);
    assert.match(row.coverageDecision.interfaceAdmissionStatus, /not established|pending|proposal/iu,
      `${capability.id} proposal does not imply channel admission`);
  }

  assert.equal(channels.channels.length, 9, "all authored channel identities remain in the denominator");
  assert.equal(channels.channels.filter(({ phase0Admission }) => phase0Admission === "not-admitted").length, 1,
    "only the source-marked archived desktop channel is excluded");
  assert.ok(channels.channels.filter(({ phase0Admission }) => phase0Admission !== "not-admitted")
    .every(({ phase0Admission, runtimeAvailability }) => /pending/u.test(phase0Admission) && runtimeAvailability !== "AVAILABLE"),
  "pending channel proposals never become runtime support claims");
  assert.equal(review.denominatorReconciliation.capabilityLeaves, 462);
  assert.equal(review.denominatorReconciliation.leavesWithUnresolvedApplicability, 383,
    "unresolved feature/channel applicability remains explicit rather than being filled with invented coverage");
});
