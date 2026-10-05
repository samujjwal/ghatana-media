//! Data models for the AI Voice application.

use serde::{Deserialize, Serialize};

/// Voice model information.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceModel {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: String,
    pub training_samples: u32,
    pub quality: Option<f32>,
    pub is_default: bool,
}

/// Training session state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingSession {
    pub id: String,
    pub model_name: String,
    pub sample_count: u32,
    pub status: TrainingStatus,
    pub progress: f32,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub error: Option<String>,
}

/// Training status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrainingStatus {
    Pending,
    Preprocessing,
    Extracting,
    Training,
    Completed,
    Failed,
}

/// Separation task state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeparationTask {
    pub id: String,
    pub input_path: String,
    pub output_dir: String,
    pub status: SeparationStatus,
    pub progress: f32,
    pub error: Option<String>,
}

/// Separation status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SeparationStatus {
    Pending,
    Loading,
    Separating,
    Completed,
    Failed,
}

/// Download task state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTask {
    pub id: String,
    pub model_id: String,
    pub url: String,
    pub progress: f32,
    pub status: DownloadStatus,
    pub error: Option<String>,
}

/// Download status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadStatus {
    Pending,
    Downloading,
    Extracting,
    Completed,
    Failed,
}

/// Audio file metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMetadata {
    pub path: String,
    pub name: String,
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub format: String,
}

/// Stem separation result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StemResult {
    pub path: String,
    pub duration: f64,
}

/// Stems output.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StemsOutput {
    pub vocals: StemResult,
    pub drums: StemResult,
    pub bass: StemResult,
    pub other: StemResult,
    pub used_fallback: bool,
    pub warning: Option<String>,
}

/// Detected phrase.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedPhrase {
    pub start_time: f64,
    pub end_time: f64,
    pub pitch_contour: Vec<f32>,
}

/// Conversion result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionResult {
    pub path: String,
    pub duration: f64,
}

/// Available model for download.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableModel {
    pub id: String,
    pub name: String,
    pub description: String,
    pub size: u64,
    pub url: String,
    #[serde(rename = "type")]
    pub model_type: String,
    pub is_available: bool,
    pub availability_reason: Option<String>,
    pub is_downloaded: bool,
    pub download_progress: Option<f32>,
}

/// Recording result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingResult {
    pub path: String,
    pub duration: f64,
}

/// Audio session mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioSessionMode {
    Edit,
    Record,
    Playback,
    Streaming,
}

/// Audio session lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioSessionState {
    Active,
    Closed,
}

/// Managed audio session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSession {
    pub id: String,
    pub source_path: String,
    pub project_id: Option<String>,
    pub mode: AudioSessionMode,
    pub state: AudioSessionState,
    pub duration_seconds: f64,
    pub created_at: String,
    pub closed_at: Option<String>,
}

/// Audio stream chunk metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamChunk {
    pub index: u32,
    pub start_ms: u64,
    pub end_ms: u64,
    pub sample_count: usize,
    pub peak_level: f32,
}

/// Planned stream segmentation for an audio file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamPlan {
    pub path: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub chunk_ms: u32,
    pub total_chunks: usize,
    pub chunks: Vec<AudioStreamChunk>,
}

/// Product-side sync quality rating.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AvSyncQuality {
    Excellent,
    Good,
    Fair,
    Poor,
}

/// Sync assessment result for local playback workflows.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvSyncAssessment {
    pub audio_duration_seconds: f64,
    pub video_duration_seconds: f64,
    pub drift_ms: i64,
    pub tolerance_ms: i64,
    pub within_tolerance: bool,
    pub quality: AvSyncQuality,
    pub recommendation: String,
}

/// Builtin effects configuration for product-side fallback processing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinEffectsConfig {
    pub gain_db: Option<f32>,
    pub normalize: bool,
    pub fade_in_ms: Option<u32>,
    pub fade_out_ms: Option<u32>,
    pub echo_delay_ms: Option<u32>,
    pub echo_decay: Option<f32>,
}

/// Result of builtin effects processing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinEffectsResult {
    pub output_path: String,
    pub duration_seconds: f64,
    pub peak_level: f32,
}

/// Training status response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingStatusResponse {
    pub status: TrainingStatus,
    pub progress: f32,
    pub error: Option<String>,
}

// ============================================================================
// Voice Cloning Models
// ============================================================================

/// Voice cloning result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCloningResult {
    pub success: bool,
    pub voice_id: String,
    pub model_path: String,
    pub embedding_path: String,
    pub similarity_score: f32,
    pub training_time_seconds: f32,
    pub message: String,
    pub error: Option<String>,
}

/// Cloned voice information.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClonedVoiceInfo {
    pub voice_id: String,
    pub voice_name: String,
    pub similarity_score: f32,
    pub embedding_dim: u32,
    pub model_path: String,
    pub created_at: f64,
}

/// Text-to-speech synthesis result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisResult {
    pub output_path: String,
    pub duration_seconds: f32,
    pub sample_rate: u32,
    pub text_processed: String,
}

/// Speaker embedding result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerEmbeddingResult {
    pub embedding: Vec<f32>,
    pub confidence: f32,
    pub duration_seconds: f32,
    pub sample_rate: u32,
}

/// Voice cloning progress.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCloningProgress {
    pub current_epoch: u32,
    pub total_epochs: u32,
    pub loss: f32,
    pub stage: String,
    pub progress_percent: f32,
    pub estimated_time_remaining: f32,
}

