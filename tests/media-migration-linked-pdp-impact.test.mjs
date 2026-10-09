import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const hashFile = (path) => createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex");
const review = readYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
const expected = new Map([
  [".product-experience/pdp-0-product-truth/goals-jtbd.yaml", ["MPSEM-0050..MPSEM-0081", "MPSEM-0170..MPSEM-0212", "MPSEM-0440..MPSEM-0453"]],
  [".product-experience/pdp-0-product-truth/actors-responsibilities.yaml", ["MPSEM-0050..MPSEM-0121", "MPSEM-0354..MPSEM-0371", "MPSEM-0440..MPSEM-0453"]],
  [".product-experience/pdp-0-product-truth/constitution.yaml", ["MPSEM-0122..MPSEM-0155"]],
]);

function expandRanges(ranges) {
  return ranges.flatMap((range) => {
    const match = /^(MPSEM-\d+)\.\.(MPSEM-\d+)$/u.exec(range);
    assert.ok(match, `invalid item ID range ${range}`);
    const first = Number(match[1].slice(6));
    const last = Number(match[2].slice(6));
    assert.ok(last >= first, `descending item ID range ${range}`);
    return Array.from({ length: last - first + 1 }, (_, offset) => `MPSEM-${String(first + offset).padStart(4, "0")}`);
  });
}

