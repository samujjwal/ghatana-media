import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readText = (path) => readFileSync(resolve(root, path), "utf8");
const readYaml = (path) => parse(readText(path));
const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const artifact = JSON.parse(readText("docs/implementation/verification/pdp-38/migration-glossary-owner-review.json"));
const approval = JSON.parse(readText("docs/implementation/verification/pdp-38/migration-coordinator-review-112.json"));
const approvedById = new Map(approval.records.map((record) => [record.claimId, record]));
const ledger = readYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
const claims = ledger.pdp38ClaimReconciliation.records.flatMap((record) => record.claims ?? [])
  .flatMap((claim) => claim.subclaims ?? [claim]);
const claimById = new Map(claims.map((claim) => [claim.claimId, claim]));

function resolveRef(ref) {
  const [path, pointer = ""] = ref.split("#", 2);
  let value = readYaml(path);
  for (const raw of pointer.split("/").filter(Boolean)) {
    const part = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (part.startsWith("@id=")) value = Array.isArray(value) ? value.find((entry) => entry.id === part.slice(4)) : undefined;
    else if (/^\d+$/u.test(part)) value = value[Number(part)];
    else value = value?.[part];
    assert.notEqual(value, undefined, `exact target resolves: ${ref}`);
  }
  return value;
}

const predicates = {
  "MPSEM-0036-C002": ["Independent declarations for access/sharing, classification, processing location, consent/rights, and retention", "single label such as private or public cannot substitute"],
  "MPSEM-0036-C003": ["Offer a simple human-readable summary", "preserving each applicable axis independently"],
  "MPSEM-0043-C004": ["Separate states for product definition, implementation, qualification, license admission, and runtime availability", "A definition record establishes only the definition axis"],
  "MPSEM-0058-C001": ["capabilityId", "media.<family>.<operation>"],
  "MPSEM-0058-C003": ["IDs are stable, lowercase, domain-owned", "omit vendor, model, provider, and implementation names"],
  "MPSEM-0074-C003": ["artifact produced from one or more authorized inputs", "derivation and processing provenance", "not a competing storage authority"],
  "MPSEM-0074-C005": ["versioned, bounded description", "does not route generic model providers or represent an execution attempt"],
  "MPSEM-0079-C001": ["Separate states for product definition, implementation, qualification, license admission, and runtime availability", "Unknown and not-evaluated are not available"],
  "MPSEM-0255-C001": ["integer sample/frame counts or rational time", "rates as {numerator, denominator}"],
  "MPSEM-0255-C002": ["Half-open intervals [start, end)", "rounding at each conversion"],
  "MPSEM-0255-C003": ["do not accumulate floating-point milliseconds across a long timeline"],
  "MPSEM-0256-C001": ["Presentation position in the admitted output/edit timeline", "rational seconds or integer output frames/samples"],
  "MPSEM-0256-C004": ["Domain model or physical simulation time", "Explicit domain unit", "Story pause/scrub does not advance t_sim"],
  "MPSEM-0256-C005": ["Explanation, animation, or editorial presentation time", "Pausing or seeking story time does not change model state"],
  "MPSEM-0256-C006": ["Story pause/scrub does not advance t_sim unless an explicit, bounded model command says so"],
  "MPSEM-0261-C003": ["Proposed initial convention", "Validate against admitted Ghatana scene/model contracts before acceptance", "A domain owner may declare converted units", "reject implicit or lossy conversion"],
  "MPSEM-0261-C005": ["Exact rational zero-based x/y center index", "(index+1/2)/dimension", "Center and boundary converters reject each other's serialized convention"],
  "MPSEM-0261-C006": ["Normalized coordinates are (index+1/2)/dimension", "No silent clipping"],
  "MPSEM-0278-C002": ["Fidelity is domain- and method-specific", "quality score", "not prove validated simulation"],
  "MPSEM-0354-C001": ["Offer a simple human-readable summary", "preserving each applicable axis independently"],
  "MPSEM-0442-C002": ["Three progressive disclosure levels over one Media semantic model, action set, and state", "Switching levels preserves authority and edits", "does not create separate workflows"],
};

