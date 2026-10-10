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

function resolveOwnerWebContext(capabilityId, familyRef, mappingByFamily) {
  const familyConsumer = mappingByFamily.get(familyRef);
  assert.ok(familyConsumer, `${familyRef} has a current Web applicability partition`);
  if (familyConsumer.webApplicableCapabilityRefs.includes(capabilityId)) {
    return { applicable: true, disposition: "SOURCE_DECLARED_DEFINITION_APPLICABLE", viewRefs: familyConsumer.viewRefs };
  }
  assert.ok(familyConsumer.webNonApplicableCapabilityRefs.includes(capabilityId),
    `${capabilityId} is explicitly classified in its family's Web applicability partition`);
  return { applicable: false, disposition: "OWNER_SELECTED_NOT_APPLICABLE_TO_THIS_LEAF", viewRefs: [] };
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
  const currentApplicability = journeys.capabilityApplicabilityDecision;
  assert.equal(currentApplicability.status, "OWNER_DEFINED_CURRENT_COMPLETE_DEFINITION_ONLY; independent acceptance, implementation, qualification, and runtime admission remain separate");
  assert.equal(Object.values(currentApplicability.dispositions).reduce((sum, count) => sum + count, 0), 462);
  assert.equal(currentApplicability.dispositions.MACHINE_CAPABILITY_WITH_EXPLICIT_CHANNEL_APPLICABILITY, 383);
  assert.equal(currentApplicability.historicalOperationEvidenceAudit.gatingForPdp0, false);
  assert.equal(currentApplicability.historicalOperationEvidenceAudit.dispositions.UNRESOLVED, 383);
  assert.match(journeys.dependencies["p0-003"], /resolved/u);
  assert.match(journeys.dependencies["p0-008"], /downstream-and-non-gating/u);
});

