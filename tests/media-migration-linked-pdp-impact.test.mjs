import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
    assert.equal(record.observedCurrentSha256, currentHash, `${path} current source fingerprint is accurate`);
    assert.notEqual(pin, currentHash, `${path} remains stale pending reconciliation`);
    assert.equal(record.disposition, "keep-stale-needs-claim-level-reconciliation");
    assert.ok(record.changedClaims?.length, `${path} describes its added claims`);
    assert.ok(record.rationale?.length, `${path} explains why the pin stays stale`);
    const spans = record.addedCurrentLineSpan;
    assert.equal(spans[1] - spans[0] + 1, record.addedLines, `${path} records the exact added source line count`);
    const lines = readFileSync(resolve(root, path), "utf8").split("\n");
    assert.equal(lines[spans[0] - 1].trim(), record.addedBlockHeader, `${path} begins its changed block at the recorded source line`);
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
  assert.equal(review.counts.uniqueUnitsByClassification.UNRESOLVED, 349);
  assert.equal(review.counts.blockStructureProposalCounts.MIXED_REQUIRES_DECOMPOSITION, 123);
  assert.equal(review.counts.blockStructureProposalCounts.ownerReviewed, 0);
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
  assert.match(constitution.domainRules.status, /pending-PDP-1-owner-review/u);
  assert.match(records.get(".product-experience/pdp-0-product-truth/constitution.yaml").rationale, /do not demonstrate equivalence/u);
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

  assert.equal(claimIds.length, 29, "the three source blocks are decomposed into atomic claims");
  assert.equal(new Set(claimIds).size, claimIds.length, "claim IDs are stable and unique");
  assert.ok(reconciliation.unresolvedDependencies.length >= 6, "external and independent review dependencies remain explicit");
  assert.equal(review.sourceChangeLedger.linkedPdpPinImpact.masterPlanPinDisposition, "unchanged-keep-stale");
  assert.ok(review.sourceChangeLedger.linkedPdpPinImpact.records.every(({ disposition }) => disposition === "keep-stale-needs-claim-level-reconciliation"));
});