test("linked PDP source changes remain stale until their migration item claims are reconciled", () => {
  const ledger = review.sourceChangeLedger;
  assert.equal(review.sourcePin.sha256, "2960242334b5144187a7a6b687d4513a97d7f45401e0544b772b0e80f122fa5a");
  assert.equal(ledger.sourcePinDisposition, "keep-stale");
  assert.equal(ledger.linkedPdpPinImpact.masterPlanPinDisposition, "unchanged-keep-stale");
  assert.match(ledger.linkedPdpPinImpact.method, /section-level provenance/u);
  assert.match(ledger.linkedPdpPinImpact.method, /none has an exactPdpRef/u);

  const sourceItems = new Map(review.items.map((item) => [item.itemId, item]));
  const linkedPins = new Map(review.linkedPdpSourcePins.map(({ path, sha256 }) => [path, sha256]));
  const impactRecords = ledger.linkedPdpPinImpact.records;
  assert.equal(impactRecords.length, 3);
  assert.deepEqual(new Set(impactRecords.map(({ path }) => path)), new Set(expected.keys()));

  for (const record of impactRecords) {
    const path = record.path;
    const pin = linkedPins.get(path);
    const currentHash = hashFile(path);
    assert.ok(pin, `${path} has an existing linked pin`);
    assert.equal(record.pinnedSha256, pin, `${path} pin is not silently refreshed`);
    if (path.endsWith('/goals-jtbd.yaml')) {
      const current = JSON.parse(readFileSync(resolve(root, 'docs/implementation/verification/pdp-38/goal-measure-current-impact.json'), 'utf8'));
      const latestOwnerCut = JSON.parse(readFileSync(resolve(root, 'docs/implementation/verification/pdp-38/migration-goals-owner-source-impact.json'), 'utf8'));
      const directCriteria = JSON.parse(readFileSync(resolve(root, 'docs/implementation/verification/pdp-38/direct-definition-criteria-review.json'), 'utf8'));
      const currentP006Cut = directCriteria.records.find(({ taskId }) => taskId === 'P0-06')?.currentCorrectiveReview;
      assert.equal(record.observedCurrentSha256, '74f9a10de4e959d1874e7e83d42fb6ff04b25b5a427230e1bf343c6ece8520d2', 'preserve prior impact observation');
      assert.equal(current.decisionRef, '.product-experience/decision-log.md#PXD-081', 'the four-measure observation remains an immutable historical cut');
      assert.equal(latestOwnerCut.decisionRef, '.product-experience/decision-log.md#PXD-090');
      assert.equal(latestOwnerCut.currentFileSha256, '28b87b3026a8c8ef4c4a16de213bc112432fc37b086d5d02e912214a4d225cea', 'PXD-090 remains an immutable historical goal-source cut');
      assert.equal(currentP006Cut?.status, 'APPROVED_CURRENT_CORRECTION');
      assert.equal(currentP006Cut?.decisionRef, '.product-experience/decision-log.md#PXD-105');
      assert.equal(currentP006Cut?.sourceFingerprints[path], currentHash, 'the latest exact P0-06 review binds current goal-source bytes');
    } else {
      const historicalHashes = {
        '.product-experience/pdp-0-product-truth/actors-responsibilities.yaml': '9f077be079a1815ea15988fd0a01a142351ab8137f299d24d1be7b72c8bd2af1',
        '.product-experience/pdp-0-product-truth/constitution.yaml': 'fe10aaf5f79a1b48b38b1cdc1519bb7cdd9db72fdc149e11d235baa683dcce45',
      };
      if (historicalHashes[path]) assert.equal(record.observedCurrentSha256, historicalHashes[path], 'retain prior source-impact observation');
      else assert.equal(record.observedCurrentSha256, currentHash);
    }
    const currentObservation = JSON.parse(readFileSync(resolve(root, 'docs/implementation/verification/pdp-38/linked-pdp-current-fingerprints.json'), 'utf8'));
    if (path.endsWith('/goals-jtbd.yaml')) {
      const directCriteria = JSON.parse(readFileSync(resolve(root, 'docs/implementation/verification/pdp-38/direct-definition-criteria-review.json'), 'utf8'));
      const currentP006Cut = directCriteria.records.find(({ taskId }) => taskId === 'P0-06')?.currentCorrectiveReview;
      assert.equal(currentObservation.sources.find(source => source.path === path)?.sha256,
        JSON.parse(readFileSync(resolve(root, 'docs/implementation/verification/pdp-38/goal-measure-current-impact.json'), 'utf8')).currentSha256,
        'the PXD-081 measurement snapshot remains preserved after later owner-source reviews');
      assert.notEqual(currentObservation.sources.find(source => source.path === path)?.sha256, currentHash,
        'the old current-fingerprint artifact is not silently rewritten to the later reviewed cut');
      assert.equal(currentP006Cut?.sourceFingerprints[path], currentHash, 'PXD-105 separately records the exact reviewed current correction');
    } else assert.equal(currentObservation.sources.find(source => source.path === path)?.sha256, currentHash);
    assert.match(currentObservation.authority, /Does not establish migration semantic parity/);
    assert.notEqual(pin, currentHash, `${path} remains stale pending reconciliation`);
    assert.equal(record.disposition, "keep-stale-needs-claim-level-reconciliation");
    assert.ok(record.changedClaims?.length, `${path} describes its added claims`);
    assert.ok(record.rationale?.length, `${path} explains why the pin stays stale`);
    const spans = record.addedCurrentLineSpan;
    assert.equal(spans[1] - spans[0] + 1, record.addedLines, `${path} records the exact added source line count`);
    const lines = readFileSync(resolve(root, path), "utf8").split("\n");
    const currentSource = currentObservation.sources.find(source => source.path === path);
    assert.deepEqual(currentSource.historicalAddedSpan, spans);
    assert.equal(currentSource.historicalObservedSha256, record.observedCurrentSha256);
    assert.equal(lines[currentSource.currentHeaderLine - 1].trim(), record.addedBlockHeader, `${path} current block header has an exact current location`);
    for (let line = spans[0]; line <= spans[1]; line += 1) assert.ok(lines[line - 1]?.trim(), `${path}:${line} exists`);

    const citation = record.citedMigrationItems;
    const declaredIds = expandRanges(citation.itemIdRanges).sort();
    const citedItems = review.items.filter((item) => item.sectionProvenanceRefs?.some(({ artifactRef }) => artifactRef === path));
    const actualIds = citedItems.map(({ itemId }) => itemId).sort();
    assert.deepEqual(declaredIds, actualIds, `${path} ledger lists the exact section-provenance item set`);
    assert.equal(citation.count, citedItems.length);
    assert.equal(citation.sectionProvenanceOnly, citedItems.length);
    assert.equal(citation.exactPdpRefCount, citedItems.filter((item) => item.exactPdpRefs?.includes(path)).length);
    assert.equal(citation.exactPdpRefCount, 0, `${path} has no claim-exact migration links`);
  }

  assert.equal(review.counts.uniqueContentUnits, 1340);
  assert.equal(review.counts.uniqueUnitsByClassification.UNRESOLVED, 260);
  assert.equal(review.counts.blockStructureProposalCounts.MIXED_REQUIRES_DECOMPOSITION, 124);
  assert.equal(review.counts.blockStructureProposalCounts.ownerReviewed, 3);
});

