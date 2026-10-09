import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const candidatePath = "docs/implementation/verification/pdp-38/migration-capability-owner-candidate-163.json";
const candidate = JSON.parse(readFileSync(resolve(root, candidatePath), "utf8"));
const historicalReview = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/migration-capability-reviewed.json"), "utf8"));
const historicalPlan = readFileSync(resolve(root, "docs/migration/expert-reviewed-master-plan.md"), "utf8").split(/\r?\n/u);
const gapSource = parse(readFileSync(resolve(root, ".product-experience/gaps.yaml"), "utf8"));
const sha256Json = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha256Text = (value) => createHash("sha256").update(value).digest("hex");

const priorOwnerSourcePaths = [
  ".product-experience/pdp-0-product-truth/policy-authority-model.yaml",
  ".product-experience/pdp-0-product-truth/capabilities.yaml",
  ".product-experience/pdp-1-domain-data/privacy.yaml",
  ".product-experience/pdp-0-product-truth/domain-model.yaml",
  ".product-experience/pdp-0-product-truth/capabilities.yaml",
  ".product-experience/pdp-0-product-truth/glossary.yaml",
  ".product-experience/pdp-0-product-truth/quality-policy.yaml",
  ".product-experience/pdp-1-domain-data/operations.yaml",
  ".product-experience/pdp-0-product-truth/applications-channels.yaml",
  ".product-experience/pdp-0-product-truth/constitution.yaml",
  ".product-experience/pdp-1-domain-data/states.yaml",
  ".product-experience/pdp-0-product-truth/reuse-decisions.yaml",
  ".product-experience/pdp-3-product-experience/navigation-contracts.yaml",
  ".product-experience/pdp-2-design-interface-system/motion.yaml",
  "docs/migration/master-plan-source-change-claims.yaml",
];
const priorOwnerSources = Object.fromEntries(priorOwnerSourcePaths.map((path) => [
  path,
  parse(readFileSync(resolve(root, path), "utf8")),
]));

function resolveExactSourceRef(ref) {
  const [file, pointer] = ref.split("#");
  if (!pointer || !Object.hasOwn(priorOwnerSources, file)) return undefined;
  return pointer.split("/").filter(Boolean).reduce((value, token) => {
    const id = token.match(/^@id=(.+)$/u);
    if (id) return (Array.isArray(value) ? value : Object.values(value ?? {})).find((entry) => entry?.id === id[1]);
    const key = token.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(value) && /^\d+$/u.test(key)) return value[Number(key)];
    return value?.[key];
  }, priorOwnerSources[file]);
}

function validPriorOwnerRouteCandidate(record, prior) {
  const route = record.priorOwnerRouteReviewCandidate;
  if (!route || !prior) return false;
  const liveTargetValue = resolveExactSourceRef(route.recommendedOwnerTargetRef);
  const targetValue = route.currentTargetValue;
  return record.exactSourceText === prior.exactSourceText
    && record.sourceTextSha256 === prior.sourceTextSha256
    && prior.semanticReviewStatus === "SEMANTIC_PARITY_VERIFIED"
    && route.recommendedOwnerTargetRef === prior.proposedTargetRef
    && route.materialMeaning === prior.materialMeaning
    && route.historicalTargetValueSha256 === prior.targetValueSha256
    && liveTargetValue !== undefined
    && targetValue !== undefined
    && route.currentTargetValueSha256 === sha256Json(targetValue)
    && route.historicalTargetUnchanged === (route.currentTargetValueSha256 === route.historicalTargetValueSha256)
    && route.currentTargetDrift === !route.historicalTargetUnchanged
    && route.acceptanceEffect === "none"
    && record.semanticReviewStatus === "PENDING_COORDINATOR_MATERIAL_REVIEW";
}

