/**
 * @ghatana/ai-voice-ui-react - Types
 * 
 * AI Voice Production Studio type definitions.
 * Declares AI Voice UI types.
 * 
 * @doc.type module
 * @doc.purpose AI Voice UI types
 * @doc.layer product
 * @doc.pattern ValueObject
 */

/** Stem types */
export type StemType = 'vocals' | 'drums' | 'bass' | 'other';

/** Stem data */
export interface Stem {
  id: string;
  type: StemType;
  name: string;
  path: string;
  duration: number;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  waveformData?: number[];
}

/** Stem set from separation */
export interface StemSet {
  id: string;
  vocals: Stem;
  drums: Stem;
  bass: Stem;
  other: Stem;
}

/** Phrase label types */
export type PhraseLabel = 'verse' | 'chorus' | 'bridge' | 'intro' | 'outro' | 'other';

/** Detected phrase */
export interface Phrase {
  id: string;
  startTime: number;
  endTime: number;
  text?: string;
  pitchContour?: number[];
  label?: PhraseLabel;
  takes?: Take[];
  selectedTakeId?: string;
}

/** Recording take */
export interface Take {
  id: string;
  phraseId: string;
  path: string;
  duration: number;
  recordedAt: string;
  rating?: number;
  waveformData?: number[];
}

/** Voice model */
export interface VoiceModel {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  trainingSamples: number;
  quality: number;
  isDefault: boolean;
}

/** Training sample */
export interface TrainingSample {
  id: string;
  path: string;
  duration: number;
  text?: string;
  quality: number;
}

/** Training status */
export type TrainingStatus = 'pending' | 'preprocessing' | 'extracting' | 'training' | 'completed' | 'failed';

/** Training session */
export interface TrainingSession {
  id: string;
  modelName: string;
  samples: TrainingSample[];
  status: TrainingStatus;
  progress: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

/** Separation status */
export type SeparationStatus = 'idle' | 'loading' | 'separating' | 'completed' | 'error';

/** Separation progress */
export interface SeparationProgress {
  status: SeparationStatus;
  progress: number;
  currentStep?: string;
  error?: string;
}

/** Voice conversion options */
export interface VoiceConversionOptions {
  voiceModelId: string;
  pitchShift: number;
  formantShift: number;
  indexRatio: number;
  filterRadius: number;
  resampleRate: number;
  rmsMixRate: number;
  protectVoiceless: number;
}

/** Conversion result */
export interface ConversionResult {
  success: boolean;
  outputPath?: string;
  duration?: number;
  error?: string;
}

/** Playback state */
export interface PlaybackState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  loopStart?: number;
  loopEnd?: number;
  isLooping: boolean;
}

/** Mixer state */
export interface MixerState {
  masterVolume: number;
  stems: Record<string, StemMixSettings>;
  effects: Effect[];
}

/** Stem mix settings */
export interface StemMixSettings {
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  eq?: EQSettings;
  compression?: CompressionSettings;
}

/** EQ settings */
export interface EQSettings {
  lowGain: number;
  midGain: number;
  highGain: number;
  lowFreq: number;
  highFreq: number;
}

/** Compression settings */
export interface CompressionSettings {
  threshold: number;
  ratio: number;
  attack: number;
  release: number;
  makeupGain: number;
}

/** Effect types */
export type EffectType = 'reverb' | 'delay' | 'chorus' | 'distortion' | 'eq' | 'compressor';

/** Audio effect */
export interface Effect {
  id: string;
  type: EffectType;
  enabled: boolean;
  params: Record<string, number>;
}

/** Project state */
export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  audioFilePath?: string;
  stems?: StemSet;
  phrases?: Phrase[];
  voiceModel?: VoiceModel;
}

/** Model download info */
export interface ModelDownloadInfo {
  id: string;
  name: string;
  description: string;
  size: number;
  url: string;
  type: 'demucs' | 'rvc' | 'crepe';
  isDownloaded: boolean;
  downloadProgress?: number;
}
