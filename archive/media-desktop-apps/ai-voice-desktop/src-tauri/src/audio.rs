//! Audio processing utilities.

use crate::error::{AppError, AppResult};
use crate::metrics::AudioRuntimeMetrics;
use crate::models::AudioMetadata;
use speech_audio_rust::{
    extract_waveform as shared_extract_waveform, load_audio_buffer as shared_load_audio_buffer,
    load_audio_metadata as shared_load_audio_metadata, mix_audio as shared_mix_audio,
    slice_audio_buffer, write_wav, AudioBuffer, Resampler,
};

/// Load audio file and return metadata.
pub fn load_audio_metadata(path: &str) -> AppResult<AudioMetadata> {
    let metrics = AudioRuntimeMetrics::global();
    metrics.record_audio_load_attempt();
    let metadata = match shared_load_audio_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            metrics.record_audio_load_failure();
            return Err(map_audio_error(error));
        }
    };
    Ok(AudioMetadata {
        path: metadata.path,
        name: metadata.name,
        duration: metadata.duration,
        sample_rate: metadata.sample_rate,
        channels: metadata.channels,
        format: metadata.format,
    })
}

/// Get audio duration in seconds.
pub fn get_audio_duration(path: &str) -> AppResult<f64> {
    let metadata = load_audio_metadata(path)?;
    Ok(metadata.duration)
}

/// Extract waveform data for visualization.
pub fn extract_waveform(path: &str, num_samples: usize) -> AppResult<Vec<f32>> {
    shared_extract_waveform(path, num_samples).map_err(map_audio_error)
}

pub fn load_wav_as_audio_buffer(path: &str) -> AppResult<AudioBuffer> {
    let metrics = AudioRuntimeMetrics::global();
    metrics.record_audio_load_attempt();
    shared_load_audio_buffer(path).map_err(|error| {
        metrics.record_audio_load_failure();
        map_audio_error(error)
    })
}

/// Resample audio to target sample rate.
pub fn resample_audio(
    input_path: &str,
    output_path: &str,
    target_sample_rate: u32,
) -> AppResult<()> {
    let buffer = shared_load_audio_buffer(input_path).map_err(map_audio_error)?;
    let resampled = Resampler::new(target_sample_rate)
        .resample(&buffer)
        .map_err(map_audio_error)?;
    write_wav(output_path, &resampled).map_err(map_audio_error)
}

/// Decode any supported input audio and write it as a WAV file.
pub fn export_as_wav(input_path: &str, output_path: &str) -> AppResult<()> {
    let buffer = shared_load_audio_buffer(input_path).map_err(map_audio_error)?;
    write_wav(output_path, &buffer).map_err(map_audio_error)
}

/// Slice audio between start and end times.
pub fn slice_audio(
    input_path: &str,
    output_path: &str,
    start_time: f64,
    end_time: f64,
) -> AppResult<()> {
    let buffer = shared_load_audio_buffer(input_path).map_err(map_audio_error)?;
    let sliced = slice_audio_buffer(&buffer, start_time, end_time).map_err(map_audio_error)?;
    write_wav(output_path, &sliced).map_err(map_audio_error)
}

/// Mix multiple audio files together.
pub fn mix_audio(input_paths: &[&str], volumes: &[f32], output_path: &str) -> AppResult<()> {
    let buffers = input_paths
        .iter()
        .map(|path| shared_load_audio_buffer(path).map_err(map_audio_error))
        .collect::<AppResult<Vec<_>>>()?;
    let mixed = shared_mix_audio(&buffers, volumes).map_err(map_audio_error)?;
    write_wav(output_path, &mixed).map_err(map_audio_error)
}

fn map_audio_error(error: speech_audio_rust::SpeechAudioError) -> AppError {
    match error {
        speech_audio_rust::SpeechAudioError::FileNotFound(path) => AppError::FileNotFound(path),
        speech_audio_rust::SpeechAudioError::UnsupportedFormat(message)
        | speech_audio_rust::SpeechAudioError::InvalidInput(message) => AppError::InvalidRequest(message),
        speech_audio_rust::SpeechAudioError::Decode(message)
        | speech_audio_rust::SpeechAudioError::Encode(message) => AppError::Audio(message),
        speech_audio_rust::SpeechAudioError::Io(error) => AppError::Io(error),
    }
}
