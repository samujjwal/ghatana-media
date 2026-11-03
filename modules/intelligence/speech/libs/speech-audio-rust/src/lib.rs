use std::fs::File;
use std::io::{ErrorKind, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use hound::{SampleFormat as WavSampleFormat, WavSpec, WavWriter};
use symphonia::core::audio::{AudioBuffer as SymphoniaAudioBuffer, AudioBufferRef, Signal};
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::conv::IntoSample;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::sample::Sample;
use symphonia::default::{get_codecs, get_probe};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleFormat {
    F32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioConfig {
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: SampleFormat,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AudioBuffer {
    pub samples: Vec<f32>,
    pub config: AudioConfig,
}

impl AudioBuffer {
    pub fn new(samples: Vec<f32>, config: AudioConfig) -> Self {
        Self { samples, config }
    }

    pub fn frame_count(&self) -> usize {
        self.samples.len() / self.config.channels.max(1) as usize
    }

    pub fn duration_seconds(&self) -> f64 {
        if self.config.sample_rate == 0 || self.config.channels == 0 {
            return 0.0;
        }
        self.frame_count() as f64 / self.config.sample_rate as f64
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AudioMetadata {
    pub path: String,
    pub name: String,
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub format: String,
}

#[derive(Debug, Error)]
pub enum SpeechAudioError {
    #[error("File not found: {0}")]
    FileNotFound(String),

    #[error("Unsupported audio format: {0}")]
    UnsupportedFormat(String),

    #[error("Audio decode failed: {0}")]
    Decode(String),

    #[error("Audio encode failed: {0}")]
    Encode(String),

    #[error("Invalid audio input: {0}")]
    InvalidInput(String),

    #[error("Audio resource limit exceeded: {0}")]
    ResourceLimit(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, SpeechAudioError>;

/// Maximum cooperative wall time spent decoding one audio file.
///
/// The Symphonia API decodes packets synchronously and does not expose
/// cancellation for an in-flight codec call. The decoder checks this budget
/// before and after every probe/read/decode operation, so work stops between
/// operations when the deadline expires. Callers that need a hard kill of a
/// potentially stuck native codec must isolate decoding in a worker process.
const MAX_DECODE_TIME: Duration = Duration::from_secs(60);
/// A single in-memory decode is capped at six hours even when callers request
/// a larger sample budget. This keeps low sample rates from turning a finite
/// sample cap into an impractically long stream.
const MAX_DECODE_DURATION_SECONDS: u64 = 6 * 60 * 60;

/**
 * Finite decode budget protecting against decoded-memory bombs. Container
 * metadata is validated before any sample allocation, and decoding stops with
 * [`SpeechAudioError::ResourceLimit`] once the sample bound is exceeded —
 * a small compressed file can never expand into an unbounded buffer. The
 * in-process decoder also has a cooperative 60-second wall-time budget checked
 * between codec operations; one synchronous codec call cannot be interrupted.
 */
#[derive(Debug, Clone, Copy)]
pub struct DecodeLimits {
    /// Maximum encoded source bytes inspected by the decoder.
    pub max_input_bytes: u64,
    /// Maximum decoded interleaved samples retained in memory (~384 MiB of f32).
    pub max_decoded_samples: usize,
    /// Maximum channel count accepted from container metadata.
    pub max_channels: u16,
    /// Maximum sample rate accepted from container metadata.
    pub max_sample_rate: u32,
}

impl DecodeLimits {
    const HARD_MAX_INPUT_BYTES: u64 = 512 * 1024 * 1024;
    const HARD_MAX_DECODED_SAMPLES: usize = 96_000_000;
    const HARD_MAX_CHANNELS: u16 = 8;
    const HARD_MAX_SAMPLE_RATE: u32 = 768_000;

    pub const DEFAULT: Self = Self {
        max_input_bytes: Self::HARD_MAX_INPUT_BYTES,
        max_decoded_samples: Self::HARD_MAX_DECODED_SAMPLES,
        max_channels: Self::HARD_MAX_CHANNELS,
        max_sample_rate: Self::HARD_MAX_SAMPLE_RATE,
    };

    fn validate(&self) -> Result<()> {
        if self.max_input_bytes == 0
            || self.max_decoded_samples == 0
            || self.max_channels == 0
            || self.max_sample_rate == 0
        {
            return Err(SpeechAudioError::InvalidInput(
                "decode limits must be positive".to_string(),
            ));
        }
        if self.max_input_bytes > Self::HARD_MAX_INPUT_BYTES
            || self.max_decoded_samples > Self::HARD_MAX_DECODED_SAMPLES
            || self.max_channels > Self::HARD_MAX_CHANNELS
            || self.max_sample_rate > Self::HARD_MAX_SAMPLE_RATE
        {
            return Err(SpeechAudioError::InvalidInput(
                "decode limits cannot exceed the crate hard resource caps".to_string(),
            ));
        }
        Ok(())
    }
}

/**
 * Bandlimited windowed-sinc resampler with exact rational source-to-target
 * offsets. A Blackman-windowed sinc kernel is centered on each output position
 * and normalized by its actual tap sum, so DC gain is preserved and content
 * above the tighter of the source/target Nyquist limits is attenuated before
 * sampling. Positions come from integer rate arithmetic (`i * src / dst`),
 * never an accumulated float, so long inputs cannot drift. Non-finite input is
 * rejected rather than propagated into silently corrupt output.
 */
pub struct Resampler {
    target_sample_rate: u32,
    kernel_half_length: usize,
    cutoff_scale: f64,
}

impl Resampler {
    const DEFAULT_KERNEL_HALF_LENGTH: usize = 24;
    const DEFAULT_CUTOFF_SCALE: f64 = 0.9;
    /// Bound output allocations to the same 384 MiB f32 scale as the default decoder.
    const MAX_OUTPUT_SAMPLES: usize = 96_000_000;

    pub fn new(target_sample_rate: u32) -> Self {
        Self {
            target_sample_rate,
            kernel_half_length: Self::DEFAULT_KERNEL_HALF_LENGTH,
            cutoff_scale: Self::DEFAULT_CUTOFF_SCALE,
        }
    }

    /// Resampler with explicit kernel half-length (source samples) and cutoff
    /// scale relative to the tighter Nyquist edge, for qualified fidelity tuning.
    pub fn with_options(
        target_sample_rate: u32,
        kernel_half_length: usize,
        cutoff_scale: f64,
    ) -> Result<Self> {
        if kernel_half_length == 0 || kernel_half_length > 512 {
            return Err(SpeechAudioError::InvalidInput(
                "kernel half-length must be within 1..=512 source samples".to_string(),
            ));
        }
        if !(cutoff_scale > 0.0 && cutoff_scale <= 1.0) {
            return Err(SpeechAudioError::InvalidInput(
                "cutoff scale must be within (0, 1]".to_string(),
            ));
        }
        Ok(Self {
            target_sample_rate,
            kernel_half_length,
            cutoff_scale,
        })
    }

    fn kernel(offset: f64, cutoff: f64, half_length: usize) -> f64 {
        if offset.abs() > half_length as f64 {
            return 0.0;
        }
        let x = 2.0 * cutoff * offset;
        let sinc = if x.abs() < 1e-8 {
            1.0
        } else {
            (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
        };
        let n = offset / half_length as f64;
        let window = 0.42
            + 0.5 * (std::f64::consts::PI * n).cos()
            + 0.08 * (2.0 * std::f64::consts::PI * n).cos();
        2.0 * cutoff * sinc * window
    }

    fn validate_output_sample_count(sample_count: usize) -> Result<()> {
        if sample_count > Self::MAX_OUTPUT_SAMPLES {
            return Err(SpeechAudioError::ResourceLimit(format!(
                "resampled audio exceeds the {} sample output budget",
                Self::MAX_OUTPUT_SAMPLES
            )));
        }
        Ok(())
    }

    fn copy_bounded(samples: &[f32]) -> Result<Vec<f32>> {
        Self::validate_output_sample_count(samples.len())?;
        let mut copy = Vec::new();
        copy.try_reserve_exact(samples.len()).map_err(|error| {
            SpeechAudioError::ResourceLimit(format!(
                "cannot reserve bounded resampled output: {error}"
            ))
        })?;
        copy.extend_from_slice(samples);
        Ok(copy)
    }

    pub fn resample(&self, buffer: &AudioBuffer) -> Result<AudioBuffer> {
        if buffer.config.sample_rate == 0 {
            return Err(SpeechAudioError::InvalidInput(
                "input sample rate must be positive".to_string(),
            ));
        }
        if self.target_sample_rate == 0 {
            return Err(SpeechAudioError::InvalidInput(
                "target sample rate must be positive".to_string(),
            ));
        }
        if buffer.config.channels == 0 {
            return Err(SpeechAudioError::InvalidInput(
                "input channel count must be positive".to_string(),
            ));
        }
        let channels = buffer.config.channels as usize;
        if !buffer.samples.len().is_multiple_of(channels) {
            return Err(SpeechAudioError::InvalidInput(
                "interleaved sample count must be divisible by channel count".to_string(),
            ));
        }
        if buffer.samples.iter().any(|sample| !sample.is_finite()) {
            return Err(SpeechAudioError::InvalidInput(
                "resampler input must not contain non-finite samples".to_string(),
            ));
        }
        if buffer.samples.is_empty() || buffer.config.sample_rate == self.target_sample_rate {
            return Ok(AudioBuffer::new(
                Self::copy_bounded(&buffer.samples)?,
                AudioConfig {
                    sample_rate: self.target_sample_rate,
                    channels: buffer.config.channels,
                    sample_format: SampleFormat::F32,
                },
            ));
        }
        let src_rate = buffer.config.sample_rate as u128;
        let dst_rate = self.target_sample_rate as u128;
        let input_frames = buffer.frame_count();
        let ratio = self.target_sample_rate as f64 / buffer.config.sample_rate as f64;
        let output_frames_u128 = (input_frames as u128)
            .checked_mul(dst_rate)
            .and_then(|value| value.checked_mul(2))
            .and_then(|value| value.checked_add(src_rate))
            .ok_or_else(|| {
                SpeechAudioError::ResourceLimit("resampled frame count overflow".to_string())
            })?
            .checked_div(src_rate * 2)
            .unwrap_or(0)
            .max(1);
        let output_frames = usize::try_from(output_frames_u128).map_err(|_| {
            SpeechAudioError::ResourceLimit(
                "resampled frame count exceeds addressable memory".to_string(),
            )
        })?;
        let output_sample_count = output_frames.checked_mul(channels).ok_or_else(|| {
            SpeechAudioError::ResourceLimit("resampled sample count overflow".to_string())
        })?;
        Self::validate_output_sample_count(output_sample_count)?;
        // Anti-alias cutoff in cycles per source sample: the tighter of the
        // source and target Nyquist edges, pulled in by the cutoff scale.
        let cutoff = 0.5 * ratio.min(1.0) * self.cutoff_scale;
        let half_length = self.kernel_half_length;

        let mut output = Vec::new();
        output
            .try_reserve_exact(output_sample_count)
            .map_err(|error| {
                SpeechAudioError::ResourceLimit(format!(
                    "cannot reserve bounded resampled output: {error}"
                ))
            })?;
        let mut acc = vec![0.0f64; channels];

        for output_frame in 0..output_frames {
            // Exact rational position: output_frame * src / dst in source samples.
            let pos_num = output_frame as u128 * src_rate;
            let base = (pos_num / dst_rate) as usize;
            let frac = (pos_num % dst_rate) as f64 / dst_rate as f64;
            let center = base as f64 + frac;
            let j_lo = (center - half_length as f64).ceil().max(0.0) as usize;
            let j_hi = ((center + half_length as f64).floor() as usize)
                .min(input_frames.saturating_sub(1));

            acc.fill(0.0);
            let mut weight_sum = 0.0f64;
            for j in j_lo..=j_hi {
                let weight = Self::kernel(center - j as f64, cutoff, half_length);
                weight_sum += weight;
                let row = j * channels;
                for (channel, sum) in acc.iter_mut().enumerate() {
                    *sum += buffer.samples[row + channel] as f64 * weight;
                }
            }
            if weight_sum.abs() < f64::EPSILON {
                // Degenerate edge window: fall back to the nearest source frame.
                let nearest = center.round().min((input_frames - 1) as f64) as usize;
                output.extend_from_slice(
                    &buffer.samples[nearest * channels..nearest * channels + channels],
                );
                continue;
            }
            for sum in &acc {
                let sample = (*sum / weight_sum) as f32;
                if !sample.is_finite() {
                    return Err(SpeechAudioError::ResourceLimit(
                        "resampled sample exceeds finite f32 range".to_string(),
                    ));
                }
                output.push(sample);
            }
        }

        Ok(AudioBuffer::new(
            output,
            AudioConfig {
                sample_rate: self.target_sample_rate,
                channels: buffer.config.channels,
                sample_format: SampleFormat::F32,
            },
        ))
    }
}

pub fn load_audio_metadata<P: AsRef<Path>>(path: P) -> Result<AudioMetadata> {
    let decoded = decode_audio(path.as_ref())?;
    Ok(AudioMetadata {
        path: decoded.path.display().to_string(),
        name: decoded
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("unknown")
            .to_string(),
        duration: decoded.duration_seconds(),
        sample_rate: decoded.config.sample_rate,
        channels: decoded.config.channels,
        format: decoded.format,
    })
}

pub fn load_audio_buffer<P: AsRef<Path>>(path: P) -> Result<AudioBuffer> {
    load_audio_buffer_bounded(path, DecodeLimits::DEFAULT)
}

/// Loads a decoded buffer under an explicit finite resource budget.
pub fn load_audio_buffer_bounded<P: AsRef<Path>>(
    path: P,
    limits: DecodeLimits,
) -> Result<AudioBuffer> {
    let decoded = decode_audio_bounded(path.as_ref(), limits)?;
    Ok(AudioBuffer::new(decoded.samples, decoded.config))
}

pub fn extract_waveform<P: AsRef<Path>>(path: P, buckets: usize) -> Result<Vec<f32>> {
    if buckets == 0 {
        return Err(SpeechAudioError::InvalidInput(
            "waveform bucket count must be positive".to_string(),
        ));
    }
    // A caller-controlled bucket count must not trigger an unbounded allocation.
    const MAX_WAVEFORM_BUCKETS: usize = 1_000_000;
    if buckets > MAX_WAVEFORM_BUCKETS {
        return Err(SpeechAudioError::ResourceLimit(format!(
            "waveform bucket count exceeds {MAX_WAVEFORM_BUCKETS}"
        )));
    }

    let buffer = load_audio_buffer(path)?;
    let channels = buffer.config.channels as usize;
    if channels == 0 || !buffer.samples.len().is_multiple_of(channels) {
        return Err(SpeechAudioError::InvalidInput(
            "waveform input must have a positive channel count and complete interleaved frames"
                .to_string(),
        ));
    }
    if buffer.samples.iter().any(|sample| !sample.is_finite()) {
        return Err(SpeechAudioError::InvalidInput(
            "waveform input must not contain non-finite samples".to_string(),
        ));
    }
    let frames = buffer.frame_count();
    if frames == 0 {
        let mut waveform = Vec::new();
        waveform.try_reserve_exact(buckets).map_err(|error| {
            SpeechAudioError::ResourceLimit(format!("cannot reserve waveform buckets: {error}"))
        })?;
        waveform.resize(buckets, 0.0);
        return Ok(waveform);
    }

    let mut waveform = Vec::new();
    waveform.try_reserve_exact(buckets).map_err(|error| {
        SpeechAudioError::ResourceLimit(format!("cannot reserve waveform buckets: {error}"))
    })?;

    for bucket in 0..buckets {
        // Use exact proportional partitions; u128 avoids overflow for very large
        // caller-provided bucket counts and keeps every source frame represented.
        let start_frame = ((bucket as u128 * frames as u128) / buckets as u128) as usize;
        let end_frame = (((bucket as u128 + 1) * frames as u128) / buckets as u128) as usize;
        let mut peak = 0.0f32;
        for frame in start_frame..end_frame {
            for channel in 0..channels {
                let sample = buffer.samples[frame * channels + channel].abs();
                peak = peak.max(sample);
            }
        }
        waveform.push(peak);
    }

    Ok(waveform)
}

pub fn slice_audio_buffer(
    buffer: &AudioBuffer,
    start_time: f64,
    end_time: f64,
) -> Result<AudioBuffer> {
    if !start_time.is_finite()
        || !end_time.is_finite()
        || start_time < 0.0
        || end_time < 0.0
        || end_time < start_time
    {
        return Err(SpeechAudioError::InvalidInput(
            "slice times must be finite and non-negative, and end must be >= start".to_string(),
        ));
    }

    let channels = buffer.config.channels as usize;
    if buffer.config.sample_rate == 0
        || channels == 0
        || !buffer.samples.len().is_multiple_of(channels)
    {
        return Err(SpeechAudioError::InvalidInput(
            "slice input must have a positive sample rate and complete interleaved frames"
                .to_string(),
        ));
    }
    let frames = buffer.frame_count();
    // Select samples whose frame timestamps lie in [start_time, end_time).
    // Clamp in seconds before multiplication so huge finite times cannot overflow
    // the conversion or turn into saturated usize indices.
    let frame_boundary = |time: f64| -> usize {
        if time >= frames as f64 / buffer.config.sample_rate as f64 {
            return frames;
        }
        (time * buffer.config.sample_rate as f64).ceil() as usize
    };
    let clamped_start = frame_boundary(start_time);
    let clamped_end = frame_boundary(end_time);
    let start_index = clamped_start * channels;
    let end_index = clamped_end * channels;
    let slice = &buffer.samples[start_index..end_index];
    let mut samples = Vec::new();
    samples.try_reserve_exact(slice.len()).map_err(|error| {
        SpeechAudioError::ResourceLimit(format!("cannot reserve sliced audio: {error}"))
    })?;
    samples.extend_from_slice(slice);

    Ok(AudioBuffer::new(samples, buffer.config))
}

/// Sum aligned interleaved samples after applying one scalar gain per buffer.
/// Shorter inputs are silence-padded to the longest input. This helper does
/// not apply panning, a pan law, or perceptual loudness normalization; values
/// above unity are preserved, and sums outside finite `f32` range are rejected.
pub fn mix_audio(buffers: &[AudioBuffer], volumes: &[f32]) -> Result<AudioBuffer> {
    if buffers.is_empty() {
        return Err(SpeechAudioError::InvalidInput(
            "at least one buffer is required".to_string(),
        ));
    }
    if buffers.len() != volumes.len() {
        return Err(SpeechAudioError::InvalidInput(
            "buffers and volumes must have the same length".to_string(),
        ));
    }

    if volumes.iter().any(|volume| !volume.is_finite()) {
        return Err(SpeechAudioError::InvalidInput(
            "mix volumes must be finite".to_string(),
        ));
    }
    let reference = buffers[0].config;
    if reference.sample_rate == 0 {
        return Err(SpeechAudioError::InvalidInput(
            "mix sample rate must be positive".to_string(),
        ));
    }
    for buffer in buffers.iter() {
        if buffer.config != reference {
            return Err(SpeechAudioError::InvalidInput(
                "all buffers must share sample rate and channel count".to_string(),
            ));
        }
        if buffer.samples.iter().any(|sample| !sample.is_finite()) {
            return Err(SpeechAudioError::InvalidInput(
                "mix inputs must not contain non-finite samples".to_string(),
            ));
        }
    }

    let channels = reference.channels as usize;
    if channels == 0 {
        return Err(SpeechAudioError::InvalidInput(
            "mix channel count must be positive".to_string(),
        ));
    }
    let max_samples = buffers
        .iter()
        .map(|buffer| buffer.samples.len())
        .max()
        .unwrap_or(0);
    if buffers
        .iter()
        .any(|buffer| !buffer.samples.len().is_multiple_of(channels))
    {
        return Err(SpeechAudioError::InvalidInput(
            "mix inputs must contain complete interleaved frames".to_string(),
        ));
    }
    let mut mixed = Vec::new();
    mixed.try_reserve_exact(max_samples).map_err(|error| {
        SpeechAudioError::ResourceLimit(format!("cannot reserve mixed audio: {error}"))
    })?;
    const MIX_ACCUMULATION_BLOCK_SAMPLES: usize = 4_096;
    let block_count = max_samples / MIX_ACCUMULATION_BLOCK_SAMPLES
        + usize::from(!max_samples.is_multiple_of(MIX_ACCUMULATION_BLOCK_SAMPLES));
    let mut expiry_counts = Vec::new();
    expiry_counts
        .try_reserve_exact(block_count)
        .map_err(|error| {
            SpeechAudioError::ResourceLimit(format!("cannot reserve mix expiry metadata: {error}"))
        })?;
    expiry_counts.resize(block_count, 0usize);

    let mut active_buffer_indices = Vec::new();
    active_buffer_indices
        .try_reserve_exact(buffers.len())
        .map_err(|error| {
            SpeechAudioError::ResourceLimit(format!("cannot reserve active mix inputs: {error}"))
        })?;
    for (index, buffer) in buffers.iter().enumerate() {
        if buffer.samples.is_empty() {
            continue;
        }
        let expiry_block = (buffer.samples.len() - 1) / MIX_ACCUMULATION_BLOCK_SAMPLES;
        expiry_counts[expiry_block] = expiry_counts[expiry_block]
            .checked_add(1)
            .ok_or_else(|| SpeechAudioError::ResourceLimit("mix expiry count overflow".into()))?;
        active_buffer_indices.push(index);
    }

    let mut sums = Vec::new();
    sums.try_reserve_exact(max_samples.min(MIX_ACCUMULATION_BLOCK_SAMPLES))
        .map_err(|error| {
            SpeechAudioError::ResourceLimit(format!("cannot reserve mixed audio scratch: {error}"))
        })?;
    sums.resize(max_samples.min(MIX_ACCUMULATION_BLOCK_SAMPLES), 0.0f64);

    for (block_index, block_start) in (0..max_samples)
        .step_by(MIX_ACCUMULATION_BLOCK_SAMPLES)
        .enumerate()
    {
        let block_len = (max_samples - block_start).min(MIX_ACCUMULATION_BLOCK_SAMPLES);
        let block_sums = &mut sums[..block_len];
        block_sums.fill(0.0);

        // Keep each block's full scalar sums in f64 until every input has
        // contributed. This preserves cancellation without allocating a
        // second full-size audio buffer. Converting after each input can reject
        // a representable final result when an oversized partial sum cancels.
        for &buffer_index in &active_buffer_indices {
            let buffer = &buffers[buffer_index];
            let Some(source) = buffer
                .samples
                .get(block_start..)
                .map(|remaining| &remaining[..remaining.len().min(block_len)])
            else {
                continue;
            };
            let volume = volumes[buffer_index];
            for (sum, sample) in block_sums.iter_mut().zip(source) {
                *sum += *sample as f64 * volume as f64;
            }
        }

        for sum in block_sums.iter().copied() {
            let converted = sum as f32;
            if !converted.is_finite() {
                return Err(SpeechAudioError::ResourceLimit(
                    "mixed sample exceeds finite f32 range".to_string(),
                ));
            }
            mixed.push(converted);
        }

        // Expiry metadata makes long runs with only a few active inputs cheap:
        // compact the source-ordered active list only when at least one input
        // ends in this block, rather than rescanning every original buffer.
        if expiry_counts[block_index] > 0 {
            let block_end = block_start + block_len;
            active_buffer_indices
                .retain(|&buffer_index| buffers[buffer_index].samples.len() > block_end);
        }
    }

    Ok(AudioBuffer::new(mixed, reference))
}

pub fn write_wav<P: AsRef<Path>>(path: P, buffer: &AudioBuffer) -> Result<()> {
    validate_audio_buffer_for_wav(buffer)?;
    let spec = WavSpec {
        channels: buffer.config.channels,
        sample_rate: buffer.config.sample_rate,
        bits_per_sample: 32,
        sample_format: WavSampleFormat::Float,
    };
    let mut writer = WavWriter::create(path, spec).map_err(|error| {
        SpeechAudioError::Encode(format!("failed to create WAV writer: {error}"))
    })?;
    for sample in &buffer.samples {
        writer.write_sample(*sample).map_err(|error| {
            SpeechAudioError::Encode(format!("failed to write sample: {error}"))
        })?;
    }
    writer
        .finalize()
        .map_err(|error| SpeechAudioError::Encode(format!("failed to finalize WAV: {error}")))?;
    Ok(())
}

fn validate_audio_buffer_for_wav(buffer: &AudioBuffer) -> Result<()> {
    if buffer.config.channels == 0 || buffer.config.sample_rate == 0 {
        return Err(SpeechAudioError::InvalidInput(
            "WAV sample rate and channel count must be positive".to_string(),
        ));
    }
    if !buffer
        .samples
        .len()
        .is_multiple_of(buffer.config.channels as usize)
    {
        return Err(SpeechAudioError::InvalidInput(
            "WAV samples must contain complete interleaved frames".to_string(),
        ));
    }
    if buffer.samples.iter().any(|sample| !sample.is_finite()) {
        return Err(SpeechAudioError::InvalidInput(
            "WAV samples must be finite".to_string(),
        ));
    }
    let data_bytes = buffer
        .samples
        .len()
        .checked_mul(std::mem::size_of::<f32>())
        .ok_or_else(|| SpeechAudioError::ResourceLimit("WAV data size overflow".to_string()))?;
    // hound emits WAVEFORMATEXTENSIBLE for this f32 output. RIFF's size field
    // includes the 40-byte fmt body, both 8-byte chunk headers, and WAVE tag.
    validate_wav_data_size(data_bytes)
}

fn validate_wav_data_size(data_bytes: usize) -> Result<()> {
    let padded_data_bytes = data_bytes
        .checked_add(data_bytes & 1)
        .ok_or_else(|| SpeechAudioError::ResourceLimit("WAV data padding overflow".to_string()))?;
    let riff_bytes = padded_data_bytes
        .checked_add(60)
        .ok_or_else(|| SpeechAudioError::ResourceLimit("WAV RIFF size overflow".to_string()))?;
    if data_bytes > u32::MAX as usize || riff_bytes > u32::MAX as usize {
        return Err(SpeechAudioError::ResourceLimit(
            "WAV exceeds the RIFF 32-bit size limit".to_string(),
        ));
    }
    Ok(())
}

struct DecodedAudio {
    path: PathBuf,
    samples: Vec<f32>,
    config: AudioConfig,
    format: String,
}

impl DecodedAudio {
    fn duration_seconds(&self) -> f64 {
        if self.config.sample_rate == 0 || self.config.channels == 0 {
            return 0.0;
        }
        let frames = self.samples.len() / self.config.channels as usize;
        frames as f64 / self.config.sample_rate as f64
    }
}

fn decode_audio(path: &Path) -> Result<DecodedAudio> {
    decode_audio_bounded(path, DecodeLimits::DEFAULT)
}

fn has_exact_frame_count_container(file: &mut File) -> Result<bool> {
    let mut header = [0u8; 12];
    let read_result = file.read_exact(&mut header);
    file.seek(SeekFrom::Start(0))?;
    match read_result {
        Ok(()) => Ok(
            matches!(&header[0..4], b"RIFF" | b"RF64") && &header[8..12] == b"WAVE"
                || &header[0..4] == b"FORM" && matches!(&header[8..12], b"AIFF" | b"AIFC"),
        ),
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => Ok(false),
        Err(error) => Err(SpeechAudioError::Io(error)),
    }
}

fn trusted_expected_frames(n_frames: Option<u64>, has_exact_frame_count: bool) -> Option<u64> {
    if has_exact_frame_count {
        n_frames
    } else {
        None
    }
}

fn validate_declared_frame_count(
    frames: u64,
    sample_rate: u32,
    channels: u16,
    limits: DecodeLimits,
) -> Result<()> {
    let interleaved_samples = frames.checked_mul(u64::from(channels)).ok_or_else(|| {
        SpeechAudioError::ResourceLimit("declared audio sample count overflow".to_string())
    })?;
    if interleaved_samples > limits.max_decoded_samples as u64 {
        return Err(SpeechAudioError::ResourceLimit(format!(
            "container declares {interleaved_samples} samples, exceeding the {} sample budget",
            limits.max_decoded_samples
        )));
    }
    let max_frames = u64::from(sample_rate)
        .checked_mul(MAX_DECODE_DURATION_SECONDS)
        .ok_or_else(|| {
            SpeechAudioError::ResourceLimit("decode duration limit overflow".to_string())
        })?;
    if frames > max_frames {
        return Err(SpeechAudioError::ResourceLimit(format!(
            "container declares {frames} frames, exceeding the {MAX_DECODE_DURATION_SECONDS} second duration budget"
        )));
    }
    Ok(())
}

fn decode_audio_bounded(path: &Path, limits: DecodeLimits) -> Result<DecodedAudio> {
    decode_audio_bounded_with_time_budget(path, limits, MAX_DECODE_TIME)
}

fn decode_audio_bounded_with_time_budget(
    path: &Path,
    limits: DecodeLimits,
    max_decode_time: Duration,
) -> Result<DecodedAudio> {
    let started_at = Instant::now();
    limits.validate()?;
    if max_decode_time.is_zero() {
        return Err(SpeechAudioError::InvalidInput(
            "decode time budget must be positive".to_string(),
        ));
    }
    ensure_decode_time(started_at, max_decode_time)?;
    let path_metadata = std::fs::metadata(path).map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            SpeechAudioError::FileNotFound(path.display().to_string())
        } else {
            SpeechAudioError::Io(error)
        }
    })?;
    // Reject FIFOs, devices, and directories before File::open. Opening a
    // FIFO can block indefinitely, before the cooperative decode deadline or
    // the later opened-handle regular-file check can run.
    if !path_metadata.is_file() {
        return Err(SpeechAudioError::InvalidInput(
            "bounded audio decoding requires a regular file".to_string(),
        ));
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let mut file = File::open(path)?;
    let input_bytes = file.metadata()?.len();
    ensure_decode_time(started_at, max_decode_time)?;
    if input_bytes > limits.max_input_bytes {
        return Err(SpeechAudioError::ResourceLimit(format!(
            "encoded audio is {input_bytes} bytes, exceeding the {} byte source budget",
            limits.max_input_bytes
        )));
    }
    validate_riff_wav(&mut file, input_bytes, limits, started_at, max_decode_time)?;
    file.seek(SeekFrom::Start(0))?;
    // Only WAVE/AIFF container headers provide frame counts that this decoder
    // can treat as exact. Some codec probes (notably ADTS/AAC) estimate
    // `n_frames` from sampled bitrate, which is not a truncation boundary.
    ensure_decode_time(started_at, max_decode_time)?;
    let has_exact_frame_count = has_exact_frame_count_container(&mut file)?;
    ensure_decode_time(started_at, max_decode_time)?;
    let file_size_observer = file.try_clone()?;
    let source_changed = Arc::new(AtomicBool::new(false));
    let bounded_source =
        FixedLengthMediaSource::new(file, input_bytes, Arc::clone(&source_changed))?;

    decode_audio_from_source(DecodeSource {
        path,
        extension: &extension,
        input_bytes,
        limits,
        max_decode_time,
        started_at,
        has_exact_frame_count,
        source: Box::new(bounded_source),
        file_size_observer,
        source_changed,
    })
}

/// A file-backed source whose readable and seekable range is fixed to the
/// length admitted by the initial metadata check. Appended bytes can never be
/// observed by the decoder, even if another process grows the same file while
/// it is being probed or decoded.
struct FixedLengthMediaSource {
    file: File,
    length: u64,
    position: u64,
    source_changed: Arc<AtomicBool>,
}

impl FixedLengthMediaSource {
    fn new(mut file: File, length: u64, source_changed: Arc<AtomicBool>) -> std::io::Result<Self> {
        if !file.metadata()?.is_file() {
            return Err(std::io::Error::new(
                ErrorKind::Unsupported,
                "bounded audio decoding requires a regular file",
            ));
        }
        let position = file.stream_position()?;
        Ok(Self {
            file,
            length,
            position,
            source_changed,
        })
    }

    fn observe_length(&self) -> std::io::Result<()> {
        let actual = self.file.metadata()?.len();
        if actual != self.length {
            self.source_changed.store(true, Ordering::Release);
        }
        Ok(())
    }
}

impl Read for FixedLengthMediaSource {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let remaining = self.length.saturating_sub(self.position);
        if remaining == 0 {
            self.observe_length()?;
            return Ok(0);
        }
        let allowed = buffer.len().min(remaining.min(usize::MAX as u64) as usize);
        let count = self.file.read(&mut buffer[..allowed])?;
        self.position += count as u64;
        self.observe_length()?;
        Ok(count)
    }
}

impl Seek for FixedLengthMediaSource {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        self.observe_length()?;
        let target = match position {
            SeekFrom::Start(offset) => i128::from(offset),
            SeekFrom::Current(offset) => i128::from(self.position) + i128::from(offset),
            SeekFrom::End(offset) => i128::from(self.length) + i128::from(offset),
        };
        if target < 0 || target > i128::from(self.length) {
            return Err(std::io::Error::new(
                ErrorKind::InvalidInput,
                "seek is outside the admitted audio source range",
            ));
        }
        let position = self.file.seek(SeekFrom::Start(target as u64))?;
        self.position = position;
        self.observe_length()?;
        Ok(position)
    }
}

impl MediaSource for FixedLengthMediaSource {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        Some(self.length)
    }
}

struct DecodeSource<'a> {
    path: &'a Path,
    extension: &'a str,
    input_bytes: u64,
    limits: DecodeLimits,
    max_decode_time: Duration,
    started_at: Instant,
    has_exact_frame_count: bool,
    source: Box<dyn MediaSource>,
    file_size_observer: File,
    source_changed: Arc<AtomicBool>,
}

fn append_interleaved_typed<F>(
    samples: &mut Vec<f32>,
    source: &SymphoniaAudioBuffer<F>,
) -> Result<()>
where
    F: Sample + IntoSample<f32>,
{
    let frames = source.frames();
    let channels = source.spec().channels.count();
    let sample_count = frames.checked_mul(channels).ok_or_else(|| {
        SpeechAudioError::ResourceLimit("decoded packet sample count overflow".to_string())
    })?;
    samples.try_reserve_exact(sample_count).map_err(|error| {
        SpeechAudioError::ResourceLimit(format!(
            "cannot reserve bounded decoded sample output: {error}"
        ))
    })?;

    for frame in 0..frames {
        for channel in 0..channels {
            let sample = source.chan(channel)[frame].into_sample();
            if !sample.is_finite() {
                return Err(SpeechAudioError::Decode(
                    "decoded audio contains non-finite IEEE float samples".to_string(),
                ));
            }
            samples.push(sample);
        }
    }

    Ok(())
}

fn append_interleaved_ref(samples: &mut Vec<f32>, source: AudioBufferRef<'_>) -> Result<()> {
    match source {
        AudioBufferRef::U8(buffer) => append_interleaved_typed(samples, &buffer),
        AudioBufferRef::U16(buffer) => append_interleaved_typed(samples, &buffer),
        AudioBufferRef::U24(buffer) => append_interleaved_typed(samples, &buffer),
        AudioBufferRef::U32(buffer) => append_interleaved_typed(samples, &buffer),
        AudioBufferRef::S8(buffer) => append_interleaved_typed(samples, &buffer),
        AudioBufferRef::S16(buffer) => append_interleaved_typed(samples, &buffer),
        AudioBufferRef::S24(buffer) => append_interleaved_typed(samples, &buffer),
        AudioBufferRef::S32(buffer) => append_interleaved_typed(samples, &buffer),
        AudioBufferRef::F32(buffer) => append_interleaved_typed(samples, &buffer),
        AudioBufferRef::F64(buffer) => append_interleaved_typed(samples, &buffer),
    }
}

fn decode_audio_from_source(input: DecodeSource<'_>) -> Result<DecodedAudio> {
    let DecodeSource {
        path,
        extension,
        input_bytes,
        limits,
        max_decode_time,
        started_at,
        has_exact_frame_count,
        source,
        file_size_observer,
        source_changed,
    } = input;
    ensure_source_unchanged(&file_size_observer, input_bytes, &source_changed)?;
    let source = MediaSourceStream::new(source, Default::default());
    let mut hint = Hint::new();
    if !extension.is_empty() {
        hint.with_extension(extension);
    }

    let probe_result = get_probe().format(
        &hint,
        source,
        &FormatOptions::default(),
        &MetadataOptions::default(),
    );
    ensure_source_unchanged(&file_size_observer, input_bytes, &source_changed)?;
    let probe = probe_result.map_err(map_probe_error)?;
    ensure_decode_time(started_at, max_decode_time)?;
    let mut format = probe.format;
    let track = format
        .default_track()
        .ok_or_else(|| SpeechAudioError::UnsupportedFormat(path.display().to_string()))?;
    let track_id = track.id;
    let codec_params = track.codec_params.clone();
    let expected_frames = trusted_expected_frames(codec_params.n_frames, has_exact_frame_count);

    let sample_rate = codec_params
        .sample_rate
        .ok_or_else(|| SpeechAudioError::Decode("missing sample rate".to_string()))?;
    if sample_rate == 0 || sample_rate > limits.max_sample_rate {
        return Err(SpeechAudioError::ResourceLimit(format!(
            "sample rate {sample_rate} is outside the bounded range 1..={}",
            limits.max_sample_rate
        )));
    }
    let channels = codec_params
        .channels
        .map(|channels| channels.count() as u16)
        .ok_or_else(|| SpeechAudioError::Decode("missing channel layout".to_string()))?;
    if channels == 0 || channels > limits.max_channels {
        return Err(SpeechAudioError::ResourceLimit(format!(
            "channel count {channels} is outside the bounded range 1..={}",
            limits.max_channels
        )));
    }
    if let Some(expected_frames) = expected_frames {
        validate_declared_frame_count(expected_frames, sample_rate, channels, limits)?;
    }

    let mut decoder = get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(map_decode_error)?;
    ensure_decode_time(started_at, max_decode_time)?;

    let mut samples = Vec::new();
    let mut decoded_frames = 0u64;

    loop {
        ensure_decode_time(started_at, max_decode_time)?;
        let packet_result = format.next_packet();
        ensure_source_unchanged(&file_size_observer, input_bytes, &source_changed)?;
        let packet = match packet_result {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => {
                break
            }
            Err(SymphoniaError::ResetRequired) => {
                return Err(SpeechAudioError::Decode(
                    "decoder reset required for chained stream".to_string(),
                ))
            }
            Err(error) => return Err(map_decode_error(error)),
        };
        ensure_decode_time(started_at, max_decode_time)?;

        if packet.track_id() != track_id {
            continue;
        }

        // A failed packet must not be silently omitted from a successful
        // result: doing so can turn a corrupt compressed stream into
        // apparently valid, but incomplete, provider input.
        let decoded_result = decoder.decode(&packet);
        ensure_source_unchanged(&file_size_observer, input_bytes, &source_changed)?;
        let decoded = decoded_result.map_err(map_packet_decode_error)?;
        ensure_decode_time(started_at, max_decode_time)?;

        // Bound the exact decoded packet before growing the accumulated
        // output. Decoder capacity can be much larger than the remaining
        // budget, so it is not a safe allocation size.
        let spec = *decoded.spec();
        let packet_channels = spec.channels.count();
        if packet_channels == 0 || packet_channels > limits.max_channels as usize {
            return Err(SpeechAudioError::ResourceLimit(format!(
                "decoded channel count {packet_channels} is outside the bounded range 1..={}",
                limits.max_channels
            )));
        }
        if spec.rate == 0 || spec.rate > limits.max_sample_rate || spec.rate != sample_rate {
            return Err(SpeechAudioError::ResourceLimit(format!(
                "decoded sample rate {} does not match the bounded track rate {sample_rate}",
                spec.rate
            )));
        }
        if packet_channels != channels as usize {
            return Err(SpeechAudioError::Decode(format!(
                "decoded channel layout changed from {channels} to {packet_channels}"
            )));
        }
        let packet_frames = decoded.frames();
        let packet_samples = packet_frames.checked_mul(packet_channels).ok_or_else(|| {
            SpeechAudioError::ResourceLimit("decoded packet sample count overflow".to_string())
        })?;
        let remaining_samples = limits.max_decoded_samples.saturating_sub(samples.len());
        if packet_samples > remaining_samples {
            return Err(SpeechAudioError::ResourceLimit(format!(
                "decoded audio exceeds the {} sample budget",
                limits.max_decoded_samples
            )));
        }
        if packet_frames == 0 {
            continue;
        }
        let new_decoded_frames = decoded_frames
            .checked_add(packet_frames as u64)
            .ok_or_else(|| {
                SpeechAudioError::ResourceLimit("decoded frame count overflow".to_string())
            })?;
        // Enforce duration before allocating additional output samples.
        validate_declared_frame_count(new_decoded_frames, sample_rate, channels, limits)?;
        decoded_frames = new_decoded_frames;
        append_interleaved_ref(&mut samples, decoded)?;
    }

    if let Some(expected_frames) = expected_frames {
        if decoded_frames < expected_frames {
            return Err(SpeechAudioError::Decode(format!(
                "truncated audio: container declares {expected_frames} frames but only {decoded_frames} were decoded"
            )));
        }
    }
    ensure_decode_time(started_at, max_decode_time)?;
    ensure_source_unchanged(&file_size_observer, input_bytes, &source_changed)?;

    Ok(DecodedAudio {
        path: path.to_path_buf(),
        samples,
        config: AudioConfig {
            sample_rate,
            channels,
            sample_format: SampleFormat::F32,
        },
        format: extension.to_owned(),
    })
}

fn ensure_source_unchanged(
    file: &File,
    expected_len: u64,
    source_changed: &AtomicBool,
) -> Result<()> {
    let actual_len = file.metadata()?.len();
    if source_changed.load(Ordering::Acquire) || actual_len != expected_len {
        return Err(SpeechAudioError::ResourceLimit(format!(
            "encoded audio source changed size during decoding (expected {expected_len} bytes, observed {actual_len})"
        )));
    }
    Ok(())
}

fn ensure_decode_time(started_at: Instant, budget: Duration) -> Result<()> {
    if started_at.elapsed() >= budget {
        return Err(SpeechAudioError::ResourceLimit(
            "audio decode exceeded its wall-time budget".to_string(),
        ));
    }
    Ok(())
}

/// Validate ordinary RIFF/WAVE chunk boundaries before handing the file to a
/// codec. This checks container integrity and common PCM/IEEE-float layouts;
/// it does not establish provenance, licensing, or provider quality.
fn validate_riff_wav(
    file: &mut File,
    file_len: u64,
    limits: DecodeLimits,
    started_at: Instant,
    max_decode_time: Duration,
) -> Result<()> {
    ensure_decode_time(started_at, max_decode_time)?;
    let mut header = [0u8; 12];
    file.seek(SeekFrom::Start(0))?;
    match file.read_exact(&mut header) {
        Ok(()) if &header[..4] == b"RIFF" && &header[8..] == b"WAVE" => {}
        Ok(()) => return Ok(()),
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(()),
        Err(error) => return Err(SpeechAudioError::Io(error)),
    }

    let declared_len = u64::from(u32::from_le_bytes(header[4..8].try_into().unwrap())) + 8;
    if declared_len != file_len {
        return Err(SpeechAudioError::Decode(format!(
            "RIFF size declares {declared_len} bytes but file has {file_len}"
        )));
    }

    let mut offset = 12u64;
    let mut fmt: Option<(u16, u16, u32, u32, u16, u16)> = None;
    let mut extensible_metadata: Option<(u16, u32)> = None;
    let mut data_size: Option<u32> = None;
    while offset < declared_len {
        ensure_decode_time(started_at, max_decode_time)?;
        if declared_len - offset < 8 {
            return Err(SpeechAudioError::Decode(
                "truncated RIFF chunk header".to_string(),
            ));
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut chunk_header = [0u8; 8];
        file.read_exact(&mut chunk_header)?;
        ensure_decode_time(started_at, max_decode_time)?;
        let chunk_size = u32::from_le_bytes(chunk_header[4..8].try_into().unwrap());
        let chunk_start = offset + 8;
        let chunk_end = chunk_start
            .checked_add(u64::from(chunk_size))
            .ok_or_else(|| SpeechAudioError::Decode("RIFF chunk size overflow".to_string()))?;
        let padded_end = chunk_end
            .checked_add(u64::from(chunk_size & 1))
            .ok_or_else(|| SpeechAudioError::Decode("RIFF chunk padding overflow".to_string()))?;
        if padded_end > declared_len {
            return Err(SpeechAudioError::Decode(format!(
                "RIFF chunk {:?} extends beyond declared container size",
                String::from_utf8_lossy(&chunk_header[..4])
            )));
        }

        if &chunk_header[..4] == b"fmt " {
            if fmt.is_some() || chunk_size < 16 {
                return Err(SpeechAudioError::Decode(
                    "WAVE must contain one fmt chunk of at least 16 bytes".to_string(),
                ));
            }
            let mut raw = [0u8; 40];
            let bytes_to_read = if chunk_size >= 40 { 40 } else { 16 };
            file.read_exact(&mut raw[..bytes_to_read])?;
            ensure_decode_time(started_at, max_decode_time)?;
            let mut encoding = u16::from_le_bytes(raw[0..2].try_into().unwrap());
            if encoding == 0xfffe {
                let extension_size = u32::from(u16::from_le_bytes(raw[16..18].try_into().unwrap()));
                if chunk_size < 40 || extension_size < 22 || extension_size + 18 > chunk_size {
                    return Err(SpeechAudioError::Decode(
                        "WAVE extensible fmt chunk is shorter than its required extension"
                            .to_string(),
                    ));
                }
                const SUBFORMAT_TAIL: [u8; 14] =
                    [0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
                let subtype = u16::from_le_bytes(raw[24..26].try_into().unwrap());
                // The standard GUID begins with the subtype in the first two
                // bytes, followed by the canonical WAVEFORMATEX GUID suffix.
                if raw[26..40] == SUBFORMAT_TAIL {
                    encoding = subtype;
                } else {
                    return Err(SpeechAudioError::Decode(
                        "WAVE extensible fmt chunk has an unsupported subformat GUID".to_string(),
                    ));
                }
                if !matches!(encoding, 1 | 3) {
                    return Err(SpeechAudioError::Decode(
                        "WAVE extensible fmt chunk uses an unsupported audio subformat".to_string(),
                    ));
                }
                extensible_metadata = Some((
                    u16::from_le_bytes(raw[18..20].try_into().unwrap()),
                    u32::from_le_bytes(raw[20..24].try_into().unwrap()),
                ));
            }
            fmt = Some((
                encoding,
                u16::from_le_bytes(raw[2..4].try_into().unwrap()),
                u32::from_le_bytes(raw[4..8].try_into().unwrap()),
                u32::from_le_bytes(raw[8..12].try_into().unwrap()),
                u16::from_le_bytes(raw[12..14].try_into().unwrap()),
                u16::from_le_bytes(raw[14..16].try_into().unwrap()),
            ));
        } else if &chunk_header[..4] == b"data" && data_size.replace(chunk_size).is_some() {
            return Err(SpeechAudioError::Decode(
                "WAVE contains more than one data chunk".to_string(),
            ));
        }
        offset = padded_end;
    }

    ensure_decode_time(started_at, max_decode_time)?;

    let (encoding, channels, rate, byte_rate, block_align, bits) =
        fmt.ok_or_else(|| SpeechAudioError::Decode("WAVE is missing its fmt chunk".to_string()))?;
    let data_size = data_size
        .ok_or_else(|| SpeechAudioError::Decode("WAVE is missing its data chunk".to_string()))?;
    if channels == 0 || channels > limits.max_channels || rate == 0 || rate > limits.max_sample_rate
    {
        return Err(SpeechAudioError::ResourceLimit(format!(
            "WAVE channel count {channels} or sample rate {rate} exceeds decode limits"
        )));
    }
    if matches!(encoding, 1 | 3) {
        let supported_bits = if encoding == 1 {
            matches!(bits, 8 | 16 | 24 | 32)
        } else {
            matches!(bits, 32 | 64)
        };
        let bytes_per_sample = u32::from(bits).div_ceil(8);
        let expected_align = u32::from(channels).checked_mul(bytes_per_sample);
        let expected_rate = expected_align.and_then(|align| rate.checked_mul(align));
        if !supported_bits
            || expected_align != Some(u32::from(block_align))
            || expected_rate != Some(byte_rate)
        {
            return Err(SpeechAudioError::Decode(
                "WAVE PCM/float bit depth, byte rate, or channel alignment is invalid".to_string(),
            ));
        }
        if let Some((valid_bits, channel_mask)) = extensible_metadata {
            // This decoder consumes the complete PCM container word. A
            // smaller valid-bit field would require alignment-aware scaling;
            // reject it rather than silently mis-normalizing the samples.
            if valid_bits != bits {
                return Err(SpeechAudioError::Decode(
                    "WAVE extensible valid bit depth must match its sample container".to_string(),
                ));
            }
            // A zero mask means the speaker layout is unspecified. When a
            // layout is supplied, its speaker count must describe every
            // interleaved channel or downstream channel identity is ambiguous.
            if channel_mask != 0 && channel_mask.count_ones() != u32::from(channels) {
                return Err(SpeechAudioError::Decode(
                    "WAVE extensible speaker mask does not match channel count".to_string(),
                ));
            }
        }
        if data_size % u32::from(block_align) != 0 {
            return Err(SpeechAudioError::Decode(
                "WAVE data chunk does not contain complete interleaved frames".to_string(),
            ));
        }
        let frames = u64::from(data_size / u32::from(block_align));
        validate_declared_frame_count(frames, rate, channels, limits)?;
    }
    Ok(())
}

fn map_probe_error(error: SymphoniaError) -> SpeechAudioError {
    match error {
        SymphoniaError::Unsupported(message) => {
            SpeechAudioError::UnsupportedFormat(message.to_string())
        }
        other => map_decode_error(other),
    }
}

fn map_decode_error(error: SymphoniaError) -> SpeechAudioError {
    match error {
        SymphoniaError::IoError(error) => SpeechAudioError::Io(error),
        SymphoniaError::Unsupported(message) => {
            SpeechAudioError::UnsupportedFormat(message.to_string())
        }
        other => SpeechAudioError::Decode(other.to_string()),
    }
}

fn map_packet_decode_error(error: SymphoniaError) -> SpeechAudioError {
    match error {
        SymphoniaError::IoError(error) if error.kind() == ErrorKind::UnexpectedEof => {
            SpeechAudioError::Decode(format!("codec packet is truncated: {error}"))
        }
        SymphoniaError::DecodeError(message) => {
            SpeechAudioError::Decode(format!("codec packet decode failed: {message}"))
        }
        other => map_decode_error(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::sync::atomic::AtomicU64;
    use tempfile::tempdir;

    struct GrowFileOnFirstRead {
        source: FixedLengthMediaSource,
        path: PathBuf,
        grown: bool,
        bytes_returned: Arc<AtomicU64>,
    }

    impl Read for GrowFileOnFirstRead {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if !self.grown {
                let mut file = OpenOptions::new().append(true).open(&self.path)?;
                file.write_all(b"concurrent-file-growth")?;
                self.grown = true;
            }
            let count = self.source.read(buffer)?;
            self.bytes_returned
                .fetch_add(count as u64, Ordering::Relaxed);
            Ok(count)
        }
    }

    impl Seek for GrowFileOnFirstRead {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            self.source.seek(position)
        }
    }

    impl MediaSource for GrowFileOnFirstRead {
        fn is_seekable(&self) -> bool {
            self.source.is_seekable()
        }

        fn byte_len(&self) -> Option<u64> {
            self.source.byte_len()
        }
    }

    fn wav_chunk(bytes: &[u8], wanted: &[u8; 4]) -> (usize, usize, usize) {
        let mut offset = 12usize;
        while offset + 8 <= bytes.len() {
            let size =
                u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
            if &bytes[offset..offset + 4] == wanted {
                return (offset, offset + 4, offset + 8);
            }
            offset += 8 + size + (size & 1);
        }
        panic!("missing WAVE chunk {:?}", String::from_utf8_lossy(wanted));
    }

    const MAX_RESAMPLE_BENCH_WORKERS: usize = 64;
    const MAX_RESAMPLE_BENCH_SCRATCH_BYTES: usize = 16 * 1024 * 1024;
    const RESAMPLE_BENCH_REPETITIONS: usize = 3;

    fn seeded_stereo_fixture() -> AudioBuffer {
        let frames = 48_000usize;
        let mut samples = Vec::new();
        samples
            .try_reserve_exact(frames * 2)
            .expect("one-second fixture allocation is bounded");
        for frame in 0..frames {
            samples.push((frame as f64 * 0.17).sin() as f32 * 0.4);
            samples.push((frame as f64 * 0.11).cos() as f32 * 0.4);
        }
        AudioBuffer::new(
            samples,
            AudioConfig {
                sample_rate: 48_000,
                channels: 2,
                sample_format: SampleFormat::F32,
            },
        )
    }

    fn estimate_resample_bench_scratch(
        input_samples: usize,
        output_samples: usize,
        worker_count: usize,
        repetitions: usize,
    ) -> Result<usize> {
        let output_bytes = output_samples
            .checked_mul(std::mem::size_of::<f32>())
            .and_then(|bytes| bytes.checked_mul(worker_count))
            .ok_or_else(|| {
                SpeechAudioError::ResourceLimit(
                    "fixture concurrency output allocation estimate overflowed".to_string(),
                )
            })?;
        let worker_slot_bytes = std::mem::size_of::<AudioBuffer>()
            .checked_add(std::mem::size_of::<std::time::Duration>())
            .and_then(|bytes| {
                bytes.checked_add(std::mem::size_of::<
                    std::thread::ScopedJoinHandle<'_, Result<(std::time::Duration, AudioBuffer)>>,
                >())
            })
            .and_then(|bytes| bytes.checked_mul(worker_count));
        let observation_bytes = worker_count
            .checked_mul(repetitions)
            .and_then(|count| count.checked_mul(std::mem::size_of::<std::time::Duration>()));
        let input_bytes = input_samples.checked_mul(std::mem::size_of::<f32>());
        let reference_bytes = output_samples.checked_mul(std::mem::size_of::<f32>());
        let fixed_buffer_headers = std::mem::size_of::<AudioBuffer>().checked_mul(2);
        let result_vector_headers = std::mem::size_of::<Vec<AudioBuffer>>()
            .checked_add(std::mem::size_of::<Vec<std::time::Duration>>() * 2)
            .and_then(|bytes| {
                bytes.checked_add(std::mem::size_of::<
                    Vec<
                        std::thread::ScopedJoinHandle<
                            '_,
                            Result<(std::time::Duration, AudioBuffer)>,
                        >,
                    >,
                >())
            });
        let scratch_bytes = worker_slot_bytes
            .and_then(|bytes| bytes.checked_add(output_bytes))
            .and_then(|bytes| bytes.checked_add(observation_bytes?))
            .and_then(|bytes| bytes.checked_add(input_bytes?))
            .and_then(|bytes| bytes.checked_add(reference_bytes?))
            .and_then(|bytes| bytes.checked_add(fixed_buffer_headers?))
            .and_then(|bytes| bytes.checked_add(result_vector_headers?))
            .and_then(|bytes| bytes.checked_add(std::mem::size_of::<std::sync::Barrier>()))
            .and_then(|bytes| {
                bytes.checked_add(std::mem::size_of::<
                    std::sync::Mutex<Option<Option<std::sync::Arc<std::sync::Barrier>>>>,
                >())
            })
            .and_then(|bytes| bytes.checked_add(std::mem::size_of::<std::sync::Condvar>()))
            .ok_or_else(|| {
                SpeechAudioError::ResourceLimit(
                    "fixture concurrency scratch estimate overflowed".to_string(),
                )
            })?;
        if scratch_bytes > MAX_RESAMPLE_BENCH_SCRATCH_BYTES {
            return Err(SpeechAudioError::ResourceLimit(format!(
                "fixture concurrency scratch estimate {scratch_bytes} exceeds {} byte budget",
                MAX_RESAMPLE_BENCH_SCRATCH_BYTES
            )));
        }
        Ok(scratch_bytes)
    }

    fn run_concurrent_resample_fixture(
        input: &AudioBuffer,
        expected: &AudioBuffer,
        worker_count: usize,
        repetitions: usize,
    ) -> Result<(std::time::Duration, Vec<std::time::Duration>, usize)> {
        if worker_count == 0 || worker_count > MAX_RESAMPLE_BENCH_WORKERS {
            return Err(SpeechAudioError::ResourceLimit(format!(
                "fixture concurrency must be within 1..={MAX_RESAMPLE_BENCH_WORKERS} workers"
            )));
        }
        if repetitions == 0 {
            return Err(SpeechAudioError::InvalidInput(
                "fixture repetition count must be positive".to_string(),
            ));
        }
        let scratch_bytes = estimate_resample_bench_scratch(
            input.samples.len(),
            expected.samples.len(),
            worker_count,
            repetitions,
        )?;

        let mut batch_wall_elapsed = std::time::Duration::ZERO;
        let mut latencies = Vec::new();
        latencies
            .try_reserve_exact(worker_count * repetitions)
            .map_err(|error| {
                SpeechAudioError::ResourceLimit(format!(
                    "cannot reserve bounded fixture latency observations: {error}"
                ))
            })?;

        for _ in 0..repetitions {
            let (wall_elapsed, batch_latencies) = std::thread::scope(|scope| -> Result<_> {
                let mut handles = Vec::new();
                handles.try_reserve_exact(worker_count).map_err(|error| {
                    SpeechAudioError::ResourceLimit(format!(
                        "cannot reserve bounded fixture worker handles: {error}"
                    ))
                })?;
                let gate = std::sync::Arc::new((
                    std::sync::Mutex::new(None::<Option<std::sync::Arc<std::sync::Barrier>>>),
                    std::sync::Condvar::new(),
                ));
                let mut batch_latencies = Vec::new();
                batch_latencies
                    .try_reserve_exact(worker_count)
                    .map_err(|error| {
                        SpeechAudioError::ResourceLimit(format!(
                            "cannot reserve bounded fixture batch latencies: {error}"
                        ))
                    })?;
                let mut outputs = Vec::new();
                outputs.try_reserve_exact(worker_count).map_err(|error| {
                    SpeechAudioError::ResourceLimit(format!(
                        "cannot reserve bounded fixture outputs: {error}"
                    ))
                })?;

                for _ in 0..worker_count {
                    let worker_gate = std::sync::Arc::clone(&gate);
                    match std::thread::Builder::new()
                        .name("speech-audio-resample-fixture".to_string())
                        .spawn_scoped(scope, move || {
                            let (lock, ready) = &*worker_gate;
                            let state = lock
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            let state = ready
                                .wait_while(state, |state| state.is_none())
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            let Some(Some(barrier)) = state.as_ref() else {
                                return Err(SpeechAudioError::ResourceLimit(
                                    "fixture worker start was cancelled".to_string(),
                                ));
                            };
                            let barrier = std::sync::Arc::clone(barrier);
                            drop(state);
                            barrier.wait();
                            let start = std::time::Instant::now();
                            let output = Resampler::new(16_000).resample(input)?;
                            Ok::<_, SpeechAudioError>((start.elapsed(), output))
                        }) {
                        Ok(handle) => handles.push(handle),
                        Err(error) => {
                            let (lock, ready) = &*gate;
                            *lock
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(None);
                            ready.notify_all();
                            for handle in handles {
                                let _ = handle.join();
                            }
                            return Err(SpeechAudioError::ResourceLimit(format!(
                                "cannot start bounded fixture worker: {error}"
                            )));
                        }
                    }
                }

                let barrier = std::sync::Arc::new(std::sync::Barrier::new(worker_count + 1));
                let (lock, ready) = &*gate;
                *lock
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) =
                    Some(Some(std::sync::Arc::clone(&barrier)));
                ready.notify_all();
                let wall_start = std::time::Instant::now();
                barrier.wait();
                for handle in handles {
                    let (latency, output) = handle.join().map_err(|_| {
                        SpeechAudioError::ResourceLimit(
                            "fixture resampler worker panicked".to_string(),
                        )
                    })??;
                    batch_latencies.push(latency);
                    outputs.push(output);
                }
                let elapsed = wall_start.elapsed();
                if outputs.iter().any(|output| {
                    output.config.sample_rate != expected.config.sample_rate
                        || output.config.channels != expected.config.channels
                        || output.samples != expected.samples
                        || output.samples.iter().any(|sample| !sample.is_finite())
                }) {
                    return Err(SpeechAudioError::InvalidInput(
                        "fixture resampler output differs from deterministic reference".to_string(),
                    ));
                }
                drop(outputs);
                Ok((elapsed, batch_latencies))
            })?;
            batch_wall_elapsed += wall_elapsed;
            latencies.extend(batch_latencies);
        }
        Ok((batch_wall_elapsed, latencies, scratch_bytes))
    }

    fn nearest_rank_percentile(
        sorted: &[std::time::Duration],
        percentile: usize,
    ) -> std::time::Duration {
        let rank = (sorted.len() * percentile).div_ceil(100).max(1);
        sorted[rank - 1]
    }

    #[test]
    fn decoded_duration_matches_buffer_formula_without_requiring_valid_rates() {
        let decoded = DecodedAudio {
            path: PathBuf::new(),
            samples: vec![0.0; 10],
            config: AudioConfig {
                sample_rate: 4,
                channels: 2,
                sample_format: SampleFormat::F32,
            },
            format: "wav".to_string(),
        };
        let equivalent = AudioBuffer::new(decoded.samples.clone(), decoded.config);
        assert_eq!(decoded.duration_seconds(), 1.25);
        assert_eq!(decoded.duration_seconds(), equivalent.duration_seconds());

        let mut zero_rate = decoded;
        zero_rate.config.sample_rate = 0;
        assert_eq!(zero_rate.duration_seconds(), 0.0);

        let mut zero_channels = zero_rate;
        zero_channels.config.sample_rate = 4;
        zero_channels.config.channels = 0;
        assert_eq!(zero_channels.duration_seconds(), 0.0);
    }

    #[test]
    fn resampler_changes_frame_count() {
        let buffer = AudioBuffer::new(
            vec![0.0, 0.5, 1.0, 0.5],
            AudioConfig {
                sample_rate: 2,
                channels: 1,
                sample_format: SampleFormat::F32,
            },
        );

        let output = Resampler::new(4).resample(&buffer).unwrap();

        assert_eq!(output.config.sample_rate, 4);
        assert!(output.samples.len() >= 7);
        // The bandlimited edge window cannot reproduce the first sample exactly;
        // it stays bounded near the leading source neighborhood instead.
        assert!(output.samples.first().copied().unwrap().abs() < 0.3);
    }

    fn sine_buffer(sample_rate: u32, channels: u16, frames: usize, freq_hz: f64) -> AudioBuffer {
        let mut samples = Vec::with_capacity(frames * channels as usize);
        for frame in 0..frames {
            for channel in 0..channels {
                let phase = 2.0 * std::f64::consts::PI * freq_hz * frame as f64
                    / sample_rate as f64
                    + channel as f64 * 0.0;
                samples.push((phase.sin() * 0.5) as f32);
            }
        }
        AudioBuffer::new(
            samples,
            AudioConfig {
                sample_rate,
                channels,
                sample_format: SampleFormat::F32,
            },
        )
    }

    fn rms(samples: &[f32]) -> f64 {
        let sum_sq: f64 = samples.iter().map(|s| (*s as f64) * (*s as f64)).sum();
        (sum_sq / samples.len().max(1) as f64).sqrt()
    }

    #[test]
    fn resampler_preserves_inband_tone_across_source_rates() {
        // 1 kHz tone through 1k/8k/44.1k/48k source rates into 16 kHz stays within
        // a tight tolerance of the analytic sine once edge windows settle.
        for source_rate in [1_000u32, 8_000, 44_100, 48_000] {
            let frames = source_rate as usize / 4;
            let input = sine_buffer(source_rate, 1, frames, 125.0);
            let output = Resampler::new(16_000).resample(&input).unwrap();

            let expected_frames = ((frames as u128 * 16_000 * 2 + source_rate as u128)
                / (source_rate as u128 * 2)) as usize;
            assert_eq!(output.samples.len(), expected_frames);

            let edge = 64usize.min(output.samples.len() / 4);
            let mut max_err = 0.0f64;
            for (i, sample) in output
                .samples
                .iter()
                .enumerate()
                .skip(edge)
                .take(output.samples.len() - 2 * edge)
            {
                let ideal = (2.0 * std::f64::consts::PI * 125.0 * i as f64 / 16_000.0).sin() * 0.5;
                max_err = max_err.max((*sample as f64 - ideal).abs());
            }
            assert!(
                max_err < 0.05,
                "in-band tone distorted at {source_rate} Hz: max_err={max_err}"
            );
        }
    }

    #[test]
    fn resampler_impulse_is_time_aligned_across_named_source_rates() {
        // Exercise the rates called out by RS-03. The source impulse is kept
        // well inside the buffer so truncation at either edge cannot move the
        // peak. Expected positions use integer rational conversion, matching
        // the public sample-boundary convention (no accumulated float clock).
        for source_rate in [1_000u32, 8_000, 44_100, 48_000] {
            let target_rate = 16_000u32;
            let input_frames = source_rate as usize * 2;
            let source_impulse = source_rate as usize;
            let mut samples = vec![0.0f32; input_frames];
            samples[source_impulse] = 1.0;
            let input = AudioBuffer::new(
                samples,
                AudioConfig {
                    sample_rate: source_rate,
                    channels: 1,
                    sample_format: SampleFormat::F32,
                },
            );

            let output = Resampler::new(target_rate).resample(&input).unwrap();
            let peak = output
                .samples
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.total_cmp(b.1))
                .map(|(index, _)| index)
                .unwrap();
            let expected = (source_impulse as u128 * target_rate as u128 + source_rate as u128 / 2)
                / source_rate as u128;
            assert!(
                (peak as u128).abs_diff(expected) <= 1,
                "{source_rate} Hz impulse peak at {peak}, expected {expected}"
            );
            let peak_amplitude = output.samples[peak];
            // For downsampling the impulse's peak scales with the low-pass
            // cutoff (approximately target/source rate); the key regression
            // is a finite, substantial peak at the rationally mapped time.
            assert!(
                (0.2..=1.05).contains(&peak_amplitude),
                "{source_rate} Hz impulse peak amplitude {peak_amplitude}"
            );
        }
    }

    #[test]
    fn resampler_interior_impulse_response_is_symmetric_and_finite() {
        // An integer-ratio upsample places this centered impulse exactly on
        // an output sample. A windowed-sinc response is symmetric about that
        // rational position; this catches phase asymmetry that peak-only
        // alignment tests would miss.
        let source_rate = 16_000u32;
        let target_rate = 48_000u32;
        let source_impulse = 512usize;
        let mut samples = vec![0.0f32; 1_024];
        samples[source_impulse] = 1.0;
        let input = AudioBuffer::new(
            samples,
            AudioConfig {
                sample_rate: source_rate,
                channels: 1,
                sample_format: SampleFormat::F32,
            },
        );

        let output = Resampler::new(target_rate).resample(&input).unwrap();
        let center = source_impulse * target_rate as usize / source_rate as usize;
        assert!(output.samples.iter().all(|sample| sample.is_finite()));
        for offset in 1..=72usize {
            let left = output.samples[center - offset] as f64;
            let right = output.samples[center + offset] as f64;
            assert!(
                (left - right).abs() < 1e-6,
                "impulse response is asymmetric at offset {offset}: {left} vs {right}"
            );
        }
    }

    #[test]
    fn resampler_attenuates_alias_content() {
        // 20 kHz source content is above the 4 kHz Nyquist edge of an 8 kHz
        // target and must be attenuated before sampling, not folded.
        let input = sine_buffer(48_000, 1, 4_800, 20_000.0);
        let output = Resampler::new(8_000).resample(&input).unwrap();

        assert!(
            rms(&output.samples) < 0.02,
            "alias energy leaked: {}",
            rms(&output.samples)
        );
    }

    #[test]
    fn resampler_preserves_channel_isolation_and_dc() {
        // Left carries a tone, right carries DC; neither leaks across channels.
        let frames = 2_000usize;
        let mut samples = Vec::with_capacity(frames * 2);
        for frame in 0..frames {
            samples.push(
                (2.0 * std::f64::consts::PI * 250.0 * frame as f64 / 16_000.0).sin() as f32 * 0.5,
            );
            samples.push(0.7f32);
        }
        let input = AudioBuffer::new(
            samples,
            AudioConfig {
                sample_rate: 16_000,
                channels: 2,
                sample_format: SampleFormat::F32,
            },
        );

        let output = Resampler::new(8_000).resample(&input).unwrap();
        let edge = 48usize;
        for frame in output
            .samples
            .chunks_exact(2)
            .skip(edge)
            .take(output.samples.len() / 2 - 2 * edge)
        {
            assert!(
                (frame[1] - 0.7).abs() < 0.02,
                "DC channel drifted: {}",
                frame[1]
            );
        }

        // A left-only impulse must not appear in the right channel. Check the
        // complete tail so even low-level kernel leakage is caught.
        let mut isolated_samples = vec![0.0f32; 256 * 2];
        isolated_samples[128 * 2] = 1.0;
        let isolated = AudioBuffer::new(
            isolated_samples,
            AudioConfig {
                sample_rate: 16_000,
                channels: 2,
                sample_format: SampleFormat::F32,
            },
        );
        let isolated_output = Resampler::new(8_000).resample(&isolated).unwrap();
        assert!(isolated_output
            .samples
            .chunks_exact(2)
            .all(|frame| frame[1] == 0.0));
    }

    #[test]
    fn resampler_tracks_source_positions_without_drift() {
        // An impulse at an exact source position maps to the same rational
        // position in the output, with no accumulated float offset over a
        // 48000-sample span.
        let mut samples = vec![0.0f32; 48_000];
        samples[36_001] = 1.0;
        let input = AudioBuffer::new(
            samples,
            AudioConfig {
                sample_rate: 48_000,
                channels: 1,
                sample_format: SampleFormat::F32,
            },
        );

        let output = Resampler::new(8_000).resample(&input).unwrap();
        let peak = output
            .samples
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .map(|(i, _)| i)
            .unwrap();
        let expected = 36_001usize * 8_000 / 48_000;
        assert!(
            peak.abs_diff(expected) <= 1,
            "impulse drifted: peak={peak} expected={expected}"
        );
    }

    #[test]
    fn resampler_long_duration_matches_rational_endpoint_and_reference_tone() {
        // Thirty seconds at the common 44.1 -> 48 kHz conversion is long
        // enough to expose a per-output floating-point phase accumulator. The
        // final impulse is checked against direct rational arithmetic.
        let source_rate = 44_100u32;
        let target_rate = 48_000u32;
        let input_frames = source_rate as usize * 30;
        let impulse_frame = input_frames - 20_000;
        let mut samples = vec![0.0f32; input_frames];
        samples[impulse_frame] = 1.0;
        let input = AudioBuffer::new(
            samples,
            AudioConfig {
                sample_rate: source_rate,
                channels: 1,
                sample_format: SampleFormat::F32,
            },
        );
        let output = Resampler::new(target_rate).resample(&input).unwrap();
        let peak = output
            .samples
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .map(|(index, _)| index)
            .unwrap();
        let expected = (impulse_frame as u128 * target_rate as u128 + source_rate as u128 / 2)
            / source_rate as u128;
        assert!(
            (peak as u128).abs_diff(expected) <= 1,
            "long-duration impulse drifted: peak={peak}, expected={expected}"
        );

        // Compare an independent in-band 440 Hz reference after edge settling.
        // This bounds passband error without claiming provider or production
        // quality.
        let tone_frames = 44_100usize * 2;
        let tone = sine_buffer(source_rate, 1, tone_frames, 440.0);
        let tone_output = Resampler::new(target_rate).resample(&tone).unwrap();
        let edge = 128usize;
        let mut max_error = 0.0f64;
        for (index, sample) in tone_output
            .samples
            .iter()
            .enumerate()
            .skip(edge)
            .take(tone_output.samples.len() - 2 * edge)
        {
            let reference =
                (2.0 * std::f64::consts::PI * 440.0 * index as f64 / target_rate as f64).sin()
                    * 0.5;
            max_error = max_error.max((*sample as f64 - reference).abs());
        }
        assert!(max_error < 0.01, "440 Hz reference max error {max_error}");
    }

    #[test]
    fn resampler_rejects_non_finite_and_invalid() {
        let mut input = sine_buffer(16_000, 1, 128, 250.0);
        input.samples[64] = f32::NAN;
        assert!(matches!(
            Resampler::new(8_000).resample(&input),
            Err(SpeechAudioError::InvalidInput(_))
        ));
        assert!(matches!(
            Resampler::new(16_000).resample(&input),
            Err(SpeechAudioError::InvalidInput(_))
        ));
        assert!(matches!(
            Resampler::new(0).resample(&sine_buffer(16_000, 1, 64, 250.0)),
            Err(SpeechAudioError::InvalidInput(_))
        ));
        assert!(matches!(
            Resampler::with_options(16_000, 0, 0.9),
            Err(SpeechAudioError::InvalidInput(_))
        ));
        assert!(matches!(
            Resampler::with_options(16_000, 24, 1.5),
            Err(SpeechAudioError::InvalidInput(_))
        ));
    }

    #[test]
    fn resampler_rejects_finite_input_that_overflows_f32_output() {
        let mut samples = vec![0.0; 96];
        samples[24..48].fill(f32::MAX);
        let input = AudioBuffer::new(
            samples,
            AudioConfig {
                sample_rate: 48_000,
                channels: 1,
                sample_format: SampleFormat::F32,
            },
        );

        assert!(matches!(
            Resampler::new(16_000).resample(&input),
            Err(SpeechAudioError::ResourceLimit(_))
        ));
    }

    #[test]
    fn resampler_bounds_output_allocation_and_rejects_malformed_channels() {
        assert!(Resampler::validate_output_sample_count(Resampler::MAX_OUTPUT_SAMPLES).is_ok());
        assert!(matches!(
            Resampler::validate_output_sample_count(Resampler::MAX_OUTPUT_SAMPLES + 1),
            Err(SpeechAudioError::ResourceLimit(_))
        ));

        let one_sample = AudioBuffer::new(
            vec![0.5],
            AudioConfig {
                sample_rate: 1,
                channels: 1,
                sample_format: SampleFormat::F32,
            },
        );
        assert!(matches!(
            Resampler::new(u32::MAX).resample(&one_sample),
            Err(SpeechAudioError::ResourceLimit(_))
        ));

        let zero_channels = AudioBuffer::new(
            vec![0.5],
            AudioConfig {
                sample_rate: 16_000,
                channels: 0,
                sample_format: SampleFormat::F32,
            },
        );
        assert!(matches!(
            Resampler::new(8_000).resample(&zero_channels),
            Err(SpeechAudioError::InvalidInput(_))
        ));

        let incomplete_interleaved_frame = AudioBuffer::new(
            vec![0.1, 0.2, 0.3],
            AudioConfig {
                sample_rate: 16_000,
                channels: 2,
                sample_format: SampleFormat::F32,
            },
        );
        assert!(matches!(
            Resampler::new(8_000).resample(&incomplete_interleaved_frame),
            Err(SpeechAudioError::InvalidInput(_))
        ));

        let same_rate = sine_buffer(16_000, 1, 16, 250.0);
        assert_eq!(
            Resampler::new(16_000).resample(&same_rate).unwrap().samples,
            same_rate.samples
        );
        let empty = AudioBuffer::new(
            Vec::new(),
            AudioConfig {
                sample_rate: 8_000,
                channels: 1,
                sample_format: SampleFormat::F32,
            },
        );
        assert!(Resampler::new(16_000)
            .resample(&empty)
            .unwrap()
            .samples
            .is_empty());
    }

    #[test]
    fn resample_decode_rtf_smoke() {
        // Seeded measurement smoke only: records real-time factor for resample
        // and WAV decode under a generous bounded-scratch ceiling. No baseline
        // is asserted; the absolute bound only guards pathological regression.
        let input = seeded_stereo_fixture();

        let start = std::time::Instant::now();
        let output = Resampler::new(16_000).resample(&input).unwrap();
        let resample_elapsed = start.elapsed();

        let temp = tempdir().unwrap();
        let path = temp.path().join("rtf.wav");
        write_wav(&path, &output).unwrap();
        let decode_start = std::time::Instant::now();
        let decoded = load_audio_buffer(&path).unwrap();
        let decode_elapsed = decode_start.elapsed();

        assert_eq!(decoded.config.sample_rate, 16_000);
        assert_eq!(decoded.config.channels, 2);
        assert_eq!(decoded.samples.len(), output.samples.len());
        let seconds = input.duration_seconds();
        println!(
            "resample_rtf={:.3} decode_rtf={:.3} duration_s={:.2}",
            resample_elapsed.as_secs_f64() / seconds,
            decode_elapsed.as_secs_f64() / seconds,
            seconds
        );
        assert!(
            resample_elapsed.as_secs_f64() < 30.0,
            "resample pathologically slow: {resample_elapsed:?}"
        );
        drop(decoded);
        drop(output);

        let expected = Resampler::new(16_000).resample(&input).unwrap();
        for worker_count in [1usize, 16, 64] {
            let (wall_elapsed, mut latencies, scratch_bytes) = run_concurrent_resample_fixture(
                &input,
                &expected,
                worker_count,
                RESAMPLE_BENCH_REPETITIONS,
            )
            .unwrap();
            latencies.sort_unstable();
            let audio_seconds =
                input.duration_seconds() * worker_count as f64 * RESAMPLE_BENCH_REPETITIONS as f64;
            println!(
                "fixture_local_resample_concurrency workers={worker_count} repetitions={RESAMPLE_BENCH_REPETITIONS} latency_p50_ms={:.3} latency_p95_ms={:.3} aggregate_rtf={:.6} estimated_tracked_bytes={scratch_bytes}",
                nearest_rank_percentile(&latencies, 50).as_secs_f64() * 1_000.0,
                nearest_rank_percentile(&latencies, 95).as_secs_f64() * 1_000.0,
                wall_elapsed.as_secs_f64() / audio_seconds
            );
        }
        assert!(matches!(
            run_concurrent_resample_fixture(&input, &expected, 65, RESAMPLE_BENCH_REPETITIONS),
            Err(SpeechAudioError::ResourceLimit(_))
        ));
        assert!(matches!(
            estimate_resample_bench_scratch(
                input.samples.len(),
                MAX_RESAMPLE_BENCH_SCRATCH_BYTES,
                1,
                RESAMPLE_BENCH_REPETITIONS,
            ),
            Err(SpeechAudioError::ResourceLimit(_))
        ));
    }

    #[test]
    fn slice_audio_buffer_returns_expected_window() {
        let buffer = AudioBuffer::new(
            vec![0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
            AudioConfig {
                sample_rate: 2,
                channels: 1,
                sample_format: SampleFormat::F32,
            },
        );

        let sliced = slice_audio_buffer(&buffer, 1.0, 2.0).unwrap();

        assert_eq!(sliced.samples, vec![0.4, 0.6]);
    }

    #[test]
    fn slice_audio_buffer_uses_half_open_sample_timestamps_and_preserves_stereo_frames() {
        let config = AudioConfig {
            sample_rate: 4,
            channels: 2,
            sample_format: SampleFormat::F32,
        };
        let buffer = AudioBuffer::new(vec![0.0, 10.0, 1.0, 11.0, 2.0, 12.0, 3.0, 13.0], config);

        // [0.25, 0.75) selects frame timestamps 0.25 and 0.5, both channels intact.
        assert_eq!(
            slice_audio_buffer(&buffer, 0.25, 0.75).unwrap().samples,
            vec![1.0, 11.0, 2.0, 12.0]
        );
        assert!(slice_audio_buffer(&buffer, 0.5, 0.5)
            .unwrap()
            .samples
            .is_empty());
        assert_eq!(
            slice_audio_buffer(&buffer, 0.75, 1.0).unwrap().samples,
            vec![3.0, 13.0]
        );
    }

    #[test]
    fn adjacent_slice_windows_partition_stereo_audio_without_overlap_or_drift() {
        let config = AudioConfig {
            sample_rate: 3,
            channels: 2,
            sample_format: SampleFormat::F32,
        };
        let buffer = AudioBuffer::new(vec![0.0, 10.0, 1.0, 11.0, 2.0, 12.0], config);

        // Adjacent half-open windows use seconds at 3 Hz. Their shared edges
        // must neither duplicate nor omit a frame, and each frame stays paired.
        let windows = [
            slice_audio_buffer(&buffer, 0.0, 1.0 / 3.0).unwrap(),
            slice_audio_buffer(&buffer, 1.0 / 3.0, 2.0 / 3.0).unwrap(),
            slice_audio_buffer(&buffer, 2.0 / 3.0, 1.0).unwrap(),
        ];
        let joined = windows
            .iter()
            .flat_map(|window| window.samples.iter().copied())
            .collect::<Vec<_>>();

        assert_eq!(joined, buffer.samples);
        assert!(windows.iter().all(|window| window.frame_count() == 1));
    }

    #[test]
    fn slice_audio_buffer_rejects_non_finite_times_instead_of_coercing_indices() {
        let buffer = AudioBuffer::new(
            vec![0.0, 0.2, 0.4, 0.6],
            AudioConfig {
                sample_rate: 2,
                channels: 1,
                sample_format: SampleFormat::F32,
            },
        );

        for (start, end) in [
            (f64::NAN, 1.0),
            (f64::INFINITY, 1.0),
            (f64::NEG_INFINITY, 1.0),
            (0.0, f64::NAN),
            (0.0, f64::INFINITY),
            (0.0, f64::NEG_INFINITY),
        ] {
            assert!(matches!(
                slice_audio_buffer(&buffer, start, end),
                Err(SpeechAudioError::InvalidInput(_))
            ));
        }
    }

    #[test]
    fn slice_audio_buffer_keeps_finite_out_of_range_times_clamped() {
        let buffer = AudioBuffer::new(
            vec![0.0, 0.2, 0.4, 0.6],
            AudioConfig {
                sample_rate: 2,
                channels: 1,
                sample_format: SampleFormat::F32,
            },
        );

        assert_eq!(
            slice_audio_buffer(&buffer, 1.5, 10.0).unwrap().samples,
            vec![0.6]
        );
        assert!(slice_audio_buffer(&buffer, 10.0, 11.0)
            .unwrap()
            .samples
            .is_empty());
        assert!(
            slice_audio_buffer(&buffer, 0.0, f64::MAX)
                .unwrap()
                .samples
                .len()
                == buffer.samples.len()
        );
    }

    #[test]
    fn slice_audio_buffer_rejects_negative_and_invalid_time_or_sample_units() {
        let buffer = AudioBuffer::new(
            vec![0.0, 1.0],
            AudioConfig {
                sample_rate: 2,
                channels: 1,
                sample_format: SampleFormat::F32,
            },
        );
        for (start, end) in [(-0.01, 0.5), (0.0, -0.01), (0.75, 0.5)] {
            assert!(matches!(
                slice_audio_buffer(&buffer, start, end),
                Err(SpeechAudioError::InvalidInput(_))
            ));
        }
        let zero_rate = AudioBuffer::new(
            vec![0.0],
            AudioConfig {
                sample_rate: 0,
                channels: 1,
                sample_format: SampleFormat::F32,
            },
        );
        assert!(matches!(
            slice_audio_buffer(&zero_rate, 0.0, 1.0),
            Err(SpeechAudioError::InvalidInput(_))
        ));

        let incomplete_stereo = AudioBuffer::new(
            vec![0.0],
            AudioConfig {
                sample_rate: 2,
                channels: 2,
                sample_format: SampleFormat::F32,
            },
        );
        assert!(matches!(
            slice_audio_buffer(&incomplete_stereo, 0.0, 1.0),
            Err(SpeechAudioError::InvalidInput(_))
        ));

        let zero_channels = AudioBuffer::new(
            vec![],
            AudioConfig {
                sample_rate: 2,
                channels: 0,
                sample_format: SampleFormat::F32,
            },
        );
        assert!(matches!(
            slice_audio_buffer(&zero_channels, 0.0, 1.0),
            Err(SpeechAudioError::InvalidInput(_))
        ));
    }

    #[test]
    fn mix_audio_validates_shape_and_preserves_silence() {
        let config = AudioConfig {
            sample_rate: 16_000,
            channels: 2,
            sample_format: SampleFormat::F32,
        };
        assert!(matches!(
            mix_audio(&[], &[]),
            Err(SpeechAudioError::InvalidInput(_))
        ));

        let stereo = AudioBuffer::new(vec![0.0, 0.0], config);
        assert!(matches!(
            mix_audio(std::slice::from_ref(&stereo), &[]),
            Err(SpeechAudioError::InvalidInput(_))
        ));
        assert_eq!(
            mix_audio(std::slice::from_ref(&stereo), &[1.0])
                .unwrap()
                .samples,
            vec![0.0, 0.0]
        );

        let incomplete_stereo = AudioBuffer::new(vec![0.0], config);
        assert!(matches!(
            mix_audio(&[incomplete_stereo], &[1.0]),
            Err(SpeechAudioError::InvalidInput(_))
        ));

        let same_shape_other_rate = AudioBuffer::new(
            vec![0.0, 0.0],
            AudioConfig {
                sample_rate: 8_000,
                ..config
            },
        );
        assert!(matches!(
            mix_audio(
                &[
                    AudioBuffer::new(vec![0.0, 0.0], config),
                    same_shape_other_rate,
                ],
                &[1.0, 1.0]
            ),
            Err(SpeechAudioError::InvalidInput(_))
        ));
    }

    #[test]
    fn mix_audio_preserves_gain_without_peak_normalization() {
        let config = AudioConfig {
            sample_rate: 16000,
            channels: 1,
            sample_format: SampleFormat::F32,
        };
        let first = AudioBuffer::new(vec![0.8, 0.8], config);
        let second = AudioBuffer::new(vec![0.8, -0.8], config);

        let mixed = mix_audio(&[first, second], &[1.0, 1.0]).unwrap();

        assert_eq!(mixed.samples, vec![1.6, 0.0]);
    }

    #[test]
    fn mix_audio_preserves_stereo_channel_isolation_and_interleaving() {
        let config = AudioConfig {
            sample_rate: 16000,
            channels: 2,
            sample_format: SampleFormat::F32,
        };
        let left = AudioBuffer::new(vec![0.5, 0.0, 0.25, 0.0], config);
        let right = AudioBuffer::new(vec![0.0, -0.5, 0.0, -0.25], config);
        let mixed = mix_audio(&[left, right], &[1.0, 1.0]).unwrap();
        assert_eq!(mixed.samples, vec![0.5, -0.5, 0.25, -0.25]);
        assert_eq!(mixed.frame_count(), 2);
    }

    #[test]
    fn mix_audio_preserves_pre_panned_channels_and_shorter_track_timing() {
        let config = AudioConfig {
            sample_rate: 16_000,
            channels: 2,
            sample_format: SampleFormat::F32,
        };
        // The inputs already contain isolated left/right content; this helper
        // performs no pan processing. It preserves raw gain (including values
        // above unity) and pads the shorter track with silence.
        let left = AudioBuffer::new(vec![0.8, 0.0, 0.8, 0.0], config);
        let right = AudioBuffer::new(vec![0.0, -0.6], config);
        let mixed = mix_audio(&[left, right], &[2.0, 2.0]).unwrap();
        assert_eq!(mixed.samples, vec![1.6, -1.2, 1.6, 0.0]);
        assert_eq!(mixed.frame_count(), 2);
    }

    #[test]
    fn mix_audio_rejects_zero_sample_rate() {
        let invalid_config = AudioConfig {
            sample_rate: 0,
            channels: 1,
            sample_format: SampleFormat::F32,
        };
        let input = AudioBuffer::new(vec![0.5], invalid_config);
        assert!(matches!(
            mix_audio(&[input], &[1.0]),
            Err(SpeechAudioError::InvalidInput(_))
        ));
    }

    #[test]
    fn mix_audio_rejects_unrepresentable_finite_sum_without_clipping() {
        let config = AudioConfig {
            sample_rate: 16000,
            channels: 1,
            sample_format: SampleFormat::F32,
        };
        let huge = AudioBuffer::new(vec![f32::MAX], config);
        assert!(matches!(
            mix_audio(&[huge.clone(), huge], &[2.0, 2.0]),
            Err(SpeechAudioError::ResourceLimit(_))
        ));
    }

    #[test]
    fn mix_audio_checks_final_sum_after_f64_accumulation() {
        let config = AudioConfig {
            sample_rate: 16_000,
            channels: 1,
            sample_format: SampleFormat::F32,
        };
        let mixed = mix_audio(
            &[
                AudioBuffer::new(vec![f32::MAX], config),
                AudioBuffer::new(vec![f32::MAX], config),
                AudioBuffer::new(vec![-f32::MAX], config),
            ],
            &[1.0, 1.0, 1.0],
        )
        .unwrap();

        assert_eq!(mixed.samples, vec![f32::MAX]);
    }

    #[test]
    fn mix_audio_accumulates_many_variable_length_inputs_in_bounded_blocks() {
        let config = AudioConfig {
            sample_rate: 16_000,
            channels: 1,
            sample_format: SampleFormat::F32,
        };
        let buffers = (0..37)
            .map(|index| {
                let length = index % 11;
                AudioBuffer::new(vec![index as f32; length], config)
            })
            .collect::<Vec<_>>();
        let volumes = vec![1.0; buffers.len()];

        let mixed = mix_audio(&buffers, &volumes).unwrap();

        let expected = (0..10)
            .map(|sample_index| {
                (0..37)
                    .filter(|index| index % 11 > sample_index)
                    .map(|index| index as f32)
                    .sum::<f32>()
            })
            .collect::<Vec<_>>();
        assert_eq!(mixed.samples, expected);
    }

    #[test]
    fn mix_audio_keeps_stereo_alignment_across_accumulation_block_boundary() {
        let config = AudioConfig {
            sample_rate: 16_000,
            channels: 2,
            sample_format: SampleFormat::F32,
        };
        // The internal accumulation block is 4096 interleaved samples. Place
        // distinct channel values on both sides of that boundary and let the
        // second input end halfway through the final stereo frame range.
        let mut long_samples = vec![0.0; 4_102];
        long_samples[4_094..4_098].copy_from_slice(&[0.25, -0.25, 0.5, -0.5]);
        long_samples[4_100..].copy_from_slice(&[0.75, -0.75]);
        let mut short_samples = vec![0.0; 4_098];
        short_samples[4_094..4_098].copy_from_slice(&[0.5, 0.5, -0.25, 0.25]);
        let mixed = mix_audio(
            &[
                AudioBuffer::new(long_samples, config),
                AudioBuffer::new(short_samples, config),
            ],
            &[1.0, 1.0],
        )
        .unwrap();

        assert_eq!(mixed.samples.len(), 4_102);
        assert_eq!(mixed.frame_count(), 2_051);
        assert_eq!(
            mixed.samples[4_094..4_100],
            [0.75, 0.25, 0.25, -0.25, 0.0, 0.0]
        );
        assert_eq!(mixed.samples[4_100..], [0.75, -0.75]);
    }

    #[test]
    fn write_and_read_wav_round_trip() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("round-trip.wav");
        let buffer = AudioBuffer::new(
            vec![0.0, 0.25, -0.25, 0.5],
            AudioConfig {
                sample_rate: 16000,
                channels: 1,
                sample_format: SampleFormat::F32,
            },
        );

        write_wav(&path, &buffer).unwrap();
        let metadata = load_audio_metadata(&path).unwrap();
        let decoded = load_audio_buffer(&path).unwrap();

        assert_eq!(metadata.sample_rate, 16000);
        assert_eq!(metadata.channels, 1);
        assert_eq!(metadata.format, "wav");
        assert_eq!(decoded.config.sample_rate, 16000);
        assert_eq!(decoded.config.channels, 1);
        assert_eq!(decoded.samples.len(), buffer.samples.len());
        let expected_pcm_bytes: Vec<u8> = buffer
            .samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        assert_eq!(bytes_at_wav_data(&path), expected_pcm_bytes);
        assert!(decoded
            .samples
            .iter()
            .zip(&buffer.samples)
            .all(|(actual, expected)| (actual - expected).abs() <= 1e-7));
    }

    #[test]
    fn write_wav_float_roundtrip_is_byte_deterministic_without_clipping() {
        let temp = tempdir().unwrap();
        let first_path = temp.path().join("float-first.wav");
        let replay_path = temp.path().join("float-replay.wav");
        let buffer = AudioBuffer::new(
            vec![-1.25, 1.5, 0.0, -0.75],
            AudioConfig {
                sample_rate: 48_000,
                channels: 2,
                sample_format: SampleFormat::F32,
            },
        );

        write_wav(&first_path, &buffer).unwrap();
        write_wav(&replay_path, &buffer).unwrap();
        let first_bytes = std::fs::read(&first_path).unwrap();
        let replay_bytes = std::fs::read(&replay_path).unwrap();
        assert_eq!(first_bytes, replay_bytes);

        let decoded = load_audio_buffer(&first_path).unwrap();
        assert_eq!(decoded.config.sample_rate, 48_000);
        assert_eq!(decoded.config.channels, 2);
        assert_eq!(decoded.frame_count(), 2);
        assert_eq!(decoded.samples, buffer.samples);
        assert!(decoded.samples.iter().any(|sample| sample.abs() > 1.0));
    }

    fn bytes_at_wav_data(path: &Path) -> Vec<u8> {
        let bytes = std::fs::read(path).unwrap();
        let (_, _, data_start) = wav_chunk(&bytes, b"data");
        bytes[data_start..].to_vec()
    }

    #[test]
    fn write_wav_emits_consistent_float_riff_and_data_sizes() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("header.wav");
        let buffer = AudioBuffer::new(
            vec![-0.75, 0.5, 0.125, -0.25],
            AudioConfig {
                sample_rate: 24_000,
                channels: 2,
                sample_format: SampleFormat::F32,
            },
        );
        write_wav(&path, &buffer).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(
            u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize + 8,
            bytes.len()
        );
        assert_eq!(&bytes[8..12], b"WAVE");
        let (fmt_offset, fmt_size_offset, fmt_data) = wav_chunk(&bytes, b"fmt ");
        assert_eq!(
            u32::from_le_bytes(bytes[fmt_size_offset..fmt_data].try_into().unwrap()),
            40
        );
        assert_eq!(
            u16::from_le_bytes(bytes[fmt_data..fmt_data + 2].try_into().unwrap()),
            0xfffe
        );
        assert_eq!(
            u16::from_le_bytes(bytes[fmt_data + 2..fmt_data + 4].try_into().unwrap()),
            2
        );
        assert_eq!(
            u32::from_le_bytes(bytes[fmt_data + 4..fmt_data + 8].try_into().unwrap()),
            24_000
        );
        assert_eq!(
            u32::from_le_bytes(bytes[fmt_data + 8..fmt_data + 12].try_into().unwrap()),
            192_000
        );
        assert_eq!(
            u16::from_le_bytes(bytes[fmt_data + 12..fmt_data + 14].try_into().unwrap()),
            8
        );
        assert_eq!(
            u16::from_le_bytes(bytes[fmt_data + 14..fmt_data + 16].try_into().unwrap()),
            32
        );
        assert_eq!(
            u16::from_le_bytes(bytes[fmt_data + 24..fmt_data + 26].try_into().unwrap()),
            3
        ); // IEEE float extensible subtype
        assert_eq!(&bytes[fmt_offset..fmt_offset + 4], b"fmt ");
        let (_, data_size, data_start) = wav_chunk(&bytes, b"data");
        assert_eq!(
            u32::from_le_bytes(bytes[data_size..data_start].try_into().unwrap()),
            16
        );
        assert_eq!(bytes.len(), data_start + 16);
    }

    #[test]
    fn decode_rejects_inconsistent_extensible_valid_bits_and_channel_mask() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("extensible-source.wav");
        let buffer = AudioBuffer::new(
            vec![-0.5, 0.5, 0.25, -0.25],
            AudioConfig {
                sample_rate: 48_000,
                channels: 2,
                sample_format: SampleFormat::F32,
            },
        );
        write_wav(&source, &buffer).unwrap();
        let original = std::fs::read(&source).unwrap();
        let (_, _, fmt) = wav_chunk(&original, b"fmt ");
        assert_eq!(
            u16::from_le_bytes(original[fmt..fmt + 2].try_into().unwrap()),
            0xfffe,
            "fixture must exercise WAVE_FORMAT_EXTENSIBLE"
        );

        let output = temp.path().join("malformed-extensible.wav");
        let mut wrong_valid_bits = original.clone();
        wrong_valid_bits[fmt + 18..fmt + 20].copy_from_slice(&31u16.to_le_bytes());
        std::fs::write(&output, wrong_valid_bits).unwrap();
        assert!(matches!(
            load_audio_buffer(&output),
            Err(SpeechAudioError::Decode(message))
                if message == "WAVE extensible valid bit depth must match its sample container"
        ));

        let mut wrong_channel_mask = original;
        wrong_channel_mask[fmt + 20..fmt + 24].copy_from_slice(&1u32.to_le_bytes());
        std::fs::write(&output, wrong_channel_mask).unwrap();
        assert!(matches!(
            load_audio_buffer(&output),
            Err(SpeechAudioError::Decode(message))
                if message == "WAVE extensible speaker mask does not match channel count"
        ));
    }

    #[test]
    fn write_wav_rejects_invalid_sample_layout_before_creating_output() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("invalid.wav");
        let config = AudioConfig {
            sample_rate: 16_000,
            channels: 2,
            sample_format: SampleFormat::F32,
        };
        for buffer in [
            AudioBuffer::new(vec![0.1], config),
            AudioBuffer::new(vec![f32::NAN, 0.0], config),
            AudioBuffer::new(
                vec![0.0],
                AudioConfig {
                    sample_rate: 0,
                    ..config
                },
            ),
            AudioBuffer::new(
                vec![0.0],
                AudioConfig {
                    channels: 0,
                    ..config
                },
            ),
        ] {
            assert!(matches!(
                write_wav(&path, &buffer),
                Err(SpeechAudioError::InvalidInput(_))
            ));
            assert!(!path.exists());
        }
    }

    #[test]
    fn wav_size_preflight_accounts_for_extensible_fmt_and_data_padding() {
        let max_data_bytes = (u32::MAX as usize - 60) & !3;
        assert!(validate_wav_data_size(max_data_bytes).is_ok());
        assert!(matches!(
            validate_wav_data_size(max_data_bytes + 4),
            Err(SpeechAudioError::ResourceLimit(_))
        ));
        assert!(matches!(
            validate_wav_data_size(u32::MAX as usize - 60),
            Err(SpeechAudioError::ResourceLimit(_))
        ));
    }

    #[test]
    fn decode_rejects_non_finite_float_wav_payloads() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("non-finite.wav");
        write_wav(
            &path,
            &AudioBuffer::new(
                vec![0.25],
                AudioConfig {
                    sample_rate: 16_000,
                    channels: 1,
                    sample_format: SampleFormat::F32,
                },
            ),
        )
        .unwrap();
        let mut bytes = std::fs::read(&path).unwrap();
        let (_, _, data_start) = wav_chunk(&bytes, b"data");
        bytes[data_start..data_start + 4].copy_from_slice(&f32::NAN.to_le_bytes());
        std::fs::write(&path, bytes).unwrap();
        assert!(matches!(
            load_audio_buffer(&path),
            Err(SpeechAudioError::Decode(_))
        ));
    }

    #[test]
    fn decodes_synthetic_pcm_16_and_24_bit_stereo_with_expected_range_and_layout() {
        let temp = tempdir().unwrap();
        for (name, bits, samples, expected, tolerance) in [
            (
                "pcm16.wav",
                16,
                vec![-32_768i32, 32_767, -16_384, 16_384],
                vec![-1.0f32, 32_767.0 / 32_768.0, -0.5, 0.5],
                1e-6f32,
            ),
            (
                "pcm24.wav",
                24,
                vec![-8_388_608i32, 8_388_607, -4_194_304, 4_194_304],
                vec![-1.0f32, 8_388_607.0 / 8_388_608.0, -0.5, 0.5],
                1e-6f32,
            ),
        ] {
            let path = temp.path().join(name);
            let spec = WavSpec {
                channels: 2,
                sample_rate: 16_000,
                bits_per_sample: bits,
                sample_format: WavSampleFormat::Int,
            };
            let mut writer = WavWriter::create(&path, spec).unwrap();
            for sample in samples {
                writer.write_sample(sample).unwrap();
            }
            writer.finalize().unwrap();

            let decoded = load_audio_buffer(&path).unwrap();
            assert_eq!(decoded.config.channels, 2);
            assert_eq!(decoded.config.sample_rate, 16_000);
            assert_eq!(decoded.frame_count(), 2);
            for (actual, expected) in decoded.samples.iter().zip(expected) {
                assert!(
                    (actual - expected).abs() <= tolerance,
                    "{name}: {actual} != {expected}"
                );
                assert!((-1.0..=1.0).contains(actual));
            }
        }
    }

    #[test]
    fn riff_wav_validation_rejects_inconsistent_sizes_layout_and_trailing_bytes() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source.wav");
        let buffer = AudioBuffer::new(
            vec![0.0, 0.25, -0.25, 0.5],
            AudioConfig {
                sample_rate: 16_000,
                channels: 2,
                sample_format: SampleFormat::F32,
            },
        );
        write_wav(&source, &buffer).unwrap();
        let original = std::fs::read(&source).unwrap();
        let malformed = [
            {
                let mut bytes = original.clone();
                let malformed_riff_size = (bytes.len() as u32) - 7;
                bytes[4..8].copy_from_slice(&malformed_riff_size.to_le_bytes());
                bytes
            },
            {
                let mut bytes = original.clone();
                let (_, size, _) = wav_chunk(&bytes, b"data");
                bytes[size..size + 4].copy_from_slice(&17u32.to_le_bytes());
                bytes
            },
            {
                let mut bytes = original.clone();
                let (_, _, fmt) = wav_chunk(&bytes, b"fmt ");
                bytes[fmt + 12..fmt + 14].copy_from_slice(&4u16.to_le_bytes());
                bytes
            },
            {
                let mut bytes = original.clone();
                let (_, _, fmt) = wav_chunk(&bytes, b"fmt ");
                bytes[fmt + 14..fmt + 16].copy_from_slice(&12u16.to_le_bytes());
                bytes
            },
            {
                let mut bytes = original.clone();
                let (_, size, _) = wav_chunk(&bytes, b"fmt ");
                bytes[size..size + 4].copy_from_slice(&16u32.to_le_bytes());
                bytes
            },
            {
                let mut bytes = original.clone();
                let (_, _, fmt) = wav_chunk(&bytes, b"fmt ");
                bytes[fmt + 16..fmt + 18].copy_from_slice(&20u16.to_le_bytes());
                bytes
            },
            {
                let mut bytes = original.clone();
                let (_, _, fmt) = wav_chunk(&bytes, b"fmt ");
                bytes[fmt + 16..fmt + 18].copy_from_slice(&23u16.to_le_bytes());
                bytes
            },
            {
                let mut bytes = original.clone();
                let (_, _, fmt) = wav_chunk(&bytes, b"fmt ");
                bytes[fmt + 39] ^= 0x01;
                bytes
            },
            {
                let mut bytes = original.clone();
                let (_, _, fmt) = wav_chunk(&bytes, b"fmt ");
                bytes[fmt + 24..fmt + 26].copy_from_slice(&2u16.to_le_bytes());
                bytes
            },
            {
                let mut bytes = original.clone();
                let (_, size, _) = wav_chunk(&bytes, b"data");
                bytes[size..size + 4].copy_from_slice(&15u32.to_le_bytes());
                bytes
            },
            {
                let mut bytes = original.clone();
                bytes.push(0xaa);
                bytes
            },
        ];
        let path = temp.path().join("malformed.wav");
        for bytes in malformed {
            std::fs::write(&path, bytes).unwrap();
            assert!(load_audio_buffer(&path).is_err());
        }
    }

    #[test]
    fn decode_budget_rejects_oversized_channels_and_samples() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("budget.wav");
        let buffer = AudioBuffer::new(
            vec![0.1; 65_536],
            AudioConfig {
                sample_rate: 16000,
                channels: 1,
                sample_format: SampleFormat::F32,
            },
        );
        write_wav(&path, &buffer).unwrap();

        // A zero-valued limit is an invalid input, not an unbounded decode.
        assert!(matches!(
            load_audio_buffer_bounded(
                &path,
                DecodeLimits {
                    max_decoded_samples: 0,
                    ..DecodeLimits::DEFAULT
                }
            ),
            Err(SpeechAudioError::InvalidInput(_))
        ));
        // A sample budget below the actual decoded extent fails closed.
        let limited = DecodeLimits {
            max_decoded_samples: 8,
            ..DecodeLimits::DEFAULT
        };
        assert!(matches!(
            load_audio_buffer_bounded(&path, limited),
            Err(SpeechAudioError::ResourceLimit(_))
        ));
        // The exact interleaved sample budget is admitted at the boundary.
        let exact_boundary = DecodeLimits {
            max_decoded_samples: buffer.samples.len(),
            ..DecodeLimits::DEFAULT
        };
        assert_eq!(
            load_audio_buffer_bounded(&path, exact_boundary)
                .unwrap()
                .samples
                .len(),
            buffer.samples.len()
        );
        // A sample-rate bound rejects this 16kHz source before allocation.
        let rate_limited = DecodeLimits {
            max_sample_rate: 8000,
            ..DecodeLimits::DEFAULT
        };
        assert!(matches!(
            load_audio_buffer_bounded(&path, rate_limited),
            Err(SpeechAudioError::ResourceLimit(_))
        ));
        // A zero-channel bound is invalid input; the default decodes fine.
        assert!(matches!(
            load_audio_buffer_bounded(
                &path,
                DecodeLimits {
                    max_channels: 0,
                    ..DecodeLimits::DEFAULT
                }
            ),
            Err(SpeechAudioError::InvalidInput(_))
        ));
        assert_eq!(load_audio_buffer(&path).unwrap().samples.len(), 65_536);
    }

    #[test]
    fn decode_budget_rejects_oversized_encoded_input_before_probe() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("encoded-budget.wav");
        write_wav(
            &path,
            &AudioBuffer::new(
                vec![0.25; 32],
                AudioConfig {
                    sample_rate: 16_000,
                    channels: 1,
                    sample_format: SampleFormat::F32,
                },
            ),
        )
        .unwrap();

        assert!(matches!(
            load_audio_buffer_bounded(
                &path,
                DecodeLimits {
                    max_input_bytes: 1,
                    ..DecodeLimits::DEFAULT
                }
            ),
            Err(SpeechAudioError::ResourceLimit(_))
        ));
        assert!(matches!(
            load_audio_buffer_bounded(
                &path,
                DecodeLimits {
                    max_input_bytes: 0,
                    ..DecodeLimits::DEFAULT
                }
            ),
            Err(SpeechAudioError::InvalidInput(_))
        ));
    }

    #[test]
    fn decode_limits_cannot_raise_crate_hard_caps() {
        let too_many_samples = DecodeLimits {
            max_decoded_samples: DecodeLimits::HARD_MAX_DECODED_SAMPLES + 1,
            ..DecodeLimits::DEFAULT
        };
        let oversized_caps = [
            DecodeLimits {
                max_input_bytes: DecodeLimits::HARD_MAX_INPUT_BYTES + 1,
                ..DecodeLimits::DEFAULT
            },
            too_many_samples,
            DecodeLimits {
                max_channels: DecodeLimits::HARD_MAX_CHANNELS + 1,
                ..DecodeLimits::DEFAULT
            },
            DecodeLimits {
                max_sample_rate: DecodeLimits::HARD_MAX_SAMPLE_RATE + 1,
                ..DecodeLimits::DEFAULT
            },
        ];
        for limits in oversized_caps {
            assert!(matches!(
                limits.validate(),
                Err(SpeechAudioError::InvalidInput(_))
            ));
        }
    }

    #[test]
    fn declared_frame_count_checks_sample_overflow_and_duration_before_decode() {
        let limits = DecodeLimits::DEFAULT;
        assert!(matches!(
            validate_declared_frame_count(u64::MAX, 16_000, 2, limits),
            Err(SpeechAudioError::ResourceLimit(message))
                if message == "declared audio sample count overflow"
        ));
        assert!(matches!(
            validate_declared_frame_count(
                MAX_DECODE_DURATION_SECONDS + 1,
                1,
                1,
                limits,
            ),
            Err(SpeechAudioError::ResourceLimit(message))
                if message.contains("duration budget")
        ));
        assert!(validate_declared_frame_count(16_000 * 60, 16_000, 2, limits).is_ok());

        // A valid, modest-size low-rate WAVE crosses the duration cap while
        // remaining below the sample cap, so RIFF preflight must reject it.
        let temp = tempdir().unwrap();
        let path = temp.path().join("duration-budget.wav");
        write_wav(
            &path,
            &AudioBuffer::new(
                vec![0.0; (MAX_DECODE_DURATION_SECONDS + 1) as usize],
                AudioConfig {
                    sample_rate: 1,
                    channels: 1,
                    sample_format: SampleFormat::F32,
                },
            ),
        )
        .unwrap();
        assert!(matches!(
            load_audio_buffer(&path),
            Err(SpeechAudioError::ResourceLimit(message))
                if message.contains("duration budget")
        ));
    }

    #[test]
    fn bounded_decoder_rejects_growth_of_the_opened_file() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("growing-source.wav");
        write_wav(
            &path,
            &AudioBuffer::new(
                vec![0.25; 256],
                AudioConfig {
                    sample_rate: 16_000,
                    channels: 1,
                    sample_format: SampleFormat::F32,
                },
            ),
        )
        .unwrap();

        let started_at = Instant::now();
        let limits = DecodeLimits::DEFAULT;
        let mut file = File::open(&path).unwrap();
        let input_bytes = file.metadata().unwrap().len();
        validate_riff_wav(&mut file, input_bytes, limits, started_at, MAX_DECODE_TIME).unwrap();
        file.seek(SeekFrom::Start(0)).unwrap();
        let has_exact_frame_count = has_exact_frame_count_container(&mut file).unwrap();
        let file_size_observer = file.try_clone().unwrap();
        let source_changed = Arc::new(AtomicBool::new(false));
        let bytes_returned = Arc::new(AtomicU64::new(0));
        let source = GrowFileOnFirstRead {
            source: FixedLengthMediaSource::new(file, input_bytes, Arc::clone(&source_changed))
                .unwrap(),
            path: path.clone(),
            grown: false,
            bytes_returned: Arc::clone(&bytes_returned),
        };

        let result = decode_audio_from_source(DecodeSource {
            path: &path,
            extension: "wav",
            input_bytes,
            limits,
            max_decode_time: MAX_DECODE_TIME,
            started_at,
            has_exact_frame_count,
            source: Box::new(source),
            file_size_observer,
            source_changed,
        });

        assert!(matches!(
            result,
            Err(SpeechAudioError::ResourceLimit(message))
                if message.contains("source changed size during decoding")
        ));
        assert!(std::fs::metadata(&path).unwrap().len() > input_bytes);
        assert!(bytes_returned.load(Ordering::Relaxed) <= input_bytes);
    }

    #[test]
    fn decode_budget_enforces_cooperative_wall_time() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("time-budget.wav");
        write_wav(
            &path,
            &AudioBuffer::new(
                vec![0.25; 32],
                AudioConfig {
                    sample_rate: 16_000,
                    channels: 1,
                    sample_format: SampleFormat::F32,
                },
            ),
        )
        .unwrap();

        assert!(matches!(
            decode_audio_bounded_with_time_budget(
                &path,
                DecodeLimits::DEFAULT,
                Duration::from_nanos(1),
            ),
            Err(SpeechAudioError::ResourceLimit(_))
        ));
        assert!(matches!(
            decode_audio_bounded_with_time_budget(&path, DecodeLimits::DEFAULT, Duration::ZERO,),
            Err(SpeechAudioError::InvalidInput(_))
        ));
    }

    #[test]
    fn bounded_decoder_rejects_non_regular_paths_before_opening() {
        let temp = tempdir().unwrap();
        assert!(matches!(
            load_audio_buffer(temp.path()),
            Err(SpeechAudioError::InvalidInput(message))
                if message == "bounded audio decoding requires a regular file"
        ));
    }

    #[test]
    fn estimated_codec_frame_counts_do_not_become_truncation_bounds() {
        let temp = tempdir().unwrap();
        let aac_path = temp.path().join("estimated.aac");
        // ADTS starts with a syncword; its probe derives n_frames from sampled
        // bitrate rather than an exact container frame count.
        std::fs::write(&aac_path, b"\xff\xf1\x50\x80\x00\x1f\xfc\x00").unwrap();
        let mut aac_file = File::open(&aac_path).unwrap();
        assert!(!has_exact_frame_count_container(&mut aac_file).unwrap());
        assert_eq!(trusted_expected_frames(Some(96_000), false), None);

        let wav_path = temp.path().join("exact.wav");
        write_wav(
            &wav_path,
            &AudioBuffer::new(
                vec![0.0; 16],
                AudioConfig {
                    sample_rate: 16_000,
                    channels: 1,
                    sample_format: SampleFormat::F32,
                },
            ),
        )
        .unwrap();
        let mut wav_file = File::open(&wav_path).unwrap();
        assert!(has_exact_frame_count_container(&mut wav_file).unwrap());
        assert_eq!(trusted_expected_frames(Some(16), true), Some(16));
    }

    #[test]
    fn malformed_and_truncated_audio_inputs_fail_without_panicking() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("hostile.wav");

        // Inputs that fail during container identification or metadata parsing.
        for bytes in [
            vec![],
            vec![0xff; 7],
            b"RIFF\x24\x00\x00\x00WAVEfmt ".to_vec(),
            b"RIFF\xff\xff\xff\xffWAVEdata".to_vec(),
        ] {
            std::fs::write(&path, bytes).unwrap();
            let outcome = std::panic::catch_unwind(|| load_audio_buffer(&path));
            assert!(outcome.is_ok(), "decoder panicked on malformed bytes");
            assert!(outcome.unwrap().is_err(), "malformed input was accepted");
        }

        // Truncated valid WAVE files must not escape the decoder as a partial
        // success. Probe several chunk/header/data boundaries deterministically.
        let complete_path = temp.path().join("complete.wav");
        write_wav(
            &complete_path,
            &AudioBuffer::new(
                vec![0.125; 4_096],
                AudioConfig {
                    sample_rate: 16_000,
                    channels: 1,
                    sample_format: SampleFormat::F32,
                },
            ),
        )
        .unwrap();
        let complete = std::fs::read(&complete_path).unwrap();
        for cut in [1, 4, 8, 12, 36, 43, complete.len() / 2, complete.len() - 1] {
            std::fs::write(&path, &complete[..cut]).unwrap();
            let outcome = std::panic::catch_unwind(|| load_audio_buffer(&path));
            assert!(
                outcome.is_ok(),
                "decoder panicked with WAVE truncated at {cut}"
            );
            assert!(
                outcome.unwrap().is_err(),
                "truncated WAVE input was accepted at {cut} bytes"
            );
        }

        // Deterministically mutate chunk headers and payload positions. A
        // mutation may still describe valid audio, but it must never panic or
        // escape the normal decoded-sample/finiteness budget.
        for index in (0..complete.len()).step_by((complete.len() / 32).max(1)) {
            let mut mutated = complete.clone();
            mutated[index] ^= 0xff;
            std::fs::write(&path, &mutated).unwrap();
            let outcome = std::panic::catch_unwind(|| load_audio_buffer(&path));
            assert!(
                outcome.is_ok(),
                "decoder panicked with byte {index} mutated"
            );
            if let Ok(decoded) = outcome.unwrap() {
                assert!(decoded.samples.len() <= DecodeLimits::DEFAULT.max_decoded_samples);
                assert!(decoded.samples.iter().all(|sample| sample.is_finite()));
            }
        }
    }

    #[test]
    fn public_decoder_rejects_hostile_riff_corpus_with_typed_errors() {
        let temp = tempdir().unwrap();
        let source_path = temp.path().join("source.wav");
        let hostile_path = temp.path().join("hostile.wav");
        write_wav(
            &source_path,
            &AudioBuffer::new(
                vec![0.125; 4_096],
                AudioConfig {
                    sample_rate: 16_000,
                    channels: 1,
                    sample_format: SampleFormat::F32,
                },
            ),
        )
        .unwrap();
        let valid = std::fs::read(source_path).unwrap();

        // Each row is a deterministic mutation of a valid RIFF/WAVE source.
        // The public bounded decoder must reject it before returning samples,
        // with a stable typed error appropriate to the violated invariant.
        let mut wrong_riff_length = valid.clone();
        wrong_riff_length[4..8].copy_from_slice(&0u32.to_le_bytes());

        let mut oversized_data_chunk = valid.clone();
        let (_, data_size_offset, _) = wav_chunk(&valid, b"data");
        oversized_data_chunk[data_size_offset..data_size_offset + 4]
            .copy_from_slice(&u32::MAX.to_le_bytes());

        let mut too_many_channels = valid.clone();
        let (_, _, fmt_payload_offset) = wav_chunk(&valid, b"fmt ");
        too_many_channels[fmt_payload_offset + 2..fmt_payload_offset + 4]
            .copy_from_slice(&3u16.to_le_bytes());

        let mut excessive_rate = valid.clone();
        excessive_rate[fmt_payload_offset + 4..fmt_payload_offset + 8]
            .copy_from_slice(&48_001u32.to_le_bytes());

        let cases = [
            (
                "wrong RIFF byte count",
                wrong_riff_length,
                DecodeLimits::DEFAULT,
                "Decode",
                "RIFF size declares 8 bytes but file has 16452",
            ),
            (
                "data chunk extending past RIFF end",
                oversized_data_chunk,
                DecodeLimits::DEFAULT,
                "Decode",
                "RIFF chunk \"data\" extends beyond declared container size",
            ),
            (
                "channel count above caller cap",
                too_many_channels,
                DecodeLimits {
                    max_channels: 2,
                    ..DecodeLimits::DEFAULT
                },
                "ResourceLimit",
                "WAVE channel count 3 or sample rate 16000 exceeds decode limits",
            ),
            (
                "sample rate above caller cap",
                excessive_rate,
                DecodeLimits {
                    max_sample_rate: 48_000,
                    ..DecodeLimits::DEFAULT
                },
                "ResourceLimit",
                "WAVE channel count 1 or sample rate 48001 exceeds decode limits",
            ),
        ];

        for (label, bytes, limits, expected_kind, expected_message) in cases {
            std::fs::write(&hostile_path, bytes).unwrap();
            let outcome =
                std::panic::catch_unwind(|| load_audio_buffer_bounded(&hostile_path, limits));
            assert!(outcome.is_ok(), "public decoder panicked for {label}");
            match outcome.unwrap() {
                Err(SpeechAudioError::Decode(message))
                    if expected_kind == "Decode" && message == expected_message => {}
                Err(SpeechAudioError::ResourceLimit(message))
                    if expected_kind == "ResourceLimit" && message == expected_message => {}
                other => panic!(
                    "{label} must return {expected_kind}({expected_message:?}), got {other:?}"
                ),
            }
        }

        std::fs::write(&hostile_path, &valid).unwrap();
        let limited = std::panic::catch_unwind(|| {
            load_audio_buffer_bounded(
                &hostile_path,
                DecodeLimits {
                    max_decoded_samples: 1,
                    ..DecodeLimits::DEFAULT
                },
            )
        });
        assert!(limited.is_ok(), "public decoder panicked at the sample cap");
        assert!(matches!(
            limited.unwrap(),
            Err(SpeechAudioError::ResourceLimit(message))
                if message == "container declares 4096 samples, exceeding the 1 sample budget"
        ));
    }

    #[test]
    fn seeded_bounded_wave_mutations_are_panic_free_and_respect_decode_caps() {
        const SEED: u64 = 0x6d65_6469_615f_7273;
        const CASES: usize = 128;
        const MAX_INPUT_BYTES: usize = 8 * 1024;
        const MAX_OUTPUT_SAMPLES: usize = 1_024;

        fn next_random(state: &mut u64) -> u64 {
            // xorshift64*: fixed-width, dependency-free and reproducible across runs.
            *state ^= *state >> 12;
            *state ^= *state << 25;
            *state ^= *state >> 27;
            (*state).wrapping_mul(0x2545_f491_4f6c_dd1d)
        }

        let temp = tempdir().unwrap();
        let source_path = temp.path().join("seeded-source.wav");
        let input_path = temp.path().join("seeded-mutated.wav");
        write_wav(
            &source_path,
            &AudioBuffer::new(
                (0..512)
                    .map(|sample| ((sample as f32 * 0.071).sin()) * 0.5)
                    .collect(),
                AudioConfig {
                    sample_rate: 16_000,
                    channels: 1,
                    sample_format: SampleFormat::F32,
                },
            ),
        )
        .unwrap();
        let valid = std::fs::read(source_path).unwrap();
        assert!(valid.len() <= MAX_INPUT_BYTES);

        let limits = DecodeLimits {
            max_input_bytes: MAX_INPUT_BYTES as u64,
            max_decoded_samples: MAX_OUTPUT_SAMPLES,
            max_channels: 2,
            ..DecodeLimits::DEFAULT
        };
        let mut state = SEED;

        for case in 0..CASES {
            let mut mutated = valid.clone();
            let operations = if case == 0 {
                0
            } else {
                1 + (next_random(&mut state) as usize % 8)
            };
            for _ in 0..operations {
                if mutated.is_empty() {
                    mutated.push(next_random(&mut state) as u8);
                    continue;
                }
                match next_random(&mut state) % 4 {
                    0 => {
                        let index = next_random(&mut state) as usize % mutated.len();
                        mutated[index] ^= (next_random(&mut state) as u8) | 1;
                    }
                    1 => {
                        let index = next_random(&mut state) as usize % mutated.len();
                        mutated[index] = next_random(&mut state) as u8;
                    }
                    2 => {
                        let length = next_random(&mut state) as usize % (mutated.len() + 1);
                        mutated.truncate(length);
                    }
                    _ if mutated.len() < MAX_INPUT_BYTES => {
                        let room = MAX_INPUT_BYTES - mutated.len();
                        let count = 1 + (next_random(&mut state) as usize % room.min(16));
                        for _ in 0..count {
                            mutated.push(next_random(&mut state) as u8);
                        }
                    }
                    _ => {
                        let index = next_random(&mut state) as usize % mutated.len();
                        mutated[index] = !mutated[index];
                    }
                }
            }
            assert!(mutated.len() <= MAX_INPUT_BYTES);
            std::fs::write(&input_path, mutated).unwrap();

            // The decoder checks this cooperative budget between codec operations;
            // it is not a hard wall-clock limit for an in-flight codec call.
            let outcome = std::panic::catch_unwind(|| {
                decode_audio_bounded_with_time_budget(
                    &input_path,
                    limits,
                    Duration::from_millis(250),
                )
            });
            assert!(
                outcome.is_ok(),
                "decoder panicked for fixed-seed case {case}"
            );
            match outcome.unwrap() {
                Ok(decoded) => {
                    assert!(
                        decoded.config.channels > 0
                            && decoded.config.channels <= limits.max_channels,
                        "successful case {case} returned an invalid or over-cap channel count"
                    );
                    assert!(
                        decoded.config.sample_rate > 0
                            && decoded.config.sample_rate <= limits.max_sample_rate,
                        "successful case {case} returned an invalid or over-cap sample rate"
                    );
                    assert!(
                        decoded.samples.len() <= limits.max_decoded_samples,
                        "successful case {case} exceeded the decoded sample budget"
                    );
                    assert_eq!(
                        decoded.samples.len() % decoded.config.channels as usize,
                        0,
                        "successful case {case} returned misaligned interleaved samples"
                    );
                    assert!(
                        decoded.samples.iter().all(|sample| sample.is_finite()),
                        "successful case {case} returned non-finite samples"
                    );
                    if case == 0 {
                        assert_eq!(decoded.samples.len(), 512);
                        assert_eq!(
                            decoded.config,
                            AudioConfig {
                                sample_rate: 16_000,
                                channels: 1,
                                sample_format: SampleFormat::F32,
                            }
                        );
                    }
                }
                Err(error) if case == 0 => {
                    panic!("unmutated seed fixture was not decodable: {error}");
                }
                Err(_) => {}
            }
        }
    }

    #[test]
    fn malformed_compressed_codec_packet_is_not_silently_skipped() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("corrupt.mp3");
        // MPEG-1 Layer III, 128 kbps / 44.1 kHz frame header followed by an
        // invalid all-ones side-info/payload. The container probe can identify
        // the codec, but decoding the packet must fail closed.
        let mut frame = vec![0xff; 417];
        frame[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0x64]);
        std::fs::write(&path, frame).unwrap();

        let outcome = std::panic::catch_unwind(|| load_audio_buffer(&path));
        assert!(outcome.is_ok(), "decoder panicked on corrupt MP3 packet");
        assert!(matches!(outcome.unwrap(), Err(SpeechAudioError::Decode(_))));
    }

    #[test]
    fn seeded_bounded_mp3_mutations_are_panic_free_and_respect_decode_caps() {
        const SEED: u64 = 0x6d70_335f_7273_3032;
        const CASES: usize = 48;
        const MAX_INPUT_BYTES: usize = 1024;
        const MAX_OUTPUT_SAMPLES: usize = 32_768;

        fn next_random(state: &mut u64) -> u64 {
            *state ^= *state >> 12;
            *state ^= *state << 25;
            *state ^= *state >> 27;
            (*state).wrapping_mul(0x2545_f491_4f6c_dd1d)
        }

        let temp = tempdir().unwrap();
        let path = temp.path().join("mutated.mp3");
        // Keep the recognizable MPEG-1 Layer III header from the corrupt-packet
        // regression, then exercise deterministic payload, header and truncation
        // changes that the WAVE-only mutation corpus cannot reach.
        let mut seed = vec![0xff; 417];
        seed[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0x64]);
        let limits = DecodeLimits {
            max_input_bytes: MAX_INPUT_BYTES as u64,
            max_decoded_samples: MAX_OUTPUT_SAMPLES,
            max_channels: 2,
            ..DecodeLimits::DEFAULT
        };
        let mut state = SEED;

        for case in 0..CASES {
            let mut mutated = seed.clone();
            match case / 16 {
                0 => {
                    // Mutate payload bytes without changing the recognizable
                    // MP3 header, covering decoder packet handling.
                    let operations = 1 + next_random(&mut state) as usize % 6;
                    for _ in 0..operations {
                        let index = 4 + next_random(&mut state) as usize % (mutated.len() - 4);
                        mutated[index] ^= (next_random(&mut state) as u8) | 1;
                    }
                }
                1 => {
                    // Cover EOF before the sync/header, inside the header, and
                    // throughout the packet payload at deterministic lengths.
                    let length = 1 + (case - 16) * (seed.len() - 1) / 15;
                    mutated.truncate(length);
                }
                _ => {
                    // Mutate each of the four framing/header bytes while the
                    // remaining bytes keep the packet large enough to probe.
                    let index = (case - 32) % 4;
                    mutated[index] ^= (next_random(&mut state) as u8) | 1;
                }
            }
            assert!(mutated.len() <= MAX_INPUT_BYTES);
            std::fs::write(&path, mutated).unwrap();

            let outcome = std::panic::catch_unwind(|| {
                decode_audio_bounded_with_time_budget(&path, limits, Duration::from_millis(250))
            });
            assert!(
                outcome.is_ok(),
                "decoder panicked for fixed-seed MP3 case {case}"
            );
            if let Ok(decoded) = outcome.unwrap() {
                assert!(
                    decoded.config.channels > 0 && decoded.config.channels <= limits.max_channels
                );
                assert!(
                    decoded.config.sample_rate > 0
                        && decoded.config.sample_rate <= limits.max_sample_rate
                );
                assert!(decoded.samples.len() <= limits.max_decoded_samples);
                assert_eq!(decoded.samples.len() % decoded.config.channels as usize, 0);
                assert!(decoded.samples.iter().all(|sample| sample.is_finite()));
            }
        }
    }

    #[test]
    fn large_ancillary_riff_chunks_are_walked_without_unbounded_allocation() {
        const ANCILLARY_CHUNKS: usize = 512;
        const MAX_FIXTURE_BYTES: usize = 8 * 1024;

        let temp = tempdir().unwrap();
        let source_path = temp.path().join("source.wav");
        let hostile_path = temp.path().join("many-chunks.wav");
        write_wav(
            &source_path,
            &AudioBuffer::new(
                vec![0.125, -0.25, 0.375, -0.5],
                AudioConfig {
                    sample_rate: 16_000,
                    channels: 1,
                    sample_format: SampleFormat::F32,
                },
            ),
        )
        .unwrap();
        let valid = std::fs::read(source_path).unwrap();
        let (fmt_offset, _, _) = wav_chunk(&valid, b"fmt ");
        let mut many_chunks = valid[..fmt_offset].to_vec();
        for _ in 0..ANCILLARY_CHUNKS {
            many_chunks.extend_from_slice(b"JUNK");
            many_chunks.extend_from_slice(&0u32.to_le_bytes());
        }
        many_chunks.extend_from_slice(&valid[fmt_offset..]);
        let riff_size = u32::try_from(many_chunks.len() - 8).unwrap();
        many_chunks[4..8].copy_from_slice(&riff_size.to_le_bytes());
        assert!(many_chunks.len() <= MAX_FIXTURE_BYTES);

        std::fs::write(&hostile_path, &many_chunks).unwrap();
        let decoded = load_audio_buffer_bounded(
            &hostile_path,
            DecodeLimits {
                max_input_bytes: MAX_FIXTURE_BYTES as u64,
                max_decoded_samples: 4,
                max_channels: 1,
                max_sample_rate: 16_000,
            },
        )
        .unwrap();
        assert_eq!(decoded.samples.len(), 4);
        assert!(decoded.samples.iter().all(|sample| sample.is_finite()));

        // A tiny physical file that advertises a multi-gigabyte ancillary
        // chunk must be rejected from its extent before any payload read/allocation.
        let mut oversized = valid;
        let (data_header, _, _) = wav_chunk(&oversized, b"data");
        oversized[data_header..data_header + 4].copy_from_slice(b"JUNK");
        oversized[data_header + 4..data_header + 8].copy_from_slice(&u32::MAX.to_le_bytes());
        std::fs::write(&hostile_path, oversized).unwrap();
        let outcome = std::panic::catch_unwind(|| load_audio_buffer(&hostile_path));
        assert!(
            outcome.is_ok(),
            "decoder panicked on a huge declared RIFF chunk"
        );
        assert!(
            matches!(outcome.unwrap(), Err(SpeechAudioError::Decode(message)) if message.contains("extends beyond declared container size"))
        );
    }

    #[test]
    fn truncated_codec_packet_eof_is_a_decode_error() {
        let error = map_packet_decode_error(SymphoniaError::IoError(std::io::Error::new(
            ErrorKind::UnexpectedEof,
            "truncated packet",
        )));
        assert!(
            matches!(error, SpeechAudioError::Decode(message) if message.contains("truncated"))
        );
    }

    #[test]
    fn extract_waveform_uses_requested_bucket_count() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("waveform.wav");
        let buffer = AudioBuffer::new(
            vec![0.0, 0.2, -0.3, 0.4, -0.5, 0.6, -0.7, 0.8],
            AudioConfig {
                sample_rate: 8000,
                channels: 1,
                sample_format: SampleFormat::F32,
            },
        );

        write_wav(&path, &buffer).unwrap();
        let waveform = extract_waveform(&path, 4).unwrap();

        assert_eq!(waveform.len(), 4);
        assert!(waveform.iter().all(|sample| *sample >= 0.0));
        assert!(matches!(
            extract_waveform(&path, 0),
            Err(SpeechAudioError::InvalidInput(_))
        ));
    }

    #[test]
    fn extract_waveform_handles_stereo_peaks_and_silence_with_bounded_buckets() {
        let temp = tempdir().unwrap();
        let stereo_path = temp.path().join("stereo-waveform.wav");
        let config = AudioConfig {
            sample_rate: 8_000,
            channels: 2,
            sample_format: SampleFormat::F32,
        };
        write_wav(
            &stereo_path,
            &AudioBuffer::new(vec![0.1, -0.7, 0.4, -0.2], config),
        )
        .unwrap();
        assert_eq!(extract_waveform(&stereo_path, 2).unwrap(), vec![0.7, 0.4]);

        let silence_path = temp.path().join("silence-waveform.wav");
        write_wav(
            &silence_path,
            &AudioBuffer::new(
                vec![0.0; 8],
                AudioConfig {
                    channels: 1,
                    ..config
                },
            ),
        )
        .unwrap();
        assert_eq!(extract_waveform(&silence_path, 4).unwrap(), vec![0.0; 4]);
        assert!(matches!(
            extract_waveform(&silence_path, 1_000_001),
            Err(SpeechAudioError::ResourceLimit(_))
        ));
    }

    #[test]
    fn extract_waveform_returns_zero_for_empty_buckets_when_buckets_exceed_frames() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("sparse-waveform.wav");
        write_wav(
            &path,
            &AudioBuffer::new(
                vec![0.5, -0.25],
                AudioConfig {
                    sample_rate: 8_000,
                    channels: 1,
                    sample_format: SampleFormat::F32,
                },
            ),
        )
        .unwrap();

        // Four proportional buckets over two frames produce empty buckets at
        // positions 0 and 2; the occupied buckets retain each frame's peak.
        assert_eq!(
            extract_waveform(&path, 4).unwrap(),
            vec![0.0, 0.5, 0.0, 0.25]
        );
    }

    #[test]
    fn write_and_read_stereo_wav_preserves_channels() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("stereo.wav");
        let buffer = AudioBuffer::new(
            vec![0.5, -0.5, 0.25, -0.25, 1.0, -1.0, 0.125, -0.125],
            AudioConfig {
                sample_rate: 16_000,
                channels: 2,
                sample_format: SampleFormat::F32,
            },
        );

        write_wav(&path, &buffer).unwrap();
        let metadata = load_audio_metadata(&path).unwrap();
        let decoded = load_audio_buffer(&path).unwrap();

        assert_eq!(metadata.duration, 4.0 / 16_000.0);
        assert_eq!(metadata.sample_rate, 16_000);
        assert_eq!(metadata.channels, 2);
        assert_eq!(metadata.format, "wav");
        assert_eq!(decoded.config.channels, 2);
        assert_eq!(decoded.config.sample_rate, 16_000);
        assert_eq!(decoded.frame_count(), 4);
        assert_eq!(decoded.samples.len(), buffer.samples.len());
        for (actual, expected) in decoded.samples.iter().zip(buffer.samples.iter()) {
            assert!(
                (actual - expected).abs() <= 1e-6,
                "stereo round trip changed sample: {actual} != {expected}"
            );
        }
    }

    #[test]
    fn mix_audio_rejects_non_finite() {
        let config = AudioConfig {
            sample_rate: 16000,
            channels: 1,
            sample_format: SampleFormat::F32,
        };
        let good = AudioBuffer::new(vec![0.5, 0.5], config);
        let nan_buffer = AudioBuffer::new(vec![0.5, f32::NAN], config);

        assert!(matches!(
            mix_audio(std::slice::from_ref(&good), &[f32::NAN]),
            Err(SpeechAudioError::InvalidInput(_))
        ));
        assert!(matches!(
            mix_audio(std::slice::from_ref(&good), &[f32::INFINITY]),
            Err(SpeechAudioError::InvalidInput(_))
        ));
        assert!(matches!(
            mix_audio(&[nan_buffer], &[1.0]),
            Err(SpeechAudioError::InvalidInput(_))
        ));
        let infinite_buffer = AudioBuffer::new(vec![f32::INFINITY], config);
        assert!(matches!(
            mix_audio(&[infinite_buffer], &[1.0]),
            Err(SpeechAudioError::InvalidInput(_))
        ));
    }
}
