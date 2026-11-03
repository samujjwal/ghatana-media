//! Reproducible local throughput characterization for RS-07.
//!
//! The workload is generated in memory and written to a temporary PCM WAV. It
//! is not user audio, a cross-host qualification, or an enforced performance
//! limit. Process RSS includes startup, fixture creation, and both workloads.

use std::time::{Duration, Instant};

use hound::{SampleFormat as HoundSampleFormat, WavSpec, WavWriter};
use speech_audio_rust::{
    load_audio_buffer_bounded, AudioBuffer, AudioConfig, DecodeLimits, Resampler, SampleFormat,
};
use tempfile::Builder;

const SEED: u64 = 0x5253_3037_2026_1103;
const SOURCE_RATE: u32 = 48_000;
const TARGET_RATE: u32 = 16_000;
const DURATION_SECONDS: usize = 5;
const SAMPLES: usize = SOURCE_RATE as usize * DURATION_SECONDS;
const WARMUPS: usize = 2;
const RUNS: usize = 15;
const MAX_INPUT_BYTES: u64 = 1_000_000;
const MAX_DECODED_SAMPLES: usize = 160_000;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let samples = seeded_samples(SEED, SAMPLES);
    let source = AudioBuffer::new(
        samples,
        AudioConfig {
            sample_rate: SOURCE_RATE,
            channels: 1,
            sample_format: SampleFormat::F32,
        },
    );
    let resampler = Resampler::new(TARGET_RATE);
    let wav_fixture = make_decode_fixture()?;

    println!("workload=rs07_seeded_audio_v1 seed={SEED:#018x}");
    println!(
        "host=os:{} arch:{} parallelism={}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::thread::available_parallelism()
            .map(|count| count.get().to_string())
            .unwrap_or_else(|_| "unknown".to_string())
    );
    println!(
        "resample=mono_f32 source_rate_hz={SOURCE_RATE} target_rate_hz={TARGET_RATE} input_samples={SAMPLES} duration_seconds={DURATION_SECONDS} warmups={WARMUPS} runs={RUNS}"
    );
    println!(
        "decode=generated_pcm_s16_wav sample_rate_hz=16000 channels=1 duration_seconds=10 max_input_bytes={MAX_INPUT_BYTES} max_decoded_samples={MAX_DECODED_SAMPLES} warmups={WARMUPS} runs={RUNS}"
    );
    println!("measurement_scope=per-operation wall time; process CPU and peak RSS include setup and both workloads");

    let mut resample_times = Vec::with_capacity(RUNS);
    let mut resample_checksum = None;
    let mut resample_output_samples = 0;
    for iteration in 0..(WARMUPS + RUNS) {
        let start = Instant::now();
        let result = resampler.resample(&source)?;
        let elapsed = start.elapsed();
        resample_output_samples = result.samples.len();
        let observed_checksum = checksum(&result.samples);
        if resample_checksum.is_some_and(|expected| expected != observed_checksum) {
            return Err("resampler output changed across identical seeded runs".into());
        }
        resample_checksum = Some(observed_checksum);
        if iteration >= WARMUPS {
            resample_times.push(elapsed);
        }
    }
    print_stats(
        "resample",
        &resample_times,
        DURATION_SECONDS as f64,
        resample_output_samples as f64,
    );
    println!(
        "resample_output_samples={resample_output_samples} deterministic_checksum={:016x}",
        resample_checksum.unwrap_or_default()
    );

    let mut decode_times = Vec::with_capacity(RUNS);
    let mut decode_checksum = None;
    let mut decode_samples = 0;
    for iteration in 0..(WARMUPS + RUNS) {
        let start = Instant::now();
        let decoded = load_audio_buffer_bounded(
            wav_fixture.path(),
            DecodeLimits {
                max_input_bytes: MAX_INPUT_BYTES,
                max_decoded_samples: MAX_DECODED_SAMPLES,
                max_channels: 1,
                max_sample_rate: 16_000,
            },
        )?;
        let elapsed = start.elapsed();
        decode_samples = decoded.samples.len();
        let observed_checksum = checksum(&decoded.samples);
        if decode_checksum.is_some_and(|expected| expected != observed_checksum) {
            return Err("decoder output changed across identical generated-fixture runs".into());
        }
        decode_checksum = Some(observed_checksum);
        if iteration >= WARMUPS {
            decode_times.push(elapsed);
        }
    }
    print_stats("decode", &decode_times, 10.0, decode_samples as f64);
    println!(
        "decode_output_samples={decode_samples} deterministic_checksum={:016x}",
        decode_checksum.unwrap_or_default()
    );
    println!(
        "process_cpu_seconds={}",
        process_cpu_seconds()?.map_or_else(|| "UNAVAILABLE".to_string(), |v| format!("{v:.6}"))
    );
    println!(
        "process_peak_rss_bytes={}",
        process_peak_rss_bytes()?.map_or_else(|| "UNAVAILABLE".to_string(), |v| v.to_string())
    );
    println!("scope=diagnostic measurements only; no threshold asserted; results are host and build specific");
    Ok(())
}

