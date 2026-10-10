import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const readYaml = (path) => parse(read(path));
const artifactPath = "docs/migration/current-master-plan-claim-dispositions.json";
const sourcePath = "docs/migration/expert-reviewed-master-plan.md";
const ledgerPath = "docs/migration/master-plan-source-change-claims.yaml";
const classes = new Set(["adopted", "clarified", "superseded", "execution-only", "external-owner", "out-of-current-product-scope"]);
const candidatePhase = process.env.PDP_MIGRATION_CANDIDATE_PHASE ?? "ALL";
if (!["ALL", "PDP-0"].includes(candidatePhase)) throw new Error(`PDP_MIGRATION_CANDIDATE_PHASE must be ALL or PDP-0; got ${candidatePhase}`);
const p0Only = candidatePhase === "PDP-0";
const downstreamOwner = (ref, ownerRole = "") => /\/pdp-[1-3]-|PDP-[1-3]/u.test(`${ref ?? ""} ${ownerRole}`);
const rationalePatterns = {
  adopted:/adopt|already present/iu,
  clarified:/clarif/iu,
  superseded:/supersed/iu,
  "execution-only":/task|execution|procedure|implementation/iu,
  "external-owner":/external|downstream|owner/iu,
  "out-of-current-product-scope":/out.of.scope|outside|no product behavior/iu,
};

function resolveOwner(ref) {
  const [path, pointer] = ref.split("#", 2);
  if (path.endsWith(".md")) {
    const match = pointer?.match(/^L(\d+)$/u);
    assert.ok(match, `plan anchor must use a concrete line: ${ref}`);
    const line = read(path).split(/\r?\n/u)[Number(match[1]) - 1];
    assert.ok(line, `plan anchor resolves: ${ref}`);
    return line;
  }
  let value = readYaml(path);
  for (const raw of (pointer ?? "").split("/").filter(Boolean)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (/^\d+$/u.test(segment)) value = value[Number(segment)];
    else value = value?.[segment];
    assert.notEqual(value, undefined, `owner selector resolves: ${ref}`);
  }
  return value;
}

