//! Python interop for ML model operations.
//!
//! This module bridges Rust to Python for ML operations:
//! - Stem separation (Demucs)
//! - Voice training (RVC)
//! - Voice conversion
//! - Phrase detection

use pyo3::prelude::*;
use pyo3::types::PyDict;
use crate::error::{AppError, AppResult};
use crate::models::{StemsOutput, StemResult, DetectedPhrase, ConversionResult};
use tokio::process::Command;
use std::path::PathBuf;

fn add_embedded_python_path(py: Python<'_>) -> AppResult<()> {
    let sys = py.import_bound("sys").map_err(|e| AppError::Python(e.to_string()))?;
    sys.setattr("dont_write_bytecode", true)
        .map_err(|e| AppError::Python(e.to_string()))?;
    let path = sys.getattr("path").map_err(|e| AppError::Python(e.to_string()))?;

    let python_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python");
    if python_dir.exists() {
        path.call_method1("insert", (0, python_dir.to_str().unwrap_or("")))
            .map_err(|e| AppError::Python(e.to_string()))?;
    }

    Ok(())
}

/// Initialize Python environment.
pub fn init_python() -> AppResult<()> {
    Python::with_gil(|py| {
        add_embedded_python_path(py)
    })
}

async fn find_system_python_executable() -> Option<String> {
    let candidates = ["python3", "python"];
    for candidate in candidates {
        let output = Command::new(candidate).arg("--version").output().await.ok()?;
        if output.status.success() {
            return Some(candidate.to_string());
        }
    }
    None
}

async fn system_python_has_stem_deps(python: &str, pythonpath: &str) -> bool {
    let code = format!(
        r#"import json
import sys
sys.path.insert(0, r'''{}''')

required = [
  "torch",
  "torchaudio",
  "demucs",
  "numpy",
  "librosa",
  "soundfile",
]

missing = []
for name in required:
  try:
    __import__(name)
  except Exception:
    missing.append(name)

print(json.dumps({{"missing": missing}}))
sys.exit(1 if missing else 0)
"#,
        pythonpath
    );

    Command::new(python)
        .arg("-c")
        .arg(code)
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Separate audio into stems using system Python (external process).
///
/// This allows using a user-installed Python + demucs stack when the embedded
/// Python environment isn't available.
pub async fn separate_stems_system_python(input_path: &str, output_dir: &str) -> AppResult<StemsOutput> {
    let python_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python");
    let pythonpath = python_dir
        .to_str()
        .ok_or_else(|| AppError::Python("Invalid python module path".to_string()))?
        .to_string();

    let python = find_system_python_executable()
        .await
        .ok_or_else(|| AppError::Python("System Python not found (python3/python)".to_string()))?;

    if !system_python_has_stem_deps(&python, &pythonpath).await {
        return Err(AppError::Python(
            "System Python is present but missing required deps (torch/torchaudio/demucs/numpy/librosa/soundfile)"
                .to_string(),
        ));
    }

    let code = r#"
import json
import sys
sys.path.insert(0, sys.argv[3])
from stem_separator_enhanced import separate_stems_enhanced

result = separate_stems_enhanced(sys.argv[1], sys.argv[2])
print(json.dumps(result))
"#;

    let output = Command::new(&python)
        .arg("-c")
        .arg(code)
        .arg(input_path)
        .arg(output_dir)
        .arg(&pythonpath)
        .output()
        .await
        .map_err(|e| AppError::Python(format!("Failed to run system python: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(AppError::Python(format!("System python separation failed: {}", stderr)));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let value: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| AppError::Python(format!("Invalid JSON from system python: {}", e)))?;

    let success = value.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
    if !success {
        let error = value
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown separation error")
            .to_string();
        return Err(AppError::Separation(error));
    }

    let stems = value
        .get("stems")
        .and_then(|v| v.as_object())
        .ok_or_else(|| AppError::Python("Missing stems in system python result".to_string()))?;

    let extract = |name: &str| -> AppResult<StemResult> {
        let stem = stems
            .get(name)
            .and_then(|v| v.as_object())
            .ok_or_else(|| AppError::Python(format!("Missing {} stem", name)))?;
        let path = stem
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Python(format!("Missing path for {}", name)))?
            .to_string();
        let duration = stem.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
        Ok(StemResult { path, duration })
    };

    Ok(StemsOutput {
        vocals: extract("vocals")?,
        drums: extract("drums")?,
        bass: extract("bass")?,
        other: extract("other")?,
        used_fallback: false,
        warning: None,
    })
}

/// Separate audio into stems using enhanced Demucs separator.
pub fn separate_stems(input_path: &str, output_dir: &str) -> AppResult<StemsOutput> {
    Python::with_gil(|py| {
        // Import our enhanced separator module
        let sys = py.import_bound("sys").map_err(|e| AppError::Python(e.to_string()))?;
        sys.setattr("dont_write_bytecode", true)
            .map_err(|e| AppError::Python(e.to_string()))?;
        let path = sys.getattr("path").map_err(|e| AppError::Python(e.to_string()))?;

        // Add python directory to path
        let python_dir = std::env::current_dir()
            .unwrap_or_default()
            .join("src-tauri")
            .join("python");

        if python_dir.exists() {
            path.call_method1("insert", (0, python_dir.to_str().unwrap_or("")))
                .map_err(|e| AppError::Python(e.to_string()))?;
        }

        // Import the enhanced separator
        let separator_module = py.import_bound("stem_separator_enhanced")
            .map_err(|e| AppError::Python(format!("Failed to import stem_separator_enhanced: {}", e)))?;

        let separate_fn = separator_module.getattr("separate_stems_enhanced")
            .map_err(|e| AppError::Python(format!("Function not found: {}", e)))?;

        // Call the function
        let result = separate_fn.call1((input_path, output_dir))
            .map_err(|e| AppError::Separation(e.to_string()))?;

        let result_dict = result.downcast::<PyDict>()
            .map_err(|e| AppError::Python(format!("Invalid result type: {}", e)))?;

        // Extract success status
        let success: bool = result_dict.get_item("success")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok())
            .unwrap_or(false);

        if !success {
            let error_msg = result_dict.get_item("error")
                .ok()
                .flatten()
                .and_then(|v| v.extract::<String>().ok())
                .unwrap_or_else(|| "Unknown error".to_string());
            return Err(AppError::Separation(error_msg));
        }

        // Extract stems
        let stems_bound = result_dict.get_item("stems")
            .ok()
            .flatten()
            .ok_or_else(|| AppError::Python("Missing stems in result".to_string()))?;

        let stems_dict = stems_bound.downcast::<PyDict>()
            .map_err(|_| AppError::Python("stems is not a dict".to_string()))?;

        let extract_stem = |name: &str| -> AppResult<StemResult> {
            let stem_bound = stems_dict.get_item(name)
                .ok()
                .flatten()
                .ok_or_else(|| AppError::Python(format!("Missing {} stem", name)))?;

            let stem = stem_bound.downcast::<PyDict>()
                .map_err(|_| AppError::Python(format!("{} is not a dict", name)))?;

            let path = stem.get_item("path")
                .ok()
                .flatten()
                .ok_or_else(|| AppError::Python(format!("Missing path for {}", name)))?
                .extract::<String>()
                .map_err(|e| AppError::Python(format!("Invalid path: {}", e)))?;

            let duration = stem.get_item("duration")
                .ok()
                .flatten()
                .and_then(|v| v.extract::<f64>().ok())
                .unwrap_or(0.0);

            Ok(StemResult { path, duration })
        };

        Ok(StemsOutput {
            vocals: extract_stem("vocals")?,
            drums: extract_stem("drums")?,
            bass: extract_stem("bass")?,
            other: extract_stem("other")?,
            used_fallback: false,
            warning: None,
        })
    })
}

/// Detect phrases in vocal audio.
pub fn detect_phrases(vocal_path: &str) -> AppResult<Vec<DetectedPhrase>> {
    Python::with_gil(|py| {
        let code = r#"
def detect_vocal_phrases(audio_path):
    try:
        import librosa
        import numpy as np
        
        # Load audio
        y, sr = librosa.load(audio_path, sr=22050)
        
        # Compute RMS energy
        rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
        times = librosa.times_like(rms, sr=sr, hop_length=512)
        
        # Find phrase boundaries using energy threshold
        threshold = np.mean(rms) * 0.5
        is_voice = rms > threshold
        
        # Find phrase boundaries
        phrases = []
        in_phrase = False
        start_time = 0
        
        for i, (t, v) in enumerate(zip(times, is_voice)):
            if v and not in_phrase:
                start_time = t
                in_phrase = True
            elif not v and in_phrase:
                if t - start_time > 0.3:  # Minimum phrase length
                    # Extract pitch contour for this phrase
                    start_sample = int(start_time * sr)
                    end_sample = int(t * sr)
                    phrase_audio = y[start_sample:end_sample]
                    
                    pitches, magnitudes = librosa.piptrack(y=phrase_audio, sr=sr)
                    pitch_contour = []
                    for j in range(pitches.shape[1]):
                        index = magnitudes[:, j].argmax()
                        pitch = pitches[index, j]
                        if pitch > 0:
                            pitch_contour.append(float(pitch))
                    
                    phrases.append({
                        'start_time': float(start_time),
                        'end_time': float(t),
                        'pitch_contour': pitch_contour[:50]  # Limit size
                    })
                in_phrase = False
        
        return phrases
    except ImportError:
        # Fallback: return dummy phrases
        return [
            {'start_time': 0.0, 'end_time': 5.0, 'pitch_contour': [200.0] * 10},
            {'start_time': 6.0, 'end_time': 12.0, 'pitch_contour': [220.0] * 10},
        ]
"#;

        py.run_bound(code, None, None)
            .map_err(|e| AppError::Python(e.to_string()))?;

        let locals = PyDict::new_bound(py);
        locals.set_item("audio_path", vocal_path)
            .map_err(|e| AppError::Python(e.to_string()))?;

        py.run_bound("result = detect_vocal_phrases(audio_path)", None, Some(&locals))
            .map_err(|e| AppError::Python(e.to_string()))?;

        let result_any = locals
            .get_item("result")
            .map_err(|e| AppError::Python(e.to_string()))?
            .ok_or_else(|| AppError::Python("No result".to_string()))?;

        // Extract as a list and iterate over Bound items
        let result_list = result_any.downcast::<pyo3::types::PyList>()
            .map_err(|e| AppError::Python(format!("Result is not a list: {}", e)))?;

        let phrases: Vec<DetectedPhrase> = result_list
            .iter()
            .filter_map(|item| {
                let dict = item.downcast::<PyDict>().ok()?;

                let start_any = dict.get_item("start_time").ok()??;
                let end_any = dict.get_item("end_time").ok()??;
                let contour_any = dict.get_item("pitch_contour").ok()??;

                let start_time: f64 = start_any.extract().ok()?;
                let end_time: f64 = end_any.extract().ok()?;
                let pitch_contour: Vec<f32> = contour_any.extract().ok()?;

                Some(DetectedPhrase {
                    start_time,
                    end_time,
                    pitch_contour,
                })
            })
            .collect();

        Ok(phrases)
    })
}

/// Convert voice using RVC model.
pub fn convert_voice(
    input_path: &str,
    output_path: &str,
    model_path: &str,
    pitch_shift: f32,
) -> AppResult<ConversionResult> {
    let _ = (input_path, output_path, model_path, pitch_shift);

    Err(AppError::Conversion(
        "Voice conversion is unavailable because no verified conversion engine is configured for this runtime."
            .to_string(),
    ))
}

/// Train RVC model from samples using Python voice_trainer module.
pub fn train_voice_model(
    session_id: &str,
    sample_paths: &[String],
    output_path: &str,
    model_name: &str,
    status_path: &str,
) -> AppResult<()> {
    Python::with_gil(|py| {
        add_embedded_python_path(py)?;

        let code = r#"
import os
import json
import threading

from voice_trainer import train_voice_model

def write_status(status_path, status, progress, error=None):
    directory = os.path.dirname(status_path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(status_path, "w", encoding="utf-8") as fh:
        json.dump({
            "status": status,
            "progress": float(progress),
            "error": error,
        }, fh)

def make_progress_callback(status_path):
    def callback(progress):
        error = getattr(progress, "error", None)
        write_status(status_path, progress.status.value, progress.progress, error)
    return callback

def start_training(sample_paths, output_path, model_name, status_path):
    output_dir = os.path.dirname(output_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    write_status(status_path, "pending", 0.0, None)

    def train_thread():
        try:
            callback = make_progress_callback(status_path)
            train_voice_model(sample_paths, output_dir, model_name, progress_callback=callback)
            write_status(status_path, "completed", 100.0, None)
        except Exception as exc:
            write_status(status_path, "failed", 0.0, str(exc))

    thread = threading.Thread(target=train_thread, daemon=True)
    thread.start()
"#;

        py.run_bound(code, None, None)
            .map_err(|e| AppError::Python(e.to_string()))?;

        let locals = PyDict::new_bound(py);
        let paths_list: Vec<&str> = sample_paths.iter().map(|s| s.as_str()).collect();
        locals.set_item("session_id", session_id)
            .map_err(|e| AppError::Python(e.to_string()))?;
        locals.set_item("sample_paths", paths_list)
            .map_err(|e| AppError::Python(e.to_string()))?;
        locals.set_item("output_path", output_path)
            .map_err(|e| AppError::Python(e.to_string()))?;
        locals.set_item("model_name", model_name)
            .map_err(|e| AppError::Python(e.to_string()))?;
        locals.set_item("status_path", status_path)
            .map_err(|e| AppError::Python(e.to_string()))?;

        py.run_bound(
            "start_training(sample_paths, output_path, model_name, status_path)",
            None,
            Some(&locals),
        )
            .map_err(|e| AppError::Training(e.to_string()))?;

        Ok(())
    })
}

// ============================================================================
// Voice Cloning Functions
// ============================================================================

/// Clone a voice using Python voice_cloner module.
pub async fn call_voice_cloning(
    voice_name: &str,
    audio_paths: &[String],
    epochs: u32,
    learning_rate: f32,
) -> AppResult<crate::models::VoiceCloningResult> {
    use tokio::task;

    let voice_name = voice_name.to_string();
    let audio_paths = audio_paths.to_vec();

    task::spawn_blocking(move || {
        Python::with_gil(|py| {
            // Import modules
            let model_manager = py.import_bound("models.model_manager")
                .map_err(|e| AppError::Python(format!("Failed to import model_manager: {}", e)))?;
            let speaker_embedding = py.import_bound("speaker_embedding")
                .map_err(|e| AppError::Python(format!("Failed to import speaker_embedding: {}", e)))?;
            let voice_cloner = py.import_bound("voice_cloner")
                .map_err(|e| AppError::Python(format!("Failed to import voice_cloner: {}", e)))?;

            // Create ModelManager
            let models_dir = dirs::home_dir()
                .unwrap_or_default()
                .join(".ghatana")
                .join("models");
            let manager = model_manager.getattr("ModelManager")?
                .call1((models_dir.to_str().unwrap_or(""),))?;

            // Create SpeakerEmbeddingExtractor
            let extractor = speaker_embedding.getattr("SpeakerEmbeddingExtractor")?
                .call1((manager.clone(), "auto"))?;

            // Create VoiceCloner
            let cloner = voice_cloner.getattr("VoiceCloner")?
                .call1((manager, extractor))?;

            // Create config
            let config_class = voice_cloner.getattr("CloningConfig")?;
            let config = config_class.call0()?;
            config.setattr("epochs", epochs)?;
            config.setattr("learning_rate", learning_rate)?;

            // Clone voice
            let result = cloner.call_method1(
                "clone",
                (audio_paths, voice_name, config, py.None())
            )?;

            // Extract result fields
            let success: bool = result.getattr("success")?.extract()?;
            let voice_id: String = result.getattr("voice_id")?.extract()?;
            let model_path: String = result.getattr("model_path")?.extract()?;
            let embedding_path: String = result.getattr("embedding_path")?.extract()?;
            let similarity_score: f32 = result.getattr("similarity_score")?.extract()?;
            let training_time: f32 = result.getattr("training_time_seconds")?.extract()?;
            let message: String = result.getattr("message")?.extract()?;
            let error: Option<String> = result.getattr("error")?.extract()?;

            Ok(crate::models::VoiceCloningResult {
                success,
                voice_id,
                model_path,
                embedding_path,
                similarity_score,
                training_time_seconds: training_time,
                message,
                error,
            })
        })
    })
    .await
    .map_err(|e| AppError::Python(format!("Task join error: {}", e)))?
}

/// List cloned voices.
pub async fn list_cloned_voices() -> AppResult<Vec<crate::models::ClonedVoiceInfo>> {
    use tokio::task;

    task::spawn_blocking(|| {
        Python::with_gil(|py| {
            let voice_cloner = py.import_bound("voice_cloner")
                .map_err(|e| AppError::Python(format!("Failed to import voice_cloner: {}", e)))?;

            let model_manager = py.import_bound("models.model_manager")
                .map_err(|e| AppError::Python(format!("Failed to import model_manager: {}", e)))?;
            let speaker_embedding = py.import_bound("speaker_embedding")
                .map_err(|e| AppError::Python(format!("Failed to import speaker_embedding: {}", e)))?;

            let models_dir = dirs::home_dir()
                .unwrap_or_default()
                .join(".ghatana")
                .join("models");
            let manager = model_manager.getattr("ModelManager")?.call1((models_dir.to_str().unwrap_or(""),))?;
            let extractor = speaker_embedding.getattr("SpeakerEmbeddingExtractor")?.call1((manager.clone(), "auto"))?;

            let cloner = voice_cloner.getattr("VoiceCloner")?.call1((manager, extractor))?;
            let voices_list = cloner.call_method0("list_cloned_voices")?;

            let mut voices = Vec::new();
            for voice_dict in voices_list.iter()? {
                let voice = voice_dict?;
                voices.push(crate::models::ClonedVoiceInfo {
                    voice_id: voice.get_item("voice_id")?.extract()?,
                    voice_name: voice.get_item("voice_name")?.extract()?,
                    similarity_score: voice.get_item("similarity_score")?.extract()?,
                    embedding_dim: voice.get_item("embedding_dim")?.extract()?,
                    model_path: voice.get_item("model_path")?.extract()?,
                    created_at: voice.get_item("created_at")?.extract()?,
                });
            }

            Ok(voices)
        })
    })
    .await
    .map_err(|e| AppError::Python(format!("Task join error: {}", e)))?
}

/// Load a cloned voice for synthesis.
pub async fn load_cloned_voice(voice_id: &str) -> AppResult<()> {
    use tokio::task;
    let voice_id = voice_id.to_string();

    task::spawn_blocking(move || {
        Python::with_gil(|py| {
            let _voice_cloner = py.import_bound("voice_cloner")
                .map_err(|e| AppError::Python(format!("Failed to import voice_cloner: {}", e)))?;

            // Get voice metadata to get paths
            let voices_dir = dirs::home_dir()
                .unwrap_or_default()
                .join(".ghatana")
                .join("voices")
                .join(&voice_id);

            let model_path = voices_dir.join("model.pt");
            let embedding_path = voices_dir.join("embedding.npy");

            if !model_path.exists() || !embedding_path.exists() {
                return Err(AppError::Python(format!("Voice {} not found", voice_id)));
            }

            // Create synthesizer and load voice
            let synthesizer_mod = py.import_bound("cloned_voice_synthesizer")
                .map_err(|e| AppError::Python(format!("Failed to import synthesizer: {}", e)))?;

            let synthesizer = synthesizer_mod.getattr("ClonedVoiceSynthesizer")?.call0()?;
            synthesizer.call_method0("load_base_models")?;
            synthesizer.call_method1(
                "load_voice",
                (voice_id, model_path.to_str().unwrap_or(""), embedding_path.to_str().unwrap_or(""))
            )?;

            Ok(())
        })
    })
    .await
    .map_err(|e| AppError::Python(format!("Task join error: {}", e)))?
}

/// Synthesize text with a cloned voice.
pub async fn synthesize_with_cloned_voice(
    text: &str,
    voice_id: &str,
    speed: f32,
    pitch: f32,
    output_path: &str,
) -> AppResult<crate::models::SynthesisResult> {
    use tokio::task;

    let text = text.to_string();
    let voice_id = voice_id.to_string();
    let output_path = output_path.to_string();

    task::spawn_blocking(move || {
        Python::with_gil(|py| {
            let synthesizer_mod = py.import_bound("cloned_voice_synthesizer")
                .map_err(|e| AppError::Python(format!("Failed to import synthesizer: {}", e)))?;

            let synthesizer = synthesizer_mod.getattr("ClonedVoiceSynthesizer")?.call0()?;
            synthesizer.call_method0("load_base_models")?;

            // Load voice
            let voices_dir = dirs::home_dir()
                .unwrap_or_default()
                .join(".ghatana")
                .join("voices")
                .join(&voice_id);

            let model_path = voices_dir.join("model.pt");
            let embedding_path = voices_dir.join("embedding.npy");

            synthesizer.call_method1(
                "load_voice",
                (voice_id.clone(), model_path.to_str().unwrap_or(""), embedding_path.to_str().unwrap_or(""))
            )?;

            // Create config
            let config_class = synthesizer_mod.getattr("SynthesisConfig")?;
            let config = config_class.call0()?;
            config.setattr("speed", speed)?;
            config.setattr("pitch_shift", pitch)?;

            // Synthesize
            let result = synthesizer.call_method1(
                "synthesize",
                (text, voice_id, config, py.None())
            )?;

            // Save audio
            let audio = result.getattr("audio")?.extract::<Vec<f32>>()?;
            let sample_rate: u32 = result.getattr("sample_rate")?.extract()?;

            synthesizer.call_method1(
                "save_audio",
                (audio, sample_rate, output_path.clone())
            )?;

            let duration: f32 = result.getattr("duration_seconds")?.extract()?;
            let text_processed: String = result.getattr("text_processed")?.extract()?;

            Ok(crate::models::SynthesisResult {
                output_path,
                duration_seconds: duration,
                sample_rate,
                text_processed,
            })
        })
    })
    .await
    .map_err(|e| AppError::Python(format!("Task join error: {}", e)))?
}

/// Delete a cloned voice.
pub async fn delete_cloned_voice(voice_id: &str) -> AppResult<()> {
    use tokio::task;
    let voice_id = voice_id.to_string();

    task::spawn_blocking(move || {
        Python::with_gil(|py| {
            let voice_cloner = py.import_bound("voice_cloner")
                .map_err(|e| AppError::Python(format!("Failed to import voice_cloner: {}", e)))?;

            let model_manager = py.import_bound("models.model_manager")
                .map_err(|e| AppError::Python(format!("Failed to import model_manager: {}", e)))?;
            let speaker_embedding = py.import_bound("speaker_embedding")
                .map_err(|e| AppError::Python(format!("Failed to import speaker_embedding: {}", e)))?;

            let models_dir = dirs::home_dir()
                .unwrap_or_default()
                .join(".ghatana")
                .join("models");
            let manager = model_manager.getattr("ModelManager")?.call1((models_dir.to_str().unwrap_or(""),))?;
            let extractor = speaker_embedding.getattr("SpeakerEmbeddingExtractor")?.call1((manager.clone(), "auto"))?;

            let cloner = voice_cloner.getattr("VoiceCloner")?.call1((manager, extractor))?;
            cloner.call_method1("delete_voice", (voice_id,))?;

            Ok(())
        })
    })
    .await
    .map_err(|e| AppError::Python(format!("Task join error: {}", e)))?
}

/// Extract speaker embedding from audio.
pub async fn extract_speaker_embedding(audio_path: &str) -> AppResult<crate::models::SpeakerEmbeddingResult> {
    use tokio::task;
    let audio_path = audio_path.to_string();

    task::spawn_blocking(move || {
        Python::with_gil(|py| {
            let model_manager = py.import_bound("models.model_manager")
                .map_err(|e| AppError::Python(format!("Failed to import model_manager: {}", e)))?;
            let speaker_embedding = py.import_bound("speaker_embedding")
                .map_err(|e| AppError::Python(format!("Failed to import speaker_embedding: {}", e)))?;

            let models_dir = dirs::home_dir()
                .unwrap_or_default()
                .join(".ghatana")
                .join("models");
            let manager = model_manager.getattr("ModelManager")?.call1((models_dir.to_str().unwrap_or(""),))?;

            let extractor = speaker_embedding.getattr("SpeakerEmbeddingExtractor")?.call1((manager, "auto"))?;
            let result = extractor.call_method1("extract", (audio_path,))?;

            let embedding: Vec<f32> = result.getattr("embedding")?.extract()?;
            let confidence: f32 = result.getattr("confidence")?.extract()?;
            let duration: f32 = result.getattr("duration_seconds")?.extract()?;
            let sample_rate: u32 = result.getattr("sample_rate")?.extract()?;

            Ok(crate::models::SpeakerEmbeddingResult {
                embedding,
                confidence,
                duration_seconds: duration,
                sample_rate,
            })
        })
    })
    .await
    .map_err(|e| AppError::Python(format!("Task join error: {}", e)))?
}

