import { z } from 'zod';

/**
 * @doc.type types
 * @doc.purpose Shared TypeScript interfaces for audio-video application
 * @doc.layer shared
 * @doc.pattern domain-driven design
 */
export type ServiceType = 'stt' | 'tts' | 'ai-voice' | 'vision' | 'multimodal';
export type AudioFormat = 'pcm' | 'wav' | 'mp3' | 'flac' | 'ogg' | 'aac';
export interface CanonicalAudioFormat {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    format: AudioFormat;
}
export interface AudioData {
    data: ArrayBuffer;
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    durationMs: number;
    format: AudioFormat;
}
export interface VideoData {
    data: ArrayBuffer;
    width: number;
    height: number;
    durationMs: number;
    fps: number;
    format: 'mp4' | 'avi' | 'mov';
}
export interface ImageData {
    data: ArrayBuffer;
    width: number;
    height: number;
    format: 'png' | 'jpg' | 'jpeg' | 'webp';
}
export interface STTRequest {
    audio: AudioData;
    language?: string;
    model?: string;
    options?: STTOptions;
}
export interface STTOptions {
    enablePunctuation?: boolean;
    enableTimestamps?: boolean;
    maxAlternatives?: number;
    profanityFilter?: boolean;
}
export interface STTResult {
    text: string;
    confidence: number;
    alternatives?: AlternativeTranscription[];
    words?: WordTimestamp[];
    processingTimeMs: number;
    language: string;
    model: string;
}
export interface AlternativeTranscription {
    text: string;
    confidence: number;
}
export interface WordTimestamp {
    word: string;
    start: number;
    end: number;
    confidence: number;
}
export interface TTSRequest {
    text: string;
    voiceId?: string;
    language?: string;
    options?: TTSOptions;
}
export interface TTSOptions {
    sampleRate?: number;
    speed?: number;
    pitch?: number;
    volume?: number;
    emotion?: string;
    format?: Exclude<AudioFormat, 'pcm'>;
}
export interface TTSResult {
    audio: AudioData;
    voiceUsed: string;
    processingTimeMs: number;
    characters: number;
    durationMs: number;
}
export interface AIVoiceRequest {
    text: string;
    task: 'enhance' | 'translate' | 'summarize' | 'style';
    options?: AIVoiceOptions;
}
export interface AIVoiceOptions {
    targetLanguage?: string;
    style?: 'formal' | 'casual' | 'professional' | 'creative';
    maxLength?: number;
    preserveTone?: boolean;
}
export interface AIVoiceResult {
    processedText: string;
    originalText: string;
    task: string;
    processingTimeMs: number;
    confidence: number;
}
export interface VisionRequest {
    image: ImageData;
    task: 'detect' | 'classify' | 'segment' | 'analyze';
    options?: VisionOptions;
}
export interface VisionOptions {
    confidenceThreshold?: number;
    maxDetections?: number;
    classes?: string[];
    enableSegmentation?: boolean;
}
export interface DetectionResult {
    objects: DetectedObject[];
    confidence: number;
    processingTimeMs: number;
    imageSize: {
        width: number;
        height: number;
    };
}
export interface DetectedObject {
    class: string;
    confidence: number;
    bbox: BoundingBox;
    attributes?: Record<string, unknown>;
}
export interface BoundingBox {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface MultimodalRequest {
    audio?: AudioData;
    video?: VideoData;
    image?: ImageData;
    text?: string;
    task: 'transcribe' | 'synthesize' | 'analyze' | 'translate' | 'summarize';
    options?: MultimodalOptions;
}
export interface MultimodalOptions {
    primaryModality?: 'audio' | 'video' | 'image' | 'text';
    enableCrossModal?: boolean;
    outputFormat?: 'text' | 'audio' | 'video' | 'structured';
    language?: string;
}
export interface MultimodalResult {
    /** Varies based on task and output format — discriminate on `task` when consuming. */
    result: unknown;
    confidence: number;
    processingTimeMs: number;
    modalities: string[];
    insights?: MultimodalInsight[];
}
export interface MultimodalInsight {
    type: string;
    description: string;
    confidence: number;
    data: unknown;
}
export declare const STTResultSchema: z.ZodType<STTResult>;
export declare const DetectionResultSchema: z.ZodType<DetectionResult>;
export declare const MultimodalResultSchema: z.ZodType<MultimodalResult>;
export declare function parseSTTResult(input: unknown): STTResult;
export declare function parseDetectionResult(input: unknown): DetectionResult;
export declare function parseMultimodalResult(input: unknown): MultimodalResult;
export interface ServiceStatus {
    service: ServiceType;
    status: 'healthy' | 'degraded' | 'unhealthy';
    uptime: number;
    version: string;
    lastCheck: Date;
    metrics?: ServiceMetrics;
}
export interface ServiceMetrics {
    requestCount: number;
    errorRate: number;
    avgResponseTime: number;
    activeConnections: number;
    memoryUsage?: number;
    cpuUsage?: number;
}
export interface UIState {
    theme: 'light' | 'dark' | 'auto';
    sidebarOpen: boolean;
    activePanel?: string;
    notifications: Notification[];
}
export interface AudioVideoState {
    activeService: ServiceType;
    services: Record<ServiceType, ServiceState>;
    settings: AudioVideoSettings;
    ui: UIState;
}
export interface ServiceState {
    status: ServiceStatus;
    lastResult?: unknown;
    isProcessing: boolean;
    error?: string;
    configuration: Record<string, unknown>;
}
export interface AudioVideoSettings {
    services: Record<ServiceType, ServiceSettings>;
    ui: UISettings;
    performance: PerformanceSettings;
    accessibility: AccessibilitySettings;
}
export interface ServiceSettings {
    enabled: boolean;
    endpoint: string;
    timeout: number;
    retries: number;
    customSettings: Record<string, unknown>;
}
export interface UISettings {
    theme: 'light' | 'dark' | 'auto';
    language: string;
    fontSize: 'small' | 'medium' | 'large';
    layout: 'compact' | 'comfortable' | 'spacious';
    animations: boolean;
    notifications: boolean;
}
export interface PerformanceSettings {
    enableGPU: boolean;
    maxConcurrentRequests: number;
    cacheSize: number;
    enableCompression: boolean;
    bufferSize: number;
}
export interface AccessibilitySettings {
    highContrast: boolean;
    reduceMotion: boolean;
    screenReader: boolean;
    keyboardNavigation: boolean;
    fontSize: number;
    colorBlindMode: 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia';
}
export interface Workflow {
    id: string;
    name: string;
    description: string;
    steps: WorkflowStep[];
    enabled: boolean;
}
export interface WorkflowStep {
    id: string;
    service: ServiceType;
    operation: string;
    parameters: Record<string, unknown>;
    conditions?: WorkflowCondition[];
}
export interface WorkflowCondition {
    field: string;
    operator: 'equals' | 'contains' | 'greater' | 'less';
    value: string | number | boolean;
}
export interface WorkflowExecution {
    workflowId: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    startTime: Date;
    endTime?: Date;
    results: Record<string, unknown>;
    error?: string;
}
export interface AudioVideoError {
    code: string;
    message: string;
    service?: ServiceType;
    details?: Record<string, unknown>;
    timestamp: Date;
    retryable?: boolean;
}
export interface APIError extends AudioVideoError {
    statusCode?: number;
    endpoint?: string;
}
export interface AudioVideoEvent {
    type: string;
    service?: ServiceType;
    data: unknown;
    timestamp: Date;
}
export interface ServiceEvent extends AudioVideoEvent {
    service: ServiceType;
    eventType: 'status_change' | 'result' | 'error' | 'configuration_change';
}
export interface UIEvent extends AudioVideoEvent {
    eventType: 'navigation' | 'settings_change' | 'workflow_start' | 'workflow_complete';
}
export type DeepPartial<T> = {
    [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
export type ServiceResponse<T = any> = {
    success: boolean;
    data?: T;
    error?: AudioVideoError;
    metadata?: Record<string, unknown>;
};
export type ProgressCallback = (progress: number, message?: string) => void;
export type ErrorCallback = (error: AudioVideoError) => void;
export type SuccessCallback<T = any> = (result: T) => void;
export declare const DEFAULT_AUDIO_FORMAT: CanonicalAudioFormat;
export declare function createAudioData(data: ArrayBuffer, overrides?: Partial<Omit<AudioData, 'data'>>): AudioData;
export declare function isSupportedAudioFormat(format: string): format is AudioFormat;
