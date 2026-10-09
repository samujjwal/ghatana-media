import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const candidate = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/truth-domain-pdp0-pdp1-owner-candidate-199.json"), "utf8"));
const partition = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/migration-pending-owner-partition-499.json"), "utf8"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const sources = new Map();
const pinnedPlan = execFileSync("git", ["show", "e62514f94c45a4ecbc438d26298bf82b6a6f3d69:docs/migration/expert-reviewed-master-plan.md"], { cwd: root, encoding: "utf8" });

function resolveSelector(ref) {
  const [sourcePath, pointer = ""] = ref.split("#", 2);
  let snapshot = sources.get(sourcePath);
  if (!snapshot) {
    const source = readFileSync(resolve(root, sourcePath), "utf8");
    snapshot = { source, document: parse(source) };
    sources.set(sourcePath, snapshot);
  }
  const { source } = snapshot;
  let value = snapshot.document;
  for (const raw of pointer.split("/").filter(Boolean)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (segment.startsWith("@id=")) {
      assert.ok(Array.isArray(value), `${ref}: @id selector requires an array parent`);
      value = value.find((item) => item?.id === segment.slice(4));
    } else if (/^\d+$/u.test(segment)) value = value[Number(segment)];
    else value = value?.[segment];
    assert.notEqual(value, undefined, `${ref}: unresolved exact source selector segment ${segment}`);
  }
  return { source, value };
}

function validateMaterialReview(row, valuesByRef) {
  const review = row.ownerSemanticReview;
  if (!review || review.acceptanceEffect !== "none" || review.runtimeStatus !== "NOT_EVALUATED") return false;
  if (!Array.isArray(review.exactContractRefs) || review.exactContractRefs.length === 0
    || new Set(review.exactContractRefs).size !== review.exactContractRefs.length
    || review.proposedTargetRef !== review.exactContractRefs[0]) return false;
  const bindingRefs = (review.materialBindings ?? []).map((binding) => binding.ref);
  const isWithinExactSource = (bindingRef) => review.exactContractRefs.some((sourceRef) =>
    bindingRef === sourceRef || bindingRef.startsWith(`${sourceRef}/`));
  if (bindingRefs.some((ref) => !isWithinExactSource(ref))
    || review.exactContractRefs.some((sourceRef) => !bindingRefs.some((bindingRef) => isWithinExactSource(bindingRef)
      && (bindingRef === sourceRef || bindingRef.startsWith(`${sourceRef}/`))))) return false;
  const values = review.exactContractRefs.map((ref) => valuesByRef.get(ref));
  if (values.some((value) => typeof value !== "string")) return false;
  const joined = values.join("\n");
  if (!review.materialPredicates.every((predicate) => joined.includes(predicate))) return false;
  return (review.materialBindings ?? []).every((binding) => isWithinExactSource(binding.ref)
    && typeof valuesByRef.get(binding.ref) === "string"
    && valuesByRef.get(binding.ref).includes(binding.requiredSourcePhrase));
}

