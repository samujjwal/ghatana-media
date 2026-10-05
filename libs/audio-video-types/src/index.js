/**
 * @doc.type types
 * @doc.purpose Shared TypeScript interfaces for audio-video application
 * @doc.layer shared
 * @doc.pattern domain-driven design
 */
import { z } from 'zod';

const ConfidenceSchema = z.number().min(0).max(1);

const BoundingBoxSchema = z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
}).strict();

const AlternativeTranscriptionSchema = z.object({
    text: z.string(),
    confidence: ConfidenceSchema,
}).strict();

const WordTimestampSchema = z.object({
    word: z.string(),
    start: z.number(),
    end: z.number(),
    confidence: ConfidenceSchema,
}).strict();

export const STTResultSchema = z.object({
    text: z.string(),
    confidence: ConfidenceSchema,
    alternatives: z.array(AlternativeTranscriptionSchema).optional(),
    words: z.array(WordTimestampSchema).optional(),
    processingTimeMs: z.number(),
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
    processingTimeMs: z.number(),
    imageSize: z.object({
        width: z.number(),
        height: z.number(),
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
    processingTimeMs: z.number(),
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
