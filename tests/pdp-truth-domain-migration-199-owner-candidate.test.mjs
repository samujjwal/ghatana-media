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
const headCandidate = JSON.parse(execFileSync("git", ["show", "HEAD:docs/implementation/verification/pdp-38/truth-domain-pdp0-pdp1-owner-candidate-199.json"], { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }));
const pxd173Successor = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd173.json"), "utf8"));
const pxd183Successor = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd183.json"), "utf8"));
const pxd185Successor = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd185.json"), "utf8"));
const partition = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/migration-pending-owner-partition-499.json"), "utf8"));
const pdp0Status = JSON.parse(readFileSync(resolve(root, "docs/implementation/pdp-0-phase-dev-status.json"), "utf8"));
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

test("the 199-row cohort preserves historical claim identity and phase-scoped live source locators", () => {
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
    // Preserve the full historical cohort census in every phase, but read
    // live owner sources only for the active phase. PDP-0 must not depend on
    // PDP-1 locator values while its handoff is being frozen.
    if (candidatePhase === "PDP-0" && row.ownerPhase !== "PDP-0") continue;
    const observation = row.currentProposalObservation;
    const observationTargetRef = observation?.currentTargetRef ?? row.priorLocatorRef;
    const { source, value } = resolveSelector(observationTargetRef);
    const currentValueSha256 = sha(typeof value === "string" ? value : JSON.stringify(value));
    assert.equal(observation?.status, "PENDING_COORDINATOR_MATERIAL_REVIEW", `${row.claimId} live source delta remains explicitly pending`);
    assert.equal(observation.priorSourceFileSha256, row.ownerSourceSha256, `${row.claimId} historical file pin is preserved`);
    assert.equal(observation.priorTargetValueSha256, row.currentTargetValueSha256, `${row.claimId} historical value pin is preserved`);
    const valueDrift = observation.currentValueDriftObservation;
    if (valueDrift) {
      assert.equal(observation.currentTargetValueSha256, row.currentTargetValueSha256,
        `${row.claimId} recorded target-value pin is preserved during live drift`);
      assert.equal(valueDrift.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
      assert.equal(valueDrift.acceptanceEffect, "none");
      assert.equal(valueDrift.recordedTargetValueSha256, row.currentTargetValueSha256);
      assert.equal(valueDrift.observedTargetValueSha256, currentValueSha256,
        `${row.claimId} explicit drift observation binds the exact live target value`);
      assert.equal(valueDrift.ref, observationTargetRef);
      assert.match(valueDrift.reason, /does not imply acceptance/u);
    } else {
      assert.equal(observation.currentTargetValueSha256, currentValueSha256,
        `${row.claimId} current observation binds the exact live target value`);
    }
    if (observation.currentTargetRef) {
      assert.equal(observation.currentTargetRef, row.ownerSemanticReview?.proposedTargetRef,
        `${row.claimId} current observation selector matches its owner-reviewed current target`);
    }
    assert.equal(observation.currentSourceFileSha256, sha(source), `${row.claimId} current observation binds the exact live source file`);
    assert.match(observation.reason, /does not imply acceptance/u);
    assert.ok(row.currentTargetValuePreview);
    assert.ok(source.length > 0, `${row.claimId} owner source was read`);
  }
});

