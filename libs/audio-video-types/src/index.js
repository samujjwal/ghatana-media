/**
 * @doc.type types
 * @doc.purpose Shared TypeScript interfaces for audio-video application
 * @doc.layer shared
 * @doc.pattern domain-driven design
 */
import { z } from 'zod';

const ConfidenceSchema = z.number().min(0).max(1);
const NonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const BoundingBoxSchema = z.object({
    // Coordinate origin and units are source-unresolved; preserve negative x/y
    // and fractional values, but reject non-finite coordinates and negative extents.
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().refine((value) => value >= 0, 'width cannot be negative'),
    height: z.number().finite().refine((value) => value >= 0, 'height cannot be negative'),
}).strict();

const AlternativeTranscriptionSchema = z.object({
    text: z.string(),
    confidence: ConfidenceSchema,
}).strict();

const WordTimestampSchema = z.object({
    word: z.string(),
    // Unit and origin remain unresolved; preserve fractional and negative times,
    // but reject non-finite values and reversed intervals.
    start: z.number().finite(),
    end: z.number().finite(),
    confidence: ConfidenceSchema,
}).strict().superRefine((word, context) => {
    if (word.end < word.start) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['end'],
            message: 'word end cannot precede word start',
        });
    }
});

export const STTResultSchema = z.object({
    text: z.string(),
    confidence: ConfidenceSchema,
    alternatives: z.array(AlternativeTranscriptionSchema).optional(),
    words: z.array(WordTimestampSchema).optional(),
    processingTimeMs: NonNegativeSafeIntegerSchema,
    language: z.string(),
    model: z.string(),
}).strict();

const DetectedObjectSchema = z.object({
    class: z.string(),
    confidence: ConfidenceSchema,
    bbox: BoundingBoxSchema,
    attributes: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const DetectionResultSchema = z.object({
    objects: z.array(DetectedObjectSchema),
    confidence: ConfidenceSchema,
    processingTimeMs: NonNegativeSafeIntegerSchema,
    imageSize: z.object({
        width: z.number().finite().refine((value) => value > 0, 'image width must be positive'),
        height: z.number().finite().refine((value) => value > 0, 'image height must be positive'),
    }).strict(),
}).strict();

const MultimodalInsightSchema = z.object({
    type: z.string(),
    description: z.string(),
    confidence: ConfidenceSchema,
    data: z.unknown(),
}).strict();

export const MultimodalResultSchema = z.object({
    result: z.unknown(),
    confidence: ConfidenceSchema,
    processingTimeMs: NonNegativeSafeIntegerSchema,
    modalities: z.array(z.string()),
    insights: z.array(MultimodalInsightSchema).optional(),
}).strict();

export function parseSTTResult(input) {
    return STTResultSchema.parse(input);
}

export function parseDetectionResult(input) {
    return DetectionResultSchema.parse(input);
}

export function parseMultimodalResult(input) {
    return MultimodalResultSchema.parse(input);
}

export const DEFAULT_AUDIO_FORMAT = {
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
    format: 'pcm',
};
export function createAudioData(data, overrides = {}) {
    return {
        data,
        sampleRate: overrides.sampleRate ?? DEFAULT_AUDIO_FORMAT.sampleRate,
        channels: overrides.channels ?? DEFAULT_AUDIO_FORMAT.channels,
        bitsPerSample: overrides.bitsPerSample ?? DEFAULT_AUDIO_FORMAT.bitsPerSample,
        durationMs: overrides.durationMs ?? 0,
        format: overrides.format ?? DEFAULT_AUDIO_FORMAT.format,
    };
}
export function isSupportedAudioFormat(format) {
    return ['pcm', 'wav', 'mp3', 'flac', 'ogg', 'aac'].includes(format);
}
