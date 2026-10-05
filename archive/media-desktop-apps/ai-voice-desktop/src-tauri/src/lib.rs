//! AI Voice Production Studio - Tauri Backend
//!
//! This module provides the Tauri backend for the AI Voice desktop application.

pub mod audio;
pub mod buffer;
pub mod commands;
pub mod config;
pub mod device;
pub mod error;
pub mod effects;
pub mod metrics;
pub mod ml_integration_commands;
pub mod ml_model_bridge;
pub mod models;
pub mod playback;
pub mod pool;
pub mod project_storage;
pub mod python;
pub mod recorder;
pub mod resilience;
pub mod session;
pub mod state;
pub mod stream;
pub mod sync;

use state::AppState;
use once_cell::sync::OnceCell;
use std::path::PathBuf;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

static LOG_GUARD: OnceCell<WorkerGuard> = OnceCell::new();

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let data_dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ghatana")
        .join("speech")
        .join("ai-voice");
    let log_dir = data_dir.join("logs");
    let _ = std::fs::create_dir_all(&log_dir);

    let file_appender = tracing_appender::rolling::daily(&log_dir, "ai-voice-desktop.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    let _ = LOG_GUARD.set(guard);

    let panic_log_path = log_dir.join("panic.log");
    std::panic::set_hook(Box::new(move |info| {
        use std::io::Write;
        let backtrace = std::backtrace::Backtrace::force_capture();
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&panic_log_path)
        {
            let _ = writeln!(file, "PANIC: {info}\n{backtrace}\n");
        }
    }));

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "ai_voice_desktop_lib=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .with(tracing_subscriber::fmt::layer().with_ansi(false).with_writer(non_blocking))
        .init();

    tracing::info!("Starting AI Voice Production Studio");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            // Audio commands
            commands::ai_voice_load_audio,
            commands::ai_voice_get_audio_info,
            commands::ai_voice_play_audio,
            commands::ai_voice_stop_audio,
            commands::ai_voice_get_audio_runtime_metrics,
            commands::ai_voice_export_audio,
            commands::ai_voice_create_audio_session,
            commands::ai_voice_get_audio_session,
            commands::ai_voice_list_audio_sessions,
            commands::ai_voice_close_audio_session,
            commands::ai_voice_analyze_sync,
            commands::ai_voice_stream_audio,
            commands::ai_voice_apply_builtin_effects,
            // Stem separation
            commands::ai_voice_separate_stems,
            commands::ai_voice_separation_progress,
            // Phrase detection
            commands::ai_voice_detect_phrases,
            // Voice conversion
            commands::ai_voice_convert_phrase,
            commands::ai_voice_convert_full,
            // Voice models
            commands::ai_voice_list_models,
            commands::ai_voice_load_model,
            commands::ai_voice_delete_model,
            commands::ai_voice_test_model,
            // Training
            commands::ai_voice_start_training,
            commands::ai_voice_training_status,
            commands::ai_voice_start_recording,
            commands::ai_voice_stop_recording,
            // Model downloads
            commands::ai_voice_list_available_models,
            commands::ai_voice_download_model,
            commands::ai_voice_download_progress,
            // Project
            commands::ai_voice_export_project,
            commands::ai_voice_generate_example_audio,
            commands::ai_voice_seed_example_projects,
            // ML Model Management
            ml_integration_commands::list_available_models,
            ml_integration_commands::list_downloaded_models,
            ml_integration_commands::download_model,
            ml_integration_commands::delete_model,
            ml_integration_commands::get_model_cache_size,
            ml_integration_commands::clear_model_cache,
            // Project Persistence
            ml_integration_commands::get_project_storage_directory,
            ml_integration_commands::save_audio_project,
            ml_integration_commands::load_audio_project,
            ml_integration_commands::list_audio_projects,
            ml_integration_commands::delete_audio_project,
            ml_integration_commands::export_audio_project,
            // Audio Quality Analysis
            ml_integration_commands::analyze_audio_quality,
            // Audio Effects Processing
            ml_integration_commands::process_audio_effects,
            // Voice Cloning
            commands::ai_voice_clone_voice,
            commands::ai_voice_list_cloned_voices,
            commands::ai_voice_load_cloned_voice,
            commands::ai_voice_synthesize_with_voice,
            commands::ai_voice_delete_cloned_voice,
            commands::ai_voice_extract_speaker_embedding,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
