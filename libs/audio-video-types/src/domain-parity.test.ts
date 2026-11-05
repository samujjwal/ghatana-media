import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  MediaArtifactSchema,
  MediaJobStateSchema,
  MediaAttemptStateSchema,
  LegacyMediaJobStateSchema,
  SourcePresentationTimeSchema,
  UploadSessionSchema,
} from "./contracts.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(resolve(here, "../../../contracts/domain-parity/v1/golden-vectors.v1.json"), "utf8"),
);

const IdentifierBound = MediaArtifactSchema.shape.id;
const ByteCountBound = MediaArtifactSchema.shape.sizeBytes;
const ChecksumBound = MediaArtifactSchema.shape.checksumSha256;
const uploadSessionObject = typeof UploadSessionSchema.innerType === "function"
  ? UploadSessionSchema.innerType()
  : UploadSessionSchema;
const UploadStateBound = uploadSessionObject.shape.state;

describe("domain parity golden vectors (TypeScript side)", () => {
  it("canonical job states match the Java LogicalJobStatus vocabulary exactly", () => {
    const { accept, reject } = vectors.sharedEnums.canonicalJobStates;
    for (const state of accept) expect(MediaJobStateSchema.safeParse(state).success, state).toBe(true);
    for (const state of reject) expect(MediaJobStateSchema.safeParse(state).success, state).toBe(false);
  });

  it("canonical attempt states match the Java LogicalAttemptStatus vocabulary exactly", () => {
    const { accept, reject } = vectors.sharedEnums.canonicalAttemptStates;
    for (const state of accept) expect(MediaAttemptStateSchema.safeParse(state).success, state).toBe(true);
    for (const state of reject) expect(MediaAttemptStateSchema.safeParse(state).success, state).toBe(false);
  });

  it("legacy wire spellings stay confined to the explicit compatibility boundary", () => {
    for (const state of vectors.sharedEnums.legacyWireJobStates.values) {
      expect(LegacyMediaJobStateSchema.safeParse(state).success).toBe(true);
      expect(MediaJobStateSchema.safeParse(state).success).toBe(false);
    }
  });

  it("identifier vectors enforce the documented per-side verdict", () => {
    for (const vector of vectors.scalarVectors.identifiers) {
      const value = vector.value ?? vector.repeatChar.repeat(vector.repeatCount);
      expect(IdentifierBound.safeParse(value).success, JSON.stringify(vector)).toBe(vector.typescript === "accept");
    }
  });

  it("checksumSha256 vectors enforce the documented per-side verdict", () => {
    for (const vector of vectors.scalarVectors.checksumSha256Hex) {
      expect(ChecksumBound.safeParse(vector.value).success, JSON.stringify(vector)).toBe(vector.typescript === "accept");
    }
  });

  it("rational temporal vectors enforce the documented per-side verdict", () => {
    for (const vector of vectors.scalarVectors.rationalTemporal) {
      const parsed = SourcePresentationTimeSchema.safeParse({
        numerator: vector.numerator,
        denominator: vector.denominator,
        clockRef: "golden-vector-clock",
      });
      expect(parsed.success, JSON.stringify(vector)).toBe(vector.typescript === "accept");
    }
  });

  it("byte-count vectors enforce exact safe-integer semantics", () => {
    for (const vector of vectors.scalarVectors.byteCounts) {
      expect(ByteCountBound.safeParse(vector.value).success, JSON.stringify(vector)).toBe(vector.typescript === "accept");
    }
  });

  it("upload-session state vocabulary stays exactly the documented divergent set", () => {
    const expected = vectors.vocabularyComparisons.uploadSessionStates.typescript;
    expect([...UploadStateBound.options].sort()).toEqual([...expected].sort());
    for (const state of expected) expect(UploadStateBound.safeParse(state).success).toBe(true);
    for (const state of vectors.vocabularyComparisons.uploadSessionStates.java) {
      if (!expected.includes(state)) expect(UploadStateBound.safeParse(state).success, state).toBe(false);
    }
  });

  it("every declared divergence still describes the current contract truthfully", () => {
    for (const divergence of vectors.knownDivergences) {
      expect(divergence.id).toMatch(/^DP-/u);
      expect(divergence.typescript).toBeTruthy();
      expect(divergence.java).toBeTruthy();
      expect(divergence.reconciliation).toBeTruthy();
    }
    expect(IdentifierBound.safeParse("x".repeat(257)).success).toBe(false);
    expect(SourcePresentationTimeSchema.safeParse({ numerator: 0, denominator: 1, clockRef: "c" }).success).toBe(true);
  });
});