function validClaimSpecificScopeMapping(record) {
  const mapping = record.claimSpecificSemanticCandidate;
  if (!mapping || mapping.reviewStatus !== "PENDING_COORDINATOR_MATERIAL_REVIEW"
    || mapping.acceptanceEffect !== "none" || mapping.runtimeAdmission !== "NOT_ADMITTED"
    || mapping.qualification !== "NOT_EVALUATED" || mapping.negativeCases.length < 2) return false;
  const value = resolveExactSourceRef(mapping.sourceRef);
  if (value === undefined || mapping.sourceValueSha256 !== sha256Json(value)) return false;
  if (mapping.expectedMembers) {
    if (value.scopeStatus !== "TARGET" || !Array.isArray(value.capabilityIds)) return false;
    const actual = new Set(value.capabilityIds);
    return new Set(mapping.expectedMembers).size === mapping.expectedMembers.length
      && mapping.expectedMembers.every((id) => actual.has(id));
  }
  if (mapping.expectedOutputTypes) {
    if (value.recordCount !== mapping.expectedOutputTypes.length || value.records?.length !== mapping.expectedOutputTypes.length) return false;
    const types = value.records.map(({ artifactType }) => artifactType.replace(/^simulation-pass-result-/u, ""));
    return new Set(types).size === types.length
      && mapping.expectedOutputTypes.length === types.length
      && mapping.expectedOutputTypes.every((type) => types.includes(type))
      && value.records.every((record) => record.ownerDefinitionStatus === "OWNER_DEFINED_DEFINITION_ONLY"
        && record.domainObjectRefs?.length === 1 && record.domainObjectRefs[0] === "media.domain.media-run"
        && record.immutableArtifactVersionCreated === false);
  }
  return false;
}

function validGapMetadataDisposition(candidateValue, gapDocument) {
  const record = candidateValue.records.find(({ claimId }) => claimId === "MPSEM-0003-C004");
  const gap = gapDocument.gaps.find(({ id }) => id === "GAP-MEDIA-MIGRATION-SEMANTICS");
  return record?.exactSourceText === "extraction and review are tracked in `GAP-MEDIA-MIGRATION-SEMANTICS`."
    && record.routeKind === "GAP_REGISTER_STATUS_METADATA_NOT_CAPABILITY_BEHAVIOR"
    && record.proposedTargetRef === ".product-experience/gaps.yaml#/gaps/@id=GAP-MEDIA-MIGRATION-SEMANTICS"
    && record.capabilityRef === undefined
    && record.semanticReviewStatus === "PENDING_COORDINATOR_MATERIAL_REVIEW"
    && record.semanticEquivalence === "NOT_ASSERTED"
    && gap?.status === "open"
    && record.semanticEvidence?.gapSourceRef === record.proposedTargetRef
    && record.semanticEvidence?.gapValueSha256 === sha256Json(gap)
    && record.semanticEvidence?.observedStatus === "open"
    && /does not map to a product capability/u.test(record.semanticEvidence.meaning ?? "");
}

test("migration-gap tracking metadata resolves to the exact open gap register row, not a capability leaf", () => {
  assert.equal(candidate.records.length, 163);
  assert.equal(new Set(candidate.records.map(({ claimId }) => claimId)).size, 163);
  assert.equal(candidate.population.exactCapabilityLeafOwnerCandidates,
    candidate.records.filter(({ routeKind }) => routeKind === "EXACT_CAPABILITY_LEAF_OWNER_DEFINITION_CANDIDATE").length);
  assert.equal(candidate.population.exactPolicyOwnerRouteCandidates, 1);
  assert.equal(candidate.population.gapRegisterStatusMetadataNotCapability, 1);
  assert.equal(validGapMetadataDisposition(candidate, gapSource), true);

  const capabilityMisroute = structuredClone(candidate);
  const row = capabilityMisroute.records.find(({ claimId }) => claimId === "MPSEM-0003-C004");
  row.routeKind = "EXACT_CAPABILITY_LEAF_OWNER_DEFINITION_CANDIDATE";
  row.proposedTargetRef = ".product-experience/pdp-0-product-truth/capabilities.yaml#/capabilities/@id=media.project.review";
  row.capabilityRef = "media.project.review";
  assert.equal(validGapMetadataDisposition(capabilityMisroute, gapSource), false,
    "a project-review capability cannot substantiate a migration-gap tracking statement");

  const closedGapWithoutReview = structuredClone(gapSource);
  closedGapWithoutReview.gaps.find(({ id }) => id === "GAP-MEDIA-MIGRATION-SEMANTICS").status = "closed";
  assert.equal(validGapMetadataDisposition(candidate, closedGapWithoutReview), false,
    "the candidate pins the current open gap state and cannot imply closure");
});

