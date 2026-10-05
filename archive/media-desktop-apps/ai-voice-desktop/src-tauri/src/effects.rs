use crate::error::{AppError, AppResult};
use crate::models::{BuiltinEffectsConfig, BuiltinEffectsResult};

pub fn apply_builtin_effects(
    input_path: &str,
    output_path: &str,
    config: &BuiltinEffectsConfig,
) -> AppResult<BuiltinEffectsResult> {
    let mut buffer = speech_audio_rust::load_audio_buffer(input_path)
        .map_err(|error| AppError::Audio(error.to_string()))?;

    if let Some(gain_db) = config.gain_db {
        let gain = 10f32.powf(gain_db / 20.0);
        for sample in &mut buffer.samples {
            *sample *= gain;
        }
    }

    if let Some(fade_in_ms) = config.fade_in_ms {
        apply_fade(&mut buffer.samples, buffer.config.sample_rate, buffer.config.channels, fade_in_ms, true);
    }
    if let Some(fade_out_ms) = config.fade_out_ms {
        apply_fade(&mut buffer.samples, buffer.config.sample_rate, buffer.config.channels, fade_out_ms, false);
    }
    if let Some(delay_ms) = config.echo_delay_ms {
        apply_echo(
            &mut buffer.samples,
            buffer.config.sample_rate,
            buffer.config.channels,
            delay_ms,
            config.echo_decay.unwrap_or(0.35),
        );
    }

    let peak = buffer.samples.iter().fold(0.0f32, |max_peak, sample| max_peak.max(sample.abs()));
    if config.normalize && peak > 0.0 {
        for sample in &mut buffer.samples {
            *sample /= peak;
        }
    }

    let peak = buffer.samples.iter().fold(0.0f32, |max_peak, sample| max_peak.max(sample.abs()));
    speech_audio_rust::write_wav(output_path, &buffer)
        .map_err(|error| AppError::Audio(error.to_string()))?;

    Ok(BuiltinEffectsResult {
        output_path: output_path.to_string(),
        duration_seconds: buffer.duration_seconds(),
        peak_level: peak,
    })
}

fn apply_fade(samples: &mut [f32], sample_rate: u32, channels: u16, fade_ms: u32, fade_in: bool) {
    let frames = ((sample_rate as u64 * fade_ms as u64) / 1000) as usize;
    let channels = channels.max(1) as usize;
    let total_frames = samples.len() / channels;
    let fade_frames = frames.min(total_frames);
    for frame in 0..fade_frames {
        let ratio = frame as f32 / fade_frames.max(1) as f32;
        let multiplier = if fade_in { ratio } else { 1.0 - ratio };
        let target_frame = if fade_in { frame } else { total_frames - fade_frames + frame };
        for channel in 0..channels {
            samples[target_frame * channels + channel] *= multiplier;
        }
    }
}

fn apply_echo(samples: &mut [f32], sample_rate: u32, channels: u16, delay_ms: u32, decay: f32) {
    let channels = channels.max(1) as usize;
    let delay_frames = ((sample_rate as u64 * delay_ms as u64) / 1000) as usize;
    let delay_samples = delay_frames * channels;
    if delay_samples == 0 || decay <= 0.0 {
        return;
    }
    for index in delay_samples..samples.len() {
        let echoed = samples[index - delay_samples] * decay;
        samples[index] = (samples[index] + echoed).clamp(-1.0, 1.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use speech_audio_rust::{write_wav, AudioBuffer, AudioConfig, SampleFormat};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn applies_builtin_effects_and_writes_output() {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let input = std::env::temp_dir().join(format!("effects-input-{unique}.wav"));
        let output = std::env::temp_dir().join(format!("effects-output-{unique}.wav"));
        let buffer = AudioBuffer::new(
            vec![0.2; 8000],
            AudioConfig {
                sample_rate: 8000,
                channels: 1,
                sample_format: SampleFormat::F32,
            },
        );
        write_wav(&input, &buffer).unwrap();

        let result = apply_builtin_effects(
            input.to_str().unwrap(),
            output.to_str().unwrap(),
            &BuiltinEffectsConfig {
                gain_db: Some(3.0),
                normalize: true,
                fade_in_ms: Some(10),
                fade_out_ms: Some(10),
                echo_delay_ms: Some(20),
                echo_decay: Some(0.25),
            },
        )
        .unwrap();

        assert!(std::path::Path::new(&result.output_path).exists());
        assert!(result.duration_seconds > 0.0);
        let _ = std::fs::remove_file(input);
        let _ = std::fs::remove_file(output);
    }
}