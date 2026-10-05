/**
 * React hook wrapping browser SpeechRecognition with an explicit platform STT
 * fallback lifecycle.
 *
 * @doc.type hook
 * @doc.purpose Accessible speech-to-text recording and transcription lifecycle
 * @doc.layer shared
 * @doc.pattern StateMachineHook
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createPlatformError,
  getAudioVideoPlatformMetrics,
  incrementAudioVideoPlatformMetric,
  isPlatformSpeechRecognitionAvailable,
  normalizeAudioVideoRuntimeConfig,
  startFallbackRecording,
  type AudioVideoPlatformError,
  type AudioVideoProvider,
  type AudioVideoRuntimeConfig,
  type AudioVideoRuntimeMetricsSnapshot,
  type AudioVideoSpeechHookConfig,
  type FallbackRecordingSession,
} from "./audioVideoPlatform";

interface BrowserSpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface BrowserSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: BrowserSpeechRecognitionAlternative;
}

interface BrowserSpeechRecognitionEvent {
  readonly results: ArrayLike<BrowserSpeechRecognitionResult>;
}

interface BrowserSpeechRecognitionErrorEvent {
  readonly error: string;
  readonly message?: string;
}

interface BrowserSpeechRecognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort?(): void;
}

export interface SpeechRecognitionOptions {
  readonly lang?: string;
  readonly interimResults?: boolean;
  readonly continuous?: boolean;
}

export interface SpeechRecognitionCallbacks {
  readonly onTranscript?: (transcript: string, isFinal: boolean) => void;
  readonly onEnd?: () => void;
  readonly onError?: (event: BrowserSpeechRecognitionErrorEvent) => void;
  readonly onPlatformError?: (error: AudioVideoPlatformError) => void;
  readonly onProviderChange?: (provider: AudioVideoProvider) => void;
}

export type SpeechRecognitionState =
  | "idle"
  | "requesting-permission"
  | "listening"
  | "stopping"
  | "transcribing"
  | "completed"
  | "failed"
  | "cancelled";

export interface UseSpeechRecognitionResult {
  /** Begin browser recognition or begin a platform fallback recording. */
  readonly start: (
    callbacks?: SpeechRecognitionCallbacks,
    options?: SpeechRecognitionOptions,
  ) => void;
  /** Stop the active session. Platform recordings are transcribed. */
  readonly stop: () => void;
  /** Cancel the active session and discard captured audio or in-flight upload. */
  readonly cancel: () => void;
  readonly isListening: boolean;
  readonly isSupported: boolean;
  readonly supportsPlatformFallback: boolean;
  readonly activeProvider: AudioVideoProvider;
  readonly state: SpeechRecognitionState;
  readonly error: AudioVideoPlatformError | null;
  readonly metrics: AudioVideoRuntimeMetricsSnapshot;
}

function getSpeechRecognitionCtor():
  | (new () => BrowserSpeechRecognition)
  | undefined {
  if (typeof window === "undefined") return undefined;
  const candidate = window as typeof window & {
    SpeechRecognition?: new () => BrowserSpeechRecognition;
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
  };
  return candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition;
}