function validateMaterial(row, target) {
  const text = JSON.stringify(target);
  for (const phrase of predicates[row.claimId] ?? []) assert.ok(text.includes(phrase), `${row.claimId} preserves: ${phrase}`);
}

test("the full live 22-claim glossary cohort preserves historical pins and binds complete owner definitions", () => {
  assert.equal(artifact.schemaVersion, "media.pdp38-migration-glossary-owner-review.v1");
  assert.equal(artifact.recordCount, 22);
  assert.equal(artifact.records.length, 22);
  assert.equal(new Set(artifact.records.map(({ claimId }) => claimId)).size, 22);
  for (const row of artifact.records) {
    const original = claimById.get(row.claimId);
    const approved = approvedById.get(row.claimId);
    assert.ok(original, `${row.claimId} remains a current source claim`);
    assert.ok(approved, `${row.claimId} has a distinct coordinator approval overlay`);
    assert.equal(original.exactSourceText, row.exactSourceText);
    assert.equal(original.sourceTextSha256, row.sourceTextSha256);
    assert.equal(approved.previousTargetRef, row.previousTargetRef);
    assert.equal(approved.previousTargetValueSha256, row.previousTargetValueSha256);
    assert.equal(row.semanticReviewStatus, "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY");
    assert.equal(row.coordinatorReviewStatus, "PENDING");
    assert.equal(row.acceptanceEffect, "none");
    if (row.proposedDisposition === "NON_NORMATIVE_SOURCE_METADATA") {
      assert.equal(row.claimId, "MPSEM-0053-C001");
      assert.equal(original.disposition, "NON_NORMATIVE_SOURCE_METADATA");
      assert.equal(original.sourceEvidenceRef, approved.currentTargetRef);
      const line = readText("docs/migration/expert-reviewed-master-plan.md").split("\n")[142];
      assert.match(line, /^\| Generative orchestration subsystem \| \*\*MediaSynth\*\*/u);
      assert.deepEqual(row.metadataFields, ["table-row-heading"]);
      continue;
    }
    const target = resolveRef(row.proposedTargetRef);
    assert.equal(sha(target), row.proposedTargetValueSha256, `${row.claimId} exact target hash`);
    validateMaterial(row, target);
    assert.equal(original.semanticReviewRef, `docs/implementation/verification/pdp-38/migration-coordinator-review-112.json#/records/@claimId=${row.claimId}`);
    assert.equal(original.semanticReviewStatus, "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED");
    assert.equal(original.targetRef, approved.currentTargetRef);
    assert.equal(original.targetTextSha256, approved.currentTargetValueSha256);
  }
  assert.equal(artifact.nonClaims.includes("No legacy wire, runtime, qualification or independent acceptance inferred"), true);
});

test("glossary owner definitions reject loss of privacy axes, clock profiles, pixel-center conversion, and disclosure state", () => {
  const row = (claimId) => artifact.records.find((entry) => entry.claimId === claimId);
  const mutate = (claimId, edit) => {
    const claim = row(claimId);
    const target = structuredClone(resolveRef(claim.proposedTargetRef));
    edit(target);
    assert.throws(() => validateMaterial(claim, target));
  };
  mutate("MPSEM-0036-C003", (target) => { target.summaryRule = "Use one private/public value."; });
  mutate("MPSEM-0255-C002", (target) => { target.intervalConvention = "Closed intervals."; });
  mutate("MPSEM-0256-C006", (target) => { target.coupling = "Story scrub advances model time."; });
  mutate("MPSEM-0261-C005", (target) => { target.convention = "pixel-boundary; top-left; right-down"; });
  mutate("MPSEM-0442-C002", (target) => { target.distinctions = ["Switching levels creates separate workflows."]; });
});
