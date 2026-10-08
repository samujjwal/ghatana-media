import { describe, expect, it } from "vitest";
import {
  MediaArtifactSchema,
  normalizeLegacyMediaJobState,
  observeMediaJobState,
  MediaJobStateSchema,
  MediaJobStateObservationSchema,
  MediaProcessingJobSchema,
  UploadSessionSchema,
  VoiceTrainingRequestSchema,
} from "./contracts";

const timestamp = "2026-08-05T12:00:00.000Z";

describe("media contracts", () => {
  it.each(["CANCELLING", "RETRYING"] as const)("retains legacy job state %s without unsafe canonical coercion", (state) => {
    const observation = observeMediaJobState(state);
    expect(observation).toEqual({
      machineId: "media-job",
      state,
      rawState: state,
      canonicalState: null,
      mappingDisposition: "LEGACY_STATE_UNMAPPED",
    });
    expect(normalizeLegacyMediaJobState(state)).toBe(state);
    expect(MediaJobStateSchema.safeParse(observation.canonicalState ?? observation.state).success).toBe(false);
  });

  it("preserves canonical job states with explicit machine context", () => {
    const observation = observeMediaJobState("OUTCOME_UNKNOWN");
    expect(observation).toMatchObject({
      machineId: "media-job",
      state: "OUTCOME_UNKNOWN",
      rawState: "OUTCOME_UNKNOWN",
      canonicalState: "OUTCOME_UNKNOWN",
      mappingDisposition: "CANONICAL_STATE",
    });
  });

  it("rejects unsupported raw inputs and inconsistent state observations", () => {
    expect(() => observeMediaJobState("MYSTERY_STATE" as never)).toThrow(TypeError);
    expect(() => observeMediaJobState(null as never)).toThrow(TypeError);
    expect(MediaJobStateObservationSchema.safeParse({
      machineId: "media-job", state: "OUTCOME_UNKNOWN", rawState: "COMPLETED",
      canonicalState: "OUTCOME_UNKNOWN", mappingDisposition: "CANONICAL_STATE",
    }).success).toBe(false);
    expect(MediaJobStateObservationSchema.safeParse({
      machineId: "media-job", state: "RETRYING", rawState: "RETRYING",
      canonicalState: "RETRY_PENDING", mappingDisposition: "CANONICAL_STATE",
    }).success).toBe(false);
  });

  it("requires transport-safe artifact identity and provenance", () => {
    const artifact = MediaArtifactSchema.parse({
      id: "artifact-1",
      tenantId: "tenant-1",
      kind: "AUDIO",
      status: "AVAILABLE",
      fileName: "source.wav",
      mimeType: "audio/wav",
      sizeBytes: 1024,
      checksumSha256: "a".repeat(64),
      classification: "CONFIDENTIAL",
      createdAt: timestamp,
      updatedAt: timestamp,
      ownerId: "user-1",
      provenance: {
        sourceArtifactIds: [],
        providerId: "upload",
      },
      metadata: {},
    });

    expect(artifact.checksumSha256).toHaveLength(64);
    expect(artifact.provenance.providerId).toBe("upload");
    expect(() =>
      MediaArtifactSchema.parse({ ...artifact, createdAt: new Date() }),
    ).toThrow();
  });

  it("rejects impossible upload progress", () => {
    expect(() =>
      UploadSessionSchema.parse({
        id: "upload-1",
        artifactId: "artifact-1",
        state: "UPLOADING",
        partSizeBytes: 1024,
        uploadedBytes: 2048,
        totalBytes: 1024,
        expiresAt: timestamp,
        checksumRequired: true,
        retryable: true,
      }),
    ).toThrow(/uploadedBytes/u);
  });

  it("requires rights attestation and consent identity for voice training", () => {
    expect(() =>
      VoiceTrainingRequestSchema.parse({
        name: "Voice model",
        sampleArtifactIds: ["sample-1"],
        consentReference: "consent-1",
        rightsAttestation: false,
        languageTags: ["en-US"],
        qualityThreshold: 0.8,
        idempotencyKey: "idem-1",
      }),
    ).toThrow();

    expect(
      VoiceTrainingRequestSchema.parse({
        name: "Voice model",
        sampleArtifactIds: ["sample-1"],
        consentReference: "consent-1",
        rightsAttestation: true,
        languageTags: ["en-US"],
        qualityThreshold: 0.8,
        idempotencyKey: "idem-1",
      }).rightsAttestation,
    ).toBe(true);
  });

  it("enforces state-specific terminal job fields", () => {
    const base = {
      id: "job-1",
      tenantId: "tenant-1",
      kind: "TRAIN_VOICE_MODEL",
      createdAt: timestamp,
      updatedAt: timestamp,
      correlationId: "correlation-1",
      inputArtifactIds: ["sample-1"],
      outputArtifactIds: [],
      cancellable: false,
      retryable: false,
    };
    expect(() =>
      MediaProcessingJobSchema.parse({
        ...base,
        state: "COMPLETED",
        progress: 90,
        completedAt: timestamp,
      }),
    ).toThrow();
    expect(
      MediaProcessingJobSchema.parse({
        ...base,
        state: "COMPLETED",
        progress: 100,
        completedAt: timestamp,
      }).state,
    ).toBe("COMPLETED");
  });
});
