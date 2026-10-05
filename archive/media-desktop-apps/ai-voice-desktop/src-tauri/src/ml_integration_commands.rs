/**
 * Tauri Commands for Phase 4 Integration
 *
 * Bridges React UI with:
 * - Model Manager (Python)
 * - Project Storage (Rust)
 * - Quality Metrics (Python)
 * - Effects Library (Python)
 */

use tauri::State;
use serde::{Deserialize, Serialize};
use tracing;

use crate::project_storage::{Project, ProjectInfo};
use crate::ml_model_bridge::{AudioQualityMetrics, AudioEffectsConfig};
use crate::state::AppState;

// ============================================================================
// Model Manager Commands
// ============================================================================

#[tauri::command]
pub async fn list_available_models() -> Result<Vec<String>, String> {
    Ok(vec![
        "demucs-htdemucs".to_string(),
        "demucs-htdemucs_ft".to_string(),
        "demucs-htdemucs_6s".to_string(),
        "whisper-base".to_string(),
        "ecapa-tdnn".to_string(),
    ])
}

#[tauri::command]
pub async fn list_downloaded_models(
    state: State<'_, AppState>
) -> Result<Vec<String>, String> {
    let cache_dir = state.models_dir.to_str().unwrap_or("");
    tracing::info!(cache_dir = cache_dir, "ModelManager:list_downloaded_models");
    crate::ml_model_bridge::list_downloaded_models(cache_dir).map_err(|e| {
        tracing::error!(cache_dir = cache_dir, error = %e, "ModelManager:list_downloaded_models:error");
        e.to_string()
    })
}

#[tauri::command]
pub async fn download_model(
    model_id: String,
    state: State<'_, AppState>
) -> Result<(), String> {
    let cache_dir = state.models_dir.to_str().unwrap_or("");
    tracing::info!(model_id = model_id.as_str(), cache_dir = cache_dir, "ModelManager:download_model");
    crate::ml_model_bridge::download_ml_model(&model_id, cache_dir).map_err(|e| {
        tracing::error!(
            model_id = model_id.as_str(),
            cache_dir = cache_dir,
            error = %e,
            "ModelManager:download_model:error"
        );
        e.to_string()
    })
}

#[tauri::command]
pub async fn delete_model(
    model_id: String,
    state: State<'_, AppState>
) -> Result<(), String> {
    let cache_dir = state.models_dir.to_str().unwrap_or("");
    tracing::info!(model_id = model_id.as_str(), cache_dir = cache_dir, "ModelManager:delete_model");
    crate::ml_model_bridge::delete_ml_model(&model_id, cache_dir).map_err(|e| {
        tracing::error!(
            model_id = model_id.as_str(),
            cache_dir = cache_dir,
            error = %e,
            "ModelManager:delete_model:error"
        );
        e.to_string()
    })
}

#[tauri::command]
pub async fn get_model_cache_size(
    state: State<'_, AppState>
) -> Result<f64, String> {
    let cache_dir = state.models_dir.to_str().unwrap_or("");
    tracing::info!(cache_dir = cache_dir, "ModelManager:get_model_cache_size");
    crate::ml_model_bridge::get_cache_size_in_megabytes(cache_dir).map_err(|e| {
        tracing::error!(cache_dir = cache_dir, error = %e, "ModelManager:get_model_cache_size:error");
        e.to_string()
    })
}

#[tauri::command]
pub async fn clear_model_cache(
    state: State<'_, AppState>
) -> Result<(), String> {
    let cache_dir = state.models_dir.to_str().unwrap_or("");
    tracing::info!(cache_dir = cache_dir, "ModelManager:clear_model_cache");
    crate::ml_model_bridge::clear_model_cache(cache_dir).map_err(|e| {
        tracing::error!(cache_dir = cache_dir, error = %e, "ModelManager:clear_model_cache:error");
        e.to_string()
    })
}

// ============================================================================
// Project Storage Commands
// ============================================================================

#[tauri::command]
pub async fn get_project_storage_directory(
    state: State<'_, AppState>
) -> Result<String, String> {
    Ok(state.projects_dir.to_string_lossy().to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn save_audio_project(
    project: Project,
    storage_directory: String,
) -> Result<String, String> {
    crate::project_storage::save_project(project, storage_directory).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn load_audio_project(
    project_id: String,
    storage_directory: String,
) -> Result<Project, String> {
    crate::project_storage::load_project(project_id, storage_directory).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn list_audio_projects(
    storage_directory: String,
) -> Result<Vec<ProjectInfo>, String> {
    crate::project_storage::list_projects(storage_directory).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn delete_audio_project(
    project_id: String,
    storage_directory: String,
) -> Result<(), String> {
    crate::project_storage::delete_project(project_id, storage_directory).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn export_audio_project(
    project_id: String,
    export_file_path: String,
    storage_directory: String,
) -> Result<String, String> {
    crate::project_storage::export_project(project_id, export_file_path, storage_directory).await
}

// ============================================================================
// Quality Metrics Commands
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct QualityMetrics {
    pub mos_score: f64,
    pub wer: Option<f64>,
    pub speaker_similarity: Option<f64>,
    pub snr: f64,
    pub pesq: Option<f64>,
    pub stoi: Option<f64>,
}

#[tauri::command]
pub async fn analyze_audio_quality(
    audio_file_path: String,
    reference_transcript: Option<String>,
    reference_audio_file_path: Option<String>,
) -> Result<AudioQualityMetrics, String> {
    crate::ml_model_bridge::assess_audio_quality(
        &audio_file_path,
        reference_transcript.as_deref(),
        reference_audio_file_path.as_deref(),
    ).map_err(|e| e.to_string())
}

// ============================================================================
// Effects Commands
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct EffectsConfig {
    pub reverb: Option<ReverbConfig>,
    pub delay: Option<DelayConfig>,
    pub eq: Option<EQConfig>,
    pub compressor: Option<CompressorConfig>,
    pub limiter: Option<LimiterConfig>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReverbConfig {
    pub room_size: f32,
    pub wet: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DelayConfig {
    pub time: f32,
    pub feedback: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EQConfig {
    pub bands: Vec<EQBand>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EQBand {
    pub freq: f32,
    pub gain: f32,
    pub q: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CompressorConfig {
    pub threshold: f32,
    pub ratio: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LimiterConfig {
    pub threshold: f32,
}

#[tauri::command]
pub async fn process_audio_effects(
    input_audio_path: String,
    output_audio_path: String,
    effects_configuration: AudioEffectsConfig,
    audio_sample_rate: u32,
) -> Result<String, String> {
    crate::ml_model_bridge::apply_audio_effects(
        &input_audio_path,
        &output_audio_path,
        effects_configuration,
        audio_sample_rate,
    ).map_err(|e| e.to_string())
}

// ============================================================================
// Main Registration
// ============================================================================

pub fn register_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            // Model Manager
            list_available_models,
            list_downloaded_models,
            download_model,
            delete_model,
            get_model_cache_size,
            clear_model_cache,
            // Project Storage
            get_project_storage_directory,
            save_audio_project,
            load_audio_project,
            list_audio_projects,
            delete_audio_project,
            export_audio_project,
            // Quality Metrics
            analyze_audio_quality,
            // Effects
            process_audio_effects,
        ])
}

