/**
 * Reliable audio playback hook with explicit loading, buffering, failure, and
 * loop lifecycle.
 *
 * @doc.type hook
 * @doc.purpose Audio playback lifecycle and controls
 * @doc.layer product
 * @doc.pattern StateMachineHook
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { PlaybackState } from "../types";

export type AudioPlaybackStatus =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "buffering"
  | "ended"
  | "failed";

export interface UseAudioPlayerOptions {
  readonly audioPath?: string;
  readonly autoPlay?: boolean;
  readonly loop?: boolean;
  readonly initialVolume?: number;
  readonly playbackRate?: number;
  readonly onEnd?: () => void;
  readonly onTimeUpdate?: (time: number) => void;
  readonly onError?: (error: Error) => void;
}

export interface UseAudioPlayerResult {
  readonly state: PlaybackState;
  readonly status: AudioPlaybackStatus;
  readonly error: Error | null;
  readonly isReady: boolean;
  readonly play: () => Promise<void>;
  readonly pause: () => void;
  readonly toggle: () => Promise<void>;
  readonly seek: (time: number) => void;
  readonly setLoop: (start: number, end: number) => void;
  readonly clearLoop: () => void;
  readonly setVolume: (volume: number) => void;
  readonly setPlaybackRate: (rate: number) => void;
  readonly reload: () => void;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function playbackError(message: string, cause?: unknown): Error {
  const error = new Error(message);
  if (cause !== undefined) {
    Object.defineProperty(error, "cause", { value: cause });
  }
  return error;
}

export function useAudioPlayer(
  options: UseAudioPlayerOptions = {},
): UseAudioPlayerResult {
  const {
    audioPath,
    autoPlay = false,
    loop = false,
    initialVolume = 1,
    playbackRate = 1,
  } = options;
  const callbackRef = useRef({
    onEnd: options.onEnd,
    onTimeUpdate: options.onTimeUpdate,
    onError: options.onError,
  });
  callbackRef.current = {
    onEnd: options.onEnd,
    onTimeUpdate: options.onTimeUpdate,
    onError: options.onError,
  };

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const loopRef = useRef<{
    readonly start?: number;
    readonly end?: number;
    readonly enabled: boolean;
  }>({ enabled: loop });
  const [reloadVersion, setReloadVersion] = useState(0);
  const [status, setStatus] = useState<AudioPlaybackStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [state, setState] = useState<PlaybackState>({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    isLooping: loop,
  });

  const publishError = useCallback((nextError: Error): void => {
    setError(nextError);
    setStatus("failed");
    setState((previous) => ({ ...previous, isPlaying: false }));
    callbackRef.current.onError?.(nextError);
  }, []);

  const stopAnimation = useCallback((): void => {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!audioPath) {
      audioRef.current = null;
      setStatus("idle");
      setError(null);
      setState({
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        isLooping: loopRef.current.enabled,
        ...(loopRef.current.start !== undefined
          ? { loopStart: loopRef.current.start }
          : {}),
        ...(loopRef.current.end !== undefined
          ? { loopEnd: loopRef.current.end }
          : {}),
      });
      return;
    }

    const audio = new Audio();
    audio.preload = "metadata";
    audio.volume = clamp(initialVolume, 0, 1);
    audio.playbackRate = clamp(playbackRate, 0.25, 4);
    audioRef.current = audio;
    setStatus("loading");
    setError(null);

    const onLoadedMetadata = (): void => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      setState((previous) => ({ ...previous, duration }));
      setStatus("ready");
      if (autoPlay) {
        void audio.play().catch((cause: unknown) => {
          publishError(
            playbackError(
              "Automatic playback was blocked or the audio could not start.",
              cause,
            ),
          );
        });
      }
    };
    const onPlaying = (): void => {
      setStatus("playing");
      setState((previous) => ({ ...previous, isPlaying: true }));
    };
    const onPause = (): void => {
      if (audio.ended) return;
      setStatus((current) => (current === "failed" ? current : "paused"));
      setState((previous) => ({ ...previous, isPlaying: false }));
    };
    const onWaiting = (): void => setStatus("buffering");
    const onCanPlay = (): void => {
      setStatus((current) =>
        current === "buffering" ? (audio.paused ? "ready" : "playing") : current,
      );
    };
    const onEnded = (): void => {
      setStatus("ended");
      setState((previous) => ({
        ...previous,
        isPlaying: false,
        currentTime: audio.duration || 0,
      }));
      callbackRef.current.onEnd?.();
    };
    const onError = (): void => {
      const mediaError = audio.error;
      publishError(
        playbackError(
          mediaError?.message || "The audio source could not be loaded or played.",
          mediaError,
        ),
      );
    };
    const onDurationChange = (): void => {
      if (Number.isFinite(audio.duration)) {
        setState((previous) => ({ ...previous, duration: audio.duration }));
      }
    };

    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    audio.src = audioPath;
    audio.load();

    return () => {
      stopAnimation();
      audio.pause();
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      audio.removeAttribute("src");
      audio.load();
      if (audioRef.current === audio) audioRef.current = null;
    };
  }, [
    audioPath,
    autoPlay,
    initialVolume,
    playbackRate,
    publishError,
    reloadVersion,
    stopAnimation,
  ]);

  useEffect(() => {
    if (!state.isPlaying) {
      stopAnimation();
      return;
    }

    const updateTime = (): void => {
      const audio = audioRef.current;
      if (!audio) return;
      const loopState = loopRef.current;
      if (
        loopState.enabled &&
        loopState.end !== undefined &&
        audio.currentTime >= loopState.end
      ) {
        audio.currentTime = loopState.start ?? 0;
      }
      const time = audio.currentTime;
      setState((previous) => ({ ...previous, currentTime: time }));
      callbackRef.current.onTimeUpdate?.(time);
      animationRef.current = requestAnimationFrame(updateTime);
    };

    animationRef.current = requestAnimationFrame(updateTime);
    return stopAnimation;
  }, [state.isPlaying, stopAnimation]);

  const play = useCallback(async (): Promise<void> => {
    const audio = audioRef.current;
    if (!audio) {
      publishError(playbackError("No audio source is loaded."));
      return;
    }
    setError(null);
    try {
      await audio.play();
    } catch (cause: unknown) {
      publishError(playbackError("Audio playback could not start.", cause));
    }
  }, [publishError]);

  const pause = useCallback((): void => {
    audioRef.current?.pause();
  }, []);

  const toggle = useCallback(async (): Promise<void> => {
    if (audioRef.current?.paused ?? true) await play();
    else pause();
  }, [pause, play]);

  const seek = useCallback((time: number): void => {
    const audio = audioRef.current;
    if (!audio) return;
    const duration = Number.isFinite(audio.duration) ? audio.duration : state.duration;
    const nextTime = clamp(time, 0, Math.max(0, duration));
    audio.currentTime = nextTime;
    setState((previous) => ({ ...previous, currentTime: nextTime }));
    callbackRef.current.onTimeUpdate?.(nextTime);
  }, [state.duration]);

  const setLoop = useCallback((start: number, end: number): void => {
    const duration = audioRef.current?.duration ?? state.duration;
    const boundedStart = clamp(start, 0, Math.max(0, duration));
    const boundedEnd = clamp(end, boundedStart, Math.max(boundedStart, duration));
    loopRef.current = {
      enabled: true,
      start: boundedStart,
      end: boundedEnd,
    };
    setState((previous) => ({
      ...previous,
      isLooping: true,
      loopStart: boundedStart,
      loopEnd: boundedEnd,
    }));
  }, [state.duration]);

  const clearLoop = useCallback((): void => {
    loopRef.current = { enabled: false };
    setState((previous) => {
      const { loopStart: _loopStart, loopEnd: _loopEnd, ...remaining } = previous;
      return { ...remaining, isLooping: false };
    });
  }, []);

  const setVolume = useCallback((volume: number): void => {
    if (audioRef.current) audioRef.current.volume = clamp(volume, 0, 1);
  }, []);

  const setPlaybackRate = useCallback((rate: number): void => {
    if (audioRef.current) audioRef.current.playbackRate = clamp(rate, 0.25, 4);
  }, []);

  const reload = useCallback((): void => {
    setReloadVersion((version) => version + 1);
  }, []);

  return {
    state,
    status,
    error,
    isReady: ["ready", "playing", "paused", "buffering", "ended"].includes(
      status,
    ),
    play,
    pause,
    toggle,
    seek,
    setLoop,
    clearLoop,
    setVolume,
    setPlaybackRate,
    reload,
  };
}
