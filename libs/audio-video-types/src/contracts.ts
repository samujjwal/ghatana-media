import { z } from "zod";

const IdentifierSchema = z.string().min(1).max(256);
const IsoTimestampSchema = z.string().datetime({ offset: true });
const ConfidenceSchema = z.number().min(0).max(1);
const PercentageSchema = z.number().min(0).max(100);
const NonNegativeIntegerSchema = z.number().int().nonnegative();

export const MediaClassificationSchema = z.enum([
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL",
  "RESTRICTED",
  "BIOMETRIC",
]);
export type MediaClassification = z.infer<typeof MediaClassificationSchema>;

export const MediaArtifactKindSchema = z.enum([
  "AUDIO",
  "VIDEO",
  "IMAGE",
  "TRANSCRIPT",
  "VOICE_MODEL",
  "DERIVED",
]);
export type MediaArtifactKind = z.infer<typeof MediaArtifactKindSchema>;

export const MediaArtifactStatusSchema = z.enum([
  "UPLOADING",
  "AVAILABLE",
  "PROCESSING",
  "QUARANTINED",
  "FAILED",
  "DELETING",
  "DELETED",
]);
export type MediaArtifactStatus = z.infer<typeof MediaArtifactStatusSchema>;

export const MediaArtifactSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    kind: MediaArtifactKindSchema,
    status: MediaArtifactStatusSchema,
    fileName: z.string().min(1).max(512),
    mimeType: z.string().min(1).max(256),
    sizeBytes: NonNegativeIntegerSchema,
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    classification: MediaClassificationSchema,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    retentionUntil: IsoTimestampSchema.optional(),
    ownerId: IdentifierSchema,
    correlationId: IdentifierSchema.optional(),
    provenance: z
      .object({
        sourceArtifactIds: z.array(IdentifierSchema).default([]),
        operationId: IdentifierSchema.optional(),
        providerId: IdentifierSchema.optional(),
        modelId: IdentifierSchema.optional(),
        modelVersion: z.string().optional(),
      })
      .strict(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type MediaArtifact = z.infer<typeof MediaArtifactSchema>;

export const UploadSessionSchema = z
  .object({
    id: IdentifierSchema,
    artifactId: IdentifierSchema,
    state: z.enum([
      "CREATED",
      "UPLOADING",
      "VERIFYING",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "EXPIRED",
    ]),
    uploadUrl: z.string().url().optional(),
    partSizeBytes: z.number().int().positive(),
    uploadedBytes: NonNegativeIntegerSchema,
    totalBytes: NonNegativeIntegerSchema,
    expiresAt: IsoTimestampSchema,
    checksumRequired: z.boolean(),
    retryable: z.boolean(),
  })
  .strict()
  .superRefine((session, context) => {
    if (session.uploadedBytes > session.totalBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["uploadedBytes"],
        message: "uploadedBytes cannot exceed totalBytes",
      });
    }
  });
export type UploadSession = z.infer<typeof UploadSessionSchema>;

export const MediaOperationKindSchema = z.enum([
  "TRANSCRIBE",
  "SYNTHESIZE",
  "VISION_ANALYZE",
  "MULTIMODAL_ANALYZE",
  "SEPARATE_STEMS",
  "TRAIN_VOICE_MODEL",
  "CONVERT_VOICE",
  "EXPORT",
  "DELETE",
]);
export type MediaOperationKind = z.infer<typeof MediaOperationKindSchema>;

/**
 * Canonical job lifecycle states owned by PDP-1. Cancellation requests and
 * retry attempts are represented by explicit operation/attempt fields rather
 * than by new product states; unknown outcomes are never silently retried.
 */
export const MediaJobStateSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "RETRY_PENDING",
  "OUTCOME_UNKNOWN",
  "RECONCILING",
  "COMPLETED",
  "PARTIALLY_SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);
export type MediaJobState = z.infer<typeof MediaJobStateSchema>;

/** Legacy wire spellings retained only at an explicit compatibility boundary. */
export const LegacyMediaJobStateSchema = z.enum(["CANCELLING", "RETRYING"]);
export type LegacyMediaJobState = z.infer<typeof LegacyMediaJobStateSchema>;

