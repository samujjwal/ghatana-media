//! Bounded, deterministic waveform repair primitives.
//!
//! These operations are intentionally simple DSP: denoise applies a smooth
//! block noise gate estimated from an explicitly supplied noise-only region;
//! declip linearly reconstructs bounded clipped runs. They are not a learned
//! speech enhancement model and synthetic tests do not qualify perceptual
//! quality on production speech.

use crate::{AudioBuffer, Result, SampleFormat, SpeechAudioError};

const MAX_REPAIR_SAMPLES: usize = 6_000_000;
const MAX_PROFILE_FRAMES: usize = 2_000_000;
const MAX_BLOCK_FRAMES: usize = 16_384;
const MAX_DECLIP_RUN_FRAMES: usize = 4_096;
const MAX_REPAIR_CHANNELS: u16 = 8;
const MAX_REPAIR_SAMPLE_RATE: u32 = 768_000;

#[derive(Debug, Clone, Copy)]
pub struct RepairLimits {
    pub max_samples: usize,
    pub max_profile_frames: usize,
    pub max_declip_run_frames: usize,
}

impl RepairLimits {
    pub const DEFAULT: Self = Self {
        max_samples: MAX_REPAIR_SAMPLES,
        max_profile_frames: MAX_PROFILE_FRAMES,
        max_declip_run_frames: MAX_DECLIP_RUN_FRAMES,
    };