test("all current master-plan source claims have one exact, non-accepting owner disposition", () => {
  const audit = JSON.parse(read(artifactPath));
  const ledger = readYaml(ledgerPath);
  const source = read(sourcePath);
  const sourceLines = source.split("\n");
  const sourceHash = sha(source);
  const claimsById = new Map(ledger.claimDecompositions.map(claim => [claim.claimId, claim]));
  const expectedIds = [...claimsById.keys()];

  assert.equal(audit.sourcePin.sha256, ledger.observedCurrentSource.sha256);
  assert.equal(sourceHash, audit.sourcePin.sha256, "the reviewed current source still matches its pinned bytes");
  assert.equal(audit.sourcePin.observedSha256, sourceHash);
  assert.equal(sourceLines.length - 1, audit.sourcePin.lineCount);
  assert.equal(audit.claimCount, 129);
  assert.equal(audit.records.length, 129);
  assert.equal(new Set(audit.records.map(({ claimId }) => claimId)).size, 129);
  assert.deepEqual(new Set(audit.records.map(({ claimId }) => claimId)), new Set(expectedIds));
  assert.deepEqual(audit.p0MeaningOnlyInOldPlan, []);
  const observedCounts = {};

  for (const record of audit.records) {
    const sourceClaim = claimsById.get(record.claimId);
    assert.ok(sourceClaim, `${record.claimId} exists in the historical claim ledger`);
    assert.ok(classes.has(record.classification), `${record.claimId} classification is allowed`);
    observedCounts[record.classification] = (observedCounts[record.classification] ?? 0) + 1;
    assert.equal(record.acceptanceEffect, "none", record.claimId);
    assert.ok(record.reason.length > 30, `${record.claimId} has a reason`);
    const [start, end] = record.currentSourceLines;
    assert.deepEqual(record.currentSourceLines, sourceClaim.currentSourceLines, `${record.claimId} preserves the exact source hunk coordinates`);
    assert.equal(record.exactClaim, sourceClaim.exactClaim, `${record.claimId} preserves the exact decomposed claim text`);
    assert.equal(record.clusterId, sourceClaim.clusterId);
    assert.equal(record.hunkId, sourceClaim.hunkId);
    assert.ok(start > 0 && end >= start, `${record.claimId} has exact current source lines`);
    const exactCurrentText = sourceLines.slice(start - 1, end).join("\n");
    assert.ok(exactCurrentText.includes(record.exactClaim), `${record.claimId} exact text occurs at current lines`);
    assert.equal(sha(record.exactClaim), record.sourceTextSha256, `${record.claimId} exact claim digest`);
    assert.ok(record.ownerRef && !Array.isArray(record.ownerRef), `${record.claimId} has exactly one owner ref`);
    assert.ok(record.ownerRole?.trim(), `${record.claimId} states the target owner's role`);
    assert.ok(record.reason.length > 30 && rationalePatterns[record.classification].test(record.reason), `${record.claimId} reason states its category-specific rationale`);
    assert.deepEqual(record.semanticEvidence, {
      method:'exact source claim and coordinates compared with one current owner target; reviewer classification remains non-accepting',
      sourceClaim:{claimId:record.claimId,currentSourceLines:record.currentSourceLines,sha256:record.sourceTextSha256},
      currentOwner:{ref:record.ownerRef,sha256:record.ownerValueSha256},classification:record.classification,reason:record.reason,
    }, `${record.claimId} carries source-grounded semantic comparison evidence`);
    if (!p0Only || !downstreamOwner(record.ownerRef, record.ownerRole)) {
      const ownerValue = resolveOwner(record.ownerRef);
      const ownerText = typeof ownerValue === "string" ? ownerValue : JSON.stringify(ownerValue);
      assert.equal(sha(ownerText), record.ownerValueSha256, `${record.claimId} exact current owner digest`);
    }
    if (["execution-only", "superseded"].includes(record.classification)) {
      assert.match(record.ownerRef, /^docs\/implementation\/PDP-0-3-SEQUENTIAL-DEVELOPMENT-COMPLETION-PLAN\.md#L\d+$/u);
    } else {
      assert.ok(record.ownerRef.startsWith('.product-experience/'), `${record.claimId} resolves to one current product owner`);
    }
    if (record.classification === "external-owner") assert.match(record.downstreamHandoffStatus, /NOT_A_PDP0_MEANING_GAP/u);
  }
  assert.deepEqual(audit.classificationCounts, observedCounts);

  const handoff = audit.externalHandoffs.find(({ claimId }) => claimId === "MSC-07-MSD-015-L0584-C05");
  assert.ok(handoff, "scene/model contract proposal has an explicit downstream handoff");
  const claim = audit.records.find(({ claimId }) => claimId === handoff.claimId);
  assert.equal(handoff.sourceOwnerRef, claim.ownerRef, "the handoff retains its exact current P0 source owner");
  assert.equal(handoff.sourceOwnerValueSha256, claim.ownerValueSha256);
  assert.match(handoff.status, /PENDING_PDP1_EXTERNAL_SCENE_MODEL_CONTRACT_VALIDATION/u);
  assert.match(handoff.status, /NOT_A_PDP0_MEANING_GAP/u);
  const handoffOwner = resolveOwner(handoff.ownerRef);
  const handoffOwnerText = typeof handoffOwner === "string" ? handoffOwner : JSON.stringify(handoffOwner);
  assert.equal(sha(handoffOwnerText), handoff.ownerValueSha256);
  if (!p0Only || !downstreamOwner(handoff.proposalRef)) {
    const proposalValue = resolveOwner(handoff.proposalRef);
    assert.equal(sha(JSON.stringify(proposalValue)), handoff.proposalValueSha256);
  }
  const schemaBindings = readYaml(".product-experience/pdp-0-product-truth/schema-bindings.yaml");
  assert.match(schemaBindings.canonicalPhases[1].acceptanceState, /domain-owner-adjudication-pending/u);
  const proposal = readYaml(".product-experience/pdp-0-product-truth/time-units-fidelity.yaml").unitAndCoordinateProposal;
  assert.match(proposal.status, /validation-against-admitted-scene-model-contracts-pending/u);
});

test("high-risk migration claims resolve to their semantically correct phase owners", () => {
  const audit = JSON.parse(read(artifactPath));
  const record = (id) => {
    const value = audit.records.find((item) => item.claimId === id);
    assert.ok(value, `${id} is present`);
    return value;
  };
  const owner = (id, ref) => {
    const value = record(id);
    assert.equal(value.ownerRef, ref, `${id} names the expected current owner`);
    return resolveOwner(ref);
  };
  const text = (value) => typeof value === "string" ? value : JSON.stringify(value);

  const p0 = owner("MSC-03-MSD-009-L0332-C01", ".product-experience/authority-map.yaml#/phaseAuthorities/0");
  assert.match(p0.scope, /Product meaning, outcomes, actors, requirements, capabilities/u);
  assert.match(p0.scope, /PDP-1 owns canonical domain objects/u);
  const p1Record = record("MSC-03-MSD-009-L0333-C01");
  assert.equal(p1Record.ownerRef, ".product-experience/authority-map.yaml#/phaseAuthorities/1");
  if (!p0Only) { const p1 = owner(p1Record.claimId, p1Record.ownerRef); assert.match(p1.scope, /Canonical domain objects, values and units, relationships/u); }

  const defineProduct = owner("MSC-02-MSD-003-L0024-C02", ".product-experience/authority-map.yaml#/sourceOwnership");
  assert.equal(defineProduct.scope, "all-authored-Media-PDP-0-through-PDP-3-product-meaning-and-acceptance-inputs");
  assert.equal(defineProduct.competingProductDefinitionAuthority, "prohibited");

  const boundary = owner("MSC-07-MSD-018-L0918-C01", ".product-experience/authority-map.yaml#/phaseAuthorities/0");
  assert.equal(boundary.acceptance, "P0-001-boundary-slice-only");
  assert.ok(boundary.artifacts.some((item) => item.id === "ART-P0-PRODUCT-TRUTH-BOUNDARY" && item.acceptanceState === "accepted"));

  const localeRecord = record("MSC-07-MSD-019-L1027-C04");
  const localeRule = owner("MSC-07-MSD-019-L1027-C04", ".product-experience/pdp-0-product-truth/applications-channels.yaml#/localeAdmission/rules/0");
  assert.match(localeRule, /unavailable with a reason/u);
  assert.match(localeRule, /never silently fall back to English/u);
  assert.match(localeRecord.downstreamHandoffStatus, /PENDING_PDP1_CANONICAL_LANGUAGE_AND_DATA_SEMANTICS/u);
  assert.match(localeRecord.downstreamHandoffStatus, /P0_NO_ENGLISH_FALLBACK_ADOPTED/u);
  assert.equal(localeRecord.acceptanceEffect, "none");

  if (!p0Only) {
    const statePresentation = owner("MSC-12-MSD-076-L1864-C01", ".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml#/ownerDefinedStatePresentationRules/0");
    assert.equal(statePresentation.id, "media.ui.state-presentation-not-state-machine.v1");
    assert.match(statePresentation.rule, /label and explanation are presentation only/u);
    assert.ok(statePresentation.negativeCases.some((item) => /cannot report finality/u.test(item)));
  }

  if (!p0Only) { const channels = owner("MSC-10-MSD-027-L1217-C01", ".product-experience/pdp-3-product-experience/application-channel-registry.yaml#/crossChannelInvariants"); assert.match(text(channels), /channel/iu); }
  const phaseBoundary = owner("MSC-10-MSD-027-L1217-C04", ".product-experience/authority-map.yaml#/authorityRules/1");
  assert.equal(phaseBoundary.id, "AUTH-RULE-PHASE-BOUNDARY");
  assert.match(phaseBoundary.rule, /may not silently introduce or change/u);

  const inboundGraduation = record("MSC-13-MSD-111-L2544-C01");
  assert.equal(inboundGraduation.classification, "clarified");
  const inboundGap = owner("MSC-13-MSD-111-L2544-C01", ".product-experience/gaps.yaml#/gaps/3");
  assert.equal(inboundGap.id, "GAP-04");
  assert.equal(inboundGap.status, "resolved-for-in-progress-record");
  assert.equal(inboundGap.impact, "completed-cutover-policy-remains-separately-governed");
  assert.match(inboundGraduation.reason, /does not establish completed inbound graduation/u);

  const consumerGapClaim = record("MSC-13-MSD-113-L2562-C01");
  assert.equal(consumerGapClaim.classification, "external-owner");
  const consumerGap = owner("MSC-13-MSD-113-L2562-C01", ".product-experience/gaps.yaml#/gaps/0");
  assert.equal(consumerGap.id, "GAP-01");
  assert.equal(consumerGap.status, "open");
  assert.equal(consumerGap.owner, "migration-engineer-and-consumer-owners");
  assert.match(consumerGapClaim.downstreamHandoffStatus, /NOT_A_PDP0_MEANING_GAP/u);

  const p0p1Map = owner("MSC-13-MSD-112-L2546-C01", ".product-experience/authority-map.yaml#/phaseAuthorities");
  assert.ok(p0p1Map.some(({ phase, scope }) => phase === "PDP-0" && /Product meaning, outcomes/u.test(scope)));
  assert.ok(p0p1Map.some(({ phase, scope }) => phase === "PDP-1" && /Canonical domain objects/u.test(scope)));

  for (const id of ["MSC-10-MSD-110-L2458-C01", "MSC-14-MSD-117-L2680-C01"]) {
    const summary = record(id);
    assert.equal(summary.classification, "execution-only");
    assert.equal(summary.ownerRef, "docs/implementation/PDP-0-3-SEQUENTIAL-DEVELOPMENT-COMPLETION-PLAN.md#L6");
    assert.match(summary.reason, /not product meaning/u);
    assert.match(owner(id, summary.ownerRef), /Explorer is a consumer\/projection, not a phase/u);
  }
});