export const MediaJobStateObservationSchema = z.object({
  machineId: z.literal("media-job"),
  state: z.union([MediaJobStateSchema, LegacyMediaJobStateSchema]),
  rawState: z.union([MediaJobStateSchema, LegacyMediaJobStateSchema]),
  canonicalState: MediaJobStateSchema.nullable(),
  mappingDisposition: z.enum(["CANONICAL_STATE", "LEGACY_STATE_UNMAPPED"]),
}).superRefine((observation, context) => {
  if (observation.rawState !== observation.state) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["rawState"], message: "rawState must preserve the observed state" });
  }
  const canonical = MediaJobStateSchema.safeParse(observation.state).success;
  if ((observation.mappingDisposition === "CANONICAL_STATE") !== canonical
    || (canonical ? observation.canonicalState !== observation.state : observation.canonicalState !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["mappingDisposition"], message: "state mapping disposition must match the raw observation" });
  }
});
export type MediaJobStateObservation = z.infer<typeof MediaJobStateObservationSchema>;

/**
 * Retains legacy state spellings as machine-scoped observations. Legacy
 * CANCELLING and RETRYING are not coerced to RUNNING or RETRY_PENDING because
 * neither spelling proves the corresponding canonical state.
 */
export function observeMediaJobState(state: MediaJobState | LegacyMediaJobState) {
  const canonical = MediaJobStateSchema.safeParse(state);
  const legacy = LegacyMediaJobStateSchema.safeParse(state);
  if (!canonical.success && !legacy.success) {
    throw new TypeError("Unsupported media job state observation");
  }
  const isCanonical = canonical.success;
  return MediaJobStateObservationSchema.parse({
    machineId: "media-job",
    state,
    rawState: state,
    canonicalState: isCanonical ? state as MediaJobState : null,
    mappingDisposition: isCanonical ? "CANONICAL_STATE" : "LEGACY_STATE_UNMAPPED",
  });
}

/**
 * Compatibility wrapper retaining the historical scalar return shape. Legacy
 * values remain explicit members of the result union instead of being mapped
 * to an unsupported canonical state.
 */
export function normalizeLegacyMediaJobState(state: MediaJobState | LegacyMediaJobState): MediaJobState | LegacyMediaJobState {
  return observeMediaJobState(state).state;
}

const JobBaseSchema = z.object({
  id: IdentifierSchema,
  tenantId: IdentifierSchema,
  kind: MediaOperationKindSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  correlationId: IdentifierSchema,
  inputArtifactIds: z.array(IdentifierSchema),
  outputArtifactIds: z.array(IdentifierSchema).default([]),
  cancellable: z.boolean(),
  retryable: z.boolean(),
  providerId: IdentifierSchema.optional(),
  modelId: IdentifierSchema.optional(),
  modelVersion: z.string().optional(),
});

const QueuedJobSchema = JobBaseSchema.extend({
  state: z.literal("QUEUED"),
  progress: z.literal(0),
  message: z.string().optional(),
}).strict();

const RunningJobSchema = JobBaseSchema.extend({
  state: z.literal("RUNNING"),
  progress: PercentageSchema,
  message: z.string().optional(),
  startedAt: IsoTimestampSchema,
  estimatedCompletionAt: IsoTimestampSchema.optional(),
}).strict();

const RetryPendingJobSchema = JobBaseSchema.extend({
  state: z.literal("RETRY_PENDING"),
  progress: PercentageSchema,
  message: z.string().optional(),
  retryAfter: IsoTimestampSchema.optional(),
  retryReason: z.string().min(1),
}).strict();

const OutcomeUnknownJobSchema = JobBaseSchema.extend({
  state: z.literal("OUTCOME_UNKNOWN"),
  progress: PercentageSchema,
  message: z.string().optional(),
  outcomeUnknownSince: IsoTimestampSchema,
}).strict();

const ReconcilingJobSchema = JobBaseSchema.extend({
  state: z.literal("RECONCILING"),
  progress: PercentageSchema,
  message: z.string().optional(),
  reconciliationStartedAt: IsoTimestampSchema,
}).strict();