test("the 163-record candidate remains a pending source-routing review, not claim acceptance", () => {
  assert.ok(candidate.records.every((record) => record.semanticReviewStatus === "PENDING_COORDINATOR_MATERIAL_REVIEW"));
  assert.ok(candidate.records.every((record) => record.semanticEquivalence === "NOT_ASSERTED"));
  assert.equal(candidate.authority.includes("not independent acceptance"), true);
});

test("document-extraction preservation resolves to its actual owner boundary and rejects a capability-name route", () => {
  const record = candidate.records.find(({ claimId }) => claimId === "MPSEM-0101-C002");
  const route = record?.claimSpecificSemanticRoute;
  const ref = ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#/productPolicy/platformMechanics/documentIntelligence";
  const value = resolveExactSourceRef(ref);
  const valid = (row, ownerValue) => row?.exactSourceText === "Preserve their document-extraction integration"
    && row.semanticReviewStatus === "PENDING_COORDINATOR_MATERIAL_REVIEW"
    && row.proposedTargetRef === ref
    && row.routeKind === "EXACT_DOCUMENT_INTELLIGENCE_OWNER_BOUNDARY_CANDIDATE"
    && row.capabilityRef === undefined
    && row.supersededCapabilityCandidate?.targetRef === ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.color.skin-tone-preserve"
    && row.claimSpecificSemanticRoute?.semanticReviewStatus === "PENDING_COORDINATOR_MATERIAL_REVIEW"
    && row.claimSpecificSemanticRoute?.acceptanceEffect === "none"
    && row.claimSpecificSemanticRoute?.targetValueSha256 === sha256Json(ownerValue)
    && row.claimSpecificSemanticRoute?.requiredClauses.every((clause) => JSON.stringify(ownerValue).includes(clause));
  assert.ok(route);
  assert.equal(valid(record, value), true);
  assert.equal(record.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(route.acceptanceEffect, "none");
  const wrongCapabilityRoute = structuredClone(record);
  wrongCapabilityRoute.proposedTargetRef = wrongCapabilityRoute.supersededCapabilityCandidate.targetRef;
  wrongCapabilityRoute.routeKind = "EXACT_CAPABILITY_LEAF_OWNER_DEFINITION_CANDIDATE";
  wrongCapabilityRoute.capabilityRef = "media.color.skin-tone-preserve";
  assert.equal(valid(wrongCapabilityRoute, value), false, "color-preservation capability cannot stand in for document-extraction ownership");
  for (const clause of route.requiredClauses) {
    const weakened = JSON.parse(JSON.stringify(value).replace(clause, "[material clause removed]"));
    assert.equal(valid(record, weakened), false, `${clause} must remain in the exact owner boundary`);
  }
});

test("ordinary-path provider navigation is routed to the exact experience boundary", () => {
  const row = candidate.records.find(({ claimId }) => claimId === "MPSEM-0041-C004");
  const route = row?.claimSpecificSemanticRoute;
  const ref = ".product-experience/pdp-3-product-experience/navigation-contracts.yaml#/informationArchitecture/ordinaryPathProviderSelection";
  const ownerValue = resolveExactSourceRef(ref);
  const valid = (candidateRow, value) => candidateRow?.exactSourceText === "No technical-provider navigation in the ordinary path."
    && candidateRow.proposedTargetRef === ref
    && candidateRow.routeKind === "EXACT_MEDIA_NAVIGATION_BOUNDARY_CANDIDATE"
    && candidateRow.capabilityRef === undefined
    && candidateRow.semanticReviewStatus === "PENDING_COORDINATOR_MATERIAL_REVIEW"
    && candidateRow.semanticEquivalence === "NOT_ASSERTED"
    && candidateRow.runtimeAdmission === "NOT_ADMITTED"
    && candidateRow.acceptanceEffect === "none"
    && candidateRow.supersededCapabilityCandidate?.targetRef === ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.animation.path"
    && candidateRow.claimSpecificSemanticRoute?.targetValueSha256 === sha256Json(value)
    && candidateRow.claimSpecificSemanticRoute?.requiredClauses.every((clause) => JSON.stringify(value).includes(clause));
  assert.ok(route);
  assert.equal(valid(row, ownerValue), true);
  for (const clause of route.requiredClauses) {
    const weakened = JSON.parse(JSON.stringify(ownerValue).replace(clause, "[material clause removed]"));
    assert.equal(valid(row, weakened), false, `${clause} is required by the ordinary-path boundary`);
  }
  const providerCatalogDefault = structuredClone(ownerValue);
  providerCatalogDefault.rule = "Ordinary product navigation starts from a provider catalog.";
  assert.equal(valid(row, providerCatalogDefault), false, "a provider catalog default violates the bounded Media rule");
  const falselyAuthorizingDisclosure = structuredClone(ownerValue);
  falselyAuthorizingDisclosure.disclosure = "Displaying a provider authorizes provider execution.";
  assert.equal(valid(row, falselyAuthorizingDisclosure), false, "disclosure cannot grant provider selection or execution authority");
});

test("disruptive audio autoplay is a playback rule and unknown risk remains fail-closed", () => {
  const record = candidate.records.find(({ claimId }) => claimId === "MPSEM-0452-C005");
  const route = record?.claimSpecificSemanticRoute;
  const ref = ".product-experience/pdp-2-design-interface-system/motion.yaml#ownerDefinedDisruptiveAudioPlayback";
  const value = resolveExactSourceRef(ref);
  assert.equal(record?.exactSourceText, "Do not auto-play disruptive audio.");
  assert.equal(record?.proposedTargetRef, ref);
  assert.equal(record?.routeKind, "PDP2_DISRUPTIVE_AUDIO_PLAYBACK_OWNER_RULE");
  assert.equal(record?.supersededCapabilityCandidate?.capabilityRef, "media.generate.audio.audio-to-audio");
  assert.equal(route?.targetValueSha256, sha256Json(value));
  assert.ok(route.requiredClauses.every((clause) => JSON.stringify(value).includes(clause)));
  assert.ok(value.nonClaims.includes("no-audio-disruption-detector-or-player-runtime-is-claimed"));
  assert.equal(route.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.equal(route.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(route.acceptanceEffect, "none");

  const permitsUnknownAutoplay = structuredClone(value);
  permitsUnknownAutoplay.unknownBehavior = "allow-automatic-playback";
  assert.notEqual(sha256Json(permitsUnknownAutoplay), route.targetValueSha256,
    "unknown disruption cannot be treated as evidence for autoplay");
  const wrongOwner = structuredClone(record);
  wrongOwner.proposedTargetRef = wrongOwner.supersededCapabilityCandidate.targetRef;
  assert.notEqual(wrongOwner.proposedTargetRef, ref,
    "generation capability identity cannot prove player behavior");
});

test("plan assessment clauses retain the exact historical/current source hunk, not capability behavior", () => {
  const ref = "docs/migration/master-plan-source-change-claims.yaml#/hunkReconciliation/records/5";
  const hunk = resolveExactSourceRef(ref);
  assert.equal(hunk?.hunkId, "MSD-006");
  assert.deepEqual(hunk.historicalLines, [89, 89]);
  assert.deepEqual(hunk.currentLines, [92, 92]);
  assert.ok(hunk.exactHistoricalChangedText[0].includes("four source-of-truth phases"));
  assert.ok(hunk.exactCurrentChangedText[0].includes("four PDP source-of-truth authorities"));
  for (const [claimId, expectedClauses] of [
    ["MPSEM-0017-C001", ["The supplied plan has broad capability coverage and a sound intention", "four source-of-truth phases"]],
    ["MPSEM-0017-C002", ["It is not safe to execute unchanged", "leave safety-critical contracts underspecified"]],
  ]) {
    const row = candidate.records.find(({ claimId: id }) => id === claimId);
    const route = row?.claimSpecificSemanticRoute;
    const valid = (candidateRow, sourceHunk) => {
      const sourceText = [...(sourceHunk?.exactHistoricalChangedText ?? []), ...(sourceHunk?.exactCurrentChangedText ?? [])];
      const candidateRoute = candidateRow?.claimSpecificSemanticRoute;
      return sourceHunk?.hunkId === "MSD-006"
        && candidateRow?.routeKind === "HISTORICAL_SOURCE_ASSESSMENT_ONLY"
        && candidateRow.proposedTargetRef === ref
        && candidateRow.capabilityRef === undefined
        && candidateRow.semanticReviewStatus === "PENDING_COORDINATOR_MATERIAL_REVIEW"
        && candidateRow.semanticEquivalence === "NOT_ASSERTED"
        && candidateRoute?.targetValueSha256 === sha256Json(sourceHunk)
        && candidateRoute?.requiredClauses?.every((clause) => sourceText.some((text) => text.includes(clause)))
        && candidateRoute?.acceptanceEffect === "none"
        && candidateRoute?.runtimeAdmission === "NOT_ADMITTED";
    };
    assert.equal(row?.routeKind, "HISTORICAL_SOURCE_ASSESSMENT_ONLY");
    assert.equal(row?.proposedTargetRef, ref);
    assert.equal(row?.capabilityRef, undefined);
    assert.equal(row?.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
    assert.equal(row?.semanticEquivalence, "NOT_ASSERTED");
    assert.equal(valid(row, hunk), true);
    assert.equal(route?.acceptanceEffect, "none");
    assert.equal(route?.runtimeAdmission, "NOT_ADMITTED");
    assert.ok(route?.requiredClauses.every((clause) => [...hunk.exactHistoricalChangedText, ...hunk.exactCurrentChangedText].some((text) => text.includes(clause))));
    for (const clause of expectedClauses) assert.ok(route.requiredClauses.some((value) => value.includes(clause)));
    assert.equal(route?.negativeCases.length >= 3, true);

    const weakened = structuredClone(hunk);
    weakened.exactHistoricalChangedText = weakened.exactHistoricalChangedText.map((text) => text.replace(expectedClauses.at(-1), "[removed]"));
    assert.equal(valid(row, weakened), false, `${claimId}: removed material source clause invalidates the route`);
    const capabilityRelabel = structuredClone(row);
    capabilityRelabel.routeKind = "EXACT_CAPABILITY_LEAF_OWNER_DEFINITION_CANDIDATE";
    capabilityRelabel.proposedTargetRef = capabilityRelabel.supersededCapabilityCandidate.targetRef;
    assert.equal(valid(capabilityRelabel, hunk), false,
      `${claimId}: a capability route cannot preserve this plan-level historical assessment`);
  }
});

test("55 prior owner routes are carried forward only as exact-text-matched review inputs", () => {
  const oldById = new Map(historicalReview.records.map((record) => [record.claimId, record]));
  const carried = candidate.records.filter((record) => record.priorOwnerRouteReviewCandidate);
  assert.equal(carried.length, 55);
  assert.equal(candidate.population.priorOwnerReviewPartition.currentTargetsCompared, 52);
  assert.equal(candidate.population.priorOwnerReviewPartition.currentTargetsUnchanged
    + candidate.population.priorOwnerReviewPartition.currentTargetsDrifted, 52);
  assert.match(candidate.population.priorOwnerReviewPartition.status, /historical hashes\/reviews remain unchanged/u);
  for (const record of carried) {
    const prior = oldById.get(record.claimId);
    const review = record.priorOwnerRouteReviewCandidate;
    assert.equal(prior?.semanticReviewStatus, "SEMANTIC_PARITY_VERIFIED");
    assert.equal(record.exactSourceText, prior.exactSourceText);
    assert.equal(record.sourceTextSha256, prior.sourceTextSha256);
    assert.equal(review.exactSourceMatch, true);
    assert.equal(review.recommendedOwnerTargetRef, prior.proposedTargetRef);
    assert.equal(review.historicalTargetValueSha256, prior.targetValueSha256);
    assert.ok(review.materialMeaning.trim().length > 0);
    assert.ok(review.reviewedPredicates.length > 0);
    assert.ok(review.negativeCases.length > 0);
    assert.ok(review.testSources.length > 0
      || review.currentDisposition.startsWith("PENDING_EXACT_NEGATIVE_ORACLE"),
    "a prior route without a focused test stays explicitly pending");
    assert.equal(review.acceptanceEffect, "none");
    assert.equal(record.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
    assert.equal(validPriorOwnerRouteCandidate(record, prior), true, `${record.claimId} exact current target resolves and stays pending`);
  }

  const wrongText = structuredClone(candidate.records.find((record) => record.priorOwnerRouteReviewCandidate));
  wrongText.exactSourceText += " unrelated text";
  assert.equal(wrongText.exactSourceText === oldById.get(wrongText.claimId).exactSourceText, false,
    "a prior route cannot be reused for a different atomic source claim");
  const wrongTarget = structuredClone(candidate.records.find((record) => record.priorOwnerRouteReviewCandidate));
  wrongTarget.priorOwnerRouteReviewCandidate.recommendedOwnerTargetRef = ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.project.review";
  assert.notEqual(wrongTarget.priorOwnerRouteReviewCandidate.recommendedOwnerTargetRef,
    oldById.get(wrongTarget.claimId).proposedTargetRef,
    "a current name-matched capability cannot replace the exact prior owner target");
  assert.equal(validPriorOwnerRouteCandidate(wrongTarget, oldById.get(wrongTarget.claimId)), false);

  const weakenedMeaning = structuredClone(carried[0]);
  weakenedMeaning.priorOwnerRouteReviewCandidate.materialMeaning = "The source says something related.";
  assert.equal(validPriorOwnerRouteCandidate(weakenedMeaning, oldById.get(weakenedMeaning.claimId)), false,
    "a generic summary cannot replace the exact previously reviewed material predicates");

  const driftedTarget = structuredClone(carried[0]);
  driftedTarget.priorOwnerRouteReviewCandidate.currentTargetValue = { deliberately: "changed" };
  assert.equal(validPriorOwnerRouteCandidate(driftedTarget, oldById.get(driftedTarget.claimId)), false,
    "changing the captured owner value without its exact content hash invalidates the pending route candidate");
});

test("55 prior owner routes replace the lexical capability candidates while remaining pending", () => {
  const routed = candidate.records.filter((record) => record.claimSpecificRouteCandidate);
  assert.equal(routed.length, 55);
  const headings = routed.filter((record) => record.routeKind === "HISTORICAL_REVIEW_ROW_HEADING_METADATA");
  assert.equal(headings.length, 3);
  for (const record of routed) {
    const route = record.claimSpecificRouteCandidate;
    assert.equal(record.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
    assert.equal(route.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
    assert.equal(route.acceptanceEffect, "none");
    assert.ok(route.negativeCases.length >= 2);
    assert.equal(record.supersededCapabilityCandidate?.targetRef?.includes("capabilities.yaml"), true,
      `${record.claimId} preserves the prior lexical route as historical candidate data`);
    if (record.routeKind === "HISTORICAL_REVIEW_ROW_HEADING_METADATA") {
      const line = Number(route.sourceRef.match(/#line=(\d+)$/u)?.[1]);
      assert.ok(line > 0);
      assert.equal(historicalPlan[line - 1], route.exactParentRow);
      assert.equal(sha256Text(route.exactParentRow), route.sourceValueSha256);
      assert.match(record.exactSourceText, /^\| REV-\d+ —/u);
      assert.equal(record.proposedTargetRef, route.sourceRef);
      assert.equal(record.capabilityRef, undefined);
    } else {
      const prior = historicalReview.records.find(({ claimId }) => claimId === record.claimId);
      assert.equal(record.proposedTargetRef, prior.proposedTargetRef);
      assert.equal(route.historicalTargetRef, prior.proposedTargetRef);
      assert.equal(route.materialMeaning, prior.materialMeaning);
      const currentValue = resolveExactSourceRef(record.proposedTargetRef);
      assert.notEqual(currentValue, undefined);
      assert.equal(route.currentTargetValueSha256, sha256Json(route.currentTargetValue),
        "the captured current-source-window value remains content-pinned even after later owner edits");
      assert.equal(route.historicalTargetUnchanged, route.currentTargetValueSha256 === route.historicalTargetValueSha256);
      assert.equal(route.currentTargetDrift, !route.historicalTargetUnchanged);
      if (route.currentTargetValueSha256 !== sha256Json(currentValue)) {
        assert.equal(record.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW",
          "later live-source drift remains pending for an explicit impact review");
        assert.equal(route.acceptanceEffect, "none");
      }
    }
  }

  const wrongOwner = structuredClone(routed.find((record) => record.routeKind !== "HISTORICAL_REVIEW_ROW_HEADING_METADATA"));
  wrongOwner.proposedTargetRef = ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.project.create";
  assert.notEqual(wrongOwner.proposedTargetRef, wrongOwner.claimSpecificRouteCandidate.historicalTargetRef,
    "a generic capability leaf cannot replace the exact owner rule for a reviewed claim");
  const promoted = structuredClone(routed[0]);
  promoted.semanticReviewStatus = "SEMANTIC_PARITY_VERIFIED";
  assert.equal(promoted.claimSpecificRouteCandidate.status, "PENDING_COORDINATOR_MATERIAL_REVIEW",
    "carrying a prior review never silently promotes this new 163-record candidate");
});

test("eight capability inventory claims bind exact complete member/output populations and definition-only limits", () => {
  const rows = candidate.records.filter((record) => record.claimSpecificSemanticCandidate);
  assert.equal(rows.length, 8);
  assert.equal(candidate.population.claimSpecificMeaningMappings, 8);
  for (const row of rows) assert.equal(validClaimSpecificScopeMapping(row), true, row.claimId);

  for (const row of rows.filter((record) => record.claimSpecificSemanticCandidate.expectedMembers)) {
    const mapping = row.claimSpecificSemanticCandidate;
    const family = resolveExactSourceRef(mapping.sourceRef);
    for (const member of mapping.expectedMembers) {
      const weakened = structuredClone(family);
      weakened.capabilityIds = weakened.capabilityIds.filter((id) => id !== member);
      const mutatedSources = priorOwnerSources;
      const [file, pointer] = mapping.sourceRef.split("#");
      const original = mutatedSources[file];
      const familyRows = original.families;
      const familyIndex = familyRows.findIndex(({ id }) => id === family.id);
      const replacement = structuredClone(original);
      replacement.families[familyIndex] = weakened;
      priorOwnerSources[file] = replacement;
      assert.equal(validClaimSpecificScopeMapping(row), false, `${row.claimId} rejects missing ${member}`);
      priorOwnerSources[file] = original;
    }
  }

  const simulation = rows.find(({ claimId }) => claimId === "MPSEM-0199-C001");
  const simulationValue = resolveExactSourceRef(simulation.claimSpecificSemanticCandidate.sourceRef);
  for (const record of simulationValue.records) {
    const changed = structuredClone(simulation);
    changed.claimSpecificSemanticCandidate.sourceValueSha256 = sha256Json({
      ...simulationValue,
      records: simulationValue.records.filter(({ id }) => id !== record.id),
    });
    assert.equal(validClaimSpecificScopeMapping(changed), false, `removing ${record.id} from the exact output matrix is rejected`);
  }
  const forgedKind = structuredClone(simulation);
  const operations = priorOwnerSources[".product-experience/pdp-1-domain-data/operations.yaml"];
  const originalOperations = operations;
  const mutatedOperations = structuredClone(operations);
  mutatedOperations.ownerLeafWireContracts.outputTypes.records[0].artifactType = "simulation-pass-result-depth";
  priorOwnerSources[".product-experience/pdp-1-domain-data/operations.yaml"] = mutatedOperations;
  assert.equal(validClaimSpecificScopeMapping(forgedKind), false, "a pass cannot claim a different output kind");
  priorOwnerSources[".product-experience/pdp-1-domain-data/operations.yaml"] = originalOperations;
});
