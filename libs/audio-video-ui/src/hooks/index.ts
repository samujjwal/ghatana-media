/**
 * @audio-video/ui — media-specific hooks.
 */
export { useSpeechSynthesis } from "./useSpeechSynthesis";
export type {
  UseSpeechSynthesisResult,
  SpeechSynthesisOptions,
  SpeechSynthesisState,
} from "./useSpeechSynthesis";

export {
  getAudioVideoPlatformMetrics,
  normalizeAudioVideoRuntimeConfig,
} from "./audioVideoPlatform";
export type {
  AudioVideoPlatformError,
  AudioVideoProvider,
  AudioVideoRuntimeConfig,
  AudioVideoRuntimeMetricsSnapshot,
  AudioVideoSpeechHookConfig,
} from "./audioVideoPlatform";

export { useSpeechRecognition } from "./useSpeechRecognition";
export type {
  UseSpeechRecognitionResult,
  SpeechRecognitionOptions,
  SpeechRecognitionCallbacks,
  SpeechRecognitionState,
} from "./useSpeechRecognition";

export { useMemoryPressure } from "./useMemoryPressure";
export type {
  UseMemoryPressureResult,
  UseMemoryPressureOptions,
  MemoryPressureLevel,
  MemoryInfo,
} from "./useMemoryPressure";
