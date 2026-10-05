// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![recursion_limit = "1024"]

mod grpc_client;
mod error_handling;
mod validation;

use grpc_client::{ai_voice, multimodal, stt, tts, vision};
use error_handling::{create_channel_with_retry, CircuitBreaker, RetryConfig, UserError};
use validation::{sanitize_filename, validate_audio_file, validate_image_file, validate_text, validate_video_file};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::State;
use tonic::transport::Channel;

// Application state
#[derive(Debug)]
struct AppState {
    services: Arc<Mutex<HashMap<String, ServiceStatus>>>,
    stt_circuit_breaker: CircuitBreaker,
    tts_circuit_breaker: CircuitBreaker,
    ai_voice_circuit_breaker: CircuitBreaker,
    vision_circuit_breaker: CircuitBreaker,
    multimodal_circuit_breaker: CircuitBreaker,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            services: Arc::new(Mutex::new(HashMap::new())),
            stt_circuit_breaker: CircuitBreaker::default(),
            tts_circuit_breaker: CircuitBreaker::default(),
            ai_voice_circuit_breaker: CircuitBreaker::default(),
            vision_circuit_breaker: CircuitBreaker::default(),
            multimodal_circuit_breaker: CircuitBreaker::default(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ServiceStatus {
    name: String,
    status: String,
    endpoint: String,
    last_check: String,
}

// STT Commands
#[tauri::command]
fn stt_transcribe(
    audio_data: Vec<u8>,
    language: Option<String>,
    filename: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let services = state.services.clone();
    let stt_circuit_breaker = state.stt_circuit_breaker.clone();
    let retry_config = state.retry_config.clone();

    tauri::async_runtime::block_on(stt_transcribe_inner(
        audio_data,
        language,
        filename,
        services,
        stt_circuit_breaker,
        retry_config,
    ))
}

async fn stt_transcribe_inner(
    audio_data: Vec<u8>,
    language: Option<String>,
    filename: Option<String>,
    services: Arc<Mutex<HashMap<String, ServiceStatus>>>,
    stt_circuit_breaker: CircuitBreaker,
    retry_config: RetryConfig,
) -> Result<String, String> {
    let sanitized_filename = filename.as_deref().map(sanitize_filename);

    // Validate audio file
    if let Err(e) = validate_audio_file(&audio_data, sanitized_filename.as_deref()) {
        let user_error = match e {
            validation::ValidationError::FileTooLarge { size, max } => {
                let _ = size;
                UserError::file_too_large((max / (1024 * 1024)) as u64)
            }
            validation::ValidationError::InvalidExtension { .. } => {
                UserError::invalid_file_type("audio (wav, mp3, ogg, flac, m4a)")
            }
            validation::ValidationError::InvalidFileType { .. } => {
                UserError::invalid_file_type("audio file with valid signature")
            }
            _ => UserError::processing_error(&e.to_string()),
        };
        return Err(user_error.to_json());
    }

    let addr = std::env::var("STT_GRPC_URL").unwrap_or_else(|_| "http://localhost:50051".to_string());
    let result = stt_circuit_breaker
        .call_async_for("STT", || run_stt_transcription(addr.clone(), audio_data.clone(), language.clone(), retry_config.clone()))
        .await;

    match result {
        Ok(text) => {
            let mut services = services.lock().unwrap_or_else(|e| e.into_inner());
            services.insert(
                "stt".to_string(),
                ServiceStatus {
                    name: "STT".to_string(),
                    status: "healthy".to_string(),
                    endpoint: addr,
                    last_check: chrono::Utc::now().to_rfc3339(),
                },
            );
            Ok(text)
        }
        Err(e) => Err(e.to_json()),
    }
}

async fn run_stt_transcription(
    addr: String,
    audio_data: Vec<u8>,
    language: Option<String>,
    config: RetryConfig,
) -> Result<String, String> {
    let mut delay_ms = config.initial_delay_ms;

    for attempt in 1..=config.max_attempts {
        match transcribe_once(&addr, audio_data.clone(), language.clone()).await {
            Ok(text) => return Ok(text),
            Err(error) if attempt == config.max_attempts => {
                return Err(format!("Failed after {} attempts: {}", config.max_attempts, error));
            }
            Err(error) => {
                log::warn!(
                    "Attempt {} failed: {}. Retrying in {}ms...",
                    attempt,
                    error,
                    delay_ms
                );
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                delay_ms = (delay_ms as f64 * config.backoff_multiplier) as u64;
                delay_ms = delay_ms.min(config.max_delay_ms);
            }
        }
    }

    Err("Retry logic error".to_string())
}

async fn transcribe_once(
    addr: &str,
    audio_data: Vec<u8>,
    language: Option<String>,
) -> Result<String, String> {
    let channel = create_channel_with_retry(addr.to_string())
        .await
        .map_err(|_| "Failed to connect to STT service".to_string())?;

    let mut client = stt::stt_service_client::SttServiceClient::new(channel);
    let request = tonic::Request::new(stt::TranscribeRequest {
        audio_data,
        language: language.unwrap_or_default(),
        profile_id: String::new(),
    });

    let response = client
        .transcribe(request)
        .await
        .map_err(|e| format!("Transcription failed: {}", e))?;

    Ok(response.into_inner().text)
}

#[tauri::command]
fn stt_get_status(state: State<'_, AppState>) -> Result<ServiceStatus, String> {
    tauri::async_runtime::block_on(stt_get_status_inner(state.services.clone()))
}

async fn stt_get_status_inner(
    services: Arc<Mutex<HashMap<String, ServiceStatus>>>,
) -> Result<ServiceStatus, String> {
    let services = services.lock().unwrap_or_else(|e| e.into_inner());
    Ok(services.get("stt").cloned().unwrap_or(ServiceStatus {
        name: "STT".to_string(),
        status: "unknown".to_string(),
        endpoint: "http://localhost:50051".to_string(),
        last_check: chrono::Utc::now().to_rfc3339(),
    }))
}

// TTS Commands
#[tauri::command]
fn tts_synthesize(
    text: String,
    voice_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    let services = state.services.clone();
    let tts_circuit_breaker = state.tts_circuit_breaker.clone();
    let retry_config = state.retry_config.clone();

    tauri::async_runtime::block_on(tts_synthesize_inner(
        text,
        voice_id,
        services,
        tts_circuit_breaker,
        retry_config,
    ))
}

async fn tts_synthesize_inner(
    text: String,
    voice_id: Option<String>,
    services: Arc<Mutex<HashMap<String, ServiceStatus>>>,
    tts_circuit_breaker: CircuitBreaker,
    retry_config: RetryConfig,
) -> Result<Vec<u8>, String> {
    // Validate text input
    if let Err(e) = validate_text(&text) {
        let user_error = match e {
            validation::ValidationError::TextTooLong { length, max } => {
                UserError {
                    code: "TEXT_TOO_LONG".to_string(),
                    message: format!("Text length {} exceeds maximum {} characters", length, max),
                    recovery_action: Some("Please shorten your text or split it into smaller chunks.".to_string()),
                    is_retryable: false,
                }
            }
            _ => UserError::processing_error(&e.to_string()),
        };
        return Err(user_error.to_json());
    }

    let addr = std::env::var("TTS_GRPC_URL").unwrap_or_else(|_| "http://localhost:50052".to_string());
    let result = tts_circuit_breaker
        .call_async_for("TTS", || run_tts_synthesis(addr.clone(), text.clone(), voice_id.clone(), retry_config.clone()))
        .await;
    
    match result {
        Ok(audio_data) => {
            // Update service status
            let mut services = services.lock().unwrap_or_else(|e| e.into_inner());
            services.insert("tts".to_string(), ServiceStatus {
                name: "TTS".to_string(),
                status: "healthy".to_string(),
                endpoint: addr,
                last_check: chrono::Utc::now().to_rfc3339(),
            });
            Ok(audio_data)
        }
        Err(e) => Err(e.to_json()),
    }
}

async fn run_tts_synthesis(
    addr: String,
    text: String,
    voice_id: Option<String>,
    config: RetryConfig,
) -> Result<Vec<u8>, String> {
    let mut delay_ms = config.initial_delay_ms;

    for attempt in 1..=config.max_attempts {
        match synthesize_once(&addr, text.clone(), voice_id.clone()).await {
            Ok(audio_data) => return Ok(audio_data),
            Err(error) if attempt == config.max_attempts => {
                return Err(format!("Failed after {} attempts: {}", config.max_attempts, error));
            }
            Err(error) => {
                log::warn!(
                    "Attempt {} failed: {}. Retrying in {}ms...",
                    attempt,
                    error,
                    delay_ms
                );
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                delay_ms = (delay_ms as f64 * config.backoff_multiplier) as u64;
                delay_ms = delay_ms.min(config.max_delay_ms);
            }
        }
    }

    Err("Retry logic error".to_string())
}

async fn synthesize_once(
    addr: &str,
    text: String,
    voice_id: Option<String>,
) -> Result<Vec<u8>, String> {
    let channel = create_channel_with_retry(addr.to_string())
        .await
        .map_err(|_| "Failed to connect to TTS service".to_string())?;

    let mut client = tts::tts_service_client::TtsServiceClient::new(channel);
    let request = tonic::Request::new(tts::SynthesizeRequest {
        text,
        voice_id: voice_id.unwrap_or_default(),
        profile_id: String::new(),
        options: None,
    });

    let response = client
        .synthesize(request)
        .await
        .map_err(|e| format!("Synthesis failed: {}", e))?;

    Ok(response.into_inner().audio_data)
}

#[tauri::command]
fn tts_get_status(state: State<'_, AppState>) -> Result<ServiceStatus, String> {
    tauri::async_runtime::block_on(tts_get_status_inner(state.services.clone()))
}

async fn tts_get_status_inner(
    services: Arc<Mutex<HashMap<String, ServiceStatus>>>,
) -> Result<ServiceStatus, String> {
    let services = services.lock().unwrap_or_else(|e| e.into_inner());
    Ok(services.get("tts").cloned().unwrap_or(ServiceStatus {
        name: "TTS".to_string(),
        status: "unknown".to_string(),
        endpoint: "http://localhost:50052".to_string(),
        last_check: chrono::Utc::now().to_rfc3339(),
    }))
}

// AI Voice Commands
#[tauri::command]
fn ai_voice_process(
    text: String,
    task: String,
    voice_id: Option<String>,
    emotion: Option<String>,
    speaking_rate: Option<f32>,
    pitch_semitones: Option<f32>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let services = state.services.clone();
    let ai_voice_circuit_breaker = state.ai_voice_circuit_breaker.clone();
    let retry_config = state.retry_config.clone();

    tauri::async_runtime::block_on(ai_voice_process_inner(
        text,
        task,
        voice_id,
        emotion,
        speaking_rate,
        pitch_semitones,
        services,
        ai_voice_circuit_breaker,
        retry_config,
    ))
}

async fn ai_voice_process_inner(
    text: String,
    task: String,
    voice_id: Option<String>,
    emotion: Option<String>,
    speaking_rate: Option<f32>,
    pitch_semitones: Option<f32>,
    services: Arc<Mutex<HashMap<String, ServiceStatus>>>,
    ai_voice_circuit_breaker: CircuitBreaker,
    retry_config: RetryConfig,
) -> Result<String, String> {
    // Validate text input before sending to the AI Voice service.
    if let Err(e) = validate_text(&text) {
        let user_error = match e {
            validation::ValidationError::TextTooLong { length, max } => UserError {
                code: "TEXT_TOO_LONG".to_string(),
                message: format!("Text length {} exceeds maximum {} characters", length, max),
                recovery_action: Some(
                    "Please shorten your text or split it into smaller chunks.".to_string(),
                ),
                is_retryable: false,
            },
            _ => UserError::processing_error(&e.to_string()),
        };
        return Err(user_error.to_json());
    }

    let addr = std::env::var("AI_VOICE_GRPC_URL")
        .unwrap_or_else(|_| "http://localhost:50053".to_string());
    log::debug!(
        "AI Voice request: {} chars, task: '{}', voice: {:?}",
        text.len(),
        task,
        voice_id
    );

    let result = ai_voice_circuit_breaker
        .call_async_for("AI Voice", || {
            run_ai_voice_processing(
                addr.clone(),
                text.clone(),
                task.clone(),
                voice_id.clone(),
                emotion.clone(),
                speaking_rate,
                pitch_semitones,
                retry_config.clone(),
            )
        })
        .await;

    match result {
        Ok(json_result) => {
            let mut services = services.lock().unwrap_or_else(|e| e.into_inner());
            services.insert(
                "ai-voice".to_string(),
                ServiceStatus {
                    name: "AI Voice".to_string(),
                    status: "healthy".to_string(),
                    endpoint: addr,
                    last_check: chrono::Utc::now().to_rfc3339(),
                },
            );
            Ok(json_result)
        }
        Err(e) => Err(e.to_json()),
    }
}

async fn run_ai_voice_processing(
    addr: String,
    text: String,
    task: String,
    voice_id: Option<String>,
    emotion: Option<String>,
    speaking_rate: Option<f32>,
    pitch_semitones: Option<f32>,
    config: RetryConfig,
) -> Result<String, String> {
    let mut delay_ms = config.initial_delay_ms;

    for attempt in 1..=config.max_attempts {
        match process_ai_voice_once(
            &addr,
            text.clone(),
            task.clone(),
            voice_id.clone(),
            emotion.clone(),
            speaking_rate,
            pitch_semitones,
        )
        .await
        {
            Ok(result) => return Ok(result),
            Err(error) if attempt == config.max_attempts => {
                return Err(format!("Failed after {} attempts: {}", config.max_attempts, error));
            }
            Err(error) => {
                log::warn!(
                    "Attempt {} failed: {}. Retrying in {}ms...",
                    attempt,
                    error,
                    delay_ms
                );
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                delay_ms = (delay_ms as f64 * config.backoff_multiplier) as u64;
                delay_ms = delay_ms.min(config.max_delay_ms);
            }
        }
    }

    Err("Retry logic error".to_string())
}

async fn process_ai_voice_once(
    addr: &str,
    text: String,
    task: String,
    voice_id: Option<String>,
    emotion: Option<String>,
    speaking_rate: Option<f32>,
    pitch_semitones: Option<f32>,
) -> Result<String, String> {
    let channel = create_channel_with_retry(addr.to_string())
        .await
        .map_err(|_| "Failed to connect to AI Voice service".to_string())?;

    let mut client = grpc_client::ai_voice::ai_voice_service_client::AiVoiceServiceClient::new(channel);
    let request = tonic::Request::new(grpc_client::ai_voice::VoiceProcessRequest {
        text,
        task,
        voice_id: voice_id.unwrap_or_default(),
        emotion: emotion.unwrap_or_default(),
        speaking_rate: speaking_rate.unwrap_or(1.0),
        pitch_semitones: pitch_semitones.unwrap_or(0.0),
    });

    let response = client
        .process_voice(request)
        .await
        .map_err(|e| format!("AI Voice processing failed: {}", e))?;
    let inner = response.into_inner();

    Ok(serde_json::json!({
        "audio_data": inner.audio_data,
        "sample_rate": inner.sample_rate,
        "duration_ms": inner.duration_ms,
        "processing_time_ms": inner.processing_time_ms,
        "applied_task": inner.applied_task,
        "voice_used": inner.voice_used,
    })
    .to_string())
}

// Computer Vision Commands
#[tauri::command]
fn vision_process(
    image_data: Vec<u8>,
    task: String,
    filename: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let services = state.services.clone();
    let vision_circuit_breaker = state.vision_circuit_breaker.clone();
    let retry_config = state.retry_config.clone();

    tauri::async_runtime::block_on(vision_process_inner(
        image_data,
        task,
        filename,
        services,
        vision_circuit_breaker,
        retry_config,
    ))
}

async fn vision_process_inner(
    image_data: Vec<u8>,
    task: String,
    filename: Option<String>,
    services: Arc<Mutex<HashMap<String, ServiceStatus>>>,
    vision_circuit_breaker: CircuitBreaker,
    retry_config: RetryConfig,
) -> Result<String, String> {
    let sanitized_filename = filename.as_deref().map(sanitize_filename);

    // Validate image file
    if let Err(e) = validate_image_file(&image_data, sanitized_filename.as_deref()) {
        let user_error = match e {
            validation::ValidationError::FileTooLarge { size, max } => {
                let _ = size;
                UserError::file_too_large((max / (1024 * 1024)) as u64)
            }
            validation::ValidationError::InvalidExtension { .. } => {
                UserError::invalid_file_type("image (jpg, jpeg, png, gif, webp, bmp)")
            }
            validation::ValidationError::InvalidFileType { .. } => {
                UserError::invalid_file_type("image file with valid signature")
            }
            _ => UserError::processing_error(&e.to_string()),
        };
        return Err(user_error.to_json());
    }

    let addr = std::env::var("VISION_GRPC_URL").unwrap_or_else(|_| "http://localhost:50054".to_string());
    let result = vision_circuit_breaker
        .call_async_for("Vision", || run_vision_detection(addr.clone(), image_data.clone(), task.clone(), retry_config.clone()))
        .await;
    
    match result {
        Ok(json_result) => {
            // Update service status
            let mut services = services.lock().unwrap_or_else(|e| e.into_inner());
            services.insert("vision".to_string(), ServiceStatus {
                name: "Vision".to_string(),
                status: "healthy".to_string(),
                endpoint: addr,
                last_check: chrono::Utc::now().to_rfc3339(),
            });
            Ok(json_result)
        }
        Err(e) => Err(e.to_json()),
    }
}

async fn run_vision_detection(
    addr: String,
    image_data: Vec<u8>,
    task: String,
    config: RetryConfig,
) -> Result<String, String> {
    let mut delay_ms = config.initial_delay_ms;

    for attempt in 1..=config.max_attempts {
        match detect_vision_once(&addr, image_data.clone(), task.clone()).await {
            Ok(result) => return Ok(result),
            Err(error) if attempt == config.max_attempts => {
                return Err(format!("Failed after {} attempts: {}", config.max_attempts, error));
            }
            Err(error) => {
                log::warn!(
                    "Attempt {} failed: {}. Retrying in {}ms...",
                    attempt,
                    error,
                    delay_ms
                );
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                delay_ms = (delay_ms as f64 * config.backoff_multiplier) as u64;
                delay_ms = delay_ms.min(config.max_delay_ms);
            }
        }
    }

    Err("Retry logic error".to_string())
}

async fn detect_vision_once(
    addr: &str,
    image_data: Vec<u8>,
    task: String,
) -> Result<String, String> {
    let channel = create_channel_with_retry(addr.to_string())
        .await
        .map_err(|_| "Failed to connect to Vision service".to_string())?;

    let mut client = grpc_client::vision::vision_service_client::VisionServiceClient::new(channel);
    let request = tonic::Request::new(grpc_client::vision::DetectRequest {
        image_data: image_data.into(),
        target_classes: if task.is_empty() { vec![] } else { vec![task] },
        max_detections: 10,
        confidence_threshold: 0.5,
    });

    let response = client
        .detect_objects(request)
        .await
        .map_err(|e| format!("Vision detection failed: {}", e))?;
    let result = response.into_inner();

    let detections: Vec<serde_json::Value> = result
        .detections
        .iter()
        .map(|d| {
            serde_json::json!({
                "class": d.class_name,
                "confidence": d.confidence,
                "bbox": {
                    "x": d.bounding_box.as_ref().map(|b| b.x).unwrap_or(0.0),
                    "y": d.bounding_box.as_ref().map(|b| b.y).unwrap_or(0.0),
                    "width": d.bounding_box.as_ref().map(|b| b.width).unwrap_or(0.0),
                    "height": d.bounding_box.as_ref().map(|b| b.height).unwrap_or(0.0),
                }
            })
        })
        .collect();

    Ok(serde_json::json!({"objects": detections}).to_string())
}

// Multimodal Commands
#[tauri::command]
fn multimodal_process(
    request: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let services = state.services.clone();
    let multimodal_circuit_breaker = state.multimodal_circuit_breaker.clone();
    let retry_config = state.retry_config.clone();

    tauri::async_runtime::block_on(multimodal_process_inner(
        request,
        services,
        multimodal_circuit_breaker,
        retry_config,
    ))
}

async fn multimodal_process_inner(
    request: serde_json::Value,
    services: Arc<Mutex<HashMap<String, ServiceStatus>>>,
    multimodal_circuit_breaker: CircuitBreaker,
    retry_config: RetryConfig,
) -> Result<String, String> {
    // Extract and validate data from request
    let audio_data = request.get("audio_data")
        .or_else(|| request.get("audioData"))
        .and_then(json_value_to_bytes)
        .unwrap_or_default();
    let image_data = request.get("image_data")
        .or_else(|| request.get("imageData"))
        .and_then(json_value_to_bytes)
        .unwrap_or_default();
    let video_data = request.get("video_data")
        .or_else(|| request.get("videoData"))
        .and_then(json_value_to_bytes)
        .unwrap_or_default();
    let text = request.get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    
    // Validate inputs if provided
    if !audio_data.is_empty() {
        if let Err(e) = validate_audio_file(&audio_data, None) {
            return Err(UserError::processing_error(&format!("Invalid audio data: {}", e)).to_json());
        }
    }
    if !image_data.is_empty() {
        if let Err(e) = validate_image_file(&image_data, None) {
            return Err(UserError::processing_error(&format!("Invalid image data: {}", e)).to_json());
        }
    }
    if !video_data.is_empty() {
        if let Err(e) = validate_video_file(&video_data, None) {
            return Err(UserError::processing_error(&format!("Invalid video data: {}", e)).to_json());
        }
    }
    if !text.is_empty() {
        if let Err(e) = validate_text(&text) {
            return Err(UserError::processing_error(&format!("Invalid text: {}", e)).to_json());
        }
    }

    let addr = std::env::var("MULTIMODAL_GRPC_URL").unwrap_or_else(|_| "http://localhost:50055".to_string());
    let result = multimodal_circuit_breaker
        .call_async_for("Multimodal", || {
            run_multimodal_processing(
                addr.clone(),
                audio_data.clone(),
                image_data.clone(),
                video_data.clone(),
                text.clone(),
                retry_config.clone(),
            )
        })
        .await;
    
    match result {
        Ok(json_result) => {
            // Update service status
            let mut services = services.lock().unwrap_or_else(|e| e.into_inner());
            services.insert("multimodal".to_string(), ServiceStatus {
                name: "Multimodal".to_string(),
                status: "healthy".to_string(),
                endpoint: addr,
                last_check: chrono::Utc::now().to_rfc3339(),
            });
            Ok(json_result)
        }
        Err(e) => Err(e.to_json()),
    }
}

async fn run_multimodal_processing(
    addr: String,
    audio_data: Vec<u8>,
    image_data: Vec<u8>,
    video_data: Vec<u8>,
    text: String,
    config: RetryConfig,
) -> Result<String, String> {
    let mut delay_ms = config.initial_delay_ms;

    for attempt in 1..=config.max_attempts {
        match process_multimodal_once(
            &addr,
            audio_data.clone(),
            image_data.clone(),
            video_data.clone(),
            text.clone(),
        )
        .await
        {
            Ok(result) => return Ok(result),
            Err(error) if attempt == config.max_attempts => {
                return Err(format!("Failed after {} attempts: {}", config.max_attempts, error));
            }
            Err(error) => {
                log::warn!(
                    "Attempt {} failed: {}. Retrying in {}ms...",
                    attempt,
                    error,
                    delay_ms
                );
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                delay_ms = (delay_ms as f64 * config.backoff_multiplier) as u64;
                delay_ms = delay_ms.min(config.max_delay_ms);
            }
        }
    }

    Err("Retry logic error".to_string())
}

async fn process_multimodal_once(
    addr: &str,
    audio_data: Vec<u8>,
    image_data: Vec<u8>,
    video_data: Vec<u8>,
    text: String,
) -> Result<String, String> {
    let channel = create_channel_with_retry(addr.to_string())
        .await
        .map_err(|_| "Failed to connect to Multimodal service".to_string())?;

    let mut client = grpc_client::multimodal::multimodal_service_client::MultimodalServiceClient::new(channel);
    let grpc_request = tonic::Request::new(grpc_client::multimodal::MultimodalRequest {
        audio_data: audio_data.into(),
        image_data: image_data.into(),
        video_data: video_data.into(),
        text,
        analysis_types: vec!["combined".to_string()],
    });

    let response = client
        .process_multimodal(grpc_request)
        .await
        .map_err(|e| format!("Multimodal processing failed: {}", e))?;
    let result = response.into_inner();

    Ok(serde_json::json!({
        "summary": result.combined_analysis,
        "confidence": result.audio_analysis.as_ref().map(|a| a.confidence).unwrap_or(0.0),
        "processing_time_ms": result.processing_time_ms
    })
    .to_string())
}

// Application state
#[derive(Debug)]
struct AppState {
    services: Arc<Mutex<HashMap<String, ServiceStatus>>>,
    retry_config: RetryConfig,
    stt_circuit_breaker: CircuitBreaker,
    tts_circuit_breaker: CircuitBreaker,
    ai_voice_circuit_breaker: CircuitBreaker,
    vision_circuit_breaker: CircuitBreaker,
    multimodal_circuit_breaker: CircuitBreaker,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            services: Arc::new(Mutex::new(HashMap::new())),
            retry_config: RetryConfig::default(),
            stt_circuit_breaker: CircuitBreaker::default(),
            tts_circuit_breaker: CircuitBreaker::default(),
            ai_voice_circuit_breaker: CircuitBreaker::default(),
            vision_circuit_breaker: CircuitBreaker::default(),
            multimodal_circuit_breaker: CircuitBreaker::default(),
        }
    }
}
                    "vision" => "54",
                    "multimodal" => "55",
                    _ => "50"
                }),
                last_check: chrono::Utc::now().to_rfc3339(),
            });
        }
    }
    
    Ok(status_list)
}

