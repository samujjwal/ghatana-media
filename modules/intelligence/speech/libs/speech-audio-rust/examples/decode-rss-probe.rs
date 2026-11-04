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
const GLOBAL_MAX_INPUT_BYTES: u64 = 512 * 1024 * 1024;
const GLOBAL_MAX_DECODED_SAMPLES: usize = 96_000_000;
const GLOBAL_MAX_DURATION_SECONDS: u32 = 6 * 60 * 60;
const HIGH_WATER_MAX_INPUT_BYTES: u64 = 32 * 1024 * 1024 + 44;

#[derive(Clone, Copy)]
struct Profile {
    name: &'static str,
    duration_seconds: u32,
    max_input_bytes: u64,
    max_decoded_samples: usize,
}

impl Profile {
    const BASELINE: Self = Self {
        name: "baseline",
        duration_seconds: 10,
        max_input_bytes: 1_000_000,
        max_decoded_samples: SAMPLE_RATE as usize * 10,
    };
    const HIGH_WATER: Self = Self {
        name: "high-water",
        duration_seconds: 1_000,
        max_input_bytes: HIGH_WATER_MAX_INPUT_BYTES,
        max_decoded_samples: 16_000_000,
    };
    const HARD_CAP: Self = Self {
        name: "hard-cap",
        duration_seconds: 6_000,
        max_input_bytes: GLOBAL_MAX_INPUT_BYTES,
        max_decoded_samples: GLOBAL_MAX_DECODED_SAMPLES,
    };

    fn parse(args: impl Iterator<Item = String>) -> Result<Self, String> {
        let args = args.collect::<Vec<_>>();
        match args.as_slice() {
            [] => Ok(Self::BASELINE),
            [flag, name] if flag == "--profile" && name == "baseline" => Ok(Self::BASELINE),
            [flag, name] if flag == "--profile" && name == "high-water" => Ok(Self::HIGH_WATER),
            [flag, name] if flag == "--profile" && name == "hard-cap" => Ok(Self::HARD_CAP),
            _ => {
                Err("usage: decode-rss-probe [--profile baseline|high-water|hard-cap]".to_string())
            }
        }
    }

    fn samples(self) -> usize {
        SAMPLE_RATE as usize * self.duration_seconds as usize
    }

    fn expected_wav_bytes(self) -> u64 {
        44 + (self.samples() as u64 * 2)
    }

    fn validate(self) -> Result<(), String> {
        let samples = self.samples();
        let input_bytes = self.expected_wav_bytes();
        if self.duration_seconds > GLOBAL_MAX_DURATION_SECONDS
            || samples > GLOBAL_MAX_DECODED_SAMPLES
            || input_bytes > GLOBAL_MAX_INPUT_BYTES
            || self.max_decoded_samples > GLOBAL_MAX_DECODED_SAMPLES
            || self.max_input_bytes > GLOBAL_MAX_INPUT_BYTES
        {
            return Err(format!(
                "profile {} exceeds global high-water ceilings",
                self.name
            ));
        }
        if samples > self.max_decoded_samples || input_bytes > self.max_input_bytes {
            return Err(format!(
                "profile {} fixture exceeds its selected input or decoded-sample cap",
                self.name
            ));
        }
        Ok(())
    }
}

fn run(profile: Profile) -> Result<(), Box<dyn std::error::Error>> {
    profile.validate().map_err(std::io::Error::other)?;
    let sample_count = profile.samples();
    let expected_wav_bytes = profile.expected_wav_bytes();
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
        for index in 0..sample_count {
            let phase = (index % 200) as i32;
            let triangle = if phase < 100 { phase } else { 200 - phase };
            let sample = ((triangle - 50) * 200) as i16;
            writer.write_sample(sample)?;
        }
        writer.finalize()?;
    }

    let metadata = fixture.as_file().metadata()?;
    if metadata.len() != expected_wav_bytes {
        return Err(format!(
            "unexpected encoded WAV size: expected {expected_wav_bytes} bytes, got {}",
            metadata.len()
        )
        .into());
    }
    let decoded = load_audio_buffer_bounded(
        path,
        DecodeLimits {
            max_input_bytes: profile.max_input_bytes,
            max_decoded_samples: profile.max_decoded_samples,
            max_channels: CHANNELS,
            max_sample_rate: SAMPLE_RATE,
        },
    )?;
    if decoded.samples.len() != sample_count
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
        "profile={} decoded input_bytes={} sample_rate_hz={} channels={} duration_seconds={} samples={} max_input_bytes={} max_decoded_samples={}",
        profile.name,
        metadata.len(),
        SAMPLE_RATE,
        CHANNELS,
        profile.duration_seconds,
        decoded.samples.len(),
        profile.max_input_bytes,
        profile.max_decoded_samples
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
    let profile = match Profile::parse(std::env::args().skip(1)) {
        Ok(profile) => profile,
        Err(error) => {
            eprintln!("{error}");
            process::exit(2);
        }
    };
    if let Err(error) = run(profile) {
        eprintln!("RSS probe failed: {error}");
        process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{Profile, GLOBAL_MAX_DECODED_SAMPLES, GLOBAL_MAX_DURATION_SECONDS};

    #[test]
    fn profile_selection_is_closed_and_baseline_remains_the_default() {
        let baseline = Profile::parse(std::iter::empty()).unwrap();
        assert_eq!(baseline.name, "baseline");
        assert_eq!(baseline.samples(), 160_000);
        baseline.validate().unwrap();

        let high_water =
            Profile::parse(["--profile".to_string(), "high-water".to_string()].into_iter())
                .unwrap();
        assert_eq!(high_water.samples(), 16_000_000);
        high_water.validate().unwrap();
        let hard_cap =
            Profile::parse(["--profile".to_string(), "hard-cap".to_string()].into_iter()).unwrap();
        assert_eq!(hard_cap.duration_seconds, 6_000);
        assert_eq!(hard_cap.samples(), 96_000_000);
        assert_eq!(hard_cap.expected_wav_bytes(), 192_000_044);
        hard_cap.validate().unwrap();
        assert!(
            Profile::parse(["--profile".to_string(), "arbitrary".to_string()].into_iter()).is_err()
        );
    }

    #[test]
    fn profile_validation_rejects_fixture_larger_than_selected_bound() {
        let mut profile = Profile::BASELINE;
        profile.max_input_bytes = profile.expected_wav_bytes() - 1;
        assert!(profile
            .validate()
            .unwrap_err()
            .contains("selected input or decoded-sample cap"));
    }

    #[test]
    fn profile_validation_rejects_caps_above_global_ceilings() {
        let mut profile = Profile::BASELINE;
        profile.max_decoded_samples = GLOBAL_MAX_DECODED_SAMPLES + 1;
        assert!(profile
            .validate()
            .unwrap_err()
            .contains("global high-water ceilings"));
    }

    #[test]
    fn profile_validation_rejects_duration_above_global_ceiling() {
        let mut profile = Profile::BASELINE;
        profile.duration_seconds = GLOBAL_MAX_DURATION_SECONDS + 1;
        assert!(profile
            .validate()
            .unwrap_err()
            .contains("global high-water ceilings"));
    }
}
