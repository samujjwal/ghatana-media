/**
 * AI Voice Production Studio - Core Types
 * 
 * @doc.type module
 * @doc.purpose Core type definitions
 * @doc.layer product
 * @doc.pattern ValueObject
 */

/** Application views */
export type View =
  | 'studio'
  | 'projects'
  | 'library'
  | 'settings';

export type RuntimeMode = 'production' | 'degraded' | 'demo';

export interface RuntimeModeState {
  mode: RuntimeMode;
  reason: string;
  exportAllowed: boolean;
}

/** Project state */
export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  audioFile?: AudioFile;
  stems?: StemSet;
  phrases?: Phrase[];
  voiceModel?: VoiceModel;
}

/** Audio file metadata */
export interface AudioFile {
  id: string;
  path: string;
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
  format: string;
  waveformData?: number[];
}

/** Separated stems */
export interface StemSet {
  id: string;
  vocals: Stem;
  drums: Stem;
  bass: Stem;
  other: Stem;
  separationProgress?: number;
}

/** Individual stem */
export interface Stem {
  id: string;
  name: string;
  path: string;
  duration: number;
  volume: number;
  muted: boolean;
  solo: boolean;
  waveformData?: number[];
}

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

/** Phrase labels */
export type PhraseLabel = 'verse' | 'chorus' | 'bridge' | 'intro' | 'outro' | 'other';

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
  quality?: number;
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

/** Training status */
export type TrainingStatus = 'pending' | 'preprocessing' | 'extracting' | 'training' | 'completed' | 'failed';

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

/** Audio effect */
export interface Effect {
  id: string;
  type: EffectType;
  enabled: boolean;
  params: Record<string, number>;
}

/** Effect types */
export type EffectType = 'reverb' | 'delay' | 'chorus' | 'distortion' | 'eq' | 'compressor';

/** Playback state */
export interface PlaybackState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  loopStart?: number;
  loopEnd?: number;
  isLooping: boolean;
}

/** Separation progress */
export interface SeparationProgress {
  status: 'idle' | 'loading' | 'separating' | 'completed' | 'error';
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

/** Model download info */
export interface ModelDownloadInfo {
  id: string;
  name: string;
  description: string;
  size: number;
  url: string;
  type: 'demucs' | 'rvc' | 'crepe';
  isAvailable: boolean;
  availabilityReason?: string;
  isDownloaded: boolean;
  downloadProgress?: number;
}