const CompletedJobSchema = JobBaseSchema.extend({
  state: z.literal("COMPLETED"),
  progress: z.literal(100),
  completedAt: IsoTimestampSchema,
  resultSummary: z.string().optional(),
}).strict();

const FailedJobSchema = JobBaseSchema.extend({
  state: z.enum(["FAILED", "PARTIALLY_SUCCEEDED"]),
  progress: PercentageSchema,
  completedAt: IsoTimestampSchema,
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
    remediation: z.string().optional(),
  }),
}).strict();

const CancelledJobSchema = JobBaseSchema.extend({
  state: z.literal("CANCELLED"),
  progress: PercentageSchema,
  completedAt: IsoTimestampSchema,
}).strict();

export const MediaProcessingJobSchema = z.discriminatedUnion("state", [
  QueuedJobSchema,
  RunningJobSchema,
  RetryPendingJobSchema,
  OutcomeUnknownJobSchema,
  ReconcilingJobSchema,
  CompletedJobSchema,
  FailedJobSchema,
  CancelledJobSchema,
]);
export type MediaProcessingJob = z.infer<typeof MediaProcessingJobSchema>;

export const ProviderCapabilitySchema = z
  .object({
    id: IdentifierSchema,
    providerId: IdentifierSchema,
    operation: MediaOperationKindSchema,
    state: z.enum([
      "ACTIVE",
      "DEGRADED",
      "DISABLED",
      "MISCONFIGURED",
      "UNAVAILABLE",
      "RECOVERING",
    ]),
    supportedMimeTypes: z.array(z.string()),
    supportedLanguages: z.array(z.string()),
    maxInputBytes: NonNegativeIntegerSchema.optional(),
    maxDurationMs: NonNegativeIntegerSchema.optional(),
    streamingSupported: z.boolean(),
    cancellationSupported: z.boolean(),
    limitations: z.array(z.string()).default([]),
    lastCheckedAt: IsoTimestampSchema,
  })
  .strict();
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;

export const MediaCanonicalErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    correlationId: IdentifierSchema,
    retryable: z.boolean(),
    category: z.enum([
      "VALIDATION",
      "AUTHENTICATION",
      "AUTHORIZATION",
      "POLICY",
      "CAPABILITY",
      "RATE_LIMIT",
      "TIMEOUT",
      "CONFLICT",
      "PROCESSING",
      "INTERNAL",
    ]),
    fieldErrors: z
      .array(
        z.object({
          field: z.string(),
          code: z.string(),
          message: z.string(),
        }),
      )
      .optional(),
    runtimeDependency: z.string().optional(),
    retryAfterMs: NonNegativeIntegerSchema.optional(),
    remediation: z.string().optional(),
  })
  .strict();
export type MediaCanonicalError = z.infer<typeof MediaCanonicalErrorSchema>;

export const TranscriptionRequestSchema = z
  .object({
    artifactId: IdentifierSchema,
    languageTag: z.string().min(2).max(64).optional(),
    modelId: IdentifierSchema.optional(),
    punctuation: z.boolean().default(true),
    wordTimestamps: z.boolean().default(true),
    alternatives: z.number().int().min(1).max(10).default(1),
    profanityPolicy: z.enum(["PRESERVE", "MASK", "REMOVE"]).default("PRESERVE"),
    idempotencyKey: IdentifierSchema,
  })
  .strict();
export type TranscriptionRequest = z.infer<typeof TranscriptionRequestSchema>;

export const TranscriptionResultSchema = z
  .object({
    artifactId: IdentifierSchema,
    transcriptArtifactId: IdentifierSchema,
    text: z.string(),
    languageTag: z.string(),
    confidence: ConfidenceSchema,
    words: z
      .array(
        z.object({
          text: z.string(),
          startMs: NonNegativeIntegerSchema,
          endMs: NonNegativeIntegerSchema,
          confidence: ConfidenceSchema,
          speakerId: IdentifierSchema.optional(),
        }),
      )
      .default([]),
    alternatives: z
      .array(
        z.object({ text: z.string(), confidence: ConfidenceSchema }),
      )
      .default([]),
    providerId: IdentifierSchema,
    modelId: IdentifierSchema,
    modelVersion: z.string(),
    processingTimeMs: NonNegativeIntegerSchema,
  })
  .strict();