test("the complete 199-row truth-owned cohort preserves exact claim identity and current source locators", () => {
  const byId = new Map(partition.records.map((row) => [row.claimId, row]));
  assert.equal(candidate.records.length, 199);
  assert.equal(new Set(candidate.records.map((row) => row.claimId)).size, 199);
  for (const row of candidate.records) {
    const sourceClaim = byId.get(row.claimId);
    assert.ok(sourceClaim, `${row.claimId} remains in the source partition`);
    assert.equal(sha(row.exactSourceText), row.sourceTextSha256, `${row.claimId} exact source text digest`);
    assert.equal(sourceClaim.sourceTextSha256, row.sourceTextSha256);
    assert.equal(sourceClaim.ownerSourceFile, row.ownerSourceFile);
    assert.equal(sourceClaim.currentTargetRef, row.priorLocatorRef);
    assert.equal(sourceClaim.acceptanceEffect, "none");
    assert.equal(row.targetSnapshotStatus, "LIVE_OBSERVATION_UNREVIEWED");
    assert.equal(row.acceptanceEffect ?? row.ownerSemanticReview?.acceptanceEffect ?? "none", "none");
    assert.equal(row.sourcePlanCommit, "e62514f94c45a4ecbc438d26298bf82b6a6f3d69");
    assert.deepEqual(row.sourcePlanLineNumbers, row.exactParentContext.map(({ line }) => line));
    for (const context of row.exactParentContext) {
      const line = pinnedPlan.split(/\r?\n/u)[context.line - 1];
      assert.equal(line, context.text, `${row.claimId} exact parent context line`);
      assert.equal(sha(line), context.sha256, `${row.claimId} exact parent context hash`);
      assert.ok(line.includes(row.exactSourceText), `${row.claimId} exact claim appears in its parent context`);
    }
    const { source, value } = resolveSelector(row.priorLocatorRef);
    const currentValueSha256 = sha(typeof value === "string" ? value : JSON.stringify(value));
    const observation = row.currentProposalObservation;
    assert.equal(observation?.status, "PENDING_COORDINATOR_MATERIAL_REVIEW", `${row.claimId} live source delta remains explicitly pending`);
    assert.equal(observation.priorSourceFileSha256, row.ownerSourceSha256, `${row.claimId} historical file pin is preserved`);
    assert.equal(observation.priorTargetValueSha256, row.currentTargetValueSha256, `${row.claimId} historical value pin is preserved`);
    assert.equal(observation.currentTargetValueSha256, currentValueSha256, `${row.claimId} current observation binds the exact live target value`);
    assert.equal(observation.currentSourceFileSha256, sha(source), `${row.claimId} current observation binds the exact live source file`);
    assert.match(observation.reason, /does not imply acceptance/u);
    assert.ok(row.currentTargetValuePreview);
    assert.ok(source.length > 0, `${row.claimId} owner source was read`);
  }
});

test("only exact heading/table-label spans are classified as non-normative source metadata", () => {
  const expectedLines = new Map([
    ["MPSEM-0022-C001", 101], ["MPSEM-0024-C001", 103], ["MPSEM-0026-C001", 105],
    ["MPSEM-0028-C001", 107], ["MPSEM-0038-C001", 117], ["MPSEM-0040-C001", 119],
    ["MPSEM-0042-C001", 121], ["MPSEM-0043-C001", 122], ["MPSEM-0045-C001", 124],
    ["MPSEM-0046-C001", 125], ["MPSEM-0057-C001", 147], ["MPSEM-0054-C001", 141],
    ["MPSEM-0157-C001", 329], ["MPSEM-0158-C001", 330], ["MPSEM-0159-C001", 331],
    ["MPSEM-0320-C001", 735],
  ]);
  const masterPlanLines = pinnedPlan.split(/\r?\n/u);
  for (const row of candidate.records) {
    const review = row.ownerSemanticReview;
    if (!expectedLines.has(row.claimId)) {
      assert.notEqual(review?.disposition, "NON_NORMATIVE_SOURCE_METADATA", `${row.claimId} cannot inherit a heading disposition`);
      continue;
    }
    const lineNumber = row.exactParentContext[0].line;
    const line = masterPlanLines[lineNumber - 1];
    assert.ok(line.includes(row.exactSourceText.trim()), `${row.claimId} selected text is the exact source row label`);
    const expected = {
      disposition: "NON_NORMATIVE_SOURCE_METADATA",
      proposedTargetRef: null,
      exactContractRefs: [],
      sourceEvidenceRef: `docs/migration/expert-reviewed-master-plan.md#L${lineNumber}`,
      sourceEvidenceSha256: sha(line),
      oracleRef: "tests/pdp-truth-domain-migration-199-owner-candidate.test.mjs#non-normative-source-metadata",
      acceptanceEffect: "none",
    };
    assert.ok([
      "The selected source span is a table/section label only; the adjacent cells/rows contain the normative content and remain separate claims. This label does not define Media behavior or authority.",
      "The selected source span is a table/phase label; its adjacent columns carry the separate normative content. The label itself does not define Media behavior or authority.",
    ].includes(review.reason), `${row.claimId} uses an exact, bounded metadata rationale`);
    const { reason, ...actual } = review;
    assert.deepEqual(actual, expected);
  }
  assert.equal(expectedLines.size, 16);
});