test("every active P0 capability adjudication has an exact channel disposition, with unsupported admission left explicit", () => {
  const capabilitySource = readYaml(".product-experience/pdp-0-product-truth/capabilities.yaml");
  const capabilities = capabilitySource.capabilities;
  const requirements = readYaml(".product-experience/pdp-0-product-truth/requirements.yaml").requirements;
  const channels = readYaml(".product-experience/pdp-0-product-truth/applications-channels.yaml");
  const review = readYaml(".product-experience/pdp-0-product-truth/capability-leaf-review.yaml");
  const channelIds = new Set(channels.channels.map(({ id }) => id));
  const aliases = channels.capabilityChannelAliases.mapping;
  const capabilityById = new Map(capabilities.map((capability) => [capability.id, capability]));
  const familyByCapability = new Map();
  for (const family of capabilitySource.families) {
    for (const capabilityId of family.capabilityIds) {
      assert.ok(!familyByCapability.has(capabilityId), `${capabilityId} belongs to one exact capability family`);
      familyByCapability.set(capabilityId, family.id);
    }
  }
  assert.equal(familyByCapability.size, capabilities.length, "all 462 leaves join exactly one family");
  const web = channels.channels.find(({ id }) => id === "media.channel.web");
  const webContract = web.ownerDefinitionApplicability;
  assert.equal(webContract.status, "OWNER_DEFINED_LEAF_WEB_JOURNEY_CONTEXT; DEFINITION_ONLY");
  assert.equal(webContract.capabilityLeafCount, 462);
  assert.equal(webContract.webApplicableLeafCount, 77);
  assert.equal(webContract.webNonApplicableLeafCount, 385);
  assert.equal(webContract.phase0Admission, "pending");
  assert.equal(webContract.executionAdmission, "NOT_ADMITTED");
  assert.equal(webContract.exactScreenAndJourneyBinding, "deferred-to-PDP-3");
  assert.equal(webContract.leafIntentRule, "OWNER_LINKED_JOURNEY_PROPOSES_WEB");
  assert.equal(webContract.nonApplicabilityRule, "NO_OWNER_LINKED_WEB_JOURNEY");
  assert.equal(webContract.leafJourneyBindingSourceRef,
    ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerCapabilityLeafAdjudication/records/@capabilityRef=<capabilityIntentId>/journeyRefs");
  assert.equal(webContract.journeyChannelAndViewSourceRef,
    ".product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=<journeyId>");
  assert.equal(webContract.authorityBoundary.decisionStatus, "CURRENT_P0_OWNER_APPLICABILITY_OVERLAY");
  assert.equal(webContract.authorityBoundary.sourceProposalRole,
    "INHERITED_CHANNEL_LABEL_ONLY; NON_GATING_FOR_CURRENT_WEB_APPLICABILITY");
  const webViewIds = new Set(web.viewReferences);
  const familyConsumers = webContract.familyConsumers;
  const mappingByFamily = new Map(familyConsumers.map((entry) => [entry.familyRef, entry]));
  assert.equal(mappingByFamily.size, familyConsumers.length, "Web family consumer map has no duplicate family rows");
  const capabilityFamilies = new Set(familyByCapability.values());
  assert.equal(mappingByFamily.size, capabilityFamilies.size, "every capability family has one Web context decision");
  const leafReviewById = new Map(review.ownerCapabilityLeafAdjudication.records.map((row) => [row.capabilityRef, row]));
  const journeyCatalog = readYaml(".product-experience/pdp-0-product-truth/journey-catalog.yaml");
  const journeyById = new Map(journeyCatalog.journeys.map((journey) => [journey.id, journey]));
  const webApplicableIds = new Set();
  const webNonApplicableIds = new Set();
  for (const familyRef of capabilityFamilies) {
    const entry = mappingByFamily.get(familyRef);
    assert.ok(entry, `${familyRef} has an explicit Web consumer context or reasoned exclusion`);
    const family = capabilitySource.families.find(({ id }) => id === familyRef);
    assert.deepEqual([...entry.webApplicableCapabilityRefs, ...entry.webNonApplicableCapabilityRefs].sort(),
      [...family.capabilityIds].sort(), `${familyRef} partitions every exact leaf once`);
    assert.equal(new Set(entry.webApplicableCapabilityRefs).size, entry.webApplicableCapabilityRefs.length,
      `${familyRef} has no duplicate Web-applicable leaves`);
    assert.equal(new Set(entry.webNonApplicableCapabilityRefs).size, entry.webNonApplicableCapabilityRefs.length,
      `${familyRef} has no duplicate Web-non-applicable leaves`);
    assert.equal(entry.definitionApplicabilityState, "OWNER_DEFINED_DEFINITION_ONLY");
    assert.equal(entry.phase0Admission, "pending");
    assert.equal(entry.executionAdmission, "NOT_ADMITTED");
    const expectedJourneyRefs = new Set();
    const expectedViewRefs = new Set();
    for (const capabilityId of entry.webApplicableCapabilityRefs) {
      const leaf = leafReviewById.get(capabilityId);
      for (const id of leaf.journeyRefs ?? []) {
        const journey = journeyById.get(id);
        if (!journey?.proposedChannels?.includes("media.channel.web")) continue;
        expectedJourneyRefs.add(id);
        for (const viewRef of journey.viewRefs ?? []) expectedViewRefs.add(viewRef);
      }
    }
    assert.deepEqual([...entry.journeyRefs].sort(), [...expectedJourneyRefs].sort(),
      `${familyRef} lists exactly the owner-linked Web journeys for its applicable leaves`);
    assert.deepEqual([...entry.viewRefs].sort(), [...expectedViewRefs].sort(),
      `${familyRef} lists only views cited by those exact Web journeys`);
    for (const capabilityId of entry.webApplicableCapabilityRefs) {
      assert.ok(!webApplicableIds.has(capabilityId), `${capabilityId} occurs in one family Web-applicable partition`);
      webApplicableIds.add(capabilityId);
      const leaf = leafReviewById.get(capabilityId);
      assert.ok(leaf, `${capabilityId} resolves to an owner leaf adjudication`);
      const webJourneyRefs = (leaf.journeyRefs ?? []).filter((id) => journeyById.get(id)?.proposedChannels?.includes("media.channel.web"));
      assert.ok(webJourneyRefs.length > 0, `${capabilityId} has an owner-linked Web-proposed journey`);
      assert.ok(webJourneyRefs.every((id) => entry.journeyRefs.includes(id)), `${capabilityId} journey evidence is included in ${familyRef}`);
      for (const id of webJourneyRefs) for (const viewRef of journeyById.get(id).viewRefs ?? []) {
        assert.ok(entry.viewRefs.includes(viewRef), `${familyRef} includes the proposed view ${viewRef} from ${id}`);
      }
    }
    for (const capabilityId of entry.webNonApplicableCapabilityRefs) {
      assert.ok(!webNonApplicableIds.has(capabilityId), `${capabilityId} occurs in one family Web-non-applicable partition`);
      webNonApplicableIds.add(capabilityId);
      assert.equal(entry.nonApplicabilityRuleRef, "NO_OWNER_LINKED_WEB_JOURNEY");
      assert.ok(entry.nonApplicabilityRationale.includes("inherited supportedChannels proposal label"),
        `${capabilityId} has a reason that rejects proposal-label and convenient-view inference`);
      const leaf = leafReviewById.get(capabilityId);
      const webJourneyRefs = (leaf?.journeyRefs ?? []).filter((id) => journeyById.get(id)?.proposedChannels?.includes("media.channel.web"));
      assert.deepEqual(webJourneyRefs, [], `${capabilityId} has no owner-linked Web journey; generic views cannot promote it`);
    }
  }
  assert.equal(webApplicableIds.size, 77, "only the 77 exact leaves with owner-linked Web journeys are applicable");
  assert.equal(webNonApplicableIds.size, 385, "all remaining leaves have explicit current Web non-applicability");
  assert.equal(webApplicableIds.size + webNonApplicableIds.size, capabilities.length, "all 462 leaves are partitioned");
  for (const entry of familyConsumers) {
    if (entry.webApplicableCapabilityRefs.length === 0) {
      assert.deepEqual(entry.viewRefs, [], `${entry.familyRef} has no source-supported Web consumer view`);
      assert.equal(entry.nonApplicabilityRuleRef, "NO_OWNER_LINKED_WEB_JOURNEY");
      assert.ok(entry.nonApplicabilityRationale.includes("inherited supportedChannels proposal label"));
    }
    if (entry.webApplicableCapabilityRefs.length > 0) {
      assert.ok(entry.viewRefs.length > 0, `${entry.familyRef} has cited proposed Web views`);
      assert.ok(entry.consumerRationale.includes("owner-linked journeys that propose media.channel.web"),
        `${entry.familyRef} distinguishes product journey intent from convenient view affordances`);
    }
    for (const viewRef of entry.viewRefs) assert.ok(webViewIds.has(viewRef), `${entry.familyRef} view ${viewRef} is in the Web view registry`);
  }
  const requirementRefs = new Map();
  for (const requirement of requirements) {
    for (const capabilityId of requirement.capabilityIds ?? []) {
      assert.ok(capabilityById.has(capabilityId), `${requirement.id} references an existing feature leaf`);
      assert.ok(!requirementRefs.has(capabilityId), `${capabilityId} has one requirement scope`);
      requirementRefs.set(capabilityId, requirement.id);
    }
  }
  assert.equal(requirementRefs.size, capabilities.length, "no feature leaf is hidden outside the requirement denominator");
  const activeRows = review.ownerCapabilityLeafAdjudication.records;
  assert.equal(activeRows.length, capabilities.length, "every feature leaf has an active owner adjudication");
  const reviewById = new Map(activeRows.map((leaf) => [leaf.capabilityRef, leaf]));
  assert.equal(reviewById.size, capabilities.length, "active P0 adjudications contain no duplicate or omitted feature leaves");
  const channelMatrixIds = activeRows[0].channelApplicability.map(({ channelRef }) => channelRef).sort();
  assert.equal(channelMatrixIds.length, 11, "the P0 applicability matrix retains all 11 channel identities");

  for (const capability of capabilities) {
    const row = reviewById.get(capability.id);
    assert.ok(row, `${capability.id} has a visible scope/channel review row`);
    assert.ok(row, `${capability.id} has an active owner adjudication`);
    assert.equal(row.requirementRefs.includes(requirementRefs.get(capability.id)), true,
      `${capability.id} is linked to its canonical requirement`);
    const expectedSourceChannels = new Set(normalizedChannelRefs(capability, aliases));
    const channelRows = new Map(row.channelApplicability.map((item) => [item.channelRef, item]));
    const dispositions = new Map([...channelRows].map(([channelRef, item]) => [channelRef, item.disposition]));
    assert.equal(dispositions.size, channelMatrixIds.length, `${capability.id} has one disposition for every channel`);
    for (const channelId of channelMatrixIds) assert.ok(dispositions.has(channelId), `${capability.id} disposition covers ${channelId}`);
    for (const [channelId, item] of channelRows) {
      assert.ok(item.ruleRef?.trim(), `${capability.id} ${channelId} has an explicit applicability rule or exclusion reason`);
      assert.equal(item.phase0Admission, "pending", `${capability.id} ${channelId} applicability does not admit the channel`);
      assert.equal(item.executionAdmission, "NOT_ADMITTED", `${capability.id} ${channelId} does not claim execution support`);
    }
    for (const channelId of expectedSourceChannels) {
      if (channelId === "media.channel.web") continue;
      assert.equal(dispositions.get(channelId), "SOURCE_DECLARED_DEFINITION_APPLICABLE",
        `${capability.id} preserves its exact source-declared channel ${channelId}`);
    }
    const familyRef = familyByCapability.get(capability.id);
    const ownerWeb = resolveOwnerWebContext(capability.id, familyRef, mappingByFamily);
    const webDecision = channelRows.get("media.channel.web");
    assert.equal(ownerWeb.applicable, webApplicableIds.has(capability.id),
      `${capability.id} Web applicability agrees with exact owner-linked journey evidence`);
    assert.equal(webDecision.disposition, "SOURCE_DECLARED_DEFINITION_APPLICABLE",
      `${capability.id} raw leaf row retains only its inherited proposal label`);
    assert.equal(webDecision.ruleRef, "EXACT_SOURCE_CHANNEL_LABEL",
      `${capability.id} source-label row is superseded by the exact current owner overlay for Web`);
    assert.equal(webDecision.phase0Admission, "pending");
    assert.equal(webDecision.executionAdmission, "NOT_ADMITTED");
    // A product definition may be machine-only. Only a channel explicitly
    // declared for this leaf is applicable; absence of `web` is a valid scope.
    for (const alias of ["web", "cli", "api", "embedded", "http-api", "grpc-api", "sdk", "product-integration"]) {
      const channelId = aliases[alias];
      if (expectedSourceChannels.has(channelId)) continue;
      const item = channelRows.get(channelId);
      assert.ok(item, `${capability.id} has a decision for undeclared ${alias}`);
      if (["http-api", "grpc-api", "sdk"].includes(alias) && expectedSourceChannels.has(aliases.api)) {
        assert.equal(item.disposition, "PROTOCOL_NEUTRAL_API_APPLICABLE_CONCRETE_BINDING_REQUIRED",
          `${capability.id} protocol-neutral API intent requires an exact ${alias} binding`);
        assert.equal(item.ruleRef, "API_ALIAS_DOES_NOT_ASSERT_HTTP_GRPC_OR_SDK_EQUIVALENCE");
      } else {
        assert.equal(item.disposition, "OWNER_SELECTED_NOT_APPLICABLE_TO_THIS_LEAF",
          `${capability.id} ${alias} is explicitly out of scope when not declared`);
      }
    }
    const legacy = channelRows.get("media.channel.legacy-desktop");
    assert.equal(legacy.disposition, "EXCLUDED_FROM_ACTIVE_PRODUCT_SCOPE");
    assert.equal(legacy.ruleRef, "ARCHIVED_DESKTOP_SOURCE_ONLY");
    const events = channelRows.get("media.channel.event");
    assert.equal(events.disposition, "NOT_A_CAPABILITY_INVOCATION_CHANNEL");
    assert.equal(events.ruleRef, "EVENTS_ARE_VERSIONED_NOTIFICATIONS_NOT_COMMAND_TRANSPORT");
    const agent = channelRows.get("media.channel.agent");
    assert.ok(["OUTSIDE_SELECTED_ACTOR_SCOPE", "DEFINITION_APPLICABLE_REQUIRES_EXACT_AGENT_BINDING"].includes(agent.disposition),
      `${capability.id} agent access is excluded or requires an exact binding`);
    if (agent.disposition === "DEFINITION_APPLICABLE_REQUIRES_EXACT_AGENT_BINDING") {
      assert.equal(agent.ruleRef, "AGENT_ROLE_OR_EXPLICIT_PRODUCT_INTEGRATION");
    }
    assert.equal(row.definitionState, "OWNER_DEFINED_DEFINITION_ONLY", `${capability.id} remains definition-only`);
    assert.equal(row.runtimeAvailability, "UNKNOWN", `${capability.id} does not infer runtime availability`);
  }

  assert.equal(channels.channels.length, 9, "all authored channel identities remain in the denominator");
  assert.equal(channels.channels.filter(({ phase0Admission }) => phase0Admission === "not-admitted").length, 1,
    "only the source-marked archived desktop channel is excluded");
  assert.ok(channels.channels.filter(({ phase0Admission }) => phase0Admission !== "not-admitted")
    .every(({ phase0Admission, runtimeAvailability }) => /pending/u.test(phase0Admission) && runtimeAvailability !== "AVAILABLE"),
  "pending channel proposals never become runtime support claims");
  assert.equal(review.denominatorReconciliation.capabilityLeaves, 462);
  assert.deepEqual(review.denominatorReconciliation.leavesWithUnresolvedApplicability, 383,
    "the old leaf review keeps its historical operation-evidence denominator");
  assert.equal(review.authorityBoundary.historicalReviewEvidenceOnly.gating, false,
    "the historical 383 unresolved operation-evidence rows do not gate current P0 applicability");

  const apiCliOnlyBase = capabilities.find(({ id }) => webNonApplicableIds.has(id));
  const apiCliOnly = { ...apiCliOnlyBase, supportedChannels: ["api", "cli"] };
  const apiCliFamily = familyByCapability.get(apiCliOnly.id);
  const apiCliDecision = resolveOwnerWebContext(apiCliOnly.id, apiCliFamily, mappingByFamily);
  assert.equal(apiCliDecision.applicable, false,
    "an API/CLI-only leaf remains Web-non-applicable even when its family has other Web-consumer leaves");
  assert.equal(apiCliDecision.disposition, "OWNER_SELECTED_NOT_APPLICABLE_TO_THIS_LEAF");
  assert.deepEqual(apiCliDecision.viewRefs, []);
});
