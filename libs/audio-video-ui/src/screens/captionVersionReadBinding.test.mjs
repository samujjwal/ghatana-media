import assert from "node:assert/strict";
import test from "node:test";
import { bindCaptionVersionRows } from "./captionVersionReadBinding.ts";

const scope = Object.freeze({
  tenantId: "tenant-1",
  principalId: "principal-1",
  sourceArtifactId: "artifact-1",
  sourceArtifactVersionId: "artifact-version-2",
});

function row(overrides = {}) {
  return {
    requestId: "caption-request-1",
    requestFingerprint: "a".repeat(64),
    captionVersionId: "caption-version-1",
    registrationReceiptId: "caption-receipt-1",
    sourceArtifactId: scope.sourceArtifactId,
    sourceArtifactVersionId: scope.sourceArtifactVersionId,
    parentVersionKind: "TRANSCRIPT_VERSION",
    parentVersionId: "transcript-version-1",
    languageDisposition: "DECLARED_BY_USER",
    sourceClockId: "source-clock-1",
    registeredAt: 1_800_000_000_000,
    ...overrides,
  };
}

test("binds exact canonical rows and snapshots the returned collection", () => {
  const source = [row()];
  const bound = bindCaptionVersionRows(source, scope);

  assert.equal(bound?.length, 1);
  assert.equal(bound?.[0]?.captionVersionId, "caption-version-1");
  assert.ok(Object.isFrozen(bound));
  assert.ok(Object.isFrozen(bound?.[0]));
  source[0].captionVersionId = "caption-version-substituted";
  assert.equal(bound?.[0]?.captionVersionId, "caption-version-1");
});

test("rejects the whole list if any row belongs to a different source version", () => {
  assert.equal(bindCaptionVersionRows([
    row(),
    row({ captionVersionId: "caption-version-2", sourceArtifactVersionId: "artifact-version-other" }),
  ], scope), undefined);
});

test("rejects duplicate version identities and malformed receipt fields", () => {
  assert.equal(bindCaptionVersionRows([row(), row()], scope), undefined);
  assert.equal(bindCaptionVersionRows([row({ requestFingerprint: "A".repeat(64) })], scope), undefined);
  assert.equal(bindCaptionVersionRows([row({ registeredAt: Number.MAX_SAFE_INTEGER + 1 })], scope), undefined);
});

test("rejects padded or invalid caller scope without normalizing it", () => {
  assert.equal(bindCaptionVersionRows([row()], { ...scope, tenantId: " tenant-1" }), undefined);
  assert.equal(bindCaptionVersionRows([row()], { ...scope, sourceArtifactVersionId: "artifact-version-3" }), undefined);
});
