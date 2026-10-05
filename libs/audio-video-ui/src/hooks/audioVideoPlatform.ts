/**
 * Shared browser/platform runtime utilities for audio-video speech hooks.
 */
export type AudioVideoProvider = "none" | "browser" | "platform";

export interface AudioVideoRuntimeConfig {
  readonly languageTag: string;
  readonly requestTimeoutMs: number;
  readonly recognitionMimeType: string;
  readonly ttsVoiceId: string;
  readonly syncToleranceMs: number;
  readonly metricsEnabled: boolean;
}

export interface AudioVideoRuntimeMetricsSnapshot {
  readonly browserRecognitionSessions: number;
  readonly browserSynthesisRequests: number;
  readonly sttFallbackRequests: number;
  readonly ttsFallbackRequests: number;
  readonly fallbackFailures: number;
}

export interface AudioVideoPlatformFallbackConfig {
  readonly sttEndpoint?: string;
  readonly ttsEndpoint?: string;
  readonly headers?: HeadersInit;
  readonly preferPlatform?: boolean;
  readonly fetchImpl?: typeof fetch;
}

export interface AudioVideoSpeechHookConfig {
  readonly fallback?: AudioVideoPlatformFallbackConfig;
  readonly runtimeConfig?: Partial<AudioVideoRuntimeConfig>;
}

export interface AudioVideoPlatformError extends Error {
  readonly code: string;
  readonly category: "validation" | "runtime";
  readonly retryable: boolean;
}

const defaultRuntimeConfig: AudioVideoRuntimeConfig = {
  languageTag:
    typeof navigator !== "undefined"
      ? navigator.language || "en-US"
      : "en-US",
  requestTimeoutMs: 30_000,
  recognitionMimeType: "audio/webm",
  ttsVoiceId: "default",
  syncToleranceMs: 40,
  metricsEnabled: true,
};

const metrics: {
  browserRecognitionSessions: number;
  browserSynthesisRequests: number;
  sttFallbackRequests: number;
  ttsFallbackRequests: number;
  fallbackFailures: number;
} = {
  browserRecognitionSessions: 0,
  browserSynthesisRequests: 0,
  sttFallbackRequests: 0,
  ttsFallbackRequests: 0,
  fallbackFailures: 0,
};

export function normalizeAudioVideoRuntimeConfig(
  overrides?: Partial<AudioVideoRuntimeConfig>,
): AudioVideoRuntimeConfig {
  return {
    ...defaultRuntimeConfig,
    ...overrides,
    requestTimeoutMs: Math.max(
      1_000,
      overrides?.requestTimeoutMs ?? defaultRuntimeConfig.requestTimeoutMs,
    ),
    syncToleranceMs: Math.max(
      20,
      overrides?.syncToleranceMs ?? defaultRuntimeConfig.syncToleranceMs,
    ),
    languageTag:
      overrides?.languageTag?.trim() || defaultRuntimeConfig.languageTag,
    ttsVoiceId: overrides?.ttsVoiceId?.trim() || defaultRuntimeConfig.ttsVoiceId,
  };
}

export function createPlatformError(
  code: string,
  category: "validation" | "runtime",
  retryable: boolean,
  message: string,
): AudioVideoPlatformError {
  const error = new Error(message) as AudioVideoPlatformError;
  Object.defineProperties(error, {
    code: { value: code, enumerable: true },
    category: { value: category, enumerable: true },
    retryable: { value: retryable, enumerable: true },
  });
  return error;
}

export function incrementAudioVideoPlatformMetric(
  key: keyof AudioVideoRuntimeMetricsSnapshot,
): void {
  metrics[key] += 1;
}

export function getAudioVideoPlatformMetrics(): AudioVideoRuntimeMetricsSnapshot {
  return { ...metrics };
}

export function isPlatformSpeechRecognitionAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof window !== "undefined" &&
    "mediaDevices" in navigator &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    "MediaRecorder" in window
  );
}

function responseError(
  capability: "STT" | "TTS",
  response: Response,
): AudioVideoPlatformError {
  const retryable = response.status === 429 || response.status >= 500;
  return createPlatformError(
    response.status === 429
      ? "media.rate_limited"
      : "media.temporarily_unavailable",
    "runtime",
    retryable,
    `${capability} fallback request failed with status ${response.status}.`,
  );
}