    fn validate(self) -> Result<Self> {
        if self.max_samples == 0
            || self.max_samples > MAX_REPAIR_SAMPLES
            || self.max_profile_frames == 0
            || self.max_profile_frames > MAX_PROFILE_FRAMES
            || self.max_declip_run_frames == 0
            || self.max_declip_run_frames > MAX_DECLIP_RUN_FRAMES
        {
            return Err(SpeechAudioError::InvalidInput(
                "repair limits must be positive and cannot exceed crate hard caps".into(),
            ));
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct NoiseProfile {
    pub sample_rate: u32,
    pub channels: u16,
    pub rms_by_channel: Vec<f32>,
    pub profile_frames: usize,
}

impl NoiseProfile {
    /// Estimate per-channel RMS from a caller-designated noise-only frame span.
    /// The function never guesses which part of a recording is noise.
    pub fn estimate(buffer: &AudioBuffer, start_frame: usize, end_frame: usize) -> Result<Self> {
        Self::estimate_bounded(buffer, start_frame, end_frame, RepairLimits::DEFAULT)
    }

    pub fn estimate_bounded(
        buffer: &AudioBuffer,
        start_frame: usize,
        end_frame: usize,
        limits: RepairLimits,
    ) -> Result<Self> {
        validate_buffer(buffer, limits)?;
        let limits = limits.validate()?;
        let frames = buffer.frame_count();
        if start_frame >= end_frame || end_frame > frames {
            return Err(SpeechAudioError::InvalidInput(
                "noise profile range must be a non-empty in-bounds frame span".into(),
            ));
        }
        let profile_frames = end_frame - start_frame;
        if profile_frames > limits.max_profile_frames {
            return Err(SpeechAudioError::ResourceLimit(
                "noise profile exceeds the configured frame budget".into(),
            ));
        }
        let channels = buffer.config.channels as usize;
        let mut squares = vec![0.0f64; channels];
        for frame in start_frame..end_frame {
            for (channel, sum) in squares.iter_mut().enumerate() {
                let sample = buffer.samples[frame * channels + channel] as f64;
                *sum += sample * sample;
            }
        }
        let rms_by_channel = squares
            .into_iter()
            .map(|sum| (sum / profile_frames as f64).sqrt() as f32)
            .collect();
        Ok(Self {
            sample_rate: buffer.config.sample_rate,
            channels: buffer.config.channels,
            rms_by_channel,
            profile_frames,
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct DenoiseOptions {
    /// A block is attenuated when its RMS is below this multiple of the
    /// estimated noise RMS. Must be finite and >= 1.
    pub threshold_multiple: f32,
    /// Minimum gain applied to a block below threshold, in [0, 1].
    pub floor_gain: f32,
    /// Analysis and smoothing block length in frames.
    pub block_frames: usize,
}

impl DenoiseOptions {
    pub const DEFAULT: Self = Self {
        threshold_multiple: 2.0,
        floor_gain: 0.08,
        block_frames: 256,
    };

    fn validate(self) -> Result<Self> {
        if !self.threshold_multiple.is_finite()
            || self.threshold_multiple < 1.0
            || !self.floor_gain.is_finite()
            || !(0.0..=1.0).contains(&self.floor_gain)
            || self.block_frames == 0
            || self.block_frames > MAX_BLOCK_FRAMES
        {
            return Err(SpeechAudioError::InvalidInput(
                "denoise options are outside finite bounded ranges".into(),
            ));
        }
        Ok(self)
    }
}

/// Apply a noise-profile gate with block gain interpolation. All channels use
/// one gain per frame, preserving inter-channel phase and image relationships.
pub fn denoise(
    input: &AudioBuffer,
    profile: &NoiseProfile,
    options: DenoiseOptions,
) -> Result<AudioBuffer> {
    denoise_bounded(input, profile, options, RepairLimits::DEFAULT)
}

pub fn denoise_bounded(
    input: &AudioBuffer,
    profile: &NoiseProfile,
    options: DenoiseOptions,
    limits: RepairLimits,
) -> Result<AudioBuffer> {
    validate_buffer(input, limits)?;
    limits.validate()?;
    let options = options.validate()?;
    if profile.sample_rate != input.config.sample_rate
        || profile.channels != input.config.channels
        || profile.rms_by_channel.len() != input.config.channels as usize
        || profile.profile_frames == 0
        || profile.profile_frames > MAX_PROFILE_FRAMES
        || profile
            .rms_by_channel
            .iter()
            .any(|rms| !rms.is_finite() || *rms < 0.0)
    {
        return Err(SpeechAudioError::InvalidInput(
            "noise profile format does not match the source buffer".into(),
        ));
    }
    if input.samples.is_empty() {
        return Err(SpeechAudioError::InvalidInput(
            "denoise input must not be empty".into(),
        ));
    }
    let channels = input.config.channels as usize;
    let frames = input.frame_count();
    let mut output = Vec::new();
    output
        .try_reserve_exact(input.samples.len())
        .map_err(|error| {
            SpeechAudioError::ResourceLimit(format!("cannot reserve denoise output: {error}"))
        })?;
    let mut previous_gain = 1.0f64;
    for start in (0..frames).step_by(options.block_frames) {
        let end = (start + options.block_frames).min(frames);
        let block_frames = end - start;
        let mut block_rms = 0.0f64;
        for frame in start..end {
            for channel in 0..channels {
                let sample = input.samples[frame * channels + channel] as f64;
                block_rms += sample * sample;
            }
        }
        block_rms = (block_rms / (block_frames * channels) as f64).sqrt();
        let noise_power = profile
            .rms_by_channel
            .iter()
            .map(|rms| (*rms as f64) * (*rms as f64))
            .sum::<f64>()
            / channels as f64;
        let noise_rms = noise_power.sqrt();
        let threshold = noise_rms * options.threshold_multiple as f64;
        // Amplitude is scale-dependent: a fixed machine epsilon would disable
        // the gate for valid quiet recordings even when the profile is nonzero.
        let target_gain = if threshold == 0.0 || block_rms >= threshold {
            1.0
        } else {
            let ratio = (block_rms / threshold).clamp(0.0, 1.0);
            options.floor_gain as f64 + (1.0 - options.floor_gain as f64) * ratio
        };
        for frame in start..end {
            let within = (frame - start + 1) as f64 / block_frames as f64;
            let gain = previous_gain + (target_gain - previous_gain) * within;
            for channel in 0..channels {
                output.push((input.samples[frame * channels + channel] as f64 * gain) as f32);
            }
        }
        previous_gain = target_gain;
    }
    Ok(AudioBuffer::new(output, input.config))
}

/// Reconstruct samples in clipped runs by linear interpolation between their
/// unclipped neighbors. Runs touching a file edge or exceeding the bounded
/// run size are rejected because reconstruction would be underdetermined.
pub fn declip(input: &AudioBuffer, clip_threshold: f32) -> Result<AudioBuffer> {
    declip_bounded(input, clip_threshold, RepairLimits::DEFAULT)
}

pub fn declip_bounded(
    input: &AudioBuffer,
    clip_threshold: f32,
    limits: RepairLimits,
) -> Result<AudioBuffer> {
    validate_buffer(input, limits)?;
    let limits = limits.validate()?;
    if !clip_threshold.is_finite() || !(0.5..=1.0).contains(&clip_threshold) {
        return Err(SpeechAudioError::InvalidInput(
            "clip threshold must be finite and in [0.5, 1]".into(),
        ));
    }
    if input.samples.is_empty() {
        return Err(SpeechAudioError::InvalidInput(
            "declip input must not be empty".into(),
        ));
    }
    let channels = input.config.channels as usize;
    let frames = input.frame_count();
    let mut output = Vec::new();
    output
        .try_reserve_exact(input.samples.len())
        .map_err(|error| {
            SpeechAudioError::ResourceLimit(format!("cannot reserve declip output: {error}"))
        })?;
    output.extend_from_slice(&input.samples);
    for channel in 0..channels {
        let mut frame = 0;
        while frame < frames {
            if output[frame * channels + channel].abs() < clip_threshold {
                frame += 1;
                continue;
            }
            let start = frame;
            while frame < frames && output[frame * channels + channel].abs() >= clip_threshold {
                frame += 1;
            }
            let end = frame;
            let run = end - start;
            if start == 0 || end == frames || run > limits.max_declip_run_frames {
                return Err(SpeechAudioError::InvalidInput(
                    "clipped run lacks bounded unclipped neighbors".into(),
                ));
            }
            let left = output[(start - 1) * channels + channel] as f64;
            let right = output[end * channels + channel] as f64;
            for offset in 0..run {
                let fraction = (offset + 1) as f64 / (run + 1) as f64;
                output[(start + offset) * channels + channel] =
                    (left + (right - left) * fraction) as f32;
            }
        }
    }
    Ok(AudioBuffer::new(output, input.config))
}

#[derive(Debug, Clone, PartialEq)]
pub struct AudioQualityMetrics {
    pub source_rms: f64,
    pub output_rms: f64,
    pub peak_abs: f64,
    /// Samples at or above 99.9% full scale; a conservative indicator, not proof of clipping.
    pub source_near_clip_sample_count: usize,
    /// Samples at or above 99.9% full scale; a conservative indicator, not proof of clipping.
    pub clipped_sample_count: usize,
    pub changed_sample_count: usize,
    pub snr_db_vs_reference: Option<f64>,
    /// Absolute change in zero-lag first-two-channel correlation; None for mono.
    pub stereo_correlation_delta: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AudioComparison {
    /// Owned source copy, retained independently from the caller's input.
    /// Kept public for source compatibility; treat comparison values as snapshots.
    pub source: AudioBuffer,
    /// Owned repaired branch used when metrics were calculated.
    /// Kept public for source compatibility; treat comparison values as snapshots.
    pub repaired: AudioBuffer,
    /// Metrics calculated from the source and repaired buffers at construction.
    /// Kept public for source compatibility; mutating either buffer does not recompute them.
    pub metrics: AudioQualityMetrics,
}

impl AudioComparison {
    /// Borrow the source buffer stored in this comparison.
    pub fn source(&self) -> &AudioBuffer {
        &self.source
    }

    /// Borrow the repaired buffer stored in this comparison.
    pub fn repaired(&self) -> &AudioBuffer {
        &self.repaired
    }

    /// Borrow the metrics calculated when this comparison was created.
    pub fn metrics(&self) -> &AudioQualityMetrics {
        &self.metrics
    }

    /// Make a separate copy of the stored source branch for undo/revert.
    pub fn undo(&self) -> Result<AudioBuffer> {
        clone_buffer(&self.source)
    }
}

/// Build an owned source/repaired comparison pair and compare an optional independent
/// reference. SNR is omitted unless the reference has the exact same PCM shape.
pub fn compare_audio(
    source: &AudioBuffer,
    repaired: &AudioBuffer,
    reference: Option<&AudioBuffer>,
) -> Result<AudioComparison> {
    validate_buffer(source, RepairLimits::DEFAULT)?;
    validate_buffer(repaired, RepairLimits::DEFAULT)?;
    if source.config != repaired.config || source.samples.len() != repaired.samples.len() {
        return Err(SpeechAudioError::InvalidInput(
            "source and repaired revisions must have identical PCM format and frame count".into(),
        ));
    }
    let source_rms = rms(&source.samples);
    let output_rms = rms(&repaired.samples);
    let source_near_clip_sample_count = source
        .samples
        .iter()
        .filter(|sample| sample.abs() >= 0.999)
        .count();
    let peak_abs = repaired
        .samples
        .iter()
        .map(|sample| sample.abs() as f64)
        .fold(0.0, f64::max);
    let clipped_sample_count = repaired
        .samples
        .iter()
        .filter(|sample| sample.abs() >= 0.999)
        .count();
    let changed_sample_count = source
        .samples
        .iter()
        .zip(&repaired.samples)
        .filter(|(left, right)| left.to_bits() != right.to_bits())
        .count();
    let snr_db_vs_reference = if let Some(reference) = reference {
        validate_buffer(reference, RepairLimits::DEFAULT)?;
        if reference.config != repaired.config || reference.samples.len() != repaired.samples.len()
        {
            return Err(SpeechAudioError::InvalidInput(
                "reference must match repaired PCM format and frame count".into(),
            ));
        }
        Some(snr_db(&reference.samples, &repaired.samples))
    } else {
        None
    };
    let stereo_correlation_delta = if source.config.channels >= 2 {
        match (stereo_correlation(source), stereo_correlation(repaired)) {
            (Some(source_corr), Some(repaired_corr)) => Some((source_corr - repaired_corr).abs()),
            _ => None,
        }
    } else {
        None
    };
    Ok(AudioComparison {
        source: clone_buffer(source)?,
        repaired: clone_buffer(repaired)?,
        metrics: AudioQualityMetrics {
            source_rms,
            output_rms,
            peak_abs,
            source_near_clip_sample_count,
            clipped_sample_count,
            changed_sample_count,
            snr_db_vs_reference,
            stereo_correlation_delta,
        },
    })
}

/// First-two-channel zero-lag correlation exposes polarity/phase-relation changes
/// without presenting correlation as a perceptual quality score.
fn stereo_correlation(buffer: &AudioBuffer) -> Option<f64> {
    let channels = buffer.config.channels as usize;
    let mut cross = 0.0f64;
    let mut left_energy = 0.0f64;
    let mut right_energy = 0.0f64;
    for frame in buffer.samples.chunks_exact(channels) {
        let left = frame[0] as f64;
        let right = frame[1] as f64;
        cross += left * right;
        left_energy += left * left;
        right_energy += right * right;
    }
    if left_energy == 0.0 || right_energy == 0.0 {
        None
    } else {
        Some((cross / (left_energy * right_energy).sqrt()).clamp(-1.0, 1.0))
    }
}

fn snr_db(reference: &[f32], output: &[f32]) -> f64 {
    let mut signal = 0.0f64;
    let mut error = 0.0f64;
    for (&expected, &actual) in reference.iter().zip(output) {
        signal += (expected as f64) * (expected as f64);
        let difference = expected as f64 - actual as f64;
        error += difference * difference;
    }
    if error == 0.0 {
        f64::INFINITY
    } else if signal == 0.0 {
        f64::NEG_INFINITY
    } else {
        10.0 * (signal / error).log10()
    }
}

fn rms(samples: &[f32]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples
        .iter()
        .map(|sample| (*sample as f64) * (*sample as f64))
        .sum::<f64>()
        / samples.len() as f64)
        .sqrt()
}

fn clone_buffer(buffer: &AudioBuffer) -> Result<AudioBuffer> {
    let mut samples = Vec::new();
    samples
        .try_reserve_exact(buffer.samples.len())
        .map_err(|error| {
            SpeechAudioError::ResourceLimit(format!("cannot reserve comparison snapshot: {error}"))
        })?;
    samples.extend_from_slice(&buffer.samples);
    Ok(AudioBuffer::new(samples, buffer.config))
}

fn validate_buffer(buffer: &AudioBuffer, limits: RepairLimits) -> Result<()> {
    let limits = limits.validate()?;
    if buffer.config.sample_rate == 0
        || buffer.config.sample_rate > MAX_REPAIR_SAMPLE_RATE
        || buffer.config.channels == 0
        || buffer.config.channels > MAX_REPAIR_CHANNELS
        || buffer.config.sample_format != SampleFormat::F32
        || !buffer
            .samples
            .len()
            .is_multiple_of(buffer.config.channels as usize)
    {
        return Err(SpeechAudioError::InvalidInput(
            "repair input requires positive format and complete interleaved frames".into(),
        ));
    }
    if buffer.samples.len() > limits.max_samples {
        return Err(SpeechAudioError::ResourceLimit(
            "repair input exceeds the configured sample budget".into(),
        ));
    }
    if buffer.samples.iter().any(|sample| !sample.is_finite()) {
        return Err(SpeechAudioError::InvalidInput(
            "repair input contains non-finite samples".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mono(samples: Vec<f32>) -> AudioBuffer {
        AudioBuffer::new(
            samples,
            crate::AudioConfig {
                sample_rate: 8_000,
                channels: 1,
                sample_format: SampleFormat::F32,
            },
        )
    }

    #[test]
    fn noise_gate_reduces_noise_and_preserves_source_for_comparison() {
        let mut source = vec![0.01f32; 512];
        for value in &mut source[256..384] {
            *value = 0.35;
        }
        let input = mono(source);
        let original = input.clone();
        let profile = NoiseProfile::estimate(&input, 0, 128).unwrap();
        let repaired = denoise(
            &input,
            &profile,
            DenoiseOptions {
                block_frames: 128,
                threshold_multiple: 2.0,
                floor_gain: 0.05,
            },
        )
        .unwrap();
        let comparison = compare_audio(
            &input,
            &repaired,
            Some(&mono({
                let mut clean = vec![0.0; 512];
                clean[256..384].fill(0.35);
                clean
            })),
        )
        .unwrap();
        assert_eq!(input, original, "repair must not mutate source");
        assert!(repaired.samples[..128].iter().map(|x| x.abs()).sum::<f32>() < 2.0);
        assert!(comparison.metrics.changed_sample_count > 0);
        assert!(comparison.metrics.snr_db_vs_reference.unwrap().is_finite());
        assert_eq!(comparison.metrics.source_near_clip_sample_count, 0);
        assert_eq!(comparison.metrics.clipped_sample_count, 0);
    }

    #[test]
    fn noise_gate_keeps_attenuation_for_valid_sub_epsilon_audio_levels() {
        let profile_source = mono(vec![1.0e-20; 8]);
        let profile = NoiseProfile::estimate(&profile_source, 0, 8).unwrap();
        let quiet_input = mono(vec![1.0e-21; 8]);

        let repaired = denoise(
            &quiet_input,
            &profile,
            DenoiseOptions {
                threshold_multiple: 2.0,
                floor_gain: 0.1,
                block_frames: 8,
            },
        )
        .unwrap();

        assert!(repaired.samples.iter().all(|sample| sample.abs() < 1.0e-21));
        assert_eq!(quiet_input.samples, vec![1.0e-21; 8]);
    }

    #[test]
    fn declip_interpolates_only_bounded_interior_spans_and_preserves_input() {
        let input = mono(vec![0.0, 0.2, 1.0, 1.0, 0.8, 0.0]);
        let repaired = declip(&input, 0.98).unwrap();
        assert_eq!(input.samples, vec![0.0, 0.2, 1.0, 1.0, 0.8, 0.0]);
        assert_eq!(repaired.samples, vec![0.0, 0.2, 0.4, 0.6, 0.8, 0.0]);
        assert!(declip(&mono(vec![1.0, 0.0]), 0.98).is_err());
    }

    #[test]
    fn declip_reconstructs_stereo_channels_independently_and_preserves_source() {
        let config = crate::AudioConfig {
            sample_rate: 48_000,
            channels: 2,
            sample_format: SampleFormat::F32,
        };
        // Left has a two-frame clipped run; right stays below the threshold.
        let source = AudioBuffer::new(
            vec![
                0.0, 0.1, 0.2, -0.1, 1.0, 0.3, 1.0, -0.3, 0.8, 0.2, 0.0, -0.2,
            ],
            config,
        );

        let repaired = declip(&source, 0.98).unwrap();

        assert_eq!(
            repaired.samples,
            vec![0.0, 0.1, 0.2, -0.1, 0.4, 0.3, 0.6, -0.3, 0.8, 0.2, 0.0, -0.2]
        );
        assert_eq!(
            source.samples[1..].iter().step_by(2).collect::<Vec<_>>(),
            vec![&0.1, &-0.1, &0.3, &-0.3, &0.2, &-0.2]
        );
        assert_eq!(
            source.samples,
            vec![0.0, 0.1, 0.2, -0.1, 1.0, 0.3, 1.0, -0.3, 0.8, 0.2, 0.0, -0.2]
        );
    }

    #[test]
    fn declip_run_limit_is_inclusive_and_rejects_first_over_limit_without_mutation() {
        let limits = RepairLimits {
            max_declip_run_frames: 2,
            ..RepairLimits::DEFAULT
        };
        let at_limit = mono(vec![0.0, 1.0, 1.0, 0.8]);
        let repaired = declip_bounded(&at_limit, 0.98, limits).unwrap();
        assert_eq!(repaired.samples, vec![0.0, 0.8 / 3.0, 1.6 / 3.0, 0.8]);
        assert_eq!(at_limit.samples, vec![0.0, 1.0, 1.0, 0.8]);

        let over_limit = mono(vec![0.0, 1.0, 1.0, 1.0, 0.8]);
        assert!(matches!(
            declip_bounded(&over_limit, 0.98, limits),
            Err(SpeechAudioError::InvalidInput(_))
        ));
        assert_eq!(over_limit.samples, vec![0.0, 1.0, 1.0, 1.0, 0.8]);
    }

    #[test]
    fn silence_is_stable_and_corrupt_or_empty_inputs_are_typed_errors() {
        let silence = mono(vec![0.0; 16]);
        let profile = NoiseProfile::estimate(&silence, 0, 8).unwrap();
        assert_eq!(
            denoise(&silence, &profile, DenoiseOptions::DEFAULT).unwrap(),
            silence
        );
        assert!(declip(&mono(vec![]), 0.98).is_err());
        assert!(declip(&mono(vec![f32::NAN]), 0.98).is_err());
        assert!(NoiseProfile::estimate(&mono(vec![0.1]), 1, 1).is_err());
    }

    #[test]
    fn malformed_options_oversized_input_and_comparison_drift_fail_closed() {
        let config = mono(vec![0.0]).config;
        let oversized = AudioBuffer::new(vec![0.0; 5], config);
        assert!(matches!(
            declip_bounded(
                &oversized,
                0.98,
                RepairLimits {
                    max_samples: 4,
                    ..RepairLimits::DEFAULT
                }
            ),
            Err(SpeechAudioError::ResourceLimit(_))
        ));
        assert!(DenoiseOptions {
            block_frames: MAX_BLOCK_FRAMES + 1,
            ..DenoiseOptions::DEFAULT
        }
        .validate()
        .is_err());
        assert!(compare_audio(&mono(vec![0.0]), &mono(vec![0.0, 0.0]), None).is_err());
    }

    #[test]
    fn exact_reference_has_infinite_snr_and_unequal_reference_is_rejected() {
        let signal = mono(vec![0.1, -0.2, 0.3]);
        assert!(compare_audio(&signal, &signal, Some(&signal))
            .unwrap()
            .metrics
            .snr_db_vs_reference
            .unwrap()
            .is_infinite());
        assert!(compare_audio(&signal, &signal, Some(&mono(vec![0.1]))).is_err());
    }

    #[test]
    fn denoise_uses_shared_stereo_gain_and_preserves_relative_phase() {
        let config = crate::AudioConfig {
            sample_rate: 8_000,
            channels: 2,
            sample_format: SampleFormat::F32,
        };
        let mut samples = Vec::new();
        for frame in 0..256 {
            let value = if frame < 128 { 0.01 } else { 0.3 };
            samples.extend_from_slice(&[value, value * 0.5]);
        }
        let input = AudioBuffer::new(samples, config);
        let profile = NoiseProfile::estimate(&input, 0, 64).unwrap();
        let repaired = denoise(
            &input,
            &profile,
            DenoiseOptions {
                block_frames: 64,
                ..DenoiseOptions::DEFAULT
            },
        )
        .unwrap();
        for frame in [16usize, 48, 80, 112, 160, 192, 224] {
            let left = repaired.samples[frame * 2];
            let right = repaired.samples[frame * 2 + 1];
            assert!((left - right * 2.0).abs() < 1e-6);
        }
        let comparison = compare_audio(&input, &repaired, None).unwrap();
        assert!(comparison.metrics.stereo_correlation_delta.unwrap() < 1e-12);
    }

    #[test]
    fn comparison_reports_near_clipping_and_stereo_polarity_change() {
        let stereo = |samples: Vec<f32>| {
            AudioBuffer::new(
                samples,
                crate::AudioConfig {
                    sample_rate: 8_000,
                    channels: 2,
                    sample_format: SampleFormat::F32,
                },
            )
        };
        let source = stereo(vec![1.0, 1.0, -1.0, -1.0, 0.4, 0.4]);
        let repaired = stereo(vec![0.8, -0.8, -0.8, 0.8, 0.3, -0.3]);

        let result = compare_audio(&source, &repaired, None).unwrap();

        assert_eq!(result.metrics.source_near_clip_sample_count, 4);
        assert_eq!(result.metrics.clipped_sample_count, 0);
        assert!((result.metrics.stereo_correlation_delta.unwrap() - 2.0).abs() < 1e-12);
    }
}