test("claim-specific material clauses resolve exactly and reject weakened or substituted targets", () => {
  const reviewed = candidate.records.filter((row) => row.ownerSemanticReview?.disposition === "SOURCE_RULE_CONTENT_SUPPORTS_CLAIM_AT_DEFINITION_LEVEL");
  assert.equal(reviewed.length, 183);
  for (const row of reviewed) {
    const review = row.ownerSemanticReview;
    assert.equal(review.proposedTargetRef, review.exactContractRefs[0], ` primary target is the first exact owner clause`);
    assert.equal(new Set(review.exactContractRefs).size, review.exactContractRefs.length, `${row.claimId} exact source set is unique`);
    assert.equal(review.acceptanceEffect, "none");
    assert.equal(review.runtimeStatus, "NOT_EVALUATED");
    assert.equal(row.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED", `${row.claimId} is not promoted`);
    const resolved = review.exactContractRefs.map((ref) => {
      const { value } = resolveSelector(ref);
      return { ref, content: typeof value === "string" ? value : JSON.stringify(value) };
    });
    const valuesByRef = new Map(resolved.map(({ ref, content: value }) => [ref, value]));
    for (const binding of review.materialBindings ?? []) {
      const { value, source } = resolveSelector(binding.ref);
      const serialized = typeof value === "string" ? value : JSON.stringify(value);
      valuesByRef.set(binding.ref, serialized);
      assert.equal(binding.currentProposalObservation?.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
      assert.equal(binding.currentProposalObservation?.currentSourceValueSha256, sha(serialized), `${row.claimId} exact current bound source value`);
      assert.equal(binding.currentProposalObservation?.currentSourceFileSha256, sha(source), `${row.claimId} exact current bound source file`);
    }
    assert.equal(validateMaterialReview(row, valuesByRef), true, `${row.claimId} source set contains every listed material clause`);
    for (const binding of review.materialBindings ?? []) {
      const selected = valuesByRef.get(binding.ref);
      assert.ok(selected, `${row.claimId} material clause has an exact source binding`);
      const weakened = new Map(valuesByRef);
      weakened.set(binding.ref, selected.split(binding.requiredSourcePhrase).join(""));
      assert.equal(validateMaterialReview(row, weakened), false, `${row.claimId} weakening a bound clause is rejected`);
    }
    const foreign = candidate.records.find((other) => other.claimId !== row.claimId
      && other.priorLocatorRef !== row.priorLocatorRef
      && !review.exactContractRefs.includes(other.priorLocatorRef));
    assert.ok(foreign);
    const substitutedRow = structuredClone(row);
    const oldPrimaryRef = substitutedRow.ownerSemanticReview.exactContractRefs[0];
    substitutedRow.ownerSemanticReview.exactContractRefs[0] = foreign.priorLocatorRef;
    substitutedRow.ownerSemanticReview.proposedTargetRef = foreign.priorLocatorRef;
    const { value: foreignValue } = resolveSelector(foreign.priorLocatorRef);
    const substituted = new Map(valuesByRef);
    substituted.delete(oldPrimaryRef);
    substituted.set(foreign.priorLocatorRef, typeof foreignValue === "string" ? foreignValue : JSON.stringify(foreignValue));
    assert.equal(validateMaterialReview(substitutedRow, substituted), false, `${row.claimId} rejects valid but unrelated target substitution`);
  }
});

test("job acceptance keeps audit intent and dispatch intent inside one pre-effect durability boundary", () => {
  const { value: operation } = resolveSelector(".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.job.submit.v1");
  const contract = operation.auditIntentBoundary;
  assert.equal(contract.id, "media.operation.job-submit-audit-intent-boundary.v1");
  assert.equal(contract.sourceInvariantRef, ".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp05InvariantMappings/records/@id=media.invariant.audit-intent-precedes-effect");
  assert.deepEqual(contract.requiredBefore, ["externally-reportable-QUEUED-acknowledgement", "provider-crossing", "durable-output-registration"]);
  assert.deepEqual(contract.atomicallyPersistWith, ["jobId", "canonicalRequestFingerprint", "dispatchIntentId", "attemptId", "fencingToken", "authorityDecisionRefs"]);
  assert.match(contract.persistenceRule, /transaction|transactional-outbox/u);
  assert.match(contract.persistenceRule, /partial write must not yield a QUEUED acknowledgement/u);
  assert.match(contract.unavailableBehavior, /do not cross the boundary/u);
  assert.match(contract.unavailableBehavior, /OUTCOME_UNKNOWN/u);
  assert.match(contract.scopeStatus, /DEFINITION_ONLY/u);
  assert.match(contract.scopeStatus, /NOT_EVALUATED/u);

  const valid = (value) => value?.id === contract.id
    && value.sourceInvariantRef === contract.sourceInvariantRef
    && value.requiredBefore.includes("provider-crossing")
    && value.atomicallyPersistWith.includes("dispatchIntentId")
    && /transaction|transactional-outbox/u.test(value.persistenceRule)
    && /do not cross the boundary/u.test(value.unavailableBehavior)
    && /OUTCOME_UNKNOWN/u.test(value.unavailableBehavior);
  assert.equal(valid(contract), true);
  for (const mutation of [
    (value) => { value.atomicallyPersistWith = value.atomicallyPersistWith.filter((field) => field !== "dispatchIntentId"); },
    (value) => { value.requiredBefore = value.requiredBefore.filter((stage) => stage !== "provider-crossing"); },
    (value) => { value.sourceInvariantRef = ".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp05InvariantMappings/records/@id=media.invariant.tenant-isolation"; },
    (value) => { value.persistenceRule = "Persist whatever is available; continue if storage fails."; },
    (value) => { value.unavailableBehavior = "Retry provider dispatch until a receipt appears."; },
  ]) {
    const changed = structuredClone(contract);
    mutation(changed);
    assert.equal(valid(changed), false, "a weakened or substituted durability contract must fail");
  }
});

test("parent cancellation freezes child admission and retains unresolved child effects", () => {
  const { value: operation } = resolveSelector(".product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts/records/@id=media.operation-slice.cancel-job");
  const rule = operation.ownerDefinition.childCancellationRule;
  assert.equal(rule.id, "media.job.child-cancellation-order.v1");
  assert.match(rule.admissionClosure, /stop admitting or dispatching new child work before/u);
  assert.match(rule.childSnapshot, /exact parent job version/u);
  assert.match(rule.activeChildRule, /current attempt\/fence/u);
  assert.match(rule.activeChildRule, /authoritative stop\/finality evidence/u);
  assert.match(rule.parentFinality, /pending or unknown/u);
  assert.match(rule.unknownRule, /UNKNOWN/u);
  assert.match(rule.scopeStatus, /DEFINITION_ONLY/u);
  assert.match(rule.scopeStatus, /NOT_EVALUATED/u);
  const valid = (value) => value?.id === rule.id
    && /stop admitting or dispatching new child work before/u.test(value.admissionClosure)
    && /exact parent job version/u.test(value.childSnapshot)
    && /current attempt\/fence/u.test(value.activeChildRule)
    && /authoritative stop\/finality evidence/u.test(value.activeChildRule)
    && /pending or unknown/u.test(value.parentFinality)
    && /UNKNOWN/u.test(value.unknownRule);
  assert.equal(valid(rule), true);
  for (const mutate of [
    (value) => { value.admissionClosure = "Cancel active children after accepting later child work."; },
    (value) => { value.childSnapshot = "Cancel whatever children appear in a later read."; },
    (value) => { value.activeChildRule = "A cancellation request proves the child stopped."; },
    (value) => { value.parentFinality = "Any child acknowledgement makes the parent terminal."; },
    (value) => { value.unknownRule = "Retry missing child outcomes automatically."; },
  ]) {
    const changed = structuredClone(rule);
    mutate(changed);
    assert.equal(valid(changed), false, "a weakened child cancellation rule must fail");
  }
});

test("quality invalidation is scoped to exact dependency closure and temporal context", () => {
  const { value: rule } = resolveSelector(".product-experience/pdp-0-product-truth/quality-policy.yaml#/continuityPolicy/dependencyInvalidationRule");
  assert.equal(rule.id, "media.quality.dependency-invalidation.v1");
  assert.deepEqual(rule.evaluationIdentity.required, ["projectRevisionRef", "exactSourceVersionRefs", "policyDecisionRef", "methodVersionRef", "contextWindowRef", "dependencyNodeRefs"]);
  assert.match(rule.graphRule, /downstream dependents/u);
  assert.match(rule.graphRule, /Unrelated branches and projects remain valid only when/u);
  assert.match(rule.temporalRepairRule, /half-open context interval/u);
  assert.match(rule.temporalRepairRule, /timebase, source revision, and graph revision must match/u);
  assert.match(rule.recomputationRule, /does not authorize an automatic rerun/u);
  assert.match(rule.recomputationRule, /mark the affected evaluation UNKNOWN/u);
  assert.match(rule.scopeStatus, /DEFINITION_ONLY/u);
  const valid = (value) => value?.id === rule.id
    && value.evaluationIdentity.required.includes("dependencyNodeRefs")
    && value.evaluationIdentity.required.includes("contextWindowRef")
    && /downstream dependents/u.test(value.graphRule)
    && /Unrelated branches and projects remain valid only when/u.test(value.graphRule)
    && /half-open context interval/u.test(value.temporalRepairRule)
    && /graph revision must match/u.test(value.temporalRepairRule)
    && /does not authorize an automatic rerun/u.test(value.recomputationRule)
    && /UNKNOWN/u.test(value.recomputationRule);
  assert.equal(valid(rule), true);
  for (const mutate of [
    (value) => { value.graphRule = "Any change invalidates every project node."; },
    (value) => { value.temporalRepairRule = "A repair invalidates the whole project."; },
    (value) => { value.recomputationRule = "Automatically rerun after invalidation."; },
    (value) => { value.evaluationIdentity.required = value.evaluationIdentity.required.filter((field) => field !== "contextWindowRef"); },
  ]) {
    const changed = structuredClone(rule);
    mutate(changed);
    assert.equal(valid(changed), false, "an overbroad or under-specified invalidation rule must fail");
  }
});

test("material-change disclosure covers narration, rights, egress, spend, and publication before effect", () => {
  const { value: rule } = resolveSelector(".product-experience/pdp-0-product-truth/information-architecture.yaml#/materialChangeDisclosure");
  assert.equal(rule.id, "media.information.material-change-disclosure.v1");
  for (const dimension of [
    "changes-to-fidelity-or-preservation",
    "changes-to-person-or-identity-meaning",
    "changes-to-speech-or-narration-meaning",
    "processing-locality-and-external-egress",
    "requested-and-bounded-cost-or-spend",
    "rights-consent-and-license-scope",
    "recipient-destination-and-publication-effect",
  ]) assert.ok(rule.discloseBeforeEffect.includes(dimension), `missing material disclosure ${dimension}`);
  assert.match(rule.decisionRule, /before the user confirms a consequential external effect/u);
  assert.match(rule.unknownRule, /block or request review before the effect/u);
  assert.match(rule.setupRule, /Do not require unrelated provider, model, engine, queue, or project setup/u);
  const valid = (value) => value?.id === rule.id
    && rule.discloseBeforeEffect.every((dimension) => value.discloseBeforeEffect.includes(dimension))
    && /before the user confirms/u.test(value.decisionRule)
    && /block or request review/u.test(value.unknownRule)
    && /Do not require unrelated/u.test(value.setupRule);
  assert.equal(valid(rule), true);
  for (const mutate of [
    (value) => { value.discloseBeforeEffect = value.discloseBeforeEffect.filter((dimension) => dimension !== "changes-to-speech-or-narration-meaning"); },
    (value) => { value.discloseBeforeEffect = value.discloseBeforeEffect.filter((dimension) => dimension !== "rights-consent-and-license-scope"); },
    (value) => { value.decisionRule = "Show a generic done message after publication."; },
    (value) => { value.setupRule = "Require all providers and queues before any task."; },
  ]) {
    const changed = structuredClone(rule);
    mutate(changed);
    assert.equal(valid(changed), false, "a missing material change or forced unrelated setup must fail");
  }
});

test("versioned autosave distinguishes local, pending, durable, offline, and conflict across mutable resources", () => {
  const { value: operation } = resolveSelector(".product-experience/pdp-1-domain-data/operations.yaml#operations/@id=media.operation.caption-draft-write");
  const rule = operation.autosaveStateSemantics;
  assert.equal(rule.id, "media.caption-draft-autosave-state.v1");
  assert.deepEqual(rule.stateSet, ["DIRTY", "SAVE_PENDING", "ACKNOWLEDGED_LOCAL_REVISION", "OFFLINE_PENDING", "DRAFT_REVISION_CONFLICT", "SAVE_REJECTED"]);
  assert.match(rule.acknowledgement, /exactly draftId and the incremented draftRevision/u);
  assert.match(rule.pending, /do not label the pending edits saved/u);
  assert.match(rule.offline, /do not claim remote synchronization/u);
  assert.match(rule.conflict, /preserve both the candidate edit and current draft snapshot/u);
  assert.match(rule.conflict, /never overwrite by selecting the latest revision implicitly/u);
  const valid = (value) => value?.id === rule.id
    && ["DIRTY", "SAVE_PENDING", "ACKNOWLEDGED_LOCAL_REVISION", "OFFLINE_PENDING", "DRAFT_REVISION_CONFLICT", "SAVE_REJECTED"].every((state) => value.stateSet.includes(state))
    && /exactly draftId and the incremented draftRevision/u.test(value.acknowledgement)
    && /do not label the pending edits saved/u.test(value.pending)
    && /do not claim remote synchronization/u.test(value.offline)
    && /preserve both the candidate edit and current draft snapshot/u.test(value.conflict)
    && /never overwrite by selecting the latest revision implicitly/u.test(value.conflict);
  assert.equal(valid(rule), true);
  for (const mutate of [
    (value) => { value.stateSet = value.stateSet.filter((state) => state !== "OFFLINE_PENDING"); },
    (value) => { value.acknowledgement = "A request was sent."; },
    (value) => { value.pending = "Pending edits are saved."; },
    (value) => { value.offline = "Queue remote submission without showing offline state."; },
    (value) => { value.conflict = "Take latest revision and overwrite."; },
  ]) {
    const changed = structuredClone(rule);
    mutate(changed);
    assert.equal(valid(changed), false, "a collapsed autosave state must fail closed");
  }
  const { value: resourceRule } = resolveSelector(".product-experience/pdp-1-domain-data/operations.yaml#ownerVersionedMutationResourceRule");
  const autosave = resourceRule.autosaveRule;
  assert.match(autosave, /any mutable project, timeline, composition, scene, profile, caption, or edit resource/u);
  assert.match(autosave, /local-draft retention, pending submission, durable acknowledgement, offline-pending, and revision-conflict as distinct typed outcomes/u);
  assert.match(autosave, /local write is not a server acknowledgement/u);
  assert.match(autosave, /authoritative successor revision/u);
  assert.match(autosave, /preserves both the candidate edit and current owner snapshot/u);
  assert.match(autosave, /same request identity and fingerprint/u);
  assert.deepEqual(resourceRule.autosaveApplicability.appliesTo, ["mutable-project-heads", "versioned-composition", "scene-graph-edits", "profile-edits", "caption-drafts", "media-edit-state"]);
  assert.deepEqual(resourceRule.autosaveApplicability.excludes, ["read-only-queries", "immutable-snapshot-creation-without-existing-head"]);
});

test("versioned mutations use exact optimistic compare-and-set and render submission rejects stale project heads", () => {
  const { value: concurrency } = resolveSelector(".product-experience/pdp-1-domain-data/operations.yaml#ownerOptimisticConcurrencyRule");
  assert.equal(concurrency.id, "media.operation.optimistic-concurrency.v1");
  assert.ok(concurrency.applicability.appliesTo.includes("mutable-project-heads"));
  assert.ok(concurrency.applicability.excludes.includes("read-only-queries"));
  assert.match(concurrency.mutationRule, /expected current revision\/version/u);
  assert.match(concurrency.mutationRule, /compare them atomically/u);
  assert.match(concurrency.mutationRule, /typed conflict/u);
  assert.match(concurrency.mutationRule, /preserves both versions/u);
  assert.match(concurrency.replayRule, /cannot resolve a conflict by silently selecting the latest version/u);
  assert.match(concurrency.scopeStatus, /DEFINITION_ONLY/u);

  const { value: submit } = resolveSelector(".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.job.submit.v1");
  const cas = submit.projectRevisionCas;
  assert.equal(cas.id, "media.job-submit-project-revision-cas.v1");
  assert.deepEqual(cas.requiredTuple, ["trustedTenant", "trustedPrincipal", "projectId", "expectedRevisionId"]);
  assert.equal(cas.mismatch, "reject-before-job-acceptance-and-provider-dispatch-with-STALE_PROJECT_REVISION");
  assert.equal(cas.noLatestFallback, true);
  assert.ok(submit.errors.includes("STALE_PROJECT_REVISION"));
  assert.ok(JSON.stringify(submit.ownerWireSchema.resultSchema).includes("STALE_PROJECT_REVISION"));

  const validCas = (value) => value?.id === cas.id
    && value.appliesWhen === "projectContext-is-supplied"
    && ["trustedTenant", "trustedPrincipal", "projectId", "expectedRevisionId"].every((field) => value.requiredTuple.includes(field))
    && /exact-project-and-revision-identity-against-current-authorized-project-head/u.test(value.comparison)
    && /reject-before-job-acceptance-and-provider-dispatch-with-STALE_PROJECT_REVISION/u.test(value.mismatch)
    && value.noLatestFallback === true;
  assert.equal(validCas(cas), true);
  for (const mutate of [
    (value) => { value.requiredTuple = value.requiredTuple.filter((field) => field !== "expectedRevisionId"); },
    (value) => { value.comparison = "Compare only a display label."; },
    (value) => { value.mismatch = "Resolve to the newest project revision and continue."; },
    (value) => { value.noLatestFallback = false; },
  ]) {
    const changed = structuredClone(cas);
    mutate(changed);
    assert.equal(validCas(changed), false, "a stale revision cannot be rebound silently");
  }
});

test("owner error, CRUD, job-dimension, lease, and completion clauses reject weakening", () => {
  const { value: errors } = resolveSelector(".product-experience/pdp-1-domain-data/operations.yaml#ownerErrorResponseContract");
  const expectedErrors = ["VALIDATION", "AUTHENTICATION", "AUTHORIZATION", "POLICY", "RIGHTS_OR_LICENSE", "CAPABILITY_UNAVAILABLE", "CAPACITY_OR_QUOTA", "CONFLICT", "TIMEOUT", "CANCELLATION", "PROVIDER_OUTCOME_AMBIGUOUS", "INTERNAL"];
  assert.deepEqual(errors.errorClasses, expectedErrors);
  assert.ok(errors.requiredResponseFacts.includes("correlationRef"));
  assert.match(errors.redactionRule, /Provider request and response bodies, bearer credentials, signed URLs, secrets/u);
  assert.match(errors.unknownRule, /do not grant access or repeat an effect/u);
  const validErrors = (value) => expectedErrors.every((kind) => value.errorClasses.includes(kind))
    && value.requiredResponseFacts.includes("correlationRef")
    && /Provider request and response bodies/u.test(value.redactionRule)
    && /do not grant access/u.test(value.unknownRule);
  const weakenedErrors = structuredClone(errors);
  weakenedErrors.errorClasses = weakenedErrors.errorClasses.filter((kind) => kind !== "AUTHORIZATION");
  assert.equal(validErrors(weakenedErrors), false);
  const leakedErrors = structuredClone(errors);
  leakedErrors.redactionRule = "Provider bodies may be returned for debugging.";
  assert.equal(validErrors(leakedErrors), false);

  const { value: mutations } = resolveSelector(".product-experience/pdp-1-domain-data/operations.yaml#ownerVersionedMutationResourceRule");
  assert.deepEqual(mutations.mutationKinds, ["CREATE", "READ", "REPLACE", "PATCH", "DELETE_OR_TOMBSTONE"]);
  assert.match(mutations.replacePatchRule, /exact immutable base revision under atomic compare-and-set/u);
  assert.match(mutations.replacePatchRule, /validation runs on the complete successor before commit/u);
  assert.match(mutations.snapshotRule, /Published revisions are immutable snapshots/u);
  assert.match(mutations.deleteRule, /authorized tombstone\/revocation transition/u);
  const validMutation = (value) => value.mutationKinds.includes("PATCH")
    && /exact immutable base revision under atomic compare-and-set/u.test(value.replacePatchRule)
    && /complete successor before commit/u.test(value.replacePatchRule)
    && /immutable snapshots/u.test(value.snapshotRule)
    && /authorized tombstone\/revocation/u.test(value.deleteRule);
  const noCas = structuredClone(mutations);
  noCas.replacePatchRule = "Apply patch to whichever revision is latest.";
  assert.equal(validMutation(noCas), false);
  const mutableSnapshot = structuredClone(mutations);
  mutableSnapshot.snapshotRule = "Published revisions may be edited in place.";
  assert.equal(validMutation(mutableSnapshot), false);

  const { value: dimensions } = resolveSelector(".product-experience/pdp-1-domain-data/operations.yaml#ownerJobStatusDimensionContract");
  assert.deepEqual(dimensions.independentDimensions.map(({ id }) => id), ["overall-job", "stage-progress", "attempt-claim-and-lease", "cancellation-outcome", "remote-outcome-certainty", "quality-disposition", "delivery-status"]);
  assert.match(dimensions.megaEnumRule, /typed tuple of independently versioned dimension refs/u);
  assert.match(dimensions.cancellationRule, /a request, timeout, or user-interface state cannot change overall job status to CANCELLED/u);
  const collapsed = structuredClone(dimensions);
  collapsed.independentDimensions = collapsed.independentDimensions.filter(({ id }) => id !== "delivery-status");
  assert.notDeepEqual(collapsed.independentDimensions.map(({ id }) => id), dimensions.independentDimensions.map(({ id }) => id));

  const { value: lease } = resolveSelector(".product-experience/pdp-1-domain-data/operations.yaml#ownerAttemptLeaseLifecycle");
  assert.match(lease.claimRule, /atomic compare-and-set installs a unique positive fencing token/u);
  assert.match(lease.renewalRule, /before lease expiry/u);
  assert.match(lease.renewalRule, /maximum lease horizon/u);
  assert.match(lease.stageAttemptRule, /new attempt identity/u);
  assert.match(lease.expiryRule, /does not prove that external work stopped/u);
  const unfenced = structuredClone(lease);
  unfenced.claimRule = "A worker may start without a lease.";
  assert.equal(/unique positive fencing token/u.test(unfenced.claimRule), false);

  const { value: completion } = resolveSelector(".product-experience/pdp-1-domain-data/operations.yaml#ownerCompletionQualificationRule");
  for (const required of ["verifiedByteLengthAndSha256", "outputRegistrationReceiptRef", "currentRightsPolicyAndProvenanceRefs", "acceptedResultContractRef", "currentAttemptFenceAndJobRevision"]) {
    assert.ok(completion.requiredEvidence.includes(required), `completion requires ${required}`);
  }
  assert.match(completion.completionRule, /A provider success string, process exit, or missing error is not sufficient evidence/u);
  assert.match(completion.unknownRule, /completion is UNKNOWN/u);
  const unsafe = structuredClone(completion);
  unsafe.requiredEvidence = unsafe.requiredEvidence.filter((item) => item !== "verifiedByteLengthAndSha256");
  assert.equal(unsafe.requiredEvidence.includes("verifiedByteLengthAndSha256"), false);
});

test("erasure inventory preserves shared references, restore tombstones, and remote uncertainty", () => {
  const { value: erasure } = resolveSelector(".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedErasureInventoryContract");
  const shared = erasure.copyInventory.sharedReferenceRule;
  assert.match(shared, /exact versioned-reference inventory/u);
  assert.match(shared, /another authorized retained reference/u);
  assert.match(shared, /PARTIAL or UNKNOWN/u);
  const unsafeDelete = shared.replace(/another authorized retained reference/gu, "no other reference");
  assert.equal(/another authorized retained reference/u.test(unsafeDelete), false);

  const restore = erasure.tombstones.restoreRule;
  assert.match(restore, /Before restored data becomes readable or dispatchable/u);
  assert.match(restore, /replay applicable tombstones/u);
  assert.match(restore, /deny access until reconciliation finishes/u);
  const noRestoreGate = restore.replace(/deny access until reconciliation finishes/u, "allow access during reconciliation");
  assert.equal(/deny access until reconciliation finishes/u.test(noRestoreGate), false);

  const remote = erasure.externalCopyBoundary;
  assert.match(remote.revocation, /revocation is not remote recall/u);
  assert.match(remote.remoteDeletion, /authoritative provider deletion evidence/u);
  assert.match(remote.remoteDeletion, /do not report ERASURE_CONFIRMED/u);
  const falseRemoteReceipt = remote.remoteDeletion.replace(/authoritative provider deletion evidence/gu, "request acceptance");
  assert.equal(/authoritative provider deletion evidence/u.test(falseRemoteReceipt), false);
});