export async function transcribeWithPlatformFallback(
  audioBlob: Blob,
  fallbackConfig: AudioVideoPlatformFallbackConfig,
  languageTag: string,
  signal?: AbortSignal,
): Promise<{ readonly transcript: string; readonly confidence: number }> {
  if (!fallbackConfig.sttEndpoint) {
    throw createPlatformError(
      "media.platform_unavailable",
      "runtime",
      false,
      "No STT fallback endpoint has been configured.",
    );
  }
  const formData = new FormData();
  formData.append("audio", audioBlob, "speech.webm");
  formData.append("languageTag", languageTag);

  let response: Response;
  try {
    response = await (fallbackConfig.fetchImpl ?? fetch)(
      fallbackConfig.sttEndpoint,
      {
        method: "POST",
        headers: fallbackConfig.headers,
        body: formData,
        signal,
      },
    );
  } catch (cause: unknown) {
    if (signal?.aborted) {
      throw createPlatformError(
        "media.cancelled",
        "runtime",
        false,
        "Speech transcription was cancelled.",
      );
    }
    throw createPlatformError(
      "media.temporarily_unavailable",
      "runtime",
      true,
      cause instanceof Error ? cause.message : "STT fallback request failed.",
    );
  }

  if (!response.ok) throw responseError("STT", response);

  const body = (await response.json()) as {
    readonly transcript?: unknown;
    readonly transcription?: unknown;
    readonly confidence?: unknown;
  };
  const transcript =
    typeof body.transcript === "string"
      ? body.transcript
      : typeof body.transcription === "string"
        ? body.transcription
        : "";
  if (!transcript.trim()) {
    throw createPlatformError(
      "media.processing_failed",
      "runtime",
      true,
      "STT fallback response did not contain a transcript.",
    );
  }
  const confidence =
    typeof body.confidence === "number" ? body.confidence : 0;
  return {
    transcript,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

export async function synthesizeWithPlatformFallback(
  text: string,
  options:
    | {
        readonly rate?: number;
        readonly pitch?: number;
        readonly volume?: number;
        readonly lang?: string;
      }
    | undefined,
  fallbackConfig: AudioVideoPlatformFallbackConfig,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!fallbackConfig.ttsEndpoint) {
    throw createPlatformError(
      "media.platform_unavailable",
      "runtime",
      false,
      "No TTS fallback endpoint has been configured.",
    );
  }

  const headers = new Headers(fallbackConfig.headers);
  headers.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await (fallbackConfig.fetchImpl ?? fetch)(
      fallbackConfig.ttsEndpoint,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ text, ...options }),
        signal,
      },
    );
  } catch (cause: unknown) {
    if (signal?.aborted) {
      throw createPlatformError(
        "media.cancelled",
        "runtime",
        false,
        "Speech synthesis was cancelled.",
      );
    }
    throw createPlatformError(
      "media.temporarily_unavailable",
      "runtime",
      true,
      cause instanceof Error ? cause.message : "TTS fallback request failed.",
    );
  }

  if (!response.ok) throw responseError("TTS", response);
  const blob = await response.blob();
  if (blob.size === 0) {
    throw createPlatformError(
      "media.processing_failed",
      "runtime",
      true,
      "TTS fallback returned an empty audio response.",
    );
  }
  return blob;
}

export interface FallbackRecordingSession {
  /** Stop capture and upload the recording for transcription. */
  stopAndTranscribe(): Promise<{
    readonly transcript: string;
    readonly confidence: number;
  }>;
  /** Release tracks and abort any upload without producing a transcript. */
  discard(): void;
}

export function startFallbackRecording(
  stream: MediaStream,
  mimeType: string | undefined,
  fallbackConfig: AudioVideoPlatformFallbackConfig,
  languageTag: string,
  requestTimeoutMs = defaultRuntimeConfig.requestTimeoutMs,
): FallbackRecordingSession {
  const resolvedMime =
    mimeType && MediaRecorder.isTypeSupported(mimeType) ? mimeType : undefined;
  const recorder = new MediaRecorder(
    stream,
    resolvedMime ? { mimeType: resolvedMime } : undefined,
  );
  const chunks: Blob[] = [];
  const transcriptionController = new AbortController();
  let recorderError: AudioVideoPlatformError | null = null;
  let discarded = false;

  const releaseTracks = (): void => {
    stream.getTracks().forEach((track) => track.stop());
  };

  recorder.ondataavailable = (event): void => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  recorder.onerror = (): void => {
    recorderError = createPlatformError(
      "media.recording_failed",
      "runtime",
      true,
      "Failed to capture audio for platform speech recognition.",
    );
    releaseTracks();
  };

  recorder.start();

  const transcribeCapturedAudio = async (): Promise<{
    readonly transcript: string;
    readonly confidence: number;
  }> => {
    releaseTracks();
    if (discarded) {
      throw createPlatformError(
        "media.cancelled",
        "runtime",
        false,
        "The recording was discarded.",
      );
    }
    if (recorderError) throw recorderError;

    const blob = new Blob(chunks, {
      type: resolvedMime ?? "audio/webm",
    });
    if (blob.size === 0) {
      throw createPlatformError(
        "media.recording_empty",
        "validation",
        false,
        "No audio was captured.",
      );
    }

    const timeout = setTimeout(
      () => transcriptionController.abort(),
      Math.max(1_000, requestTimeoutMs),
    );
    try {
      return await transcribeWithPlatformFallback(
        blob,
        fallbackConfig,
        languageTag,
        transcriptionController.signal,
      );
    } finally {
      clearTimeout(timeout);
    }
  };

  const stopAndTranscribe = (): Promise<{
    readonly transcript: string;
    readonly confidence: number;
  }> => {
    if (discarded) {
      return Promise.reject(
        createPlatformError(
          "media.cancelled",
          "runtime",
          false,
          "The recording was discarded.",
        ),
      );
    }
    if (recorderError) return Promise.reject(recorderError);
    if (recorder.state === "inactive") {
      return transcribeCapturedAudio();
    }

    return new Promise((resolve, reject) => {
      recorder.onstop = (): void => {
        void transcribeCapturedAudio().then(resolve, reject);
      };
      recorder.stop();
    });
  };

  const discard = (): void => {
    discarded = true;
    transcriptionController.abort();
    if (recorder.state !== "inactive") recorder.stop();
    releaseTracks();
  };

  return { stopAndTranscribe, discard };
}