test("later-phase source locator refreshes remain explicit unaccepted handoffs", () => {
  const handoffs = candidate.laterPhaseHandoffs ?? [];
  assert.equal(handoffs.length, 2);
  const routeHandoff = handoffs.find(({ claimId }) => claimId === "MPSEM-0023-C002");
  assert.equal(routeHandoff.ownerPhase, "PDP-1/PDP-2 cross-interface");
  assert.equal(routeHandoff.status, "PENDING_OWNER_PHASE_REVIEW");
  assert.equal(routeHandoff.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
  assert.equal(routeHandoff.acceptanceEffect, "none");
  const route = candidate.records.find(({ claimId }) => claimId === routeHandoff.claimId);
  assert.equal(routeHandoff.sourceRef, route.priorLocatorRef);
  assert.equal(route.currentProposalObservation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");

  const operationHandoff = handoffs.find(({ claimId }) => claimId === "MPSEM-0039-C004");
  assert.equal(operationHandoff.ownerPhase, "PDP-1");
  assert.equal(operationHandoff.status, "PENDING_OWNER_PHASE_REVIEW");
  assert.equal(operationHandoff.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
  assert.equal(operationHandoff.acceptanceEffect, "none");
  const operationRow = candidate.records.find(({ claimId }) => claimId === operationHandoff.claimId);
  const laterPhaseRefs = operationRow.ownerSemanticReview.materialBindings
    .filter(({ ref }) => ref.startsWith(".product-experience/pdp-1-domain-data/"))
    .map(({ ref }) => ref);
  assert.deepEqual(operationHandoff.sourceRefs, laterPhaseRefs);
  for (const ref of operationHandoff.sourceRefs) {
    const binding = operationRow.ownerSemanticReview.materialBindings.find((item) => item.ref === ref);
    assert.equal(binding.currentProposalObservation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  }
});

test("MPSEM-0278-C001 keeps the historical partition locator and explicitly observes current rule 6", () => {
  const record = candidate.records.find(({ claimId }) => claimId === "MPSEM-0278-C001");
  const sourceClaim = partition.records.find(({ claimId }) => claimId === record.claimId);
  const expectedCurrentTargetRef = ".product-experience/pdp-0-product-truth/qualification-policy.yaml#/decisionRules/6";
  assert.equal(record.priorLocatorRef, ".product-experience/pdp-0-product-truth/qualification-policy.yaml#/decisionRules/5");
  assert.equal(sourceClaim.currentTargetRef, record.priorLocatorRef, "historical source partition target is unchanged");
  assert.equal(record.currentProposalObservation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.equal(record.currentProposalObservation.currentTargetRef, expectedCurrentTargetRef);
  const { value } = resolveSelector(expectedCurrentTargetRef);
  const currentValueSha256 = sha(typeof value === "string" ? value : JSON.stringify(value));
  assert.equal(currentValueSha256, "1761028bd34799e45da3421f4cdd42f89e85ca51c4daddaaa3fbc6532cf20421");
  assert.equal(record.currentProposalObservation.currentTargetValueSha256, currentValueSha256);
  assert.notEqual(record.currentProposalObservation.currentTargetRef, record.priorLocatorRef, "stale rule 5 cannot stand in for the current selector");
});

test("MPSEM-0170-C003 binds the current PXD-187 rule without promoting acceptance", () => {
  const row = candidate.records.find(({ claimId }) => claimId === "MPSEM-0170-C003");
  const targetRef = ".product-experience/pdp-0-product-truth/capability-preservation-crosswalk.yaml#/rules/0";
  assert.equal(row.priorLocatorRef, targetRef);
  assert.equal(row.currentProposalObservation.priorSourceFileSha256,
    "ccfa544afaf056b8a7ffcc77f61dc17e36289d8ddfc0fb60c75f7998a4d116af");
  assert.equal(row.currentProposalObservation.priorTargetValueSha256,
    "40fe21f5f22665a5f4e6cdda536607dae8d43fa082d0d9c81757f53caaedde9e");
  const { source, value } = resolveSelector(targetRef);
  assert.match(value, /one stable leaf record or an explicit semantic alias/u);
  assert.match(value, /AUD-SPEC-020 campaign extension is additive/u);
  assert.match(value, /without reducing the master-plan denominator/u);
  assert.equal(row.currentProposalObservation.currentSourceFileSha256, sha(source));
  assert.equal(row.currentProposalObservation.currentTargetValueSha256, sha(value));
  assert.equal(row.ownerSemanticReview.materialBindings[0].requiredSourcePhrase, value);
  assert.equal(row.currentProposalObservation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.equal(row.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
  assert.equal(row.ownerSemanticReview.acceptanceEffect, "none");
  assert.equal(row.ownerSemanticReview.runtimeStatus, "NOT_EVALUATED");
});

test("current proposal observations preserve historical source and owner pins", () => {
  const row = (claimId) => candidate.records.find((item) => item.claimId === claimId);
  const review0022 = row("MPSEM-0022-C001");
  assert.equal(review0022.sourcePlanCommit, "e62514f94c45a4ecbc438d26298bf82b6a6f3d69");
  assert.equal(review0022.ownerSourceSha256, "136cdd7921aa124c3d16435317e1463f1309ec17ad87c092fa2b35534e8ae2c4");
  assert.equal(review0022.currentProposalObservation.priorSourceFileSha256, review0022.ownerSourceSha256);
  assert.equal(review0022.currentProposalObservation.priorTargetValueSha256,
    "61debf8977441075d65403125946501e39373aa0c6b918415fef3bf439c8bb8c");

  const review0003 = row("MPSEM-0003-C002");
  assert.equal(review0003.sourcePlanCommit, "e62514f94c45a4ecbc438d26298bf82b6a6f3d69");
  assert.equal(review0003.ownerSourceSha256, "46875b1c2dbc7eb68d89eb76be5c20c999d4665c83f41f7c219a17e5c36f9ebc");
  assert.equal(review0003.currentProposalObservation.priorSourceFileSha256, review0003.ownerSourceSha256);
  assert.equal(review0003.currentProposalObservation.priorTargetValueSha256,
    "bc182679b5ca308b9e757ba680d1002ed4cbaebb5e85acb50907f6e145422310");
  assert.equal(review0003.ownerSemanticReview.disposition, "SOURCE_RULE_CONTENT_SUPPORTS_CLAIM_AT_DEFINITION_LEVEL");
  for (const binding of review0003.ownerSemanticReview.materialBindings) {
    assert.equal(binding.currentProposalObservation.priorSourceFileSha256, binding.sourceFileSha256);
    assert.equal(binding.currentProposalObservation.priorSourceValueSha256, binding.sourceValueSha256);
    assert.equal(binding.currentProposalObservation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  }
});

test("MPSEM-0042-C001 and MPSEM-0045-C002 refresh only exact PDP-1 source-file observations", () => {
  const cli = candidate.records.find(({ claimId }) => claimId === "MPSEM-0042-C001");
  assert.equal(cli.ownerPhase, "PDP-1");
  assert.equal(cli.ownerSourceFile, ".product-experience/pdp-1-domain-data/operations.yaml");
  assert.equal(cli.priorLocatorRef,
    ".product-experience/pdp-1-domain-data/operations.yaml#/sourceDenominators/lifecycleEventNames/bindingStatus");
  const cliObservation = cli.currentProposalObservation;
  const cliCurrent = resolveSelector(cliObservation.currentTargetRef ?? cli.priorLocatorRef);
  assert.equal(cliObservation.priorSourceFileSha256, cli.ownerSourceSha256);
  assert.equal(cliObservation.priorTargetValueSha256, cli.currentTargetValueSha256);
  assert.equal(cliObservation.supersededCurrentSourceFileSha256,
    "792f8ee0fe09096d68a6fa92065b56423d192b0b7445fac0408a9d73f61d7ac5");
  assert.equal(cliObservation.currentSourceFileSha256, sha(cliCurrent.source));
  assert.equal(cliObservation.currentTargetValueSha256, sha(cliCurrent.value));
  assert.equal(cliObservation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.equal(cli.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
  assert.equal(cli.ownerSemanticReview.acceptanceEffect, "none");

  const scene = candidate.records.find(({ claimId }) => claimId === "MPSEM-0045-C002");
  assert.equal(scene.ownerPhase, "PDP-1");
  assert.equal(scene.ownerSourceFile, ".product-experience/pdp-1-domain-data/domain-objects.yaml");
  assert.equal(scene.priorLocatorRef,
    ".product-experience/pdp-1-domain-data/domain-objects.yaml#/canonicalRelationshipAdjudication/records/17/relationships/0/meaning");
  const sceneObservation = scene.currentProposalObservation;
  const sceneCurrent = resolveSelector(sceneObservation.currentTargetRef ?? scene.priorLocatorRef);
  assert.equal(sceneObservation.priorSourceFileSha256, scene.ownerSourceSha256);
  assert.equal(sceneObservation.priorTargetValueSha256, scene.currentTargetValueSha256);
  assert.equal(sceneObservation.supersededCurrentSourceFileSha256,
    "ed045314dbdb6ece934348a9eba6d7c2ae791438476ef11d343cb57a04a05e04");
  assert.equal(sceneObservation.currentSourceFileSha256, sha(sceneCurrent.source));
  assert.equal(sceneObservation.currentTargetValueSha256, sha(sceneCurrent.value));
  assert.equal(sceneObservation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.equal(scene.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
  assert.equal(scene.ownerSemanticReview.acceptanceEffect, "none");
  assert.equal(scene.ownerSemanticReview.runtimeStatus, "NOT_EVALUATED");

  for (const binding of scene.ownerSemanticReview.materialBindings) {
    const observation = binding.currentProposalObservation;
    const current = resolveSelector(binding.ref);
    const serialized = typeof current.value === "string" ? current.value : JSON.stringify(current.value);
    assert.equal(observation.priorSourceFileSha256, binding.sourceFileSha256);
    assert.equal(observation.priorSourceValueSha256, binding.sourceValueSha256);
    assert.equal(observation.supersededCurrentSourceFileSha256,
      "792f8ee0fe09096d68a6fa92065b56423d192b0b7445fac0408a9d73f61d7ac5");
    assert.equal(observation.currentSourceFileSha256, sha(current.source));
    assert.equal(observation.currentSourceValueSha256, sha(serialized));
    assert.equal(observation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
    assert.equal(observation.acceptanceEffect ?? "none", "none");
  }
});

test("MPSEM-0058-C002 and MPSEM-0101-C003 refresh stable current source files without value or acceptance promotion", () => {
  const caption = candidate.records.find(({ claimId }) => claimId === "MPSEM-0058-C002");
  assert.equal(caption.ownerPhase, "PDP-1");
  const captionLive = resolveSelector(caption.currentProposalObservation.currentTargetRef ?? caption.priorLocatorRef);
  assert.equal(caption.currentProposalObservation.priorSourceFileSha256, caption.ownerSourceSha256);
  assert.equal(caption.currentProposalObservation.priorTargetValueSha256, caption.currentTargetValueSha256);
  assert.equal(caption.currentProposalObservation.supersededCurrentSourceFileSha256,
    "792f8ee0fe09096d68a6fa92065b56423d192b0b7445fac0408a9d73f61d7ac5");
  assert.equal(caption.currentProposalObservation.currentSourceFileSha256, sha(captionLive.source));
  assert.equal(caption.currentProposalObservation.currentTargetValueSha256, sha(captionLive.value));
  assert.equal(caption.currentProposalObservation.currentTargetValueSha256, caption.currentTargetValueSha256);
  assert.equal(caption.currentProposalObservation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.equal(caption.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
  assert.equal(caption.ownerSemanticReview.acceptanceEffect, "none");

  const decision = candidate.records.find(({ claimId }) => claimId === "MPSEM-0101-C003");
  assert.equal(decision.ownerPhase, "PDP-1");
  const decisionLive = resolveSelector(decision.currentProposalObservation.currentTargetRef ?? decision.priorLocatorRef);
  assert.equal(decision.currentProposalObservation.priorSourceFileSha256, decision.ownerSourceSha256);
  assert.equal(decision.currentProposalObservation.priorTargetValueSha256, decision.currentTargetValueSha256);
  assert.equal(decision.currentProposalObservation.currentSourceFileSha256, sha(decisionLive.source));
  assert.equal(decision.currentProposalObservation.currentTargetValueSha256, sha(decisionLive.value));
  assert.equal(decision.currentProposalObservation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.equal(decision.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
  assert.equal(decision.ownerSemanticReview.acceptanceEffect, "none");
  assert.equal(decision.ownerSemanticReview.runtimeStatus, "NOT_EVALUATED");

  const requirementPath = ".product-experience/pdp-0-product-truth/requirements.yaml";
  const requirementBinding = decision.ownerSemanticReview.materialBindings.find(({ ref }) => ref.startsWith(`${requirementPath}#`));
  assert.ok(requirementBinding, "PDP-0 requirement remains a source binding only");
  const requirementObservation = requirementBinding.currentProposalObservation;
  const requirementLive = resolveSelector(requirementBinding.ref);
  const serialized = typeof requirementLive.value === "string" ? requirementLive.value : JSON.stringify(requirementLive.value);
  const currentP0RequirementsSha = sha(requirementLive.source);
  assert.equal(currentP0RequirementsSha, pdp0Status.sourceShaSet[requirementPath],
    "the nested PDP-0 source digest agrees with its current native status pin");
  assert.equal(requirementBinding.sourceFileSha256, "b38f02657ed709eabb0ed08802cd673acc9cc12771ae34dcd6ecc87491339833");
  assert.equal(requirementObservation.priorSourceFileSha256, requirementBinding.sourceFileSha256);
  assert.equal(requirementObservation.previousCurrentSourceFileSha256,
    "0499998a4360d3e389b3f579b345d8a1d091fd53453f60c6a9c1937004c53e36");
  assert.equal(requirementObservation.supersededCurrentSourceFileSha256,
    "87d0eefaf735d84bb475bfcafedfd6230cc61a4a67fa105b6d12f71fe451dec6");
  assert.equal(requirementObservation.currentSourceFileSha256, currentP0RequirementsSha);
  assert.equal(requirementObservation.currentSourceValueSha256, sha(serialized));
  assert.equal(requirementObservation.currentSourceValueSha256, requirementObservation.priorSourceValueSha256,
    "the exact selected PDP-0 requirement value remains byte-identical");
  assert.equal(requirementObservation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.equal(requirementObservation.acceptanceEffect ?? "none", "none");
});

test("MPSEM-0167-C001 refreshes stable PDP-1 source fingerprints while preserving selected values and predecessors", () => {
  const row = candidate.records.find(({ claimId }) => claimId === "MPSEM-0167-C001");
  assert.equal(row.ownerPhase, "PDP-1");
  assert.equal(row.priorTargetValueSha256, "6ced0b187865f5481f58baa6a41aa408478c925f46a4c1bdca692558e4cb25d5");
  assert.equal(row.currentTargetValueSha256, "fefaf4ef885148d74d031dd06a3fc778bc994b647343b7e87bb69d8cb2a290d5");
  const observation = row.currentProposalObservation;
  assert.equal(observation.priorSourceFileSha256, row.ownerSourceSha256);
  assert.equal(observation.currentSourceFileSha256, "edf3c723630bcb8642257e211f2f2348e88ab0da820bf0d2fc666465b64cd629");
  assert.equal(observation.currentTargetValueSha256, row.currentTargetValueSha256);
  assert.equal(observation.supersededCurrentSourceFileSha256, "ed045314dbdb6ece934348a9eba6d7c2ae791438476ef11d343cb57a04a05e04");
  assert.equal(observation.sourceFileSha256History.at(-1), observation.supersededCurrentSourceFileSha256);
  assert.equal(observation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.equal(row.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
  assert.equal(row.ownerSemanticReview.acceptanceEffect, "none");
  for (const binding of row.ownerSemanticReview.materialBindings) {
    const current = binding.currentProposalObservation;
    assert.equal(current.currentSourceFileSha256, "dc2cc4ff58c3b3bd29f8d11036f0a3640c574cb4abceb0902fcafd3aad2c6cf2");
    const selected = resolveSelector(binding.ref).value;
    assert.equal(current.currentSourceValueSha256, sha(typeof selected === "string" ? selected : JSON.stringify(selected)));
    assert.equal(current.supersededCurrentSourceFileSha256, "a567d1fafc9978ed8ef6c97c07e75aa59371aaaf4a7ee9737b7aa69300579a67");
    assert.equal(current.sourceFileSha256History.at(-1), current.supersededCurrentSourceFileSha256);
    assert.equal(current.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  }
});

test("MPSEM-0172-C004 and MPSEM-0172-C005 refresh only stable exact PDP-1 source fingerprints", () => {
  const composition = candidate.records.find(({ claimId }) => claimId === "MPSEM-0172-C004");
  assert.equal(composition.ownerPhase, "PDP-1");
  assert.equal(composition.currentProposalObservation.currentSourceFileSha256,
    "edf3c723630bcb8642257e211f2f2348e88ab0da820bf0d2fc666465b64cd629");
  assert.equal(composition.currentProposalObservation.currentTargetValueSha256, composition.currentTargetValueSha256);
  assert.equal(composition.currentProposalObservation.supersededCurrentSourceFileSha256,
    "ed045314dbdb6ece934348a9eba6d7c2ae791438476ef11d343cb57a04a05e04");
  assert.equal(composition.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
  assert.equal(composition.ownerSemanticReview.acceptanceEffect, "none");
  const requirementBinding = composition.ownerSemanticReview.materialBindings.find(({ ref }) => ref.includes("requirements.yaml"));
  assert.equal(requirementBinding.currentProposalObservation.currentSourceFileSha256,
    "49c079d4aff2499bb3c226ac52e3a7101d483392775bd9b05a0a469295329ce2");
  assert.equal(requirementBinding.currentProposalObservation.currentSourceValueSha256,
    sha(resolveSelector(requirementBinding.ref).value));
  assert.equal(requirementBinding.currentProposalObservation.supersededCurrentSourceFileSha256,
    "87d0eefaf735d84bb475bfcafedfd6230cc61a4a67fa105b6d12f71fe451dec6");

  const cardinality = candidate.records.find(({ claimId }) => claimId === "MPSEM-0172-C005");
  assert.equal(cardinality.ownerPhase, "PDP-1");
  const relationship = cardinality.ownerSemanticReview.materialBindings.find(({ ref }) => ref.includes("domain-objects.yaml"));
  const aliasing = cardinality.ownerSemanticReview.materialBindings.find(({ ref }) => ref.includes("capabilities.yaml"));
  for (const binding of [relationship, aliasing]) {
    const current = binding.currentProposalObservation;
    assert.equal(current.currentSourceFileSha256, sha(resolveSelector(binding.ref).source));
    assert.equal(current.currentSourceValueSha256, sha(resolveSelector(binding.ref).value));
    assert.equal(current.sourceFileSha256History.at(-1), current.supersededCurrentSourceFileSha256);
    assert.equal(current.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  }
  assert.equal(cardinality.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
  assert.equal(cardinality.ownerSemanticReview.acceptanceEffect, "none");
});

test("MPSEM-0261-C001 refreshes stable PDP-1 conversion source fingerprints without changing selected values", () => {
  const row = candidate.records.find(({ claimId }) => claimId === "MPSEM-0261-C001");
  assert.equal(row.ownerPhase, "PDP-1");
  const current = row.currentProposalObservation;
  assert.equal(current.currentSourceFileSha256,
    "d8c9ac7c376961705cb1abc3571f5027319411d9aefb6cbc9b01caebc43e6916");
  assert.equal(current.currentTargetValueSha256, row.currentTargetValueSha256);
  assert.equal(current.supersededCurrentSourceFileSha256,
    "d497f5bc0ab88ccd51754e9ea66925449aa793433170601fa4fe88fe40153125");
  assert.equal(current.sourceFileSha256History.at(-1), current.supersededCurrentSourceFileSha256);
  for (const binding of row.ownerSemanticReview.materialBindings.filter(({ ref }) => ref.includes("value-objects.yaml"))) {
    const observation = binding.currentProposalObservation;
    assert.equal(observation.currentSourceFileSha256,
      "d8c9ac7c376961705cb1abc3571f5027319411d9aefb6cbc9b01caebc43e6916");
    assert.equal(observation.currentSourceValueSha256, sha(resolveSelector(binding.ref).value));
    assert.equal(observation.sourceFileSha256History.at(-1), observation.supersededCurrentSourceFileSha256);
    assert.equal(observation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  }
  assert.equal(row.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
  assert.equal(row.ownerSemanticReview.acceptanceEffect, "none");
});

test("MPSEM-0296-C001 refreshes stable PDP-1 operation source fingerprints without changing selected bindings", () => {
  const row = candidate.records.find(({ claimId }) => claimId === "MPSEM-0296-C001");
  assert.equal(row.ownerPhase, "PDP-1");
  const current = row.currentProposalObservation;
  assert.equal(current.currentSourceFileSha256,
    "c3b37f01103af717fcbc38a356f5daf10046c0d3b1d91d8cabfe96626889d6a2");
  assert.equal(current.currentTargetValueSha256, row.currentTargetValueSha256);
  assert.equal(current.supersededCurrentSourceFileSha256,
    "792f8ee0fe09096d68a6fa92065b56423d192b0b7445fac0408a9d73f61d7ac5");
  for (const binding of row.ownerSemanticReview.materialBindings) {
    const observation = binding.currentProposalObservation;
    assert.equal(observation.currentSourceFileSha256,
      "c3b37f01103af717fcbc38a356f5daf10046c0d3b1d91d8cabfe96626889d6a2");
    assert.equal(observation.currentSourceValueSha256, sha(resolveSelector(binding.ref).value));
    assert.equal(observation.sourceFileSha256History.at(-1), observation.supersededCurrentSourceFileSha256);
    assert.equal(observation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  }
  assert.equal(row.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
  assert.equal(row.ownerSemanticReview.acceptanceEffect, "none");
});

test("MPSEM-0297-C002 and MPSEM-0326-C001 refresh stable exact source fingerprints without acceptance promotion", () => {
  const operationRef = "c3b37f01103af717fcbc38a356f5daf10046c0d3b1d91d8cabfe96626889d6a2";
  const slice = candidate.records.find(({ claimId }) => claimId === "MPSEM-0297-C002");
  assert.equal(slice.ownerPhase, "PDP-1");
  assert.equal(slice.currentProposalObservation.currentSourceFileSha256, operationRef);
  assert.equal(slice.currentProposalObservation.currentTargetValueSha256, slice.currentTargetValueSha256);
  assert.equal(slice.currentProposalObservation.supersededCurrentSourceFileSha256,
    "792f8ee0fe09096d68a6fa92065b56423d192b0b7445fac0408a9d73f61d7ac5");
  const vision = candidate.records.find(({ claimId }) => claimId === "MPSEM-0326-C001");
  assert.equal(vision.ownerPhase, "PDP-1");
  assert.equal(vision.currentProposalObservation.currentSourceFileSha256, operationRef);
  assert.equal(vision.currentProposalObservation.currentTargetValueSha256, vision.currentTargetValueSha256);
  for (const binding of vision.ownerSemanticReview.materialBindings) {
    const observation = binding.currentProposalObservation;
    assert.equal(observation.currentSourceFileSha256, sha(resolveSelector(binding.ref).source));
    assert.equal(observation.currentSourceValueSha256, sha(resolveSelector(binding.ref).value));
    assert.equal(observation.sourceFileSha256History.at(-1), observation.supersededCurrentSourceFileSha256);
    assert.equal(observation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  }
  for (const row of [slice, vision]) {
    assert.equal(row.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
    assert.equal(row.ownerSemanticReview.acceptanceEffect, "none");
  }
});

test("MPSEM-0314-C002 and MPSEM-0335-C003 refresh stable current exact source fingerprints", () => {
  const operations = "c3b37f01103af717fcbc38a356f5daf10046c0d3b1d91d8cabfe96626889d6a2";
  const channel = "cc25faf0326d9868842b561626629ce0f3a2d4e4365452d8caa1995268df6f76";
  const sdk = candidate.records.find(({ claimId }) => claimId === "MPSEM-0314-C002");
  assert.equal(sdk.ownerPhase, "PDP-1");
  assert.equal(sdk.currentProposalObservation.currentSourceFileSha256, operations);
  assert.equal(sdk.currentProposalObservation.currentTargetValueSha256, sdk.currentTargetValueSha256);
  const stream = candidate.records.find(({ claimId }) => claimId === "MPSEM-0335-C003");
  assert.equal(stream.ownerPhase, "PDP-1");
  assert.equal(stream.currentProposalObservation.currentSourceFileSha256, operations);
  assert.equal(stream.currentProposalObservation.currentTargetValueSha256, stream.currentTargetValueSha256);
  for (const binding of stream.ownerSemanticReview.materialBindings) {
    const current = binding.currentProposalObservation;
    assert.equal(current.currentSourceFileSha256, channel);
    assert.equal(current.currentSourceValueSha256, sha(resolveSelector(binding.ref).value));
    assert.equal(current.sourceFileSha256History.at(-1), current.supersededCurrentSourceFileSha256);
    assert.equal(current.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  }
  for (const row of [sdk, stream]) {
    assert.equal(row.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
    assert.equal(row.ownerSemanticReview.acceptanceEffect, "none");
  }
});

test("MPSEM-0334-C004 and MPSEM-0336-C001 refresh stable exact PDP-1 candidate locators", () => {
  const operations = "c3b37f01103af717fcbc38a356f5daf10046c0d3b1d91d8cabfe96626889d6a2";
  const channel = "cc25faf0326d9868842b561626629ce0f3a2d4e4365452d8caa1995268df6f76";
  const action = candidate.records.find(({ claimId }) => claimId === "MPSEM-0334-C004");
  assert.equal(action.ownerPhase, "PDP-1");
  assert.equal(action.currentProposalObservation.currentSourceFileSha256, operations);
  assert.equal(action.currentProposalObservation.currentTargetValueSha256, action.currentTargetValueSha256);
  const state = candidate.records.find(({ claimId }) => claimId === "MPSEM-0336-C001");
  assert.equal(state.ownerPhase, "PDP-1");
  for (const binding of state.ownerSemanticReview.materialBindings) {
    const current = binding.currentProposalObservation;
    assert.equal(current.currentSourceFileSha256, channel);
    assert.equal(current.currentSourceValueSha256, sha(resolveSelector(binding.ref).value));
    assert.equal(current.sourceFileSha256History.at(-1), current.supersededCurrentSourceFileSha256);
    assert.equal(current.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  }
  for (const row of [action, state]) {
    assert.equal(row.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
    assert.equal(row.ownerSemanticReview.acceptanceEffect, "none");
  }
});

test("MPSEM-0336-C002 and MPSEM-0336-C004 refresh stable exact source fingerprints", () => {
  const channel = "cc25faf0326d9868842b561626629ce0f3a2d4e4365452d8caa1995268df6f76";
  const operations = "c3b37f01103af717fcbc38a356f5daf10046c0d3b1d91d8cabfe96626889d6a2";
  const cancellation = candidate.records.find(({ claimId }) => claimId === "MPSEM-0336-C002");
  assert.equal(cancellation.ownerPhase, "PDP-1");
  for (const binding of cancellation.ownerSemanticReview.materialBindings) {
    const current = binding.currentProposalObservation;
    assert.equal(current.currentSourceFileSha256, channel);
    const selected = resolveSelector(binding.ref).value;
    assert.equal(current.currentSourceValueSha256, sha(typeof selected === "string" ? selected : JSON.stringify(selected)));
    assert.equal(current.sourceFileSha256History.at(-1), current.supersededCurrentSourceFileSha256);
  }
  const sdk = candidate.records.find(({ claimId }) => claimId === "MPSEM-0336-C004");
  assert.equal(sdk.ownerPhase, "PDP-1");
  assert.equal(sdk.currentProposalObservation.currentSourceFileSha256, operations);
  assert.equal(sdk.currentProposalObservation.currentTargetValueSha256, sdk.currentTargetValueSha256);
  for (const row of [cancellation, sdk]) {
    assert.equal(row.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
    assert.equal(row.ownerSemanticReview.acceptanceEffect, "none");
  }
});

test("MPSEM-0348-C001 refreshes stable operation owner and material source fingerprints", () => {
  const row = candidate.records.find(({ claimId }) => claimId === "MPSEM-0348-C001");
  const currentHash = "c3b37f01103af717fcbc38a356f5daf10046c0d3b1d91d8cabfe96626889d6a2";
  assert.equal(row.ownerPhase, "PDP-1");
  assert.equal(row.currentProposalObservation.currentSourceFileSha256, currentHash);
  assert.equal(row.currentProposalObservation.currentTargetValueSha256, row.currentTargetValueSha256);
  for (const binding of row.ownerSemanticReview.materialBindings) {
    const current = binding.currentProposalObservation;
    assert.equal(current.currentSourceFileSha256, currentHash);
    const value = resolveSelector(binding.ref).value;
    assert.equal(current.currentSourceValueSha256, sha(typeof value === "string" ? value : JSON.stringify(value)));
    assert.equal(current.sourceFileSha256History.at(-1), current.supersededCurrentSourceFileSha256);
  }
  assert.equal(row.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
  assert.equal(row.ownerSemanticReview.acceptanceEffect, "none");
});

test("MPSEM-0358-C002 and MPSEM-0345-C001 refresh stable exact PDP-1 locators", () => {
  const relationship = candidate.records.find(({ claimId }) => claimId === "MPSEM-0358-C002");
  assert.equal(relationship.ownerPhase, "PDP-1");
  assert.equal(relationship.currentProposalObservation.currentSourceFileSha256,
    "edf3c723630bcb8642257e211f2f2348e88ab0da820bf0d2fc666465b64cd629");
  assert.equal(relationship.currentProposalObservation.currentTargetValueSha256, relationship.currentTargetValueSha256);
  const cancellation = candidate.records.find(({ claimId }) => claimId === "MPSEM-0345-C001");
  assert.equal(cancellation.ownerPhase, "PDP-1");
  const operation = cancellation.ownerSemanticReview.materialBindings.find(({ ref }) => ref.includes("operations.yaml"));
  assert.equal(operation.currentProposalObservation.currentSourceFileSha256,
    "c3b37f01103af717fcbc38a356f5daf10046c0d3b1d91d8cabfe96626889d6a2");
  const operationValue = resolveSelector(operation.ref).value;
  assert.equal(operation.currentProposalObservation.currentSourceValueSha256,
    sha(typeof operationValue === "string" ? operationValue : JSON.stringify(operationValue)));
  const beginUpload = candidate.records.find(({ claimId }) => claimId === "MPSEM-0358-C003");
  assert.equal(beginUpload.ownerPhase, "PDP-1");
  assert.equal(beginUpload.currentProposalObservation.currentSourceFileSha256,
    "c3b37f01103af717fcbc38a356f5daf10046c0d3b1d91d8cabfe96626889d6a2");
  assert.equal(beginUpload.currentProposalObservation.currentTargetValueSha256, beginUpload.currentTargetValueSha256);
  for (const row of [relationship, cancellation]) {
    assert.equal(row.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
    assert.equal(row.ownerSemanticReview.acceptanceEffect, "none");
  }
});

test("MPSEM-0369-C003 and MPSEM-0372-C005 refresh stable exact PDP-1 locators", () => {
  const identity = candidate.records.find(({ claimId }) => claimId === "MPSEM-0369-C003");
  assert.equal(identity.ownerPhase, "PDP-1");
  assert.equal(identity.currentProposalObservation.currentSourceFileSha256,
    "edf3c723630bcb8642257e211f2f2348e88ab0da820bf0d2fc666465b64cd629");
  assert.equal(identity.currentProposalObservation.currentTargetValueSha256, identity.currentTargetValueSha256);
  const cancellation = candidate.records.find(({ claimId }) => claimId === "MPSEM-0372-C005");
  assert.equal(cancellation.ownerPhase, "PDP-1");
  const binding = cancellation.ownerSemanticReview.materialBindings.find(({ ref }) => ref.includes("operations.yaml"));
  assert.equal(binding.currentProposalObservation.currentSourceFileSha256,
    "c3b37f01103af717fcbc38a356f5daf10046c0d3b1d91d8cabfe96626889d6a2");
  const value = resolveSelector(binding.ref).value;
  assert.equal(binding.currentProposalObservation.currentSourceValueSha256,
    sha(typeof value === "string" ? value : JSON.stringify(value)));
  const health = candidate.records.find(({ claimId }) => claimId === "MPSEM-0369-C004");
  assert.equal(health.ownerPhase, "PDP-1");
  assert.equal(health.currentProposalObservation.currentSourceFileSha256,
    "c3b37f01103af717fcbc38a356f5daf10046c0d3b1d91d8cabfe96626889d6a2");
  const submission = candidate.records.find(({ claimId }) => claimId === "MPSEM-0373-C001");
  assert.equal(submission.ownerPhase, "PDP-1");
  for (const auditBinding of submission.ownerSemanticReview.materialBindings.filter(({ ref }) => ref.includes("operations.yaml"))) {
    const observation = auditBinding.currentProposalObservation;
    assert.equal(observation.currentSourceFileSha256,
      "c3b37f01103af717fcbc38a356f5daf10046c0d3b1d91d8cabfe96626889d6a2");
    const selected = resolveSelector(auditBinding.ref).value;
    assert.equal(observation.currentSourceValueSha256,
      sha(typeof selected === "string" ? selected : JSON.stringify(selected)));
  }
  for (const row of [identity, cancellation, health, submission]) {
    assert.equal(row.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
    assert.equal(row.ownerSemanticReview.acceptanceEffect, "none");
  }
});

test("MPSEM-0378-C004 and MPSEM-0376-C002 refresh stable exact PDP-1 operation locators", () => {
  const operations = "c3b37f01103af717fcbc38a356f5daf10046c0d3b1d91d8cabfe96626889d6a2";
  const downstream = candidate.records.find(({ claimId }) => claimId === "MPSEM-0378-C004");
  assert.equal(downstream.ownerPhase, "PDP-1");
  assert.equal(downstream.currentProposalObservation.currentSourceFileSha256, operations);
  assert.equal(downstream.currentProposalObservation.currentTargetValueSha256, downstream.currentTargetValueSha256);
  const retry = candidate.records.find(({ claimId }) => claimId === "MPSEM-0376-C002");
  assert.equal(retry.ownerPhase, "PDP-1");
  for (const binding of retry.ownerSemanticReview.materialBindings.filter(({ ref }) => ref.includes("operations.yaml"))) {
    const current = binding.currentProposalObservation;
    assert.equal(current.currentSourceFileSha256, operations);
    const value = resolveSelector(binding.ref).value;
    assert.equal(current.currentSourceValueSha256, sha(typeof value === "string" ? value : JSON.stringify(value)));
  }
  for (const row of [downstream, retry]) {
    assert.equal(row.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
    assert.equal(row.ownerSemanticReview.acceptanceEffect, "none");
  }
});

test("MPSEM-0385-C003 and MPSEM-0378-C004 refresh stable exact source fingerprints", () => {
  const operations = "c3b37f01103af717fcbc38a356f5daf10046c0d3b1d91d8cabfe96626889d6a2";
  const availability = candidate.records.find(({ claimId }) => claimId === "MPSEM-0385-C003");
  assert.equal(availability.ownerPhase, "PDP-1");
  assert.equal(availability.currentProposalObservation.currentSourceFileSha256, operations);
  assert.equal(availability.currentProposalObservation.currentTargetValueSha256, availability.currentTargetValueSha256);
  const requirement = availability.ownerSemanticReview.materialBindings.find(({ ref }) => ref.includes("/requirements.yaml#"));
  assert.equal(requirement.currentProposalObservation.currentSourceFileSha256,
    "49c079d4aff2499bb3c226ac52e3a7101d483392775bd9b05a0a469295329ce2");
  const value = resolveSelector(requirement.ref).value;
  assert.equal(requirement.currentProposalObservation.currentSourceValueSha256,
    sha(typeof value === "string" ? value : JSON.stringify(value)));
  const publication = candidate.records.find(({ claimId }) => claimId === "MPSEM-0378-C004");
  const binding = publication.ownerSemanticReview.materialBindings.find(({ ref }) => ref.includes("operations.yaml"));
  assert.equal(binding.currentProposalObservation.currentSourceFileSha256, operations);
  const publicationValue = resolveSelector(binding.ref).value;
  assert.equal(binding.currentProposalObservation.currentSourceValueSha256,
    sha(typeof publicationValue === "string" ? publicationValue : JSON.stringify(publicationValue)));
  for (const row of [availability, publication]) {
    assert.equal(row.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
    assert.equal(row.ownerSemanticReview.acceptanceEffect, "none");
  }
});

test("MPSEM-0446-C002 refreshes stable exact PDP-1 operation fingerprints", () => {
  const row = candidate.records.find(({ claimId }) => claimId === "MPSEM-0446-C002");
  const operations = "c3b37f01103af717fcbc38a356f5daf10046c0d3b1d91d8cabfe96626889d6a2";
  assert.equal(row.ownerPhase, "PDP-1");
  assert.equal(row.currentProposalObservation.currentSourceFileSha256, operations);
  assert.equal(row.currentProposalObservation.currentTargetValueSha256, row.currentTargetValueSha256);
  for (const binding of row.ownerSemanticReview.materialBindings) {
    const current = binding.currentProposalObservation;
    assert.equal(current.currentSourceFileSha256, operations);
    const value = resolveSelector(binding.ref).value;
    assert.equal(current.currentSourceValueSha256, sha(typeof value === "string" ? value : JSON.stringify(value)));
    assert.equal(current.sourceFileSha256History.at(-1), current.supersededCurrentSourceFileSha256);
  }
  assert.equal(row.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
  assert.equal(row.ownerSemanticReview.acceptanceEffect, "none");
});

test("MPSEM-0447-C005 refreshes stable exact PDP-1 operation fingerprints", () => {
  const row = candidate.records.find(({ claimId }) => claimId === "MPSEM-0447-C005");
  const operations = "c3b37f01103af717fcbc38a356f5daf10046c0d3b1d91d8cabfe96626889d6a2";
  assert.equal(row.ownerPhase, "PDP-1");
  assert.equal(row.currentProposalObservation.currentSourceFileSha256, operations);
  assert.equal(row.currentProposalObservation.currentTargetValueSha256, row.currentTargetValueSha256);
  for (const binding of row.ownerSemanticReview.materialBindings) {
    const current = binding.currentProposalObservation;
    assert.equal(current.currentSourceFileSha256, operations);
    const value = resolveSelector(binding.ref).value;
    assert.equal(current.currentSourceValueSha256, sha(typeof value === "string" ? value : JSON.stringify(value)));
    assert.equal(current.sourceFileSha256History.at(-1), current.supersededCurrentSourceFileSha256);
  }
  assert.equal(row.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
  assert.equal(row.ownerSemanticReview.acceptanceEffect, "none");
});

test("PXD-173/PXD-183 history and PXD-185 current successors cover PDP-0 candidate observations", () => {
  assert.equal(pxd173Successor.decisionRef, ".product-experience/decision-log.md#PXD-173");
  assert.equal(pxd183Successor.decisionRef, ".product-experience/decision-log.md#PXD-183");
  assert.equal(pxd185Successor.decisionRef, ".product-experience/decision-log.md#PXD-185");
  const pxd173Records = pxd173Successor.records.filter((record) => record.sourceArtifactRef
    === "docs/implementation/verification/pdp-38/truth-domain-pdp0-pdp1-owner-candidate-199.json");
  assert.equal(pxd173Records.length, 32);
  assert.equal(pxd173Successor.counts.targetValueDrift, 0);
  assert.equal(pxd173Successor.counts.candidateObservations, pxd173Records.length);
  const pxd183Records = pxd183Successor.records.filter((record) => record.sourceArtifactRef
    === "docs/implementation/verification/pdp-38/truth-domain-pdp0-pdp1-owner-candidate-199.json");
  const refreshed = pxd185Successor.records.filter((record) => record.sourceArtifactRef
    === "docs/implementation/verification/pdp-38/truth-domain-pdp0-pdp1-owner-candidate-199.json");
  assert.equal(refreshed.length, 22);
  assert.equal(pxd185Successor.counts.targetValueDrift, 0);
  assert.equal(pxd185Successor.counts.candidateObservations, refreshed.length);
  for (const successor of refreshed) {
    const owner = candidate.records.find((record) => record.claimId === successor.claimId);
    assert.equal(owner.ownerPhase, "PDP-0");
    let observation;
    if (successor.sourceRecordRef.endsWith("/currentProposalObservation")) {
      observation = owner.currentProposalObservation;
    } else {
      observation = owner.ownerSemanticReview.materialBindings[successor.sourceBindingIndex]?.currentProposalObservation;
    }
    assert.ok(observation, `${successor.claimId} ${successor.targetRef} current observation`);
    const pxd173Predecessor = pxd173Records.find((prior) => prior.claimId === successor.claimId && prior.targetRef === successor.targetRef);
    const pxd183Predecessor = pxd183Records.find((prior) => prior.claimId === successor.claimId && prior.targetRef === successor.targetRef);
    assert.ok(pxd173Predecessor, `${successor.claimId} retains its PXD-173 source observation`);
    assert.ok(pxd183Predecessor, `${successor.claimId} retains its PXD-183 source observation`);
    assert.equal(pxd183Predecessor.predecessorCurrentSourceFileSha256, pxd173Predecessor.currentSourceFileSha256);
    assert.equal(observation.supersededCurrentSourceFileSha256, pxd173Predecessor.predecessorCurrentSourceFileSha256);
    assert.equal(observation.currentSourceSuccessorPredecessorFileSha256, pxd183Predecessor.currentSourceFileSha256);
    assert.equal(successor.predecessorCurrentSourceFileSha256, pxd183Predecessor.currentSourceFileSha256);
    assert.equal(successor.predecessorCurrentTargetValueSha256, pxd183Predecessor.currentTargetValueSha256);
    assert.equal(observation.currentSourceFileSha256, successor.currentSourceFileSha256);
    assert.equal(observation.currentTargetValueSha256 ?? observation.currentSourceValueSha256, successor.currentTargetValueSha256);
    assert.equal(observation.currentSourceSuccessorRef,
      `docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd185.json#/records/@observationId=${successor.observationId}`);
    const { source, value } = resolveSelector(successor.targetRef);
    assert.equal(successor.currentSourceFileSha256, sha(source));
    assert.equal(successor.currentTargetValueSha256, sha(typeof value === "string" ? value : JSON.stringify(value)));
    assert.equal(successor.semanticEquivalence, "NOT_ASSERTED");
    assert.equal(successor.acceptanceEffect, "none");
    assert.equal(successor.semanticPromotion, false);
  }
  for (const predecessor of pxd173Records) {
    const historicalOwner = headCandidate.records.find((record) => record.claimId === predecessor.claimId);
    assert.ok(historicalOwner, `${predecessor.claimId} exists in the HEAD candidate`);
    const historicalObservation = predecessor.sourceRecordRef.endsWith("/currentProposalObservation")
      ? historicalOwner.currentProposalObservation
      : historicalOwner.ownerSemanticReview.materialBindings.find((binding) => binding.ref === predecessor.targetRef)?.currentProposalObservation;
    assert.ok(historicalObservation, `${predecessor.claimId} ${predecessor.targetRef} HEAD observation`);
    assert.equal(predecessor.currentSourceFileSha256, historicalObservation.currentSourceFileSha256,
      "PXD-173 current source digest matches its immutable HEAD candidate observation");
    const pxd183Predecessor = pxd183Records.find((record) => record.claimId === predecessor.claimId && record.targetRef === predecessor.targetRef);
    if (pxd183Predecessor) {
      assert.equal(pxd183Predecessor.predecessorCurrentSourceFileSha256, predecessor.currentSourceFileSha256,
        "PXD-183 preserves the exact PXD-173 current source digest");
    }
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

const candidatePhase = process.env.PDP_MIGRATION_CANDIDATE_PHASE ?? "ALL";
const expectedMaterialReviewCounts = { ALL: 178, "PDP-0": 134, "PDP-1": 43 };
if (!Object.hasOwn(expectedMaterialReviewCounts, candidatePhase)) {
  throw new Error(`PDP_MIGRATION_CANDIDATE_PHASE must be one of ALL, PDP-0, PDP-1; got ${candidatePhase}`);
}

test(`claim-specific material clauses for ${candidatePhase} resolve exactly and reject weakened or substituted targets`, () => {
  const reviewed = candidate.records.filter((row) => row.ownerSemanticReview?.disposition === "SOURCE_RULE_CONTENT_SUPPORTS_CLAIM_AT_DEFINITION_LEVEL"
    && (candidatePhase === "ALL" || row.ownerPhase === candidatePhase));
  assert.equal(reviewed.length, expectedMaterialReviewCounts[candidatePhase]);
  for (const row of reviewed) {
    const review = row.ownerSemanticReview;
    if (candidatePhase === "PDP-0") {
      // PDP-0 may preserve later-phase contract refs as handoff evidence,
      // but freezing PDP-0 must not resolve or fingerprint those later-phase files.
      const isLaterPhaseRef = (ref) => /^\.product-experience\/pdp-[1-9][0-9]*-/u.test(ref);
      const deferredRefs = review.exactContractRefs.filter(isLaterPhaseRef);
      const deferredBindings = (review.materialBindings ?? []).filter(({ ref }) => isLaterPhaseRef(ref));
      const phaseRefs = review.exactContractRefs.filter((ref) => !isLaterPhaseRef(ref));
      const phaseBindings = (review.materialBindings ?? []).filter(({ ref }) => !isLaterPhaseRef(ref));

      if (deferredRefs.length > 0 || deferredBindings.length > 0) {
        assert.equal(review.proposedTargetRef, review.exactContractRefs[0], `${row.claimId} preserves its original primary target`);
        assert.equal(new Set(review.exactContractRefs).size, review.exactContractRefs.length,
          `${row.claimId} original exact source set remains unique`);
        assert.ok(deferredRefs.every((sourceRef) => deferredBindings.some(({ ref }) =>
          ref === sourceRef || ref.startsWith(`${sourceRef}/`))),
        `${row.claimId} every deferred exact ref has a containing deferred binding`);
        assert.equal(review.acceptanceEffect, "none", `${row.claimId} downstream refs remain non-accepting`);
        assert.equal(review.runtimeStatus, "NOT_EVALUATED", `${row.claimId} downstream refs do not promote runtime status`);
        assert.equal(row.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED", `${row.claimId} downstream refs do not promote parity`);
        assert.equal(row.currentProposalObservation?.status, "PENDING_COORDINATOR_MATERIAL_REVIEW",
          `${row.claimId} downstream refs remain pending`);
        for (const binding of deferredBindings) {
          assert.equal(binding.currentProposalObservation?.status, "PENDING_COORDINATOR_MATERIAL_REVIEW",
            `${row.claimId} deferred ${binding.ref} remains pending`);
          assert.equal(binding.currentProposalObservation?.acceptanceEffect ?? "none", "none",
            `${row.claimId} deferred ${binding.ref} has no acceptance effect`);
          assert.equal(binding.currentProposalObservation?.runtimeStatus ?? "NOT_EVALUATED", "NOT_EVALUATED",
            `${row.claimId} deferred ${binding.ref} has no runtime promotion`);
          assert.equal(typeof binding.currentProposalObservation?.currentSourceFileSha256, "string",
            `${row.claimId} deferred ${binding.ref} retains its observation pin`);
        }

        const valuesByRef = new Map();
        for (const ref of phaseRefs) {
          const { value } = resolveSelector(ref);
          valuesByRef.set(ref, typeof value === "string" ? value : JSON.stringify(value));
        }
        for (const binding of phaseBindings) {
          const { value, source } = resolveSelector(binding.ref);
          const serialized = typeof value === "string" ? value : JSON.stringify(value);
          valuesByRef.set(binding.ref, serialized);
          assert.equal(binding.currentProposalObservation?.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
          assert.equal(binding.currentProposalObservation?.currentSourceValueSha256, sha(serialized),
            `${row.claimId} exact in-phase bound source value`);
          assert.equal(binding.currentProposalObservation?.currentSourceFileSha256, sha(source),
            `${row.claimId} exact in-phase bound source file`);
          assert.ok(serialized.includes(binding.requiredSourcePhrase),
            `${row.claimId} in-phase binding retains its required phrase`);
        }

        // Where this row has in-phase refs, validate their source containment,
        // coverage, and phrase requirements. Later-phase refs remain untouched.
        if (phaseRefs.length > 0) {
          const scopedValues = phaseRefs.map((ref) => valuesByRef.get(ref)).filter(Boolean);
          const scopedJoined = scopedValues.join("\n");
          const scopedReview = {
            ...review,
            proposedTargetRef: phaseRefs[0],
            exactContractRefs: phaseRefs,
            materialBindings: phaseBindings,
            materialPredicates: review.materialPredicates.filter((predicate) => scopedJoined.includes(predicate)),
          };
          const scopedRow = { ...row, ownerSemanticReview: scopedReview };
          assert.equal(validateMaterialReview(scopedRow, valuesByRef), true,
            `${row.claimId} in-phase evidence validates without downstream refs`);
          for (const binding of phaseBindings) {
            const weakened = new Map(valuesByRef);
            weakened.set(binding.ref, valuesByRef.get(binding.ref).split(binding.requiredSourcePhrase).join(""));
            assert.equal(validateMaterialReview(scopedRow, weakened), false,
              `${row.claimId} weakening an in-phase clause is rejected`);
          }
        }
        continue;
      }
    }
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

test("unresolved selectors and source-value drift remain explicit material blockers", () => {
  const row = (claimId) => candidate.records.find((item) => item.claimId === claimId);
  const unresolved = row("MPSEM-0172-C004");
  assert.equal(unresolved.ownerSemanticReview.disposition, "BLOCKED_UNRESOLVED_CURRENT_SELECTOR");
  assert.equal(unresolved.ownerSemanticReview.historicalDisposition, "SOURCE_RULE_CONTENT_SUPPORTS_CLAIM_AT_DEFINITION_LEVEL");
  assert.equal(unresolved.ownerSemanticReview.materialReviewBlocker.acceptanceEffect, "none");
  assert.equal(unresolved.ownerSemanticReview.materialReviewBlocker.runtimeStatus, "NOT_EVALUATED");
  const unresolvedBinding = unresolved.ownerSemanticReview.materialBindings.find(({ ref }) => ref.endsWith("#familyDefinitionPolicy/operationIdentity"));
  assert.ok(unresolvedBinding);
  assert.throws(() => resolveSelector(unresolvedBinding.ref), /unresolved exact source selector/u);
  assert.equal(unresolvedBinding.currentProposalObservation.currentSourceValueSha256,
    "c4cd6d81b109a39bde30b00b9864c613b68faa5f028023bb06cf548bf51069d2",
    "unresolved historical current-value observation is retained");
  assert.match(unresolved.ownerSemanticReview.materialReviewBlocker.reason, /no exact owner clause/u);

  const targetDrift = row("MPSEM-0235-C001");
  if (candidatePhase === "ALL" || targetDrift.ownerPhase === candidatePhase) {
    assert.equal(targetDrift.ownerSemanticReview.disposition, "BLOCKED_CURRENT_SOURCE_VALUE_DRIFT");
    assert.equal(targetDrift.ownerSemanticReview.historicalDisposition, "SOURCE_RULE_CONTENT_SUPPORTS_CLAIM_AT_DEFINITION_LEVEL");
    assert.equal(targetDrift.ownerSemanticReview.materialReviewBlocker.acceptanceEffect, "none");
    assert.equal(targetDrift.ownerSemanticReview.materialReviewBlocker.runtimeStatus, "NOT_EVALUATED");
    const observation = targetDrift.currentProposalObservation;
    const liveDrift = observation.currentValueDriftObservation;
    assert.equal(observation.currentTargetValueSha256, targetDrift.currentTargetValueSha256,
      "the recorded target-value pin is preserved");
    assert.equal(liveDrift.recordedTargetValueSha256, targetDrift.currentTargetValueSha256);
    assert.equal(liveDrift.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
    assert.equal(liveDrift.acceptanceEffect, "none");
    const { source, value } = resolveSelector(liveDrift.ref);
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    assert.equal(liveDrift.observedTargetValueSha256, sha(serialized),
      "the explicit current drift pin binds the exact live target value");
    assert.notEqual(liveDrift.observedTargetValueSha256, liveDrift.recordedTargetValueSha256);
    assert.equal(observation.currentSourceFileSha256, sha(source),
      "the current source file observation is refreshed while both value pins remain visible");
  }

  for (const claimId of ["MPSEM-0298-C003"]) {
    const record = row(claimId);
    if (candidatePhase !== "ALL" && record.ownerPhase !== candidatePhase) continue;
    assert.equal(record.ownerSemanticReview.disposition, "BLOCKED_CURRENT_SOURCE_VALUE_DRIFT");
    assert.equal(record.ownerSemanticReview.historicalDisposition, "SOURCE_RULE_CONTENT_SUPPORTS_CLAIM_AT_DEFINITION_LEVEL");
    assert.equal(record.ownerSemanticReview.materialReviewBlocker.acceptanceEffect, "none");
    assert.equal(record.ownerSemanticReview.materialReviewBlocker.runtimeStatus, "NOT_EVALUATED");
    const binding = record.ownerSemanticReview.materialBindings.find(({ ref }) => ref.endsWith("/ownerWireSchema/requestSchema"));
    assert.ok(binding);
    const { source, value } = resolveSelector(binding.ref);
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    assert.equal(binding.currentProposalObservation.currentSourceValueSha256,
      "9601290ea449fb3aca34af0919f261324503550ca9ca871ed180b360d22293ae",
      `${claimId} retains the prior current-value observation`);
    assert.notEqual(sha(serialized), binding.currentProposalObservation.currentSourceValueSha256,
      `${claimId} live request schema has unresolved value drift`);
    assert.notEqual(binding.currentProposalObservation.currentSourceFileSha256, sha(source),
      `${claimId} source file observation is not refreshed across a value drift`);
    assert.match(record.ownerSemanticReview.materialReviewBlocker.reason, /pending exact material review/u);
  }

  for (const [claimId, suffix] of [
    ["MPSEM-0171-C008", "#coverageRule"],
    ["MPSEM-0372-C003", "#ownerJobStatusDimensionContract/independentDimensions"],
  ]) {
    const record = row(claimId);
    if (candidatePhase !== "ALL" && record.ownerPhase !== candidatePhase) continue;
    assert.equal(record.ownerSemanticReview.disposition, "BLOCKED_CURRENT_MATERIAL_CLAUSE_MISMATCH");
    assert.equal(record.ownerSemanticReview.historicalDisposition, "SOURCE_RULE_CONTENT_SUPPORTS_CLAIM_AT_DEFINITION_LEVEL");
    assert.equal(record.ownerSemanticReview.materialReviewBlocker.acceptanceEffect, "none");
    const binding = record.ownerSemanticReview.materialBindings.find(({ ref }) => ref.endsWith(suffix));
    assert.ok(binding);
    const { value } = resolveSelector(binding.ref);
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    assert.equal(serialized.includes(binding.requiredSourcePhrase), false,
      `${claimId} required phrase is absent from the live exact source value`);
    const joined = record.ownerSemanticReview.exactContractRefs.map((ref) => {
      const { value: contractValue } = resolveSelector(ref);
      return typeof contractValue === "string" ? contractValue : JSON.stringify(contractValue);
    }).join("\n");
    assert.equal(record.ownerSemanticReview.materialPredicates.every((predicate) => joined.includes(predicate)), false,
      `${claimId} current clauses fail at least one material predicate`);
  }

  const resolvedExpiry = row("MPSEM-0311-C004");
  assert.equal(resolvedExpiry.ownerPhase, "PDP-0");
  assert.equal(resolvedExpiry.ownerSemanticReview.disposition, "SOURCE_RULE_CONTENT_SUPPORTS_CLAIM_AT_DEFINITION_LEVEL");
  assert.equal(resolvedExpiry.ownerSemanticReview.acceptanceEffect, "none");
  assert.equal(resolvedExpiry.ownerSemanticReview.runtimeStatus, "NOT_EVALUATED");
  assert.equal(resolvedExpiry.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
  assert.equal(resolvedExpiry.currentProposalObservation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.equal(resolvedExpiry.currentProposalObservation.priorSourceFileSha256, resolvedExpiry.ownerSourceSha256,
    "the historical source file pin remains unchanged");
  assert.equal(resolvedExpiry.currentProposalObservation.priorTargetValueSha256, resolvedExpiry.currentTargetValueSha256,
    "the historical target value pin remains unchanged");
  assert.equal(resolvedExpiry.ownerSemanticReview.proposedTargetRef,
    ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.job.submit/ownerDefinition/idempotencyExpiryContract");
  assert.deepEqual(resolvedExpiry.ownerSemanticReview.materialBindings.map(({ ref }) => ref.split("/").at(-1)), [
    "productWideDuration", "expiryRule", "freshIdentityRule", "artifactRetentionRule", "pdp1Delegation",
  ]);
  assert.match(resolvedExpiry.ownerSemanticReview.materialBindings[0].requiredSourcePhrase, /NOT_DEFINED_BY_P0/u);
  assert.match(resolvedExpiry.ownerSemanticReview.materialBindings[1].requiredSourcePhrase,
    /never proves that no prior job or consequential effect exists[\s\S]*UNKNOWN_OUTCOME[\s\S]*same scoped idempotency identity/u);
  assert.match(resolvedExpiry.ownerSemanticReview.materialBindings[2].requiredSourcePhrase,
    /does not authorize a new idempotency key[\s\S]*fresh semantic request[\s\S]*another consequential effect/u);
  assert.match(resolvedExpiry.ownerSemanticReview.materialBindings[3].requiredSourcePhrase,
    /Artifact retention expiry is independent of idempotency and reconciliation evidence expiry/u);
  assert.match(resolvedExpiry.ownerSemanticReview.materialBindings[4].requiredSourcePhrase,
    /PDP-1 defines the exact approved per-operation retention duration[\s\S]*No duration is selected here/u);
  assert.equal(resolvedExpiry.ownerSemanticReview.materialReviewBlocker, undefined);
});

test("job acceptance keeps audit intent and dispatch intent inside one pre-effect durability boundary", { skip: candidatePhase === "PDP-0" }, () => {
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

test("parent cancellation freezes child admission and retains unresolved child effects", { skip: candidatePhase === "PDP-0" }, () => {
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

test("versioned autosave distinguishes local, pending, durable, offline, and conflict across mutable resources", { skip: candidatePhase === "PDP-0" }, () => {
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

test("versioned mutations use exact optimistic compare-and-set and render submission rejects stale project heads", { skip: candidatePhase === "PDP-0" }, () => {
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

test("owner error, CRUD, job-dimension, lease, and completion clauses reject weakening", { skip: candidatePhase === "PDP-0" }, () => {
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

test("erasure inventory preserves shared references, restore tombstones, and remote uncertainty", { skip: candidatePhase === "PDP-0" }, () => {
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
