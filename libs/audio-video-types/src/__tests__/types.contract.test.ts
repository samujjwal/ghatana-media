/**
 * Contract and shape-correctness tests for @audio-video/types.
 *
 * These tests guard against type-level regressions (shape drift between
 * the TypeScript interfaces and what service payloads actually provide).
 */
import { describe, it, expect } from 'vitest';
import {
  createAudioData,
  isSupportedAudioFormat,
  DEFAULT_AUDIO_FORMAT,
  type AudioData,
  type STTResult,
  type TTSResult,
  type DetectionResult,
  type DetectedObject,
  type BoundingBox,
  type MultimodalResult,
  type ServiceStatus,
  type AudioVideoError,
  parseSTTResult,
  parseDetectionResult,
  parseMultimodalResult,
} from '../index';

// ─── DEFAULT_AUDIO_FORMAT ─────────────────────────────────────────────────────

describe('DEFAULT_AUDIO_FORMAT', () => {
  it('has expected defaults', () => {
    expect(DEFAULT_AUDIO_FORMAT.sampleRate).toBe(16000);
    expect(DEFAULT_AUDIO_FORMAT.channels).toBe(1);
    expect(DEFAULT_AUDIO_FORMAT.bitsPerSample).toBe(16);
    expect(DEFAULT_AUDIO_FORMAT.format).toBe('pcm');
  });
});

// ─── createAudioData() ────────────────────────────────────────────────────────

describe('createAudioData()', () => {
  it('applies default values when no overrides given', () => {
    const buf = new ArrayBuffer(16);
    const audio = createAudioData(buf);
    expect(audio.data).toBe(buf);
    expect(audio.sampleRate).toBe(16000);
    expect(audio.channels).toBe(1);
    expect(audio.bitsPerSample).toBe(16);
    expect(audio.durationMs).toBe(0);
    expect(audio.format).toBe('pcm');
  });

  it('applies provided overrides', () => {
    const buf = new ArrayBuffer(4);
    const audio = createAudioData(buf, {
      sampleRate: 44100,
      channels: 2,
      bitsPerSample: 24,
      durationMs: 3000,
      format: 'wav',
    });
    expect(audio.sampleRate).toBe(44100);
    expect(audio.channels).toBe(2);
    expect(audio.bitsPerSample).toBe(24);
    expect(audio.durationMs).toBe(3000);
    expect(audio.format).toBe('wav');
  });

  it('partial overrides preserve remaining defaults', () => {
    const audio = createAudioData(new ArrayBuffer(0), { sampleRate: 8000 });
    expect(audio.sampleRate).toBe(8000);
    expect(audio.channels).toBe(1); // default kept
    expect(audio.format).toBe('pcm'); // default kept
  });
});

// ─── isSupportedAudioFormat() ─────────────────────────────────────────────────

describe('isSupportedAudioFormat()', () => {
  const supported = ['pcm', 'wav', 'mp3', 'flac', 'ogg', 'aac'] as const;
  for (const fmt of supported) {
    it(`returns true for "${fmt}"`, () => {
      expect(isSupportedAudioFormat(fmt)).toBe(true);
    });
  }

  it('returns false for unsupported format', () => {
    expect(isSupportedAudioFormat('mp4')).toBe(false);
    expect(isSupportedAudioFormat('')).toBe(false);
    expect(isSupportedAudioFormat('UNKNOWN')).toBe(false);
    expect(isSupportedAudioFormat('wma')).toBe(false);
  });
});

// ─── STTResult contract ───────────────────────────────────────────────────────

describe('STTResult contract shape', () => {
  it('satisfies expected shape', () => {
    const result: STTResult = {
      text: 'Hello world',
      confidence: 0.95,
      processingTimeMs: 200,
      language: 'en-US',
      model: 'whisper-large',
      alternatives: [{ text: 'Hello word', confidence: 0.7 }],
      words: [{ word: 'Hello', start: 0, end: 0.5, confidence: 0.99 }],
    };
    expect(result.text).toBe('Hello world');
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.alternatives![0]!.confidence).toBe(0.7);
    expect(result.words![0]!.start).toBe(0);
  });

  it('runtime parser rejects malformed confidence value', () => {
    expect(() => parseSTTResult({
      text: 'bad',
      confidence: 2,
      processingTimeMs: 10,
      language: 'en',
      model: 'x',
    })).toThrow();
  });

  it('runtime parser accepts a valid STT payload', () => {
    expect(parseSTTResult({
      text: 'Hello world',
      confidence: 0.95,
      processingTimeMs: 10,
      language: 'en-US',
      model: 'whisper-large',
    }).text).toBe('Hello world');
  });
});

// ─── BoundingBox contract ─────────────────────────────────────────────────────

describe('BoundingBox shape', () => {
  it('has numeric x, y, width, height', () => {
    const bbox: BoundingBox = { x: 10, y: 20, width: 100, height: 50 };
    expect(bbox.x).toBe(10);
    expect(bbox.y).toBe(20);
    expect(bbox.width).toBe(100);
    expect(bbox.height).toBe(50);
  });

  it('allows zero coordinates', () => {
    const bbox: BoundingBox = { x: 0, y: 0, width: 0, height: 0 };
    expect(bbox.width).toBe(0);
  });
});