fn seeded_samples(seed: u64, count: usize) -> Vec<f32> {
    let mut state = seed;
    (0..count)
        .map(|_| {
            // xorshift64* gives stable pseudo-random fixture samples without a dependency.
            state ^= state >> 12;
            state ^= state << 25;
            state ^= state >> 27;
            let value = state.wrapping_mul(0x2545_F491_4F6C_DD1D);
            let normalized = (value >> 40) as u32;
            (normalized as f32 / 8_388_607.5) - 1.0
        })
        .collect()
}

fn checksum(samples: &[f32]) -> u64 {
    samples.iter().fold(0xcbf2_9ce4_8422_2325, |hash, sample| {
        (hash ^ u64::from(sample.to_bits())).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

fn make_decode_fixture() -> Result<tempfile::NamedTempFile, Box<dyn std::error::Error>> {
    const RATE: u32 = 16_000;
    const COUNT: usize = RATE as usize * 10;
    let fixture = Builder::new()
        .prefix("speech-audio-rs07-")
        .suffix(".wav")
        .tempfile()?;
    let spec = WavSpec {
        channels: 1,
        sample_rate: RATE,
        bits_per_sample: 16,
        sample_format: HoundSampleFormat::Int,
    };
    {
        let file = fixture.as_file().try_clone()?;
        let mut writer = WavWriter::new(file, spec)?;
        let mut state = SEED ^ 0x4445_434f_4445;
        for _ in 0..COUNT {
            state ^= state >> 12;
            state ^= state << 25;
            state ^= state >> 27;
            let value = state.wrapping_mul(0x2545_F491_4F6C_DD1D);
            let sample = ((value >> 48) as u16 as i16) / 2;
            writer.write_sample(sample)?;
        }
        writer.finalize()?;
    }
    let metadata = fixture.as_file().metadata()?;
    let expected_bytes = 44 + (COUNT as u64 * 2);
    if metadata.len() != expected_bytes || metadata.len() > MAX_INPUT_BYTES {
        return Err(format!(
            "unexpected generated WAV size: expected {expected_bytes}, got {}",
            metadata.len()
        )
        .into());
    }
    Ok(fixture)
}

fn print_stats(name: &str, durations: &[Duration], audio_seconds: f64, output_samples: f64) {
    let mut seconds: Vec<f64> = durations.iter().map(Duration::as_secs_f64).collect();
    seconds.sort_by(f64::total_cmp);
    let p50 = percentile_nearest_rank(&seconds, 0.50);
    let p95 = percentile_nearest_rank(&seconds, 0.95);
    let median = p50.unwrap_or(0.0);
    let min = seconds.first().copied().unwrap_or(0.0);
    let max = seconds.last().copied().unwrap_or(0.0);
    let throughput = if median > 0.0 {
        output_samples / median
    } else {
        0.0
    };
    let rtf = if audio_seconds > 0.0 {
        median / audio_seconds
    } else {
        0.0
    };
    println!(
        "{name}_timing runs={} min_seconds={min:.6} p50_seconds={median:.6} p95_seconds={:.6} max_seconds={max:.6} output_samples_per_second={throughput:.2} real_time_factor={rtf:.6}",
        durations.len(),
        p95.unwrap_or(0.0)
    );
}

fn percentile_nearest_rank(sorted: &[f64], percentile: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = (percentile * sorted.len() as f64).ceil().max(1.0) as usize;
    sorted.get(rank - 1).copied()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn process_cpu_seconds() -> Result<Option<f64>, std::io::Error> {
    let usage = get_usage()?;
    let user = timeval_seconds(usage.ru_utime);
    let system = timeval_seconds(usage.ru_stime);
    Ok(Some(user + system))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_cpu_seconds() -> Result<Option<f64>, std::io::Error> {
    Ok(None)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn process_peak_rss_bytes() -> Result<Option<u64>, std::io::Error> {
    let raw = u64::try_from(get_usage()?.ru_maxrss)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "negative ru_maxrss"))?;
    #[cfg(target_os = "macos")]
    let bytes = raw;
    #[cfg(target_os = "linux")]
    let bytes = raw.saturating_mul(1024);
    Ok(Some(bytes))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_peak_rss_bytes() -> Result<Option<u64>, std::io::Error> {
    Ok(None)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn get_usage() -> Result<libc::rusage, std::io::Error> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: RUSAGE_SELF is valid and the pointer targets writable storage.
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    if result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: successful getrusage initializes the structure.
    Ok(unsafe { usage.assume_init() })
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn timeval_seconds(value: libc::timeval) -> f64 {
    value.tv_sec as f64 + value.tv_usec as f64 / 1_000_000.0
}
