use std::fs::File;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use hound::{SampleFormat as WavSampleFormat, WavSpec, WavWriter};
use symphonia::core::audio::{AudioBufferRef, SampleBuffer, Signal};
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
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

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, SpeechAudioError>;

pub struct Resampler {
    target_sample_rate: u32,
}

impl Resampler {
    pub fn new(target_sample_rate: u32) -> Self {
        Self { target_sample_rate }
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
        if buffer.samples.is_empty() || buffer.config.sample_rate == self.target_sample_rate {
            return Ok(AudioBuffer::new(
                buffer.samples.clone(),
                AudioConfig {
                    sample_rate: self.target_sample_rate,
                    channels: buffer.config.channels,
                    sample_format: SampleFormat::F32,
                },
            ));
        }

        let channels = buffer.config.channels.max(1) as usize;
        let input_frames = buffer.frame_count();
        let ratio = self.target_sample_rate as f64 / buffer.config.sample_rate as f64;
        let output_frames = ((input_frames as f64) * ratio).max(1.0).round() as usize;
        let mut output = Vec::with_capacity(output_frames * channels);

        for output_frame in 0..output_frames {
            let source_position = output_frame as f64 / ratio;
            let index0 = source_position.floor() as usize;
            let index1 = (index0 + 1).min(input_frames.saturating_sub(1));
            let fraction = (source_position - index0 as f64) as f32;

            for channel in 0..channels {
                let sample0 = buffer.samples[index0 * channels + channel];
                let sample1 = buffer.samples[index1 * channels + channel];
                output.push(sample0 + (sample1 - sample0) * fraction);
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
    let decoded = decode_audio(path.as_ref())?;
    Ok(AudioBuffer::new(decoded.samples, decoded.config))
}

pub fn extract_waveform<P: AsRef<Path>>(path: P, buckets: usize) -> Result<Vec<f32>> {
    if buckets == 0 {
        return Err(SpeechAudioError::InvalidInput(
            "waveform bucket count must be positive".to_string(),
        ));
    }

    let buffer = load_audio_buffer(path)?;
    let channels = buffer.config.channels.max(1) as usize;
    let frames = buffer.frame_count();
    if frames == 0 {
        return Ok(vec![0.0; buckets]);
    }

    let step = ((frames as f64) / buckets as f64).ceil().max(1.0) as usize;
    let mut waveform = Vec::with_capacity(buckets);

    for bucket in 0..buckets {
        let start_frame = bucket * step;
        if start_frame >= frames {
            waveform.push(0.0);
            continue;
        }
        let end_frame = (start_frame + step).min(frames);
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

pub fn slice_audio_buffer(buffer: &AudioBuffer, start_time: f64, end_time: f64) -> Result<AudioBuffer> {
    if start_time < 0.0 || end_time < 0.0 || end_time < start_time {
        return Err(SpeechAudioError::InvalidInput(
            "slice times must be non-negative and end must be >= start".to_string(),
        ));
    }

    let channels = buffer.config.channels.max(1) as usize;
    let start_frame = (start_time * buffer.config.sample_rate as f64).floor() as usize;
    let end_frame = (end_time * buffer.config.sample_rate as f64).ceil() as usize;
    let clamped_start = start_frame.min(buffer.frame_count());
    let clamped_end = end_frame.min(buffer.frame_count());
    let start_index = clamped_start * channels;
    let end_index = clamped_end * channels;

    Ok(AudioBuffer::new(
        buffer.samples[start_index..end_index].to_vec(),
        buffer.config,
    ))
}

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

    let reference = buffers[0].config;
    for buffer in buffers.iter().skip(1) {
        if buffer.config != reference {
            return Err(SpeechAudioError::InvalidInput(
                "all buffers must share sample rate and channel count".to_string(),
            ));
        }
    }

    let max_samples = buffers.iter().map(|buffer| buffer.samples.len()).max().unwrap_or(0);
    let mut mixed = vec![0.0f32; max_samples];

    for (buffer, volume) in buffers.iter().zip(volumes.iter().copied()) {
        for (index, sample) in buffer.samples.iter().copied().enumerate() {
            mixed[index] += sample * volume;
        }
    }

    let peak = mixed.iter().copied().fold(0.0f32, |max_peak, sample| max_peak.max(sample.abs()));
    if peak > 1.0 {
        for sample in &mut mixed {
            *sample /= peak;
        }
    }

    Ok(AudioBuffer::new(mixed, reference))
}

pub fn write_wav<P: AsRef<Path>>(path: P, buffer: &AudioBuffer) -> Result<()> {
    let spec = WavSpec {
        channels: buffer.config.channels,
        sample_rate: buffer.config.sample_rate,
        bits_per_sample: 32,
        sample_format: WavSampleFormat::Float,
    };
    let mut writer = WavWriter::create(path, spec)
        .map_err(|error| SpeechAudioError::Encode(format!("failed to create WAV writer: {error}")))?;
    for sample in &buffer.samples {
        writer
            .write_sample(*sample)
            .map_err(|error| SpeechAudioError::Encode(format!("failed to write sample: {error}")))?;
    }
    writer
        .finalize()
        .map_err(|error| SpeechAudioError::Encode(format!("failed to finalize WAV: {error}")))?;
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
        AudioBuffer::new(self.samples.clone(), self.config).duration_seconds()
    }
}

fn decode_audio(path: &Path) -> Result<DecodedAudio> {
    if !path.exists() {
        return Err(SpeechAudioError::FileNotFound(path.display().to_string()));
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let file = File::open(path)?;
    let source = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if !extension.is_empty() {
        hint.with_extension(&extension);
    }

    let probe = get_probe()
        .format(&hint, source, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(map_probe_error)?;
    let mut format = probe.format;
    let track = format
        .default_track()
        .ok_or_else(|| SpeechAudioError::UnsupportedFormat(path.display().to_string()))?;
    let track_id = track.id;
    let codec_params = track.codec_params.clone();

    let sample_rate = codec_params
        .sample_rate
        .ok_or_else(|| SpeechAudioError::Decode("missing sample rate".to_string()))?;
    let channels = codec_params
        .channels
        .map(|channels| channels.count() as u16)
        .ok_or_else(|| SpeechAudioError::Decode("missing channel layout".to_string()))?;

    let mut decoder = get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(map_decode_error)?;

    let mut samples = Vec::new();
    let mut sample_buffer: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => break,
            Err(SymphoniaError::ResetRequired) => {
                return Err(SpeechAudioError::Decode(
                    "decoder reset required for chained stream".to_string(),
                ))
            }
            Err(error) => return Err(map_decode_error(error)),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => break,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(error) => return Err(map_decode_error(error)),
        };

        match decoded {
            AudioBufferRef::F32(buffer) => {
                samples.extend_from_slice(buffer.chan(0));
                if channels > 1 {
                    samples.clear();
                    let mut interleaved = SampleBuffer::<f32>::new(buffer.capacity() as u64, *buffer.spec());
                    interleaved.copy_interleaved_ref(AudioBufferRef::F32(buffer));
                    samples.extend_from_slice(interleaved.samples());
                }
            }
            other => {
                let spec = *other.spec();
                let duration = other.capacity() as u64;
                let buffer = sample_buffer.get_or_insert_with(|| SampleBuffer::<f32>::new(duration, spec));
                buffer.copy_interleaved_ref(other);
                samples.extend_from_slice(buffer.samples());
            }
        }
    }

    Ok(DecodedAudio {
        path: path.to_path_buf(),
        samples,
        config: AudioConfig {
            sample_rate,
            channels,
            sample_format: SampleFormat::F32,
        },
        format: extension,
    })
}

fn map_probe_error(error: SymphoniaError) -> SpeechAudioError {
    match error {
        SymphoniaError::Unsupported(message) => SpeechAudioError::UnsupportedFormat(message.to_string()),
        other => map_decode_error(other),
    }
}

fn map_decode_error(error: SymphoniaError) -> SpeechAudioError {
    match error {
        SymphoniaError::IoError(error) => SpeechAudioError::Io(error),
        SymphoniaError::Unsupported(message) => SpeechAudioError::UnsupportedFormat(message.to_string()),
        other => SpeechAudioError::Decode(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

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
        assert_eq!(output.samples.first().copied().unwrap(), 0.0);
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
    fn mix_audio_normalizes_peak() {
        let config = AudioConfig {
            sample_rate: 16000,
            channels: 1,
            sample_format: SampleFormat::F32,
        };
        let first = AudioBuffer::new(vec![0.8, 0.8], config);
        let second = AudioBuffer::new(vec![0.8, -0.8], config);

        let mixed = mix_audio(&[first, second], &[1.0, 1.0]).unwrap();

        assert!(mixed.samples.iter().all(|sample| sample.abs() <= 1.0));
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
    }
}