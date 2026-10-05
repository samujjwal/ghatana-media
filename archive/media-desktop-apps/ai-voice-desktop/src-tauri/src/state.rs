//! Application state management.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::models::{AudioSession, DownloadTask, SeparationTask, TrainingSession, VoiceModel};
use crate::playback::PlaybackHandle;
use crate::recorder::RecordingHandle;

/// Application state.
pub struct AppState {
    /// Data directory for AI Voice
    pub data_dir: PathBuf,

    /// Models directory
    pub models_dir: PathBuf,

    /// Projects directory
    pub projects_dir: PathBuf,

    /// Temp directory
    pub temp_dir: PathBuf,

    /// Loaded voice models
    pub voice_models: Arc<RwLock<HashMap<String, VoiceModel>>>,

    /// Active training sessions
    pub training_sessions: Arc<RwLock<HashMap<String, TrainingSession>>>,

    /// Active separation tasks
    pub separation_tasks: Arc<RwLock<HashMap<String, SeparationTask>>>,

    /// Active download tasks
    pub download_tasks: Arc<RwLock<HashMap<String, DownloadTask>>>,

    /// Managed local audio sessions
    pub audio_sessions: Arc<RwLock<HashMap<String, AudioSession>>>,

    /// Currently playing audio path
    pub playing_audio: Arc<RwLock<Option<String>>>,

    /// Active audio playback handle (while playing)
    pub playback_handle: Arc<RwLock<Option<PlaybackHandle>>>,

    /// Recording state
    pub is_recording: Arc<RwLock<bool>>,

    /// Current recording path
    pub recording_path: Arc<RwLock<Option<PathBuf>>>,

    /// Active microphone recording handle (while recording)
    pub recording_handle: Arc<RwLock<Option<RecordingHandle>>>,
}

impl AppState {
    /// Create new application state.
    pub fn new() -> Self {
        let data_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("ghatana")
            .join("speech")
            .join("ai-voice");

        let models_dir = data_dir.join("models");
        let projects_dir = data_dir.join("projects");
        let temp_dir = data_dir.join("temp");

        // Create directories
        std::fs::create_dir_all(&models_dir).ok();
        std::fs::create_dir_all(&projects_dir).ok();
        std::fs::create_dir_all(&temp_dir).ok();

        tracing::info!("AI Voice data directory: {:?}", data_dir);

        Self {
            data_dir,
            models_dir,
            projects_dir,
            temp_dir,
            voice_models: Arc::new(RwLock::new(HashMap::new())),
            training_sessions: Arc::new(RwLock::new(HashMap::new())),
            separation_tasks: Arc::new(RwLock::new(HashMap::new())),
            download_tasks: Arc::new(RwLock::new(HashMap::new())),
            audio_sessions: Arc::new(RwLock::new(HashMap::new())),
            playing_audio: Arc::new(RwLock::new(None)),
            playback_handle: Arc::new(RwLock::new(None)),
            is_recording: Arc::new(RwLock::new(false)),
            recording_path: Arc::new(RwLock::new(None)),
            recording_handle: Arc::new(RwLock::new(None)),
        }
    }

    /// Get the path for a voice model.
    pub fn model_path(&self, model_id: &str) -> PathBuf {
        self.models_dir.join(format!("{}.pth", model_id))
    }

    /// Get the path for a project.
    pub fn project_path(&self, project_id: &str) -> PathBuf {
        self.projects_dir.join(project_id)
    }

    /// Get a temp file path.
    pub fn temp_path(&self, filename: &str) -> PathBuf {
        self.temp_dir.join(filename)
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