// ─── DetectedObject contract ──────────────────────────────────────────────────

describe('DetectedObject contract shape', () => {
  it('satisfies expected shape', () => {
    const obj: DetectedObject = {
      class: 'car',
      confidence: 0.88,
      bbox: { x: 10, y: 20, width: 200, height: 150 },
    };
    expect(obj.class).toBe('car');
    expect(obj.confidence).toBe(0.88);
    expect(obj.bbox.width).toBe(200);
  });

  it('can carry optional attributes', () => {
    const obj: DetectedObject = {
      class: 'person',
      confidence: 0.75,
      bbox: { x: 0, y: 0, width: 50, height: 120 },
      attributes: { color: 'red', speed: 3 },
    };
    expect(obj.attributes?.['color']).toBe('red');
  });
});

// ─── AudioVideoError contract ─────────────────────────────────────────────────

describe('AudioVideoError contract shape', () => {
  it('satisfies expected shape with required fields', () => {
    const err: AudioVideoError = {
      code: 'STT_ERROR',
      message: 'Transcription failed',
      service: 'stt',
      timestamp: new Date(),
      retryable: true,
    };
    expect(err.code).toBe('STT_ERROR');
    expect(err.message).toBeTruthy();
    expect(err.timestamp).toBeInstanceOf(Date);
    expect(err.retryable).toBe(true);
  });

  it('works without optional fields', () => {
    const err: AudioVideoError = {
      code: 'GENERIC',
      message: 'Something went wrong',
      timestamp: new Date(),
    };
    expect(err.service).toBeUndefined();
    expect(err.details).toBeUndefined();
    expect(err.retryable).toBeUndefined();
  });
});

// ─── ServiceStatus contract ───────────────────────────────────────────────────

describe('ServiceStatus contract shape', () => {
  it('satisfies expected shape for healthy service', () => {
    const status: ServiceStatus = {
      service: 'stt',
      status: 'healthy',
      uptime: 99999,
      version: '1.0.0',
      lastCheck: new Date(),
      metrics: {
        requestCount: 1000,
        errorRate: 0.01,
        avgResponseTime: 120,
        activeConnections: 10,
      },
    };
    expect(status.status).toBe('healthy');
    expect(status.metrics!.requestCount).toBe(1000);
  });

  it('allows all status variants', () => {
    const statuses: Array<ServiceStatus['status']> = ['healthy', 'degraded', 'unhealthy'];
    for (const s of statuses) {
      const status: ServiceStatus = {
        service: 'tts',
        status: s,
        uptime: 0,
        version: 'unknown',
        lastCheck: new Date(),
        metrics: { requestCount: 0, errorRate: 0, avgResponseTime: 0, activeConnections: 0 },
      };
      expect(status.status).toBe(s);
    }
  });
});

// ─── MultimodalResult contract ────────────────────────────────────────────────

describe('MultimodalResult contract shape', () => {
  it('satisfies expected shape', () => {
    const result: MultimodalResult = {
      result: { summary: 'ok' },
      confidence: 0.92,
      insights: [
        { type: 'sentiment', description: 'Positive tone', confidence: 0.9, data: { score: 0.9 } },
      ],
      processingTimeMs: 500,
      modalities: ['audio', 'text'],
    };
    expect(result.insights!).toHaveLength(1);
    expect(result.insights![0]!.confidence).toBe(0.9);
    expect(result.modalities).toContain('audio');
  });

  it('runtime parser validates multimodal payload', () => {
    const parsed = parseMultimodalResult({
      result: { summary: 'ok' },
      confidence: 0.8,
      processingTimeMs: 100,
      modalities: ['audio'],
      insights: [{ type: 'summary', description: 'ok', confidence: 0.9, data: {} }],
    });
    expect(parsed.modalities).toContain('audio');
  });

  it('runtime parser rejects malformed confidence values', () => {
    expect(() => parseMultimodalResult({
      result: { summary: 'bad' },
      confidence: 1.1,
      processingTimeMs: 100,
      modalities: ['audio'],
    })).toThrow();
  });
});

describe('DetectionResult runtime validation', () => {
  it('runtime parser accepts a valid detection payload', () => {
    expect(parseDetectionResult({
      objects: [{
        class: 'person',
        confidence: 0.9,
        bbox: { x: 0, y: 0, width: 10, height: 20 },
      }],
      confidence: 0.9,
      processingTimeMs: 20,
      imageSize: { width: 640, height: 480 },
    }).objects).toHaveLength(1);
  });

  it('rejects malformed detection payload', () => {
    expect(() => parseDetectionResult({
      objects: [{ class: 'person', confidence: 0.9 }],
      confidence: 0.9,
      processingTimeMs: 20,
      imageSize: { width: 640, height: 480 },
    })).toThrow();
  });
});
