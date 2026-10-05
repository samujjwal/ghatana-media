/**
 * @ghatana/ai-voice-ui-react
 *
 * Accessible components and hooks for governed AI Voice production workflows.
 *
 * @packageDocumentation
 */

export type {
  StemType,
  Stem,
  StemSet,
  PhraseLabel,
  Phrase,
  Take,
  VoiceModel,
  TrainingSample,
  TrainingStatus,
  TrainingSession,
  SeparationStatus,
  SeparationProgress,
  VoiceConversionOptions,
  ConversionResult,
  PlaybackState,
  MixerState,
  StemMixSettings,
  EQSettings,
  CompressionSettings,
  EffectType,
  Effect,
  Project,
  ModelDownloadInfo,
} from "./types";

export {
  PhraseTimeline,
  StemTrack,
  TrainingProgress,
  VoiceProductionWorkflow,
  Waveform,
} from "./components";
export type {
  PhraseTimelineProps,
  StemTrackProps,
  TrainingProgressProps,
  VoiceCapabilityState,
  VoiceConsentState,
  VoiceModelSummary,
  VoiceProductionWorkflowProps,
  VoiceSourceSummary,
  WaveformProps,
} from "./components";

export { useAudioPlayer, useStemMixer } from "./hooks";
export type {
  AudioPlaybackStatus,
  UseAudioPlayerOptions,
  UseAudioPlayerResult,
  UseStemMixerOptions,
  UseStemMixerResult,
} from "./hooks";
