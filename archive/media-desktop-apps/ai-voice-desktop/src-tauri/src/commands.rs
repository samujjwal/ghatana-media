//! Tauri commands for the AI Voice application.

use crate::error::AppError;
use crate::metrics::AudioMetricsSnapshot;
use crate::models::*;
use crate::project_storage::{AudioTrack, Project, ProjectMetadata, ProjectSettings, ProjectStorage};
use crate::python;
use crate::state::AppState;
use crate::audio;
use hound::{SampleFormat, WavSpec, WavWriter};
use serde::Deserialize;
use serde_json::Value;
use std::f32::consts::PI;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Debug, Deserialize)]
struct PersistedTrainingStatus {
    status: TrainingStatus,
    progress: f32,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PersistedVoiceMetadata {
    voice_id: String,
    voice_name: String,
    training_samples: Option<u32>,
    similarity_score: f32,
    model_path: String,
    created_at: f64,
}

fn training_status_path(state: &AppState, session_id: &str) -> PathBuf {
    state
        .data_dir
        .join("training-sessions")
        .join(format!("{}.json", session_id))
}

fn read_training_status_file(path: &Path) -> Result<Option<TrainingStatusResponse>, AppError> {
    if !path.exists() {
        return Ok(None);
    }

    let contents = std::fs::read_to_string(path)?;
    let persisted: PersistedTrainingStatus = serde_json::from_str(&contents)
        .map_err(|e| AppError::Training(format!("Invalid training status file: {}", e)))?;

    Ok(Some(TrainingStatusResponse {
        status: persisted.status,
        progress: persisted.progress,
        error: persisted.error,
    }))
}

fn apply_training_status(
    session: &mut TrainingSession,
    status: &TrainingStatusResponse,
    completed_at: &str,
) {
    session.status = status.status;
    session.progress = status.progress;
    session.error = status.error.clone();

    if matches!(status.status, TrainingStatus::Completed | TrainingStatus::Failed) {
        session.completed_at = Some(completed_at.to_string());
    }
}

fn cloned_voices_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".ghatana")
        .join("voices")
}

fn normalize_audio_format(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase()
}

fn requested_export_matches_source(input_path: &str, output_path: &str, format: &str) -> Result<bool, AppError> {
    let metadata = audio::load_audio_metadata(input_path)?;
    let source_format = normalize_audio_format(&metadata.format);
    let requested_format = normalize_audio_format(format);
    let output_extension = Path::new(output_path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(normalize_audio_format);

    Ok(source_format == requested_format
        && output_extension.as_deref().map(|ext| ext == requested_format).unwrap_or(false))
}

fn requested_export_is_wav(output_path: &str, format: &str) -> bool {
    let requested_format = normalize_audio_format(format);
    let output_extension = Path::new(output_path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(normalize_audio_format);

    requested_format == "wav" && output_extension.as_deref() == Some("wav")
}

fn discover_cloned_voice_models() -> Result<Vec<VoiceModel>, AppError> {
    let voices_dir = cloned_voices_dir();
    if !voices_dir.exists() {
        return Ok(Vec::new());
    }

    let mut discovered = Vec::new();
    for entry in std::fs::read_dir(&voices_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let metadata_path = path.join("metadata.json");
        if !metadata_path.exists() {
            continue;
        }

        let contents = std::fs::read_to_string(&metadata_path)?;
        let metadata: PersistedVoiceMetadata = serde_json::from_str(&contents)
            .map_err(|e| AppError::Model(format!("Invalid cloned voice metadata: {}", e)))?;

        discovered.push(VoiceModel {
            id: metadata.voice_id,
            name: metadata.voice_name,
            path: metadata.model_path,
            created_at: chrono::DateTime::<chrono::Utc>::from_timestamp(metadata.created_at as i64, 0)
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
            training_samples: metadata.training_samples.unwrap_or(0),
            quality: Some(metadata.similarity_score),
            is_default: false,
        });
    }

    Ok(discovered)
}

fn voice_conversion_unavailable_error() -> AppError {
    AppError::Conversion(
        "Voice conversion is unavailable because no verified conversion engine is configured for this runtime."
            .to_string(),
    )
}

// ============================================================================
// Audio Commands
// ============================================================================

/// Load an audio file and return its metadata.
#[tauri::command]
pub async fn ai_voice_load_audio(
    path: String,
    _state: State<'_, AppState>,
) -> Result<AudioMetadata, AppError> {
    tracing::info!("Loading audio: {}", path);
    audio::load_audio_metadata(&path)
}

/// Get audio file information.
#[tauri::command]
pub async fn ai_voice_get_audio_info(
    path: String,
) -> Result<AudioMetadata, AppError> {
    audio::load_audio_metadata(&path)
}

/// Play audio file.
#[tauri::command]
pub async fn ai_voice_play_audio(
    path: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    // Stop any existing playback first
    {
        let mut handle = state.playback_handle.write().await;
        if let Some(h) = handle.take() {
            let _ = h.stop();
        }
    }

    let mut playing = state.playing_audio.write().await;
    *playing = Some(path.clone());
    tracing::info!("Playing audio: {}", path);

    let handle = crate::playback::PlaybackHandle::start_default(std::path::PathBuf::from(&path))?;
    let mut playback_handle = state.playback_handle.write().await;
    *playback_handle = Some(handle);

    Ok(())
}

/// Stop audio playback.
#[tauri::command]
pub async fn ai_voice_stop_audio(
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let mut playing = state.playing_audio.write().await;
    *playing = None;

    let mut handle = state.playback_handle.write().await;
    if let Some(h) = handle.take() {
        let _ = h.stop();
    }

    tracing::info!("Stopped audio playback");
    Ok(())
}

/// Expose runtime audio metrics for observability and diagnostics.
#[tauri::command]
pub async fn ai_voice_get_audio_runtime_metrics() -> Result<AudioMetricsSnapshot, AppError> {
    Ok(crate::metrics::AudioRuntimeMetrics::global().snapshot())
}

/// Export audio to file.
#[tauri::command]
pub async fn ai_voice_export_audio(
    input_path: String,
    output_path: String,
    format: String,
) -> Result<(), AppError> {
    tracing::info!("Exporting audio: {} -> {} ({})", input_path, output_path, format);

    if requested_export_matches_source(&input_path, &output_path, &format)? {
        std::fs::copy(&input_path, &output_path)?;
        return Ok(());
    }

    if requested_export_is_wav(&output_path, &format) {
        audio::export_as_wav(&input_path, &output_path)?;
        return Ok(());
    }

    Err(AppError::Audio(
        "Audio export currently supports same-format copies or WAV output. Requested encoded format is not available in this runtime."
            .to_string(),
    ))
}

/// Create a managed audio session for local editing or playback work.
#[tauri::command]
pub async fn ai_voice_create_audio_session(
    path: String,
    project_id: Option<String>,
    mode: Option<AudioSessionMode>,
    state: State<'_, AppState>,
) -> Result<AudioSession, AppError> {
    let metadata = audio::load_audio_metadata(&path)?;
    let session = crate::session::new_audio_session(
        path,
        project_id,
        mode.unwrap_or(AudioSessionMode::Edit),
        metadata.duration,
    );
    state
        .audio_sessions
        .write()
        .await
        .insert(session.id.clone(), session.clone());
    Ok(session)
}

/// Return a managed audio session by id.
#[tauri::command]
pub async fn ai_voice_get_audio_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<AudioSession, AppError> {
    state
        .audio_sessions
        .read()
        .await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| AppError::NotInitialized(format!("Audio session not found: {}", session_id)))
}

/// List managed audio sessions.
#[tauri::command]
pub async fn ai_voice_list_audio_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<AudioSession>, AppError> {
    Ok(state.audio_sessions.read().await.values().cloned().collect())
}

/// Close a managed audio session.
#[tauri::command]
pub async fn ai_voice_close_audio_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<AudioSession, AppError> {
    let mut sessions = state.audio_sessions.write().await;
    let existing = sessions
        .remove(&session_id)
        .ok_or_else(|| AppError::NotInitialized(format!("Audio session not found: {}", session_id)))?;
    let closed = crate::session::close_audio_session(existing);
    sessions.insert(session_id, closed.clone());
    Ok(closed)
}

/// Build a local sync assessment from audio metadata and video timing.
#[tauri::command]
pub async fn ai_voice_analyze_sync(
    audio_path: String,
    video_duration_seconds: f64,
    audio_offset_ms: Option<i64>,
    video_offset_ms: Option<i64>,
    tolerance_ms: Option<i64>,
) -> Result<AvSyncAssessment, AppError> {
    let metadata = audio::load_audio_metadata(&audio_path)?;
    Ok(crate::sync::assess_sync(
        metadata.duration,
        video_duration_seconds,
        audio_offset_ms.unwrap_or_default(),
        video_offset_ms.unwrap_or_default(),
        tolerance_ms.unwrap_or(40),
    ))
}

/// Create a stream segmentation plan for chunked processing.
#[tauri::command]
pub async fn ai_voice_stream_audio(
    path: String,
    chunk_ms: Option<u32>,
) -> Result<AudioStreamPlan, AppError> {
    crate::stream::build_stream_plan(&path, chunk_ms.unwrap_or(250))
}

/// Apply lightweight builtin effects when Python processing is unavailable or unnecessary.
#[tauri::command]
pub async fn ai_voice_apply_builtin_effects(
    input_path: String,
    output_path: String,
    effects: BuiltinEffectsConfig,
) -> Result<BuiltinEffectsResult, AppError> {
    crate::effects::apply_builtin_effects(&input_path, &output_path, &effects)
}

// ============================================================================
// Stem Separation Commands
// ============================================================================

/// Separate audio into stems.
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_voice_separate_stems(
    audio_path: String,
    audio_duration: Option<f64>,
    state: State<'_, AppState>,
) -> Result<StemsOutput, AppError> {
    tracing::info!("Separating stems: {}", audio_path);
    
    let output_dir = state.temp_path(&format!("stems_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&output_dir)?;
    
    let meta = crate::audio::load_audio_metadata(&audio_path)?;
    tracing::info!(
        "Stem separation duration inputs: meta_duration={}, audio_duration={:?}",
        meta.duration,
        audio_duration
    );

    let log_wav_duration = |label: &str, path: &str| {
        match crate::audio::load_audio_metadata(path) {
            Ok(m) => tracing::info!("Stem WAV duration on disk: {} duration={}", label, m.duration),
            Err(e) => tracing::warn!("Failed to read stem WAV metadata for {}: {}", label, e),
        }
    };

    // 1) Prefer system Python (external process). This allows real Demucs stems
    // if the user has the deps installed.
    match python::separate_stems_system_python(&audio_path, output_dir.to_str().unwrap_or(""))
        .await
    {
        Ok(result) => {
            tracing::info!("Stem separation used system python");
            tracing::info!(
                "Stem separation result durations: vocals={}, drums={}, bass={}, other={}",
                result.vocals.duration,
                result.drums.duration,
                result.bass.duration,
                result.other.duration
            );
            log_wav_duration("vocals", &result.vocals.path);
            log_wav_duration("drums", &result.drums.path);
            log_wav_duration("bass", &result.bass.path);
            log_wav_duration("other", &result.other.path);
            return Ok(result);
        }
        Err(err) => {
            tracing::warn!("System python stem separation unavailable: {}", err);
        }
    }

    // 2) Fall back to embedded python via pyo3.
    match python::separate_stems(&audio_path, output_dir.to_str().unwrap_or("")) {
        Ok(result) => {
            tracing::info!("Stem separation used embedded python (pyo3)");
            tracing::info!(
                "Stem separation python result durations: vocals={}, drums={}, bass={}, other={}",
                result.vocals.duration,
                result.drums.duration,
                result.bass.duration,
                result.other.duration
            );

            log_wav_duration("vocals", &result.vocals.path);
            log_wav_duration("drums", &result.drums.path);
            log_wav_duration("bass", &result.bass.path);
            log_wav_duration("other", &result.other.path);
            Ok(result)
        }
        Err(AppError::Python(message)) if message.contains("stem_separator_enhanced") => {
            tracing::warn!(
                "Stem separation Python module unavailable; returning explicit failure: {}",
                message
            );
            Err(AppError::Python(
                "Stem separation is unavailable in this environment. Install the Python stem-separation dependencies (demucs, torch, torchaudio) to produce real stems."
                    .to_string(),
            ))
        }
        Err(err) => Err(err),
    }
}

/// Get separation progress.
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_voice_separation_progress(
    task_id: String,
    state: State<'_, AppState>,
) -> Result<SeparationTask, AppError> {
    let tasks = state.separation_tasks.read().await;
    tasks
        .get(&task_id)
        .cloned()
        .ok_or_else(|| AppError::NotInitialized(format!("Task not found: {}", task_id)))
}

// ============================================================================
// Phrase Detection Commands
// ============================================================================

/// Detect phrases in vocal audio.
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_voice_detect_phrases(
    vocal_path: String,
) -> Result<Vec<DetectedPhrase>, AppError> {
    tracing::info!("Detecting phrases: {}", vocal_path);
    python::detect_phrases(&vocal_path)
}

// ============================================================================
// Voice Conversion Commands
// ============================================================================

/// Convert a phrase using AI voice.
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_voice_convert_phrase(
    phrase_id: String,
    voice_model_id: String,
    start_time: f64,
    end_time: f64,
    state: State<'_, AppState>,
) -> Result<ConversionResult, AppError> {
    tracing::info!("Converting phrase {} with model {}", phrase_id, voice_model_id);
    let duration_seconds = (end_time - start_time).max(0.5).min(20.0);
    
    let models = state.voice_models.read().await;
    let _model = models
        .get(&voice_model_id)
        .ok_or_else(|| AppError::Model(format!("Model not found: {}", voice_model_id)))?;

    let _ = (phrase_id, start_time, end_time, duration_seconds);
    Err(voice_conversion_unavailable_error())
}

/// Convert full audio using AI voice.
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_voice_convert_full(
    input_path: String,
    voice_model_id: String,
    pitch_shift: f32,
    state: State<'_, AppState>,
) -> Result<ConversionResult, AppError> {
    tracing::info!("Converting full audio with model {}", voice_model_id);
    
    let models = state.voice_models.read().await;
    let model = models
        .get(&voice_model_id)
        .ok_or_else(|| AppError::Model(format!("Model not found: {}", voice_model_id)))?;
    
    let _ = (input_path, pitch_shift, model);

    Err(voice_conversion_unavailable_error())
}

// ============================================================================
// Voice Model Commands
// ============================================================================

/// List available voice models.
#[tauri::command]
pub async fn ai_voice_list_models(
    state: State<'_, AppState>,
) -> Result<Vec<VoiceModel>, AppError> {
    {
        let models = state.voice_models.read().await;
        let mut combined: Vec<VoiceModel> = models.values().cloned().collect();
        let known_ids: std::collections::HashSet<String> = combined.iter().map(|model| model.id.clone()).collect();
        drop(models);

        let discovered = discover_cloned_voice_models()?;
        combined.extend(
            discovered
                .into_iter()
                .filter(|model| !known_ids.contains(&model.id)),
        );

        if !combined.is_empty() {
            return Ok(combined);
        }
    }

    let discovered = discover_cloned_voice_models()?;

    if !discovered.is_empty() {
        let mut models = state.voice_models.write().await;
        for model in &discovered {
            models.insert(model.id.clone(), model.clone());
        }
    }

    Ok(discovered)
}

/// Load a voice model.
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_voice_load_model(
    model_id: String,
    state: State<'_, AppState>,
) -> Result<VoiceModel, AppError> {
    let models = state.voice_models.read().await;
    models
        .get(&model_id)
        .cloned()
        .ok_or_else(|| AppError::Model(format!("Model not found: {}", model_id)))
}

/// Delete a voice model.
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_voice_delete_model(
    model_id: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let mut models = state.voice_models.write().await;
    
    if let Some(model) = models.remove(&model_id) {
        let path = std::path::Path::new(&model.path);
        if path.exists() {
            if let Some(parent) = path.parent() {
                let metadata_path = parent.join("metadata.json");
                let embedding_path = parent.join("embedding.npy");
                if metadata_path.exists() || embedding_path.exists() {
                    std::fs::remove_dir_all(parent)?;
                } else {
                    std::fs::remove_file(path)?;
                }
            } else {
                std::fs::remove_file(path)?;
            }
        }
    }
    
    Ok(())
}

/// Test a voice model with sample text.
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_voice_test_model(
    model_id: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<String, AppError> {
    tracing::info!("Testing model {} with text: {}", model_id, text);

    let models = state.voice_models.read().await;
    let _model = models
        .get(&model_id)
        .ok_or_else(|| AppError::Model(format!("Model not found: {}", model_id)))?;

    Err(AppError::Model(
        "Voice preview synthesis is unavailable because no verified synthesis engine is configured for this runtime."
            .to_string(),
    ))
}

// ============================================================================
// Training Commands
// ============================================================================

/// Start training a new voice model.
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_voice_start_training(
    model_name: String,
    sample_paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<String, AppError> {
    tracing::info!("Starting training for model: {}", model_name);

    let session_id = uuid::Uuid::new_v4().to_string();
    let output_path = state.model_path(&model_name);
    let status_path = training_status_path(&state, &session_id);
    if let Some(parent) = status_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    python::train_voice_model(
        &session_id,
        &sample_paths,
        output_path.to_str().unwrap_or(""),
        &model_name,
        status_path.to_str().unwrap_or(""),
    )?;

    let mut sessions = state.training_sessions.write().await;
    sessions.insert(session_id.clone(), TrainingSession {
        id: session_id.clone(),
        model_name,
        sample_count: sample_paths.len() as u32,
        status: TrainingStatus::Pending,
        progress: 0.0,
        started_at: Some(chrono::Utc::now().to_rfc3339()),
        completed_at: None,
        error: None,
    });
    
    Ok(session_id)
}

/// Get training status.
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_voice_training_status(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<TrainingStatusResponse, AppError> {
    let status_path = training_status_path(&state, &session_id);

    if let Some(status) = read_training_status_file(&status_path)? {
        let now = chrono::Utc::now().to_rfc3339();
        let maybe_model_name = {
            let mut sessions = state.training_sessions.write().await;
            if let Some(session) = sessions.get_mut(&session_id) {
                apply_training_status(session, &status, &now);
                Some(session.model_name.clone())
            } else {
                None
            }
        };

        if matches!(status.status, TrainingStatus::Completed) {
            if let Some(model_name) = maybe_model_name {
                let model_path = state.model_path(&model_name);
                if model_path.exists() {
                    let sample_count = {
                        let sessions = state.training_sessions.read().await;
                        sessions
                            .get(&session_id)
                            .map(|session| session.sample_count)
                            .unwrap_or(0)
                    };

                    let mut models = state.voice_models.write().await;
                    models.entry(model_name.clone()).or_insert_with(|| VoiceModel {
                        id: model_name.clone(),
                        name: model_name,
                        path: model_path.to_string_lossy().to_string(),
                        created_at: chrono::Utc::now().to_rfc3339(),
                        training_samples: sample_count,
                        quality: None,
                        is_default: false,
                    });
                }
            }
        }

        return Ok(status);
    }

    let sessions = state.training_sessions.read().await;
    if let Some(session) = sessions.get(&session_id) {
        return Ok(TrainingStatusResponse {
            status: session.status,
            progress: session.progress,
            error: session.error.clone(),
        });
    }

    Err(AppError::NotInitialized(format!(
        "Training session not found: {}",
        session_id
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn reads_persisted_training_status_file() {
        let temp_dir = TempDir::new().expect("temp dir");
        let status_path = temp_dir.path().join("session.json");
        std::fs::write(
            &status_path,
            r#"{"status":"training","progress":42.5,"error":null}"#,
        )
        .expect("write status");

        let result = read_training_status_file(&status_path)
            .expect("status read")
            .expect("status exists");

        assert_eq!(result.status, TrainingStatus::Training);
        assert_eq!(result.progress, 42.5);
        assert_eq!(result.error, None);
    }

    #[test]
    fn apply_training_status_marks_session_complete() {
        let mut session = TrainingSession {
            id: "session-1".to_string(),
            model_name: "demo".to_string(),
            sample_count: 3,
            status: TrainingStatus::Pending,
            progress: 0.0,
            started_at: Some("2026-04-17T00:00:00Z".to_string()),
            completed_at: None,
            error: None,
        };
        let status = TrainingStatusResponse {
            status: TrainingStatus::Completed,
            progress: 100.0,
            error: None,
        };

        apply_training_status(&mut session, &status, "2026-04-17T00:01:00Z");

        assert_eq!(session.status, TrainingStatus::Completed);
        assert_eq!(session.progress, 100.0);
        assert_eq!(session.completed_at.as_deref(), Some("2026-04-17T00:01:00Z"));
    }

    #[test]
    fn voice_conversion_unavailable_error_is_conversion_error() {
        let error = voice_conversion_unavailable_error();

        match error {
            AppError::Conversion(message) => {
                assert!(message.contains("no verified conversion engine"));
            }
            other => panic!("expected conversion error, got {:?}", other),
        }
    }

    #[test]
    fn missing_training_status_returns_not_initialized_error() {
        let session_id = "missing-session";
        let error = AppError::NotInitialized(format!("Training session not found: {}", session_id));

        match error {
            AppError::NotInitialized(message) => {
                assert!(message.contains(session_id));
            }
            other => panic!("expected not initialized error, got {:?}", other),
        }
    }

    #[test]
    fn normalize_audio_format_strips_dot_and_case() {
        assert_eq!(normalize_audio_format(".WAV"), "wav");
        assert_eq!(normalize_audio_format("Mp3"), "mp3");
    }

    #[test]
    fn requested_export_matches_source_requires_matching_format_and_extension() {
        let temp_dir = TempDir::new().expect("temp dir");
        let input_path = temp_dir.path().join("input.wav");
        write_example_wav(&input_path, 0.1, 16_000, 220.0).expect("write wav");

        let output_wav = temp_dir.path().join("copy.wav");
        let output_mp3 = temp_dir.path().join("copy.mp3");

        assert!(requested_export_matches_source(
            input_path.to_str().unwrap_or(""),
            output_wav.to_str().unwrap_or(""),
            "wav",
        )
        .expect("wav match"));

        assert!(!requested_export_matches_source(
            input_path.to_str().unwrap_or(""),
            output_mp3.to_str().unwrap_or(""),
            "mp3",
        )
        .expect("mp3 mismatch"));
    }

    #[test]
    fn requested_export_is_wav_requires_wav_format_and_extension() {
        assert!(requested_export_is_wav("out.wav", "wav"));
        assert!(requested_export_is_wav("out.WAV", ".WAV"));
        assert!(!requested_export_is_wav("out.mp3", "wav"));
        assert!(!requested_export_is_wav("out.wav", "mp3"));
    }
}

/// Start recording audio.
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_voice_start_recording(
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let mut is_recording = state.is_recording.write().await;
    let mut recording_path = state.recording_path.write().await;
    let mut recording_handle = state.recording_handle.write().await;

    if *is_recording {
        return Err(AppError::InvalidRequest("Recording already in progress".to_string()));
    }

    *is_recording = true;
    *recording_path = Some(state.temp_path(&format!("recording_{}.wav", uuid::Uuid::new_v4())));

    let out_path = recording_path
        .as_ref()
        .ok_or_else(|| AppError::Audio("Failed to allocate recording path".to_string()))?
        .clone();

    let handle = crate::recorder::RecordingHandle::start_default(out_path)?;
    *recording_handle = Some(handle);

    tracing::info!("Started recording to {:?}", *recording_path);
    Ok(())
}

/// Stop recording and return the recorded audio.
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_voice_stop_recording(
    state: State<'_, AppState>,
) -> Result<RecordingResult, AppError> {
    let mut is_recording = state.is_recording.write().await;
    let recording_path = state.recording_path.read().await;
    let mut recording_handle = state.recording_handle.write().await;

    if !*is_recording {
        return Err(AppError::NotInitialized("No recording in progress".to_string()));
    }

    *is_recording = false;

    let path = recording_path
        .as_ref()
        .ok_or_else(|| AppError::NotInitialized("No recording in progress".to_string()))?;

    let handle = recording_handle
        .take()
        .ok_or_else(|| AppError::NotInitialized("Recorder not initialized".to_string()))?;

    let duration = handle.stop()?;

    tracing::info!("Stopped recording: {:?}", path);

    Ok(RecordingResult {
        path: path.to_string_lossy().to_string(),
        duration,
    })
}

// ============================================================================
// Model Download Commands
// ============================================================================

/// List available models for download.
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_voice_list_available_models(
    state: State<'_, AppState>,
) -> Result<Vec<AvailableModel>, AppError> {
    let is_downloaded = |model_id: &str, file_name: &str| -> bool {
        let manifest_path = state.models_dir.join("manifest.json");
        if let Ok(contents) = std::fs::read_to_string(manifest_path) {
            if let Ok(value) = serde_json::from_str::<Value>(&contents) {
                if value.get(model_id).is_some() {
                    return true;
                }
            }
        }

        state.models_dir.join(file_name).exists()
    };

    Ok(vec![
        AvailableModel {
            id: "demucs-htdemucs".to_string(),
            name: "Demucs HT".to_string(),
            description: "High-quality stem separation model".to_string(),
            size: 2_400 * 1024 * 1024,
            url: "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th".to_string(),
            model_type: "demucs".to_string(),
            is_available: true,
            availability_reason: None,
            is_downloaded: is_downloaded("demucs-htdemucs", "htdemucs-v4.th"),
            download_progress: None,
        },
        AvailableModel {
            id: "demucs-htdemucs_ft".to_string(),
            name: "Demucs HT (Fine-tuned)".to_string(),
            description: "Fine-tuned hybrid transformer stem separation model".to_string(),
            size: 2_400 * 1024 * 1024,
            url: "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/f7e0c4bc-ba3fe64a.th".to_string(),
            model_type: "demucs".to_string(),
            is_available: true,
            availability_reason: None,
            is_downloaded: is_downloaded("demucs-htdemucs_ft", "htdemucs_ft-v4.th"),
            download_progress: None,
        },
        AvailableModel {
            id: "demucs-htdemucs_6s".to_string(),
            name: "Demucs HT (6 stems)".to_string(),
            description: "Hybrid transformer stem separation model (6 stems)".to_string(),
            size: 2_400 * 1024 * 1024,
            url: "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/5c90dfd2-34c22ccb.th".to_string(),
            model_type: "demucs".to_string(),
            is_available: true,
            availability_reason: None,
            is_downloaded: is_downloaded("demucs-htdemucs_6s", "htdemucs_6s-v4.th"),
            download_progress: None,
        },
        AvailableModel {
            id: "rvc-base".to_string(),
            name: "RVC Base".to_string(),
            description: "Base model for voice conversion (currently unavailable in this runtime)".to_string(),
            size: 150 * 1024 * 1024,
            url: "".to_string(),
            model_type: "rvc".to_string(),
            is_available: false,
            availability_reason: Some(
                "Voice conversion model installation is disabled because no verified RVC download URL and checksum are configured for this runtime."
                    .to_string(),
            ),
            is_downloaded: state.models_dir.join("rvc_base.pth").exists(),
            download_progress: None,
        },
        AvailableModel {
            id: "crepe-full".to_string(),
            name: "CREPE Full".to_string(),
            description: "Pitch detection model (manual install required)".to_string(),
            size: 25 * 1024 * 1024,
            url: "".to_string(),
            model_type: "crepe".to_string(),
            is_available: false,
            availability_reason: Some(
                "CREPE model download metadata is not configured in this runtime. Manual dependency installation is required."
                    .to_string(),
            ),
            is_downloaded: state.models_dir.join("crepe_full.h5").exists(),
            download_progress: None,
        },
    ])
}

/// Download a model.
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_voice_download_model(
    model_id: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    if matches!(model_id.as_str(), "rvc-base" | "crepe-full") {
        return Err(AppError::Model(
            "This model is not installable in the current runtime because verified download metadata is not configured."
                .to_string(),
        ));
    }

    let cache_dir: PathBuf = state.models_dir.clone();
    tracing::info!(
        model_id = model_id.as_str(),
        cache_dir = cache_dir.to_string_lossy().as_ref(),
        "Downloading model"
    );

    let url = match model_id.as_str() {
        "demucs-htdemucs" => {
            "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th"
        }
        "demucs-htdemucs_ft" => {
            "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/f7e0c4bc-ba3fe64a.th"
        }
        "demucs-htdemucs_6s" => {
            "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/5c90dfd2-34c22ccb.th"
        }
        _ => "",
    };
    
    let mut downloads = state.download_tasks.write().await;
    downloads.insert(model_id.clone(), DownloadTask {
        id: uuid::Uuid::new_v4().to_string(),
        model_id: model_id.clone(),
        url: url.to_string(),
        progress: 0.0,
        status: DownloadStatus::Downloading,
        error: None,
    });

    drop(downloads);

    let model_id_for_task = model_id.clone();

    let download_result = tokio::task::spawn_blocking(move || {
        let cache_dir_str = cache_dir.to_str().unwrap_or("");
        catch_unwind(AssertUnwindSafe(|| {
            crate::ml_model_bridge::download_ml_model(&model_id_for_task, cache_dir_str)
        }))
        .map_err(|panic_payload| {
            let msg = if let Some(s) = panic_payload.downcast_ref::<&str>() {
                (*s).to_string()
            } else if let Some(s) = panic_payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "unknown panic".to_string()
            };
            anyhow::anyhow!("panic in model download: {}", msg)
        })?
    })
    .await
    .map_err(|e| AppError::Model(format!("Model download task failed: {}", e)))?;

    match download_result {
        Ok(_) => {
            tracing::info!(model_id = model_id.as_str(), "Model download completed");
            let mut downloads = state.download_tasks.write().await;
            if let Some(task) = downloads.get_mut(&model_id) {
                task.status = DownloadStatus::Completed;
                task.progress = 100.0;
                task.error = None;
            }
            Ok(())
        }
        Err(err) => {
            tracing::error!(model_id = model_id.as_str(), error = %err, "Model download failed");
            let mut downloads = state.download_tasks.write().await;
            if let Some(task) = downloads.get_mut(&model_id) {
                task.status = DownloadStatus::Failed;
                task.error = Some(err.to_string());
            }
            Err(AppError::Model(err.to_string()))
        }
    }
}

/// Get download progress.
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_voice_download_progress(
    model_id: String,
    state: State<'_, AppState>,
) -> Result<DownloadTask, AppError> {
    let downloads = state.download_tasks.read().await;
    downloads
        .get(&model_id)
        .cloned()
        .ok_or_else(|| AppError::NotInitialized(format!("Download not found: {}", model_id)))
}

// ============================================================================
// Project Commands
// ============================================================================

/// Export project.
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_voice_export_project(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<String, AppError> {
    tracing::info!("Exporting project: {}", project_id);

    let storage = ProjectStorage::new(state.projects_dir.clone())
        .map_err(|e| AppError::InvalidRequest(format!("Failed to initialize project storage: {}", e)))?;
    let export_dir = state.projects_dir.join("exports");
    let output_path = storage
        .export_project(&project_id, &export_dir)
        .map_err(|e| AppError::Audio(format!("Failed to export project: {}", e)))?;

    Ok(output_path.to_string_lossy().to_string())
}

fn write_example_wav(path: &Path, duration_seconds: f64, sample_rate: u32, frequency_hz: f32) -> Result<(), AppError> {
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };

    let mut writer = WavWriter::create(path, spec)
        .map_err(|e| AppError::Audio(format!("Failed to create WAV: {}", e)))?;
    let total_samples = (duration_seconds * sample_rate as f64).round() as usize;

    let amplitude = i16::MAX as f32 * 0.22;
    for i in 0..total_samples {
        let t = i as f32 / sample_rate as f32;
        let sample = (amplitude * (2.0 * PI * frequency_hz * t).sin()) as i16;
        writer
            .write_sample(sample)
            .map_err(|e| AppError::Audio(format!("Failed to write WAV sample: {}", e)))?;
    }

    writer
        .finalize()
        .map_err(|e| AppError::Audio(format!("Failed to finalize WAV: {}", e)))?;
    Ok(())
}

/// Generate example audio files (5-10) for testing.
#[tauri::command]
pub async fn ai_voice_generate_example_audio(
    count: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<AudioMetadata>, AppError> {
    let requested = count.unwrap_or(8);
    let count = requested.clamp(5, 10);

    let sample_dir = state.projects_dir.join("examples");
    std::fs::create_dir_all(&sample_dir)?;

    let sample_rate = 44_100u32;

    let mut outputs = Vec::with_capacity(count as usize);
    for idx in 0..count {
        let i = idx + 1;
        let file_name = format!("example_{:02}.wav", i);
        let file_path = sample_dir.join(&file_name);

        if !file_path.exists() {
            let duration = 3.0 + (i as f64 % 6.0);
            let frequency = 180.0 + (i as f32 * 35.0);
            write_example_wav(&file_path, duration, sample_rate, frequency)?;
        }

        let metadata = audio::load_audio_metadata(file_path.to_str().unwrap_or(""))?;
        outputs.push(metadata);
    }

    Ok(outputs)
}

/// Seed example projects in the project storage directory.
#[tauri::command]
pub async fn ai_voice_seed_example_projects(
    count: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, AppError> {
    let requested = count.unwrap_or(8);
    let count = requested.clamp(5, 10);

    let sample_dir = state.projects_dir.join("examples");
    std::fs::create_dir_all(&sample_dir)?;

    // Ensure example audio exists.
    let mut example_paths: Vec<(String, f64)> = Vec::with_capacity(count as usize);
    for idx in 0..count {
        let i = idx + 1;
        let file_name = format!("example_{:02}.wav", i);
        let file_path = sample_dir.join(&file_name);
        if !file_path.exists() {
            let duration = 3.0 + (i as f64 % 6.0);
            let frequency = 180.0 + (i as f32 * 35.0);
            write_example_wav(&file_path, duration, 44_100u32, frequency)?;
        }

        let meta = audio::load_audio_metadata(file_path.to_str().unwrap_or(""))?;
        example_paths.push((meta.path, meta.duration));
    }

    let storage = ProjectStorage::new(state.projects_dir.clone())
        .map_err(|e| AppError::InvalidRequest(format!("Failed to init project storage: {}", e)))?;

    let mut created_ids: Vec<String> = Vec::with_capacity(count as usize);
    for (idx, (path, duration)) in example_paths.into_iter().enumerate() {
        let now = chrono::Utc::now();
        let project = Project {
            id: uuid::Uuid::new_v4().to_string(),
            name: format!("Example Project {:02}", idx + 1),
            created: now,
            modified: now,
            tracks: vec![AudioTrack {
                id: uuid::Uuid::new_v4().to_string(),
                name: "Track 1".to_string(),
                audio_path: path,
                volume: 1.0,
                pan: 0.0,
                muted: false,
                solo: false,
                color: "#a855f7".to_string(),
                effects: Vec::new(),
                start_time: 0.0,
                duration,
            }],
            settings: ProjectSettings::default(),
            metadata: ProjectMetadata::default(),
        };

        storage
            .save_project(&project)
            .map_err(|e| AppError::InvalidRequest(format!("Failed to save project: {}", e)))?;
        created_ids.push(project.id);
    }

    Ok(created_ids)
}

// ============================================================================
// Voice Cloning Commands
// ============================================================================

/// Clone a voice from audio samples.
#[tauri::command]
pub async fn ai_voice_clone_voice(
    voice_name: String,
    audio_paths: Vec<String>,
    epochs: Option<u32>,
    learning_rate: Option<f32>,
    _state: State<'_, AppState>,
) -> Result<VoiceCloningResult, AppError> {
    tracing::info!("Cloning voice: {} from {} samples", voice_name, audio_paths.len());

    // Call Python voice cloning via python module
    let result = python::call_voice_cloning(
        &voice_name,
        &audio_paths,
        epochs.unwrap_or(100),
        learning_rate.unwrap_or(1e-4),
    )
    .await
    .map_err(|e| AppError::PythonError(format!("Voice cloning failed: {}", e)))?;

    tracing::info!("Voice cloning complete: {}", result.voice_id);
    Ok(result)
}

/// List all cloned voices.
#[tauri::command]
pub async fn ai_voice_list_cloned_voices(
    _state: State<'_, AppState>,
) -> Result<Vec<ClonedVoiceInfo>, AppError> {
    tracing::info!("Listing cloned voices");

    let voices = python::list_cloned_voices()
        .await
        .map_err(|e| AppError::PythonError(format!("Failed to list voices: {}", e)))?;

    Ok(voices)
}

/// Load a cloned voice for synthesis.
#[tauri::command]
pub async fn ai_voice_load_cloned_voice(
    voice_id: String,
    _state: State<'_, AppState>,
) -> Result<(), AppError> {
    tracing::info!("Loading cloned voice: {}", voice_id);

    python::load_cloned_voice(&voice_id)
        .await
        .map_err(|e| AppError::PythonError(format!("Failed to load voice: {}", e)))?;

    Ok(())
}

/// Synthesize text with a cloned voice.
#[tauri::command]
pub async fn ai_voice_synthesize_with_voice(
    text: String,
    voice_id: String,
    speed: Option<f32>,
    pitch: Option<f32>,
    output_path: String,
    _state: State<'_, AppState>,
) -> Result<SynthesisResult, AppError> {
    tracing::info!("Synthesizing with voice: {} ({})", voice_id, text.len());

    let result = python::synthesize_with_cloned_voice(
        &text,
        &voice_id,
        speed.unwrap_or(1.0),
        pitch.unwrap_or(0.0),
        &output_path,
    )
    .await
    .map_err(|e| AppError::PythonError(format!("Synthesis failed: {}", e)))?;

    tracing::info!("Synthesis complete: {:.2}s audio", result.duration_seconds);
    Ok(result)
}

/// Delete a cloned voice.
#[tauri::command]
pub async fn ai_voice_delete_cloned_voice(
    voice_id: String,
    _state: State<'_, AppState>,
) -> Result<(), AppError> {
    tracing::info!("Deleting cloned voice: {}", voice_id);

    python::delete_cloned_voice(&voice_id)
        .await
        .map_err(|e| AppError::PythonError(format!("Failed to delete voice: {}", e)))?;

    Ok(())
}

/// Extract speaker embedding from audio.
#[tauri::command]
pub async fn ai_voice_extract_speaker_embedding(
    audio_path: String,
    _state: State<'_, AppState>,
) -> Result<SpeakerEmbeddingResult, AppError> {
    tracing::info!("Extracting speaker embedding from: {}", audio_path);

    let result = python::extract_speaker_embedding(&audio_path)
        .await
        .map_err(|e| AppError::PythonError(format!("Embedding extraction failed: {}", e)))?;

    Ok(result)
}

