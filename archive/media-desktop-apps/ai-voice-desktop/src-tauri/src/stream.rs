use crate::audio;
use crate::error::{AppError, AppResult};
use crate::models::{AudioStreamChunk, AudioStreamPlan};

pub fn build_stream_plan(path: &str, chunk_ms: u32) -> AppResult<AudioStreamPlan> {
    if chunk_ms == 0 {
        return Err(AppError::InvalidRequest("chunk_ms must be positive".to_string()));
    }

    let metadata = audio::load_audio_metadata(path)?;
    let buffer = audio::load_wav_as_audio_buffer(path)?;
    let channels = buffer.config.channels.max(1) as usize;
    let frames_per_chunk = ((buffer.config.sample_rate as u64 * chunk_ms as u64) / 1000).max(1) as usize;
    let total_frames = buffer.samples.len() / channels;
    let mut chunks = Vec::new();
    let mut frame_index = 0usize;
    let mut chunk_index = 0u32;

    while frame_index < total_frames {
        let chunk_frames = (total_frames - frame_index).min(frames_per_chunk);
        let start_index = frame_index * channels;
        let end_index = start_index + chunk_frames * channels;
        let peak_level = buffer.samples[start_index..end_index]
            .iter()
            .fold(0.0f32, |peak, sample| peak.max(sample.abs()));
        let start_ms = ((frame_index as f64 / buffer.config.sample_rate as f64) * 1000.0).round() as u64;
        let end_ms = (((frame_index + chunk_frames) as f64 / buffer.config.sample_rate as f64) * 1000.0)
            .round() as u64;
        chunks.push(AudioStreamChunk {
            index: chunk_index,
            start_ms,
            end_ms,
            sample_count: chunk_frames * channels,
            peak_level,
        });
        frame_index += chunk_frames;
        chunk_index += 1;
    }

    Ok(AudioStreamPlan {
        path: path.to_string(),
        sample_rate: metadata.sample_rate,
        channels: metadata.channels,
        chunk_ms,
        total_chunks: chunks.len(),
        chunks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use speech_audio_rust::{write_wav, AudioBuffer, AudioConfig, SampleFormat};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn builds_stream_plan_for_audio_file() {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("stream-{unique}.wav"));
        let buffer = AudioBuffer::new(
            vec![0.0; 16_000],
            AudioConfig {
                sample_rate: 16_000,
                channels: 1,
                sample_format: SampleFormat::F32,
            },
        );
        write_wav(&path, &buffer).unwrap();

        let plan = build_stream_plan(path.to_str().unwrap(), 250).unwrap();
        assert_eq!(plan.sample_rate, 16_000);
        assert!(!plan.chunks.is_empty());
        let _ = std::fs::remove_file(path);
    }
}