test("the stale pin impact describes the exact newly added PDP claims", () => {
  const records = new Map(review.sourceChangeLedger.linkedPdpPinImpact.records.map((record) => [record.path, record]));
  const goals = readYaml(".product-experience/pdp-0-product-truth/goals-jtbd.yaml");
  const actors = readYaml(".product-experience/pdp-0-product-truth/actors-responsibilities.yaml");
  const constitution = readYaml(".product-experience/pdp-0-product-truth/constitution.yaml");

  assert.equal(goals.authorityMapping.goalAuthorityNotes.length, 4);
  assert.match(records.get(".product-experience/pdp-0-product-truth/goals-jtbd.yaml").changedClaims, /actorRefs-versus-principal/u);
  assert.equal(actors.trustContexts.contexts.length, 4);
  assert.equal(actors.ownershipRules.rules.length, 5);
  assert.equal(actors.trustContexts.principalKindInference, "forbidden");
  assert.equal(constitution.invariants.records.length, 7);
  assert.match(constitution.domainRules.status, /PXD-035/u);
  assert.equal(constitution.domainRules.records.length, 6);
  assert.equal(goals.successMeasureContracts.records.length, 4);
  assert.match(records.get(".product-experience/pdp-0-product-truth/constitution.yaml").rationale, /does not establish full item-level equivalence/u);
  const constitutionImpact = records.get(".product-experience/pdp-0-product-truth/constitution.yaml");
  assert.match(constitutionImpact.changedClaims, /six bounded domainRules mapped under PXD-035/u);
  assert.match(constitutionImpact.changedClaims, /does not accept canonical PDP-1 records/u);
  assert.match(constitutionImpact.rationale, /LPR-CONST-009/u);
  assert.match(constitutionImpact.rationale, /does not constitute owner acceptance/u);
  const claim = review.sourceChangeLedger.linkedPdpClaimReconciliation.sourceBlocks
    .find(({ path }) => path === ".product-experience/pdp-0-product-truth/constitution.yaml")
    .claims.find(({ claimId }) => claimId === "LPR-CONST-009");
  assert.deepEqual(claim.sourceSpan, [26, 27]);
  assert.equal(claim.ownerPhase, "PDP-0");
  assert.equal(claim.targetRef, ".product-experience/pdp-0-product-truth/constitution.yaml#/domainRules");
  assert.equal(claim.disposition, "ROUTED_TO_PDP0_BOUNDED_RULE_MAPPING; P0-010-INDEPENDENT-REVIEW-PENDING");
  assert.match(claim.assertion, /PXD-035 maps six exact PDP-1 accepted policy decisions/u);
  assert.match(claim.assertion, /does not accept PDP-1 canonical records/u);
  assert.match(claim.assertion, /runtime behavior, or the phase/u);
  assert.match(claim.dependency, /Six rule mappings have PXD-035 bounded approval/u);
  assert.match(claim.dependency, /independent P0-010 review remain open/u);

  const goalImpact = records.get(".product-experience/pdp-0-product-truth/goals-jtbd.yaml");
  assert.equal(goalImpact.additionalCurrentBlocks[0].span[0], 477);
  assert.equal(goalImpact.additionalCurrentBlocks[0].span[1], 626);
  assert.deepEqual(goalImpact.additionalCurrentBlocks[0].previousReviewedSpan, [477, 539]);
  assert.equal(goalImpact.additionalCurrentBlocks[0].header, "successMeasureContracts:");
  // The old span records a prior observation, not the later PXD-081 population.
  const currentImpact=JSON.parse(readFileSync(resolve(root,"docs/implementation/verification/pdp-38/goal-measure-current-impact.json"),"utf8"));
  const latestOwnerCut=JSON.parse(readFileSync(resolve(root,"docs/implementation/verification/pdp-38/migration-goals-owner-source-impact.json"),"utf8"));
  assert.equal(currentImpact.decisionRef,".product-experience/decision-log.md#PXD-081");
  assert.equal(latestOwnerCut.decisionRef,".product-experience/decision-log.md#PXD-090");
  assert.equal(latestOwnerCut.priorSourceFileSha256,currentImpact.currentSha256,
    "PXD-090 records the exact PXD-081 goal-source bytes as its prior snapshot");
  assert.equal(latestOwnerCut.currentFileSha256,"28b87b3026a8c8ef4c4a16de213bc112432fc37b086d5d02e912214a4d225cea",
    "PXD-090 remains an immutable historical current-file fingerprint");
  const directCriteria=JSON.parse(readFileSync(resolve(root,"docs/implementation/verification/pdp-38/direct-definition-criteria-review.json"),"utf8"));
  const currentP006=directCriteria.records.find(({taskId})=>taskId==="P0-06")?.currentCorrectiveReview;
  assert.equal(currentP006?.sourceFingerprints[ currentImpact.source ],hashFile(currentImpact.source),
    "PXD-105 separately binds the exact current goal bytes");
  assert.deepEqual(currentImpact.historicalSuccessMeasureBlock.span,goalImpact.additionalCurrentBlocks[0].span);
  const pxd081Source=execFileSync("git",["show",`${latestOwnerCut.priorSourceCommit}:${latestOwnerCut.sourcePath}`],{encoding:"utf8",maxBuffer:16*1024*1024});
  assert.equal(createHash("sha256").update(pxd081Source).digest("hex"),currentImpact.currentSha256,
    "the historical PXD-081 goal bytes remain recoverable from PXD-090's prior commit");
  const historicalMeasures=parse(pxd081Source).successMeasureContracts;
  assert.equal(createHash("sha256").update(JSON.stringify(historicalMeasures)).digest("hex"),latestOwnerCut.existingSuccessMeasuresPreservedSha256);
  const currentMeasures=readYaml(currentImpact.source).successMeasureContracts;
  assert.equal(currentMeasures.records.length,currentImpact.measurementContracts);
  assert.equal(currentMeasures.ownerCapabilityApplicabilityCrosswalk.measureApplicabilityRecords.records.length,currentImpact.normativeApplicabilityDispositions);
  assert.equal(currentImpact.measurementContracts,4);
  assert.equal(currentImpact.normativeApplicabilityDispositions,1848);
  assert.equal(goalImpact.additionalCurrentBlocks[0].lineCount, 150);
  assert.equal(goalImpact.additionalCurrentBlocks[0].previousReviewedLineCount, 63);
  assert.match(goalImpact.changedClaims, /NOT_EVALUATED baseline\/qualification/u);
  assert.match(goalImpact.changedClaims, /NOT_SET target/u);
});