export type TranscriptionResult = z.infer<typeof TranscriptionResultSchema>;

export const SynthesisRequestSchema = z
  .object({
    text: z.string().min(1).max(100_000),
    voiceId: IdentifierSchema,
    languageTag: z.string().min(2).max(64),
    outputMimeType: z.string().min(1),
    rate: z.number().min(0.25).max(4).default(1),
    pitch: z.number().min(0).max(2).default(1),
    volume: z.number().min(0).max(1).default(1),
    consentReference: IdentifierSchema.optional(),
    idempotencyKey: IdentifierSchema,
  })
  .strict();
export type SynthesisRequest = z.infer<typeof SynthesisRequestSchema>;

export const SynthesisResultSchema = z
  .object({
    artifactId: IdentifierSchema,
    voiceId: IdentifierSchema,
    providerId: IdentifierSchema,
    modelId: IdentifierSchema.optional(),
    modelVersion: z.string().optional(),
    durationMs: NonNegativeIntegerSchema,
    characterCount: NonNegativeIntegerSchema,
    processingTimeMs: NonNegativeIntegerSchema,
  })
  .strict();
export type SynthesisResult = z.infer<typeof SynthesisResultSchema>;

export const VoiceTrainingRequestSchema = z
  .object({
    name: z.string().min(1).max(256),
    sampleArtifactIds: z.array(IdentifierSchema).min(1),
    consentReference: IdentifierSchema,
    rightsAttestation: z.literal(true),
    languageTags: z.array(z.string()).min(1),
    qualityThreshold: ConfidenceSchema.default(0.8),
    idempotencyKey: IdentifierSchema,
  })
  .strict();
export type VoiceTrainingRequest = z.infer<typeof VoiceTrainingRequestSchema>;

export const VoiceConversionRequestSchema = z
  .object({
    sourceArtifactId: IdentifierSchema,
    voiceModelArtifactId: IdentifierSchema,
    pitchShiftSemitones: z.number().min(-24).max(24).default(0),
    preserveTiming: z.boolean().default(true),
    consentReference: IdentifierSchema,
    idempotencyKey: IdentifierSchema,
  })
  .strict();
export type VoiceConversionRequest = z.infer<typeof VoiceConversionRequestSchema>;

export const MultimodalSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ARTIFACT"), artifactId: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("TEXT"), text: z.string().min(1).max(100_000) }).strict(),
]);

export const MultimodalAnalysisRequestSchema = z
  .object({
    sources: z.array(MultimodalSourceSchema).min(1),
    intent: z.string().min(1).max(1_000),
    outputFormat: z.enum(["TEXT", "STRUCTURED", "ANNOTATIONS"]),
    languageTag: z.string().optional(),
    idempotencyKey: IdentifierSchema,
  })
  .strict();
export type MultimodalAnalysisRequest = z.infer<
  typeof MultimodalAnalysisRequestSchema
>;

export const OperationAcceptedSchema = z
  .object({
    operationId: IdentifierSchema,
    job: MediaProcessingJobSchema,
    statusUrl: z.string().min(1),
    cancelUrl: z.string().min(1).optional(),
    correlationId: IdentifierSchema,
  })
  .strict();
export type OperationAccepted = z.infer<typeof OperationAcceptedSchema>;

export function parseMediaArtifact(input: unknown): MediaArtifact {
  return MediaArtifactSchema.parse(input);
}

export function parseMediaProcessingJob(input: unknown): MediaProcessingJob {
  return MediaProcessingJobSchema.parse(input);
}

export function parseProviderCapability(input: unknown): ProviderCapability {
  return ProviderCapabilitySchema.parse(input);
}

export function parseMediaCanonicalError(input: unknown): MediaCanonicalError {
  return MediaCanonicalErrorSchema.parse(input);
}