#[tauri::command]
fn check_service_health(service: String, state: State<'_, AppState>) -> Result<bool, String> {
    tauri::async_runtime::block_on(check_service_health_inner(service, state.services.clone()))
}

async fn check_service_health_inner(
    service: String,
    services: Arc<Mutex<HashMap<String, ServiceStatus>>>,
) -> Result<bool, String> {
    let port = match service.as_str() {
        "stt" => "50051",
        "tts" => "50052",
        "ai-voice" => "50053",
        "vision" => "50054",
        "multimodal" => "50055",
        _ => "50050",
    };
    let addr = std::env::var(format!("{}_GRPC_URL", service.to_uppercase().replace('-', "_")))
        .unwrap_or_else(|_| format!("http://localhost:{}", port));

    // Perform an actual gRPC health check using the STT HealthCheck RPC as the canonical probe.
    // For unsupported services we fall back to a TCP connect attempt.
    let healthy = match service.as_str() {
        "stt" => {
            match Channel::from_shared(addr.clone())
                .map_err(|e| e.to_string())
                .and_then(|ep| Ok(ep.connect_timeout(std::time::Duration::from_secs(3))))
            {
                Ok(endpoint) => {
                    let result = endpoint.connect().await;
                    if let Ok(channel) = result {
                        let mut client = stt::stt_service_client::SttServiceClient::new(channel);
                        client.health_check(tonic::Request::new(stt::HealthCheckRequest {})).await.is_ok()
                    } else {
                        false
                    }
                }
                Err(_) => false,
            }
        }
        "tts" => {
            match Channel::from_shared(addr.clone())
                .map_err(|e| e.to_string())
                .and_then(|ep| Ok(ep.connect_timeout(std::time::Duration::from_secs(3))))
            {
                Ok(endpoint) => {
                    let result = endpoint.connect().await;
                    if let Ok(channel) = result {
                        let mut client = tts::tts_service_client::TtsServiceClient::new(channel);
                        client.health_check(tonic::Request::new(tts::HealthCheckRequest {})).await.is_ok()
                    } else {
                        false
                    }
                }
                Err(_) => false,
            }
        }
        "ai-voice" => {
            match Channel::from_shared(addr.clone())
                .map_err(|e| e.to_string())
                .and_then(|ep| Ok(ep.connect_timeout(std::time::Duration::from_secs(3))))
            {
                Ok(endpoint) => {
                    let result = endpoint.connect().await;
                    if let Ok(channel) = result {
                        let mut client = ai_voice::ai_voice_service_client::AiVoiceServiceClient::new(channel);
                        client.health_check(tonic::Request::new(ai_voice::HealthCheckRequest {})).await.is_ok()
                    } else {
                        false
                    }
                }
                Err(_) => false,
            }
        }
        "vision" => {
            match Channel::from_shared(addr.clone())
                .map_err(|e| e.to_string())
                .and_then(|ep| Ok(ep.connect_timeout(std::time::Duration::from_secs(3))))
            {
                Ok(endpoint) => {
                    let result = endpoint.connect().await;
                    if let Ok(channel) = result {
                        let mut client = vision::vision_service_client::VisionServiceClient::new(channel);
                        client.health_check(tonic::Request::new(vision::HealthCheckRequest {})).await.is_ok()
                    } else {
                        false
                    }
                }
                Err(_) => false,
            }
        }
        "multimodal" => {
            match Channel::from_shared(addr.clone())
                .map_err(|e| e.to_string())
                .and_then(|ep| Ok(ep.connect_timeout(std::time::Duration::from_secs(3))))
            {
                Ok(endpoint) => {
                    let result = endpoint.connect().await;
                    if let Ok(channel) = result {
                        let mut client = multimodal::multimodal_service_client::MultimodalServiceClient::new(channel);
                        client.health_check(tonic::Request::new(multimodal::HealthCheckRequest {})).await.is_ok()
                    } else {
                        false
                    }
                }
                Err(_) => false,
            }
        }
        _ => {
            false
        }
    };

    let status = if healthy { "healthy" } else { "unreachable" };
    log::debug!("Health check for service '{}' at {}: {}", service, addr, status);

    let mut services = services.lock().unwrap_or_else(|e| e.into_inner());
    services.insert(service.clone(), ServiceStatus {
        name: service.to_uppercase().to_string(),
        status: status.to_string(),
        endpoint: addr,
        last_check: chrono::Utc::now().to_rfc3339(),
    });

    Ok(healthy)
}

fn json_value_to_bytes(value: &serde_json::Value) -> Option<Vec<u8>> {
    match value {
        serde_json::Value::Array(entries) => entries
            .iter()
            .map(|entry| entry.as_u64().and_then(|v| u8::try_from(v).ok()))
            .collect(),
        serde_json::Value::String(text) => Some(text.as_bytes().to_vec()),
        _ => None,
    }
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            stt_transcribe,
            stt_get_status,
            tts_synthesize,
            tts_get_status,
            ai_voice_process,
            vision_process,
            multimodal_process,
            get_all_services_status,
            check_service_health
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
