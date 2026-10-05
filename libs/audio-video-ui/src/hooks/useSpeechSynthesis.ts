/**
 * React hook wrapping browser SpeechSynthesis with an observable platform TTS
 * fallback lifecycle.
 *
 * @doc.type hook
 * @doc.purpose Text-to-speech playback with explicit provider, error, and lifecycle state
 * @doc.layer shared
 * @doc.pattern StateMachineHook
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createPlatformError,
  getAudioVideoPlatformMetrics,
  incrementAudioVideoPlatformMetric,
  normalizeAudioVideoRuntimeConfig,
  synthesizeWithPlatformFallback,
  type AudioVideoPlatformError,
  type AudioVideoProvider,
  type AudioVideoRuntimeMetricsSnapshot,
  type AudioVideoSpeechHookConfig,
} from "./audioVideoPlatform";

export interface SpeechSynthesisOptions {
  readonly rate?: number;
  readonly pitch?: number;
  readonly volume?: number;
  readonly lang?: string;
}

export type SpeechSynthesisState =
  | "idle"
  | "loading"
  | "speaking"
  | "completed"
  | "failed"
  | "cancelled";

export interface UseSpeechSynthesisResult {
  readonly speak: (
    text: string,
    options?: SpeechSynthesisOptions,
  ) => void;
  readonly cancel: () => void;
  readonly isSupported: boolean;
  readonly isSpeaking: boolean;
  readonly state: SpeechSynthesisState;
  readonly error: AudioVideoPlatformError | null;
  readonly activeProvider: AudioVideoProvider;
  readonly metrics: AudioVideoRuntimeMetricsSnapshot;
}

function defaults(): Required<SpeechSynthesisOptions> {
  return {
    rate: 1.05,
    pitch: 1,
    volume: 0.85,
    lang:
      typeof navigator !== "undefined"
        ? navigator.language || "en-US"
        : "en-US",
  };
}

export function useSpeechSynthesis(
  hookConfig?: AudioVideoSpeechHookConfig,
): UseSpeechSynthesisResult {
  const isSupported =
    typeof window !== "undefined" && "speechSynthesis" in window;
  const [state, setState] = useState<SpeechSynthesisState>("idle");
  const [error, setError] = useState<AudioVideoPlatformError | null>(null);
  const [activeProvider, setActiveProvider] =
    useState<AudioVideoProvider>("none");
  const [metrics, setMetrics] = useState<AudioVideoRuntimeMetricsSnapshot>(
    getAudioVideoPlatformMetrics(),
  );
  const fallbackAudioRef = useRef<HTMLAudioElement | null>(null);
  const fallbackUrlRef = useRef<string | null>(null);
  const fallbackAbortRef = useRef<AbortController | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const configRef = useRef(hookConfig);
  configRef.current = hookConfig;

  const refreshMetrics = useCallback((): void => {
    setMetrics(getAudioVideoPlatformMetrics());
  }, []);

  const releaseFallbackAudio = useCallback((): void => {
    if (fallbackAudioRef.current) {
      fallbackAudioRef.current.pause();
      fallbackAudioRef.current.removeAttribute("src");
      fallbackAudioRef.current.load();
      fallbackAudioRef.current = null;
    }
    if (fallbackUrlRef.current) {
      URL.revokeObjectURL(fallbackUrlRef.current);
      fallbackUrlRef.current = null;
    }
  }, []);

  const cancel = useCallback((): void => {
    fallbackAbortRef.current?.abort();
    fallbackAbortRef.current = null;
    releaseFallbackAudio();
    if (isSupported) window.speechSynthesis.cancel();
    utteranceRef.current = null;
    setActiveProvider("none");
    setState("cancelled");
  }, [isSupported, releaseFallbackAudio]);

  const publishFailure = useCallback(
    (platformError: AudioVideoPlatformError): void => {
      incrementAudioVideoPlatformMetric("fallbackFailures");
      refreshMetrics();
      setError(platformError);
      setState("failed");
    },
    [refreshMetrics],
  );

  const speakWithPlatform = useCallback(
    async (text: string, options?: SpeechSynthesisOptions): Promise<void> => {
      const fallback = configRef.current?.fallback;
      if (!fallback?.ttsEndpoint) {
        publishFailure(
          createPlatformError(
            "media.platform_unavailable",
            "runtime",
            false,
            "Platform speech synthesis is not configured.",
          ),
        );
        return;
      }

      cancel();
      setState("loading");
      setError(null);
      setActiveProvider("platform");
      incrementAudioVideoPlatformMetric("ttsFallbackRequests");
      refreshMetrics();

      const controller = new AbortController();
      fallbackAbortRef.current = controller;
      const timeoutMs = normalizeAudioVideoRuntimeConfig(
        configRef.current?.runtimeConfig,
      ).requestTimeoutMs;
      const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

      try {
        const audioBlob = await synthesizeWithPlatformFallback(
          text,
          options,
          fallback,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(audioBlob);
        const audio = new Audio(url);
        fallbackUrlRef.current = url;
        fallbackAudioRef.current = audio;
        audio.onplay = () => setState("speaking");
        audio.onended = () => {
          releaseFallbackAudio();
          setState("completed");
          setActiveProvider("none");
        };
        audio.onerror = () => {
          releaseFallbackAudio();
          publishFailure(
            createPlatformError(
              "media.playback_failed",
              "runtime",
              true,
              "The synthesized audio could not be played.",
            ),
          );
        };
        await audio.play();
      } catch (cause: unknown) {
        if (controller.signal.aborted) {
          setState("cancelled");
          return;
        }
        publishFailure(
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
                "Platform speech synthesis failed.",
              ),
        );
      } finally {
        window.clearTimeout(timeout);
        if (fallbackAbortRef.current === controller) {
          fallbackAbortRef.current = null;
        }
      }
    },
    [cancel, publishFailure, refreshMetrics, releaseFallbackAudio],
  );

  const speak = useCallback(
    (text: string, options?: SpeechSynthesisOptions): void => {
      const normalizedText = text.trim();
      if (!normalizedText) return;
      const fallback = configRef.current?.fallback;
      if (fallback?.preferPlatform || (!isSupported && fallback?.ttsEndpoint)) {
        void speakWithPlatform(normalizedText, options);
        return;
      }
      if (!isSupported) {
        publishFailure(
          createPlatformError(
            "media.platform_unavailable",
            "runtime",
            false,
            "Speech synthesis is not supported and no platform fallback is configured.",
          ),
        );
        return;
      }

      cancel();
      setError(null);
      setActiveProvider("browser");
      incrementAudioVideoPlatformMetric("browserSynthesisRequests");
      refreshMetrics();

      const merged = { ...defaults(), ...options };
      const utterance = new SpeechSynthesisUtterance(normalizedText);
      utterance.rate = Math.max(0.1, Math.min(10, merged.rate));
      utterance.pitch = Math.max(0, Math.min(2, merged.pitch));
      utterance.volume = Math.max(0, Math.min(1, merged.volume));
      utterance.lang = merged.lang;
      utterance.onstart = () => setState("speaking");
      utterance.onend = () => {
        utteranceRef.current = null;
        setState("completed");
        setActiveProvider("none");
      };
      utterance.onerror = (event) => {
        utteranceRef.current = null;
        setError(
          createPlatformError(
            "media.playback_failed",
            "runtime",
            true,
            `Browser speech synthesis failed: ${event.error}.`,
          ),
        );
        setState("failed");
      };
      utteranceRef.current = utterance;
      window.speechSynthesis.speak(utterance);
    },
    [cancel, isSupported, publishFailure, refreshMetrics, speakWithPlatform],
  );

  useEffect(() => {
    return () => {
      fallbackAbortRef.current?.abort();
      releaseFallbackAudio();
      if (isSupported) window.speechSynthesis.cancel();
      utteranceRef.current = null;
    };
  }, [isSupported, releaseFallbackAudio]);

  return {
    speak,
    cancel,
    isSupported,
    isSpeaking: state === "speaking",
    state,
    error,
    activeProvider,
    metrics,
  };
}
