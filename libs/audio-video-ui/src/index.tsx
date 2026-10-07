/**
 * @audio-video/ui
 *
 * Media-specific React hooks and composition over the canonical Ghatana design
 * system. Generic primitives remain owned by @ghatana/design-system.
 *
 * @doc.type component
 * @doc.purpose Shared media UI composition and browser/platform speech hooks
 * @doc.layer shared
 * @doc.pattern ComponentLibrary
 */

export * from "./foundations";

export * from "@ghatana/tokens";

import type React from "react";

/**
 * Base props retained for audio-video-specific presentation components.
 */
export interface BaseComponentProps {
  readonly className?: string;
  readonly children?: React.ReactNode;
  readonly testId?: string;
}

export * from "./components";
export * from "./screens";
export * from "./ports";

export {
  getAudioVideoPlatformMetrics,
  normalizeAudioVideoRuntimeConfig,
  useSpeechRecognition,
  useSpeechSynthesis,
} from "./hooks";
export type {
  AudioVideoPlatformError,
  AudioVideoProvider,
  AudioVideoRuntimeConfig,
  AudioVideoRuntimeMetricsSnapshot,
  AudioVideoSpeechHookConfig,
  SpeechRecognitionCallbacks,
  SpeechRecognitionOptions,
  SpeechRecognitionState,
  SpeechSynthesisOptions,
  SpeechSynthesisState,
  UseSpeechRecognitionResult,
  UseSpeechSynthesisResult,
} from "./hooks";
