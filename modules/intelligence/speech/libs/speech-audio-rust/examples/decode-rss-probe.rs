//! Small deterministic decode workload for host RSS characterization.
//!
//! This is a diagnostic fixture only; its memory result does not establish a
//! worker limit or production workload bound.

use std::process;

use hound::{SampleFormat, WavSpec, WavWriter};
use speech_audio_rust::{
    load_audio_buffer_bounded, DecodeLimits, SampleFormat as AudioSampleFormat,
};
use tempfile::Builder;

const SAMPLE_RATE: u32 = 16_000;
const CHANNELS: u16 = 1;
const DURATION_SECONDS: u32 = 10;
const MAX_INPUT_BYTES: u64 = 1_000_000;
const MAX_DECODED_SAMPLES: usize = SAMPLE_RATE as usize * DURATION_SECONDS as usize;
const EXPECTED_WAV_BYTES: u64 = 44 + (MAX_DECODED_SAMPLES as u64 * 2);

fn run() -> Result<(), Box<dyn std::error::Error>> {
    // NamedTempFile creates the path with exclusive creation and removes it
    // from its Drop implementation on success or any early error return.
    let fixture = Builder::new()
        .prefix("speech-audio-rss-probe-")
        .suffix(".wav")
        .tempfile()?;
    let path = fixture.path();

    let spec = WavSpec {
        channels: CHANNELS,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    {
        let file = fixture.as_file().try_clone()?;
        let mut writer = WavWriter::new(file, spec)?;
        // A repeatable low-amplitude triangle sequence avoids random input and
        // keeps the fixture independent of external assets.
        for index in 0..MAX_DECODED_SAMPLES {
            let phase = (index % 200) as i32;
            let triangle = if phase < 100 { phase } else { 200 - phase };
            let sample = ((triangle - 50) * 200) as i16;
            writer.write_sample(sample)?;
        }
        writer.finalize()?;
    }

    let metadata = fixture.as_file().metadata()?;
    if metadata.len() != EXPECTED_WAV_BYTES {
        return Err(format!(
            "unexpected encoded WAV size: expected {EXPECTED_WAV_BYTES} bytes, got {}",
            metadata.len()
        )
        .into());
    }
    let decoded = load_audio_buffer_bounded(
        path,
        DecodeLimits {
            max_input_bytes: MAX_INPUT_BYTES,
            max_decoded_samples: MAX_DECODED_SAMPLES,
            max_channels: CHANNELS,
            max_sample_rate: SAMPLE_RATE,
        },
    )?;
    if decoded.samples.len() != MAX_DECODED_SAMPLES
        || decoded.config.sample_rate != SAMPLE_RATE
        || decoded.config.channels != CHANNELS
        || decoded.config.sample_format != AudioSampleFormat::F32
    {
        return Err(format!(
            "unexpected decoded output: samples={} sample_rate_hz={} channels={} format={:?}",
            decoded.samples.len(),
            decoded.config.sample_rate,
            decoded.config.channels,
            decoded.config.sample_format
        )
        .into());
    }
    if decoded.samples.iter().any(|sample| !sample.is_finite()) {
        return Err("decoded output contains a non-finite sample".into());
    }
    let peak_rss = peak_rss_bytes()?;
    println!(
        "decoded input_bytes={} sample_rate_hz={} channels={} duration_seconds={} samples={}",
        metadata.len(),
        SAMPLE_RATE,
        CHANNELS,
        DURATION_SECONDS,
        decoded.samples.len()
    );
    match peak_rss {
        Some(bytes) => println!("peak_rss_bytes={bytes} measurement=process_getrusage"),
        None => println!("peak_rss_bytes=UNAVAILABLE measurement=unsupported_platform"),
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn peak_rss_bytes() -> Result<Option<u64>, std::io::Error> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: RUSAGE_SELF is a valid selector and the pointer targets writable storage.
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    if result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: getrusage returned success, so the rusage structure was initialized.
    let max_rss = unsafe { usage.assume_init() }.ru_maxrss;
    let raw = u64::try_from(max_rss).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "getrusage returned negative ru_maxrss",
        )
    })?;
    #[cfg(target_os = "macos")]
    let bytes = raw;
    #[cfg(target_os = "linux")]
    let bytes = raw.saturating_mul(1024);
    Ok(Some(bytes))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn peak_rss_bytes() -> Result<Option<u64>, std::io::Error> {
    Ok(None)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("RSS probe failed: {error}");
        process::exit(1);
    }
}
