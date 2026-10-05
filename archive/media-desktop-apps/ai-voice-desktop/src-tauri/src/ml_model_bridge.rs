/**
 * Python Bridge Module - Phase 4 Integration
 *
 * Provides Rust functions to call Phase 4 Python modules:
 * - Model Manager
 * - Quality Metrics
 * - Effects Processing
 */

use pyo3::prelude::*;
use pyo3::types::{PyDict, PyModule};
use anyhow::{Context, Result};
use serde_json;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// Type definitions for audio quality metrics
#[derive(Debug, Serialize, Deserialize)]
pub struct AudioQualityMetrics {
    pub mean_opinion_score: f64,
    pub word_error_rate: Option<f64>,
    pub speaker_similarity_score: Option<f64>,
    pub signal_to_noise_ratio_db: f64,
    pub perceptual_evaluation_score: Option<f64>,
    pub short_time_intelligibility: Option<f64>,
}

// Type definitions for audio effects configuration
#[derive(Debug, Serialize, Deserialize)]
pub struct AudioEffectsConfig {
    pub reverb: Option<ReverbEffectConfig>,
    pub delay: Option<DelayEffectConfig>,
    pub equalizer: Option<EqualizerConfig>,
    pub compressor: Option<CompressorEffectConfig>,
    pub limiter: Option<LimiterEffectConfig>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReverbEffectConfig {
    pub room_size: f32,
    pub wet: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DelayEffectConfig {
    pub time: f32,
    pub feedback: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EqualizerConfig {
    pub bands: Vec<EqualizerBand>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EqualizerBand {
    pub freq: f32,
    pub gain: f32,
    pub q: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CompressorEffectConfig {
    pub threshold: f32,
    pub ratio: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LimiterEffectConfig {
    pub threshold: f32,
}

/// Initialize Python interpreter and import Phase 4 modules
fn init_python() -> Result<()> {
    pyo3::prepare_freethreaded_python();
    Ok(())
}

// ============================================================================
// Model Manager Functions
// ============================================================================

pub fn list_downloaded_models(cache_dir: &str) -> Result<Vec<String>> {
    init_python()?;
    let python_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python");
    let python_dir = python_dir.to_string_lossy().to_string();

    Python::with_gil(|py| {
        let module = PyModule::from_code_bound(
            py,
            &format!(
                r#"
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, r'''{}''')
from models.model_manager import get_model_manager

def list_downloaded(cache_dir):
    manager = get_model_manager(cache_dir)
    return manager.list_downloaded()
"#,
                python_dir
            ),
            "model_manager_bridge.py",
            "model_manager_bridge",
        )?;

        let result = module
            .getattr("list_downloaded")?
            .call1((cache_dir,))?;

        let models: Vec<String> = result.extract()?;
        Ok(models)
    })
}

pub fn download_ml_model(model_id: &str, cache_dir: &str) -> Result<()> {
    init_python()?;
    let python_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python");
    let python_dir = python_dir.to_string_lossy().to_string();

    Python::with_gil(|py| {
        let module = PyModule::from_code_bound(
            py,
            &format!(
                r#"
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, r'''{}''')
from models.model_manager import get_model_manager

def download(model_id, cache_dir):
    manager = get_model_manager(cache_dir)
    manager.download_model(model_id)
    return True
"#,
                python_dir
            ),
            "model_manager_bridge.py",
            "model_manager_bridge",
        )?;

        module
            .getattr("download")?
            .call1((model_id, cache_dir))?;

        Ok(())
    })
}

pub fn delete_ml_model(model_id: &str, cache_dir: &str) -> Result<()> {
    init_python()?;
    let python_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python");
    let python_dir = python_dir.to_string_lossy().to_string();

    Python::with_gil(|py| {
        let module = PyModule::from_code_bound(
            py,
            &format!(
                r#"
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, r'''{}''')
from models.model_manager import get_model_manager

def delete(model_id, cache_dir):
    manager = get_model_manager(cache_dir)
    manager.delete_model(model_id)
    return True
"#,
                python_dir
            ),
            "model_manager_bridge.py",
            "model_manager_bridge",
        )?;

        module
            .getattr("delete")?
            .call1((model_id, cache_dir))?;

        Ok(())
    })
}

pub fn get_cache_size_in_megabytes(cache_dir: &str) -> Result<f64> {
    init_python()?;
    let python_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python");
    let python_dir = python_dir.to_string_lossy().to_string();

    Python::with_gil(|py| {
        let module = PyModule::from_code_bound(
            py,
            &format!(
                r#"
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, r'''{}''')
from models.model_manager import get_model_manager

def get_size(cache_dir):
    manager = get_model_manager(cache_dir)
    return manager.get_cache_size()
"#,
                python_dir
            ),
            "model_manager_bridge.py",
            "model_manager_bridge",
        )?;

        let result = module
            .getattr("get_size")?
            .call1((cache_dir,))?;

        let size: f64 = result.extract()?;
        Ok(size)
    })
}

pub fn clear_model_cache(cache_dir: &str) -> Result<()> {
    init_python()?;
    let python_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python");
    let python_dir = python_dir.to_string_lossy().to_string();

    Python::with_gil(|py| {
        let module = PyModule::from_code_bound(
            py,
            &format!(
                r#"
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, r'''{}''')
from models.model_manager import get_model_manager

def clear(cache_dir):
    manager = get_model_manager(cache_dir)
    manager.clear_cache()
    return True
"#,
                python_dir
            ),
            "model_manager_bridge.py",
            "model_manager_bridge",
        )?;

        module
            .getattr("clear")?
            .call1((cache_dir,))?;

        Ok(())
    })
}

// ============================================================================
// Quality Metrics Functions
// ============================================================================

pub fn assess_audio_quality(
    audio_path: &str,
    reference_text: Option<&str>,
    reference_audio: Option<&str>,
) -> Result<AudioQualityMetrics> {
    Python::with_gil(|py| {
        let module = PyModule::from_code_bound(
            py,
            r#"
import sys
sys.path.insert(0, 'src-tauri/python')
from quality.quality_metrics import assess_audio_quality

def assess(audio_path, reference_text, reference_audio):
    return assess_audio_quality(
        audio_path,
        reference_text,
        reference_audio
    )
"#,
            "quality_bridge.py",
            "quality_bridge",
        )?;

        let result = module
            .getattr("assess")?
            .call1((audio_path, reference_text, reference_audio))?;

        // Extract metrics from Python dict
        let metrics_dict = result.downcast::<PyDict>()
            .map_err(|e| anyhow::anyhow!("Failed to downcast result: {}", e))?;

        let mos_score: f64 = metrics_dict.get_item("mos_score")?.ok_or_else(|| anyhow::anyhow!("Missing mos_score"))?.extract()?;
        let wer: Option<f64> = metrics_dict.get_item("wer")?.and_then(|v| v.extract().ok());
        let speaker_similarity: Option<f64> = metrics_dict.get_item("speaker_similarity")?.and_then(|v| v.extract().ok());
        let snr: f64 = metrics_dict.get_item("snr")?.ok_or_else(|| anyhow::anyhow!("Missing snr"))?.extract()?;
        let pesq: Option<f64> = metrics_dict.get_item("pesq")?.and_then(|v| v.extract().ok());
        let stoi: Option<f64> = metrics_dict.get_item("stoi")?.and_then(|v| v.extract().ok());

        Ok(AudioQualityMetrics {
            mean_opinion_score: mos_score,
            word_error_rate: wer,
            speaker_similarity_score: speaker_similarity,
            signal_to_noise_ratio_db: snr,
            perceptual_evaluation_score: pesq,
            short_time_intelligibility: stoi,
        })
    })
}

// ============================================================================
// Effects Functions
// ============================================================================

pub fn apply_audio_effects(
    audio_path: &str,
    output_path: &str,
    effects_config: AudioEffectsConfig,
    sample_rate: u32,
) -> Result<String> {
    Python::with_gil(|py| {
        let module = PyModule::from_code_bound(
            py,
            r#"
import sys
sys.path.insert(0, 'src-tauri/python')
from effects.audio_effects import apply_effects
import soundfile as sf

def process(audio_path, output_path, effects_config_json, sample_rate):
    import json
    effects_config = json.loads(effects_config_json)

    # Load audio
    audio, sr = sf.read(audio_path)

    # Apply effects
    processed = apply_effects(audio, sample_rate, effects_config)

    # Save
    sf.write(output_path, processed, sample_rate)

    return output_path
"#,
            "effects_bridge.py",
            "effects_bridge",
        )?;

        // Convert effects config to JSON
        let config_json = serde_json::to_string(&effects_config)
            .context("Failed to serialize effects config")?;

        let result = module
            .getattr("process")?
            .call1((audio_path, output_path, config_json, sample_rate))?;

        let output: String = result.extract()?;
        Ok(output)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_python_init() {
        assert!(init_python().is_ok());
    }
}

