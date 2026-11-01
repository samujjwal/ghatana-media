import { describe, expect, it } from "vitest";
import {
  MediaArtifactSchema,
  MediaCanonicalErrorSchema,
  MultimodalAnalysisRequestSchema,
  ProviderCapabilitySchema,
  TranscriptionResultSchema,
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
  it("roundtrips every canonical logical job state through the JSON observation and job projections", () => {
    const jobBase = {
      id: "job-1",
      tenantId: "tenant-1",
      kind: "TRANSCRIBE" as const,
      createdAt: timestamp,
      updatedAt: timestamp,
      correlationId: "correlation-1",
      inputArtifactIds: ["artifact-1"],
      cancellable: true,
      retryable: false,
    };
    const jobs = [
      { ...jobBase, state: "QUEUED", progress: 0 },
      { ...jobBase, state: "RUNNING", progress: 25, startedAt: timestamp },
      { ...jobBase, state: "RETRY_PENDING", progress: 25, retryReason: "transient failure" },
      { ...jobBase, state: "OUTCOME_UNKNOWN", progress: 25, outcomeUnknownSince: timestamp },
      { ...jobBase, state: "RECONCILING", progress: 25, reconciliationStartedAt: timestamp },
      { ...jobBase, state: "COMPLETED", progress: 100, completedAt: timestamp },
      {
        ...jobBase,
        state: "PARTIALLY_SUCCEEDED",
        progress: 75,
        completedAt: timestamp,
        error: { code: "PARTIAL", message: "one output unresolved", retryable: false },
      },
      {
        ...jobBase,
        state: "FAILED",
        progress: 0,
        completedAt: timestamp,
        error: { code: "FAILED", message: "processing failed", retryable: false },
      },
      { ...jobBase, state: "CANCELLED", progress: 0, completedAt: timestamp },
    ] as const;

    expect(jobs.map((job) => job.state)).toEqual(MediaJobStateSchema.options);
    for (const job of jobs) {
      const observation = observeMediaJobState(job.state);
      expect(MediaJobStateObservationSchema.parse(JSON.parse(JSON.stringify(observation)))).toEqual(observation);
      expect(MediaProcessingJobSchema.parse(JSON.parse(JSON.stringify(job)))).toMatchObject(job);
    }
  });

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

  it("rejects fractional, negative, and unsafe byte counts without rounding", () => {
    const artifact = {
      id: "artifact-1",
      tenantId: "tenant-1",
      kind: "AUDIO",
      status: "AVAILABLE",
      fileName: "source.wav",
      mimeType: "audio/wav",
      sizeBytes: 0,
      checksumSha256: "a".repeat(64),
      classification: "CONFIDENTIAL",
      createdAt: timestamp,
      updatedAt: timestamp,
      ownerId: "user-1",
      provenance: { sourceArtifactIds: [] },
      metadata: {},
    };
    for (const sizeBytes of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      expect(() => MediaArtifactSchema.parse({ ...artifact, sizeBytes })).toThrow();
    }
    expect(MediaArtifactSchema.parse({ ...artifact, sizeBytes: Number.MAX_SAFE_INTEGER }).sizeBytes)
      .toBe(Number.MAX_SAFE_INTEGER);
  });

  it("keeps upload byte counters exact and enforces the declared part-size ceiling", () => {
    const session = {
      id: "upload-1",
      artifactId: "artifact-1",
      state: "UPLOADING",
      partSizeBytes: 1024,
      uploadedBytes: 0,
      totalBytes: 0,
      expiresAt: timestamp,
      checksumRequired: true,
      retryable: true,
    };
    expect(UploadSessionSchema.parse({
      ...session,
      partSizeBytes: 5_368_709_120,
      uploadedBytes: Number.MAX_SAFE_INTEGER,
      totalBytes: Number.MAX_SAFE_INTEGER,
    }).uploadedBytes).toBe(Number.MAX_SAFE_INTEGER);
    for (const uploadedBytes of [-1, 0.25, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => UploadSessionSchema.parse({
        ...session, uploadedBytes, totalBytes: Number.MAX_SAFE_INTEGER,
      })).toThrow();
    }
    expect(() => UploadSessionSchema.parse({
      ...session, partSizeBytes: 5_368_709_121,
    })).toThrow();
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

  it("TY-02: rejects unbounded request and result payloads", () => {
    const huge = "x".repeat(2_000_001);
    // TranscriptionResult text is capped; a 2 MiB+1 payload fails closed.
    const baseResult = {
      artifactId: "a1", transcriptArtifactId: "t1",
      languageTag: "en", confidence: 0.9, providerId: "p",
      modelId: "m", modelVersion: "v1", processingTimeMs: 1,
    };
    expect(() => TranscriptionResultSchema.parse({ ...baseResult, text: huge })).toThrow();
    expect(TranscriptionResultSchema.parse({ ...baseResult, text: "ok" }).text).toBe("ok");
    // Word and alternative collections are item- and count-bounded.
    expect(() => TranscriptionResultSchema.parse({
      ...baseResult, text: "ok",
      words: [{ text: "w".repeat(257), startMs: 0, endMs: 1, confidence: 0.5 }],
    })).toThrow();
    expect(() => TranscriptionResultSchema.parse({
      ...baseResult, text: "ok",
      alternatives: Array.from({ length: 11 }, () => ({ text: "x", confidence: 0.5 })),
    })).toThrow();
    // Request collection bounds.
    expect(() => VoiceTrainingRequestSchema.parse({
      name: "n", sampleArtifactIds: Array.from({ length: 65 }, (_, i) => `s${i}`),
      consentReference: "c", rightsAttestation: true,
      languageTags: ["en"], idempotencyKey: "k",
    })).toThrow();
    expect(() => MultimodalAnalysisRequestSchema.parse({
      sources: Array.from({ length: 33 }, () => ({ kind: "TEXT", text: "x" })),
      intent: "i", outputFormat: "TEXT", idempotencyKey: "k",
    })).toThrow();
    // Canonical error detail bounds.
    expect(() => MediaCanonicalErrorSchema.parse({
      code: "E", message: "m".repeat(2_001), correlationId: "c",
      retryable: false, category: "VALIDATION",
    })).toThrow();
    // Capability list bounds.
    expect(() => ProviderCapabilitySchema.parse({
      id: "c", providerId: "p", operation: "TRANSCRIBE",
      state: "AVAILABLE", supportedMimeTypes: Array.from({ length: 513 }, (_, i) => `a/${i}`),
      supportedLanguages: [], streamingSupported: false, cancellationSupported: true,
      lastCheckedAt: "2026-10-29T00:00:00Z",
    })).toThrow();
  });

  it("rejects rounded or non-finite duration and time values", () => {
    const result = {
      artifactId: "a1", transcriptArtifactId: "t1", text: "ok",
      languageTag: "en", confidence: 0.9,
      words: [{ text: "word", startMs: 0, endMs: 1, confidence: 0.9 }],
      providerId: "p", modelId: "m", modelVersion: "v1", processingTimeMs: 0,
    };
    for (const startMs of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      expect(() => TranscriptionResultSchema.parse({
        ...result, words: [{ ...result.words[0], startMs, endMs: startMs }],
      })).toThrow();
    }
    for (const processingTimeMs of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      expect(() => TranscriptionResultSchema.parse({ ...result, processingTimeMs })).toThrow();
    }
  });

  it("rejects unknown enum values and unknown fields instead of coalescing them", () => {
    expect(() => MultimodalAnalysisRequestSchema.parse({
      sources: [{ kind: "TEXT", text: "hello" }],
      intent: "summarize", outputFormat: "UNKNOWN", idempotencyKey: "key-1",
    })).toThrow();
    expect(() => MultimodalAnalysisRequestSchema.parse({
      sources: [{ kind: "TEXT", text: "hello" }],
      intent: "summarize", outputFormat: "TEXT", idempotencyKey: "key-1",
      providerMode: "fallback",
    })).toThrow();
    expect(() => MediaArtifactSchema.parse({
      id: "a", tenantId: "t", kind: "UNKNOWN", status: "AVAILABLE",
      fileName: "a.wav", mimeType: "audio/wav", sizeBytes: 0,
      checksumSha256: "a".repeat(64), classification: "CONFIDENTIAL",
      createdAt: timestamp, updatedAt: timestamp, ownerId: "u",
      provenance: { sourceArtifactIds: [] }, metadata: {},
    })).toThrow();
  });
});