export function useSpeechRecognition(
  hookConfig?: AudioVideoSpeechHookConfig,
): UseSpeechRecognitionResult {
  const RecognitionCtor = getSpeechRecognitionCtor();
  const isSupported = RecognitionCtor !== undefined;
  const runtimeConfigRef = useRef<AudioVideoRuntimeConfig>(
    normalizeAudioVideoRuntimeConfig(hookConfig?.runtimeConfig),
  );
  const hookConfigRef = useRef(hookConfig);
  hookConfigRef.current = hookConfig;

  const [state, setState] = useState<SpeechRecognitionState>("idle");
  const [activeProvider, setActiveProvider] =
    useState<AudioVideoProvider>("none");
  const [error, setError] = useState<AudioVideoPlatformError | null>(null);
  const [metrics, setMetrics] = useState<AudioVideoRuntimeMetricsSnapshot>(
    getAudioVideoPlatformMetrics(),
  );

  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const recordingSessionRef = useRef<FallbackRecordingSession | null>(null);
  const callbacksRef = useRef<SpeechRecognitionCallbacks | undefined>(undefined);
  const optionsRef = useRef<SpeechRecognitionOptions | undefined>(undefined);
  const cancelledRef = useRef(false);

  const refreshMetrics = useCallback((): void => {
    setMetrics(getAudioVideoPlatformMetrics());
  }, []);

  const publishProvider = useCallback(
    (provider: AudioVideoProvider): void => {
      setActiveProvider(provider);
      callbacksRef.current?.onProviderChange?.(provider);
    },
    [],
  );

  const publishPlatformError = useCallback(
    (platformError: AudioVideoPlatformError): void => {
      setError(platformError);
      setState("failed");
      callbacksRef.current?.onPlatformError?.(platformError);
      refreshMetrics();
    },
    [refreshMetrics],
  );

  const cancel = useCallback((): void => {
    cancelledRef.current = true;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition?.abort) recognition.abort();
    else recognition?.stop();

    recordingSessionRef.current?.discard();
    recordingSessionRef.current = null;
    setState("cancelled");
    setActiveProvider("none");
  }, []);

  const startPlatformRecording = useCallback(async (): Promise<void> => {
    const fallbackConfig = hookConfigRef.current?.fallback;
    if (!fallbackConfig?.sttEndpoint || !isPlatformSpeechRecognitionAvailable()) {
      publishPlatformError(
        createPlatformError(
          "media.platform_unavailable",
          "runtime",
          false,
          "Platform speech recognition fallback is not available.",
        ),
      );
      return;
    }

    cancelledRef.current = false;
    setError(null);
    setState("requesting-permission");
    incrementAudioVideoPlatformMetric("sttFallbackRequests");
    refreshMetrics();
    publishProvider("platform");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (cancelledRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      recordingSessionRef.current = startFallbackRecording(
        stream,
        runtimeConfigRef.current.recognitionMimeType,
        fallbackConfig,
        optionsRef.current?.lang ?? runtimeConfigRef.current.languageTag,
        runtimeConfigRef.current.requestTimeoutMs,
      );
      setState("listening");
    } catch (cause: unknown) {
      incrementAudioVideoPlatformMetric("fallbackFailures");
      publishPlatformError(
        createPlatformError(
          "media.input_unavailable",
          "runtime",
          true,
          cause instanceof Error
            ? cause.message
            : "Unable to access the microphone.",
        ),
      );
    }
  }, [publishPlatformError, publishProvider, refreshMetrics]);

  const stopPlatformRecording = useCallback(async (): Promise<void> => {
    const session = recordingSessionRef.current;
    if (!session) return;
    cancelledRef.current = false;
    setState("stopping");

    try {
      setState("transcribing");
      const { transcript } = await session.stopAndTranscribe();
      if (cancelledRef.current) return;
      callbacksRef.current?.onTranscript?.(transcript, true);
      setState("completed");
      setActiveProvider("none");
      callbacksRef.current?.onEnd?.();
    } catch (cause: unknown) {
      if (cancelledRef.current) return;
      incrementAudioVideoPlatformMetric("fallbackFailures");
      publishPlatformError(
        cause instanceof Error
          ? createPlatformError(
              "media.processing_failed",
              "runtime",
              true,
              cause.message,
            )
          : createPlatformError(
              "media.processing_failed",
              "runtime",
              true,
              "Platform speech recognition failed.",
            ),
      );
    } finally {
      if (recordingSessionRef.current === session) {
        recordingSessionRef.current = null;
      }
      refreshMetrics();
    }
  }, [publishPlatformError, refreshMetrics]);

  const stop = useCallback((): void => {
    if (activeProvider === "platform") {
      void stopPlatformRecording();
      return;
    }
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      setState("stopping");
      recognition.stop();
    }
  }, [activeProvider, stopPlatformRecording]);

  const start = useCallback(
    (
      callbacks?: SpeechRecognitionCallbacks,
      options?: SpeechRecognitionOptions,
    ): void => {
      callbacksRef.current = callbacks;
      optionsRef.current = options;
      cancelledRef.current = false;
      setError(null);

      if (
        state === "listening" ||
        state === "requesting-permission" ||
        state === "stopping" ||
        state === "transcribing"
      ) {
        cancel();
      }

      if (hookConfigRef.current?.fallback?.preferPlatform || !RecognitionCtor) {
        void startPlatformRecording();
        return;
      }

      incrementAudioVideoPlatformMetric("browserRecognitionSessions");
      refreshMetrics();
      publishProvider("browser");

      const recognition = new RecognitionCtor();
      recognition.lang = options?.lang ?? navigator.language ?? "en-US";
      recognition.interimResults = options?.interimResults ?? true;
      recognition.continuous = options?.continuous ?? false;

      recognition.onresult = (event: BrowserSpeechRecognitionEvent): void => {
        const latestResult = event.results[event.results.length - 1];
        if (!latestResult) return;
        const combinedTranscript = Array.from(event.results)
          .map((result) => result[0]?.transcript ?? "")
          .join("");
        callbacksRef.current?.onTranscript?.(
          combinedTranscript,
          latestResult.isFinal,
        );
      };

      recognition.onerror = (recognitionError): void => {
        recognitionRef.current = null;
        if (hookConfigRef.current?.fallback?.sttEndpoint) {
          void startPlatformRecording();
          return;
        }
        setState("failed");
        callbacksRef.current?.onError?.(recognitionError);
      };

      recognition.onend = (): void => {
        recognitionRef.current = null;
        if (cancelledRef.current) return;
        setState("completed");
        setActiveProvider("none");
        callbacksRef.current?.onEnd?.();
      };

      recognitionRef.current = recognition;
      try {
        recognition.start();
        setState("listening");
      } catch (cause: unknown) {
        recognitionRef.current = null;
        setState("failed");
        callbacksRef.current?.onError?.({
          error: "start-failed",
          message:
            cause instanceof Error
              ? cause.message
              : "Speech recognition could not start.",
        });
      }
    },
    [
      RecognitionCtor,
      cancel,
      publishProvider,
      refreshMetrics,
      startPlatformRecording,
      state,
    ],
  );

  useEffect(() => {
    runtimeConfigRef.current = normalizeAudioVideoRuntimeConfig(
      hookConfig?.runtimeConfig,
    );
  }, [hookConfig?.runtimeConfig]);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      const recognition = recognitionRef.current;
      if (recognition?.abort) recognition.abort();
      else recognition?.stop();
      recordingSessionRef.current?.discard();
      recognitionRef.current = null;
      recordingSessionRef.current = null;
    };
  }, []);

  return {
    start,
    stop,
    cancel,
    isListening: state === "listening",
    isSupported,
    supportsPlatformFallback:
      Boolean(hookConfig?.fallback?.sttEndpoint) &&
      isPlatformSpeechRecognitionAvailable(),
    activeProvider,
    state,
    error,
    metrics,
  };
}