test("new linked-PDP assertions are atomized, source-located, and routed without implying acceptance", () => {
  const reconciliation = review.sourceChangeLedger.linkedPdpClaimReconciliation;
  assert.match(reconciliation.status, /partial/u);
  assert.match(reconciliation.scope, /do not\s+make proposed PDP records accepted/u);
  const sourcePaths = new Set(review.linkedPdpSourcePins.map(({ path }) => path));
  const claimIds = [];
  const allowedDispositions = new Set([
    "ROUTED_PENDING_OWNER_REVIEW",
    "ROUTED_WITH_EXTERNAL_OWNER_DEPENDENCY",
    "ROUTED_WITH_EXTERNAL_CONTRACT_DEPENDENCY",
    "OWNER_RESOLVED_PENDING_INDEPENDENT_REVIEW",
    "ROUTED_PENDING_PDP1_OWNER_REVIEW",
    "ROUTED_TO_PDP0_BOUNDED_RULE_MAPPING; P0-010-INDEPENDENT-REVIEW-PENDING",
  ]);
  const sourceCache = new Map();
  const targetCache = new Map();

  for (const block of reconciliation.sourceBlocks) {
    assert.ok(sourcePaths.has(block.path), `${block.path} is one of the linked pinned sources`);
    const source = readFileSync(resolve(root, block.path), "utf8");
    const sourceLines = source.split("\n");
    sourceCache.set(block.path, sourceLines);
    assert.ok(block.sourceSpan[0] > 0 && block.sourceSpan[1] <= sourceLines.length, `${block.path} source block span exists`);

    for (const claim of block.claims) {
      claimIds.push(claim.claimId);
      assert.ok(claim.assertion.length > 20, `${claim.claimId} states one claim`);
      assert.ok(allowedDispositions.has(claim.disposition), `${claim.claimId} has a non-accepting disposition`);
      assert.ok(claim.dependency.length > 0, `${claim.claimId} retains its review/owner dependency`);
      assert.ok(claim.sourceSpan[0] >= block.sourceSpan[0] && claim.sourceSpan[1] <= block.sourceSpan[1], `${claim.claimId} span is within its appended source block`);
      for (let line = claim.sourceSpan[0]; line <= claim.sourceSpan[1]; line += 1) {
        assert.ok(sourceLines[line - 1]?.trim(), `${claim.claimId} source line ${line} exists`);
      }

      const [targetPath, pointer] = claim.targetRef.split("#");
      assert.ok(targetPath && pointer?.startsWith("/"), `${claim.claimId} target is an exact PDP record pointer`);
      if (!targetCache.has(targetPath)) targetCache.set(targetPath, readYaml(targetPath));
      const target = pointer.slice(1).split("/").reduce((value, part) => value?.[part.replaceAll("~1", "/").replaceAll("~0", "~")], targetCache.get(targetPath));
      assert.notEqual(target, undefined, `${claim.claimId} target ${claim.targetRef} exists`);
    }
  }

  assert.equal(claimIds.length, 30, "the three source blocks are decomposed into atomic claims");
  assert.equal(new Set(claimIds).size, claimIds.length, "claim IDs are stable and unique");
  assert.ok(reconciliation.unresolvedDependencies.length >= 6, "external and independent review dependencies remain explicit");
  assert.equal(review.sourceChangeLedger.linkedPdpPinImpact.masterPlanPinDisposition, "unchanged-keep-stale");
  assert.ok(review.sourceChangeLedger.linkedPdpPinImpact.records.every(({ disposition }) => disposition === "keep-stale-needs-claim-level-reconciliation"));
});
