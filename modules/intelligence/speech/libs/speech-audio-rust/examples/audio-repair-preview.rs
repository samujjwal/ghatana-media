//! Bounded caller-input A/B preview using the crate's existing repair APIs.
//!
//! Usage: cargo run --offline --example audio-repair-preview -- INPUT OUTPUT_DIR NOISE_START_FRAME NOISE_END_FRAME

use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use speech_audio_rust::{
    compare_audio, declip_bounded, denoise, load_audio_buffer_bounded, write_wav, AudioBuffer,
    DecodeLimits, DenoiseOptions, NoiseProfile, RepairLimits, Result, SpeechAudioError,
};

const SOURCE_NAME: &str = "source-original";
const DENOISED_NAME: &str = "candidate-denoised.wav";
const DECLIPPED_NAME: &str = "candidate-declipped.wav";
const MANIFEST_NAME: &str = "audio-repair-preview.json";
const DECLIP_THRESHOLD: f32 = 0.98;

#[derive(Debug)]
struct OutputPaths {
    source: PathBuf,
    denoised: PathBuf,
    declipped: PathBuf,
    manifest: PathBuf,
}

fn main() {
    if let Err(error) = run_from_args(env::args_os().skip(1).collect()) {
        eprintln!("audio repair preview failed: {error}");
        std::process::exit(2);
    }
}

fn run_from_args(args: Vec<std::ffi::OsString>) -> Result<()> {
    if args.len() != 4 {
        return Err(SpeechAudioError::InvalidInput(
            "usage: audio-repair-preview INPUT OUTPUT_DIR NOISE_START_FRAME NOISE_END_FRAME".into(),
        ));
    }
    let input = PathBuf::from(&args[0]);
    let output_dir = PathBuf::from(&args[1]);
    let noise_start = parse_frame(&args[2], "noise start frame")?;
    let noise_end = parse_frame(&args[3], "noise end frame")?;
    run_preview(&input, &output_dir, noise_start, noise_end)
}

fn parse_frame(value: &std::ffi::OsStr, label: &str) -> Result<usize> {
    value
        .to_str()
        .and_then(|text| text.parse().ok())
        .ok_or_else(|| {
            SpeechAudioError::InvalidInput(format!("{label} must be a non-negative integer"))
        })
}

fn run_preview(
    input: &Path,
    output_dir: &Path,
    noise_start: usize,
    noise_end: usize,
) -> Result<()> {
    fs::create_dir_all(output_dir)?;
    let input = input.canonicalize()?;
    let output_dir = output_dir.canonicalize()?;
    let source_name = input
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.is_empty())
        .map(|extension| format!("{SOURCE_NAME}.{extension}"))
        .unwrap_or_else(|| SOURCE_NAME.to_owned());
    let paths = OutputPaths {
        source: output_dir.join(source_name),
        denoised: output_dir.join(DENOISED_NAME),
        declipped: output_dir.join(DECLIPPED_NAME),
        manifest: output_dir.join(MANIFEST_NAME),
    };
    ensure_safe_destinations(
        &input,
        [
            &paths.source,
            &paths.denoised,
            &paths.declipped,
            &paths.manifest,
        ],
    )?;

    // Reserve all names exclusively before writing any artifacts. Existing files are never
    // truncated, and a collision leaves the caller's files untouched.
    let mut reservations = Vec::new();
    for path in [
        &paths.source,
        &paths.denoised,
        &paths.declipped,
        &paths.manifest,
    ] {
        match OpenOptions::new().write(true).create_new(true).open(path) {
            Ok(file) => reservations.push((path.to_owned(), file)),
            Err(error) => {
                for (reserved, _) in reservations {
                    let _ = fs::remove_file(reserved);
                }
                return Err(error.into());
            }
        }
    }
    let result = run_reserved(&input, &paths, noise_start, noise_end, reservations);
    if result.is_err() {
        for path in [
            &paths.source,
            &paths.denoised,
            &paths.declipped,
            &paths.manifest,
        ] {
            let _ = fs::remove_file(path);
        }
    }
    result
}

fn ensure_safe_destinations<const N: usize>(input: &Path, outputs: [&PathBuf; N]) -> Result<()> {
    for (index, output) in outputs.iter().enumerate() {
        if output.exists() || *output == input {
            return Err(SpeechAudioError::InvalidInput(format!(
                "refusing existing or input-colliding output path: {}",
                output.display()
            )));
        }
        if outputs[..index].contains(output) {
            return Err(SpeechAudioError::InvalidInput(
                "output paths must be distinct".into(),
            ));
        }
    }
    Ok(())
}

fn run_reserved(
    input: &Path,
    paths: &OutputPaths,
    noise_start: usize,
    noise_end: usize,
    mut reservations: Vec<(PathBuf, File)>,
) -> Result<()> {
    let source_file = reservations
        .iter_mut()
        .find(|(path, _)| *path == paths.source)
        .expect("source path is reserved");
    let source_digest = copy_bounded_and_hash(input, &mut source_file.1)?;
    source_file.1.sync_all()?;
    drop(reservations);

    let decode_limits = preview_decode_limits();
    let source = load_audio_buffer_bounded(&paths.source, decode_limits)?;
    validate_preview_source(&source)?;
    let profile = NoiseProfile::estimate(&source, noise_start, noise_end)?;
    let denoise_options = DenoiseOptions::DEFAULT;
    let denoised = denoise(&source, &profile, denoise_options)?;
    let repair_limits = RepairLimits::DEFAULT;
    let declipped = declip_bounded(&source, DECLIP_THRESHOLD, repair_limits)?;
    write_wav(&paths.denoised, &denoised)?;
    write_wav(&paths.declipped, &declipped)?;

    let denoised_readback = load_audio_buffer_bounded(&paths.denoised, decode_limits)?;
    let declipped_readback = load_audio_buffer_bounded(&paths.declipped, decode_limits)?;
    let denoised_comparison = compare_audio(&source, &denoised_readback, None)?;
    let declipped_comparison = compare_audio(&source, &declipped_readback, None)?;
    if denoised_comparison.undo()? != source || declipped_comparison.undo()? != source {
        return Err(SpeechAudioError::InvalidInput(
            "comparison undo branch did not preserve decoded source samples".into(),
        ));
    }
    let denoised_digest = hash_file(&paths.denoised)?;
    let declipped_digest = hash_file(&paths.declipped)?;
    let manifest = manifest_json(
        input,
        &source_digest,
        paths,
        &denoised_digest,
        &declipped_digest,
        &denoised_comparison,
        &declipped_comparison,
        noise_start,
        noise_end,
        &source,
        &denoised_readback,
        &declipped_readback,
        &profile,
        denoise_options,
        repair_limits,
    )?;
    let mut output = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&paths.manifest)?;
    output.write_all(manifest.as_bytes())?;
    output.sync_all()?;
    Ok(())
}

fn validate_preview_source(source: &AudioBuffer) -> Result<()> {
    if source.samples.is_empty() || source.samples.len() > RepairLimits::DEFAULT.max_samples {
        return Err(SpeechAudioError::ResourceLimit(
            "preview source must be non-empty and within the repair sample cap".into(),
        ));
    }
    Ok(())
}

fn preview_decode_limits() -> DecodeLimits {
    DecodeLimits {
        max_decoded_samples: RepairLimits::DEFAULT.max_samples,
        ..DecodeLimits::DEFAULT
    }
}

fn copy_bounded_and_hash(input: &Path, output: &mut File) -> Result<String> {
    let mut source = File::open(input)?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let read = source.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| SpeechAudioError::ResourceLimit("input byte count overflow".into()))?;
        if total > DecodeLimits::DEFAULT.max_input_bytes {
            return Err(SpeechAudioError::ResourceLimit(
                "encoded input exceeds the crate decode byte cap".into(),
            ));
        }
        output.write_all(&chunk[..read])?;
        hasher.update(&chunk[..read]);
    }
    Ok(hex_digest(hasher.finalize().as_slice()))
}

fn hash_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        hasher.update(&chunk[..read]);
    }
    Ok(hex_digest(hasher.finalize().as_slice()))
}

fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[allow(clippy::too_many_arguments)]
fn manifest_json(
    input: &Path,
    source_digest: &str,
    paths: &OutputPaths,
    denoised_digest: &str,
    declipped_digest: &str,
    denoised: &speech_audio_rust::AudioComparison,
    declipped: &speech_audio_rust::AudioComparison,
    noise_start: usize,
    noise_end: usize,
    source_buffer: &AudioBuffer,
    denoised_buffer: &AudioBuffer,
    declipped_buffer: &AudioBuffer,
    profile: &NoiseProfile,
    denoise_options: DenoiseOptions,
    repair_limits: RepairLimits,
) -> Result<String> {
    let denoise_parameters = json!({
        "algorithm": "block-rms-noise-gate-with-interpolated-gain",
        "thresholdMultiple": denoise_options.threshold_multiple,
        "floorGain": denoise_options.floor_gain,
        "blockFrames": denoise_options.block_frames,
        "noiseProfile": {
            "startInclusive": noise_start,
            "endExclusive": noise_end,
            "frames": profile.profile_frames,
            "rmsByChannel": &profile.rms_by_channel,
        },
    });
    let declip_parameters = json!({
        "algorithm": "linear-interpolation-between-unclipped-neighbors",
        "clipThreshold": DECLIP_THRESHOLD,
        "maxRunFrames": repair_limits.max_declip_run_frames,
    });
    let manifest = json!({
        "input": input.display().to_string(),
        "source": {
            "path": paths.source.display().to_string(),
            "sha256": source_digest,
            "exactInputCopy": true,
            "audioFormat": audio_format_json(source_buffer),
        },
        "candidates": [
            {
                "operation": "denoise",
                "pipelineOrder": null,
                "path": paths.denoised.display().to_string(),
                "sha256": denoised_digest,
                "parameters": denoise_parameters,
                "audioFormat": audio_format_json(denoised_buffer),
                "metrics": metrics_json(denoised),
            },
            {
                "operation": "declip",
                "pipelineOrder": null,
                "path": paths.declipped.display().to_string(),
                "sha256": declipped_digest,
                "parameters": declip_parameters,
                "audioFormat": audio_format_json(declipped_buffer),
                "metrics": metrics_json(declipped),
            },
        ],
        "reference": null,
        "qualityClaim": null,
    });
    serde_json::to_string_pretty(&manifest)
        .map(|value| format!("{value}\n"))
        .map_err(|error| SpeechAudioError::Encode(format!("failed to serialize manifest: {error}")))
}

fn audio_format_json(buffer: &AudioBuffer) -> Value {
    json!({
        "sampleRateHz": buffer.config.sample_rate,
        "channels": buffer.config.channels,
        "sampleFormat": "f32",
        "frames": buffer.frame_count(),
        "durationSeconds": buffer.duration_seconds(),
    })
}

fn metrics_json(comparison: &speech_audio_rust::AudioComparison) -> Value {
    let metrics = comparison.metrics();
    json!({
        "sourceRms": metrics.source_rms,
        "outputRms": metrics.output_rms,
        "peakAbs": metrics.peak_abs,
        "sourceNearClipSamples": metrics.source_near_clip_sample_count,
        "outputNearClipSamples": metrics.clipped_sample_count,
        "changedSamples": metrics.changed_sample_count,
        "sourceSnrDbVsReference": metrics.source_snr_db_vs_reference,
        "snrDbVsReference": metrics.snr_db_vs_reference,
        "stereoCorrelationDelta": metrics.stereo_correlation_delta,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use hound::{SampleFormat as HoundFormat, WavSpec, WavWriter};
    use speech_audio_rust::{AudioBuffer, AudioConfig, SampleFormat};
    use tempfile::tempdir;

    fn make_wav(path: &Path, samples: &[i16]) {
        let spec = WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: HoundFormat::Int,
        };
        let mut writer = WavWriter::create(path, spec).unwrap();
        for sample in samples {
            writer.write_sample(*sample).unwrap();
        }
        writer.finalize().unwrap();
    }

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempdir().unwrap();
        let input = dir.path().join("caller.wav");
        let output = dir.path().join("preview");
        let mut samples = vec![160i16; 64];
        samples.extend(std::iter::repeat_n(900i16, 64));
        samples[95] = i16::MAX;
        make_wav(&input, &samples);
        (dir, input, output)
    }

    #[test]
    fn preview_applies_bounded_denoise_and_declip_to_synthetic_noise_and_clipping() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("synthetic-noisy-clipped.wav");
        let output = dir.path().join("preview");

        // First block is low-level deterministic noise; the second is a clean
        // periodic signal with a short, deliberately clipped interior run.
        // The fixture lets this runnable consumer prove that each branch changes
        // the supported corruption while retaining a separate source branch.
        let mut source_samples = Vec::with_capacity(512);
        let mut reference_samples = Vec::with_capacity(512);
        for frame in 0..256 {
            let noise = if frame % 2 == 0 { 100i16 } else { -100i16 };
            source_samples.push(noise);
            reference_samples.push(0i16);
        }
        for frame in 0..256 {
            let clean =
                (0.8 * (2.0 * std::f64::consts::PI * frame as f64 / 64.0).sin() * i16::MAX as f64)
                    .round() as i16;
            reference_samples.push(clean);
            source_samples.push(if (16..=20).contains(&frame) {
                i16::MAX
            } else {
                clean
            });
        }
        make_wav(&input, &source_samples);
        let original = fs::read(&input).unwrap();

        run_preview(&input, &output, 0, 256).unwrap();

        assert_eq!(
            fs::read(&input).unwrap(),
            original,
            "caller WAV remains byte-identical"
        );
        assert_eq!(
            fs::read(output.join("source-original.wav")).unwrap(),
            original,
            "source artifact is an exact encoded input copy"
        );
        let source = load_audio_buffer_bounded(&input, preview_decode_limits()).unwrap();
        let denoised =
            load_audio_buffer_bounded(output.join(DENOISED_NAME), preview_decode_limits()).unwrap();
        let declipped =
            load_audio_buffer_bounded(output.join(DECLIPPED_NAME), preview_decode_limits())
                .unwrap();
        assert_ne!(
            denoised, source,
            "noise-only block must produce an attenuated denoise candidate"
        );
        assert_ne!(
            declipped, source,
            "clipped interior run must produce a declip candidate"
        );
        assert!(
            denoised.samples[..256]
                .iter()
                .map(|sample| sample.abs() as f64)
                .sum::<f64>()
                < source.samples[..256]
                    .iter()
                    .map(|sample| sample.abs() as f64)
                    .sum::<f64>(),
            "synthetic noise-block sample magnitude is reduced"
        );
        let reference = AudioBuffer::new(
            reference_samples
                .iter()
                .map(|sample| *sample as f32 / i16::MAX as f32)
                .collect(),
            source.config,
        );
        let source_metrics = compare_audio(&source, &source, Some(&reference))
            .unwrap()
            .metrics()
            .clone();
        let repaired_metrics = compare_audio(&source, &declipped, Some(&reference))
            .unwrap()
            .metrics()
            .clone();
        assert!(repaired_metrics.snr_db_vs_reference.unwrap()
            > source_metrics.snr_db_vs_reference.unwrap(),
            "the deterministic synthetic reference should show directionally lower clipped-sample error");
        assert_eq!(
            compare_audio(&source, &denoised, None)
                .unwrap()
                .undo()
                .unwrap(),
            source
        );
        assert_eq!(
            compare_audio(&source, &declipped, None)
                .unwrap()
                .undo()
                .unwrap(),
            source
        );
    }

    #[test]
    fn preview_preserves_exact_source_and_reopens_separate_candidates_for_undo() {
        let (_dir, input, output) = fixture();
        let original = fs::read(&input).unwrap();
        run_preview(&input, &output, 0, 64).unwrap();
        let copied_source = fs::read(output.join("source-original.wav")).unwrap();
        assert_eq!(original, copied_source);
        let denoised =
            load_audio_buffer_bounded(output.join(DENOISED_NAME), preview_decode_limits()).unwrap();
        let declipped =
            load_audio_buffer_bounded(output.join(DECLIPPED_NAME), preview_decode_limits())
                .unwrap();
        let source = load_audio_buffer_bounded(&input, preview_decode_limits()).unwrap();
        assert_ne!(denoised, declipped);
        assert_eq!(
            compare_audio(&source, &denoised, None)
                .unwrap()
                .undo()
                .unwrap(),
            source
        );
        assert_eq!(
            compare_audio(&source, &declipped, None)
                .unwrap()
                .undo()
                .unwrap(),
            source
        );
        let manifest: Value =
            serde_json::from_slice(&fs::read(output.join(MANIFEST_NAME)).unwrap()).unwrap();
        assert_eq!(manifest["reference"], Value::Null);
        assert_eq!(manifest["qualityClaim"], Value::Null);
        assert_eq!(
            manifest["candidates"][0]["metrics"]["sourceSnrDbVsReference"],
            Value::Null
        );
        assert_eq!(
            manifest["candidates"][0]["metrics"]["snrDbVsReference"],
            Value::Null
        );
        assert_eq!(
            manifest["candidates"][1]["metrics"]["sourceSnrDbVsReference"],
            Value::Null
        );
        assert_eq!(
            manifest["candidates"][1]["metrics"]["snrDbVsReference"],
            Value::Null
        );
        let source_format = json!({
            "sampleRateHz": 16_000,
            "channels": 1,
            "sampleFormat": "f32",
            "frames": 128,
            "durationSeconds": 0.008,
        });
        assert_eq!(manifest["source"]["audioFormat"], source_format);
        assert_eq!(manifest["source"]["exactInputCopy"], true);
        assert_eq!(
            manifest["source"]["sha256"],
            hash_file(&output.join("source-original.wav")).unwrap()
        );

        let denoise_candidate = &manifest["candidates"][0];
        assert_eq!(denoise_candidate["operation"], "denoise");
        assert_eq!(denoise_candidate["pipelineOrder"], Value::Null);
        assert_eq!(denoise_candidate["audioFormat"], source_format);
        assert_eq!(
            denoise_candidate["parameters"]["algorithm"],
            "block-rms-noise-gate-with-interpolated-gain"
        );
        assert_eq!(
            denoise_candidate["parameters"]["thresholdMultiple"],
            DenoiseOptions::DEFAULT.threshold_multiple
        );
        assert_eq!(
            denoise_candidate["parameters"]["floorGain"],
            DenoiseOptions::DEFAULT.floor_gain
        );
        assert_eq!(
            denoise_candidate["parameters"]["blockFrames"],
            DenoiseOptions::DEFAULT.block_frames
        );
        assert_eq!(
            denoise_candidate["parameters"]["noiseProfile"]["startInclusive"],
            0
        );
        assert_eq!(
            denoise_candidate["parameters"]["noiseProfile"]["endExclusive"],
            64
        );
        assert_eq!(
            denoise_candidate["parameters"]["noiseProfile"]["frames"],
            64
        );
        assert_eq!(
            denoise_candidate["parameters"]["noiseProfile"]["rmsByChannel"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            denoise_candidate["metrics"]["sourceSnrDbVsReference"],
            Value::Null
        );
        assert_eq!(
            denoise_candidate["metrics"]["snrDbVsReference"],
            Value::Null
        );

        let declip_candidate = &manifest["candidates"][1];
        assert_eq!(
            declip_candidate["metrics"]["sourceSnrDbVsReference"],
            Value::Null
        );
        assert_eq!(declip_candidate["metrics"]["snrDbVsReference"], Value::Null);
        assert_eq!(declip_candidate["operation"], "declip");
        assert_eq!(declip_candidate["pipelineOrder"], Value::Null);
        assert_eq!(declip_candidate["audioFormat"], source_format);
        assert_eq!(
            declip_candidate["parameters"]["algorithm"],
            "linear-interpolation-between-unclipped-neighbors"
        );
        assert_eq!(
            declip_candidate["parameters"]["clipThreshold"],
            DECLIP_THRESHOLD
        );
        assert_eq!(
            declip_candidate["parameters"]["maxRunFrames"],
            RepairLimits::DEFAULT.max_declip_run_frames
        );
        assert_eq!(
            declip_candidate["metrics"]["sourceSnrDbVsReference"],
            Value::Null
        );
        assert_eq!(declip_candidate["metrics"]["snrDbVsReference"], Value::Null);

        for (candidate, artifact) in [
            (denoise_candidate, output.join(DENOISED_NAME)),
            (declip_candidate, output.join(DECLIPPED_NAME)),
        ] {
            assert_eq!(candidate["sha256"], hash_file(&artifact).unwrap());
        }
    }

    #[test]
    fn rejects_collision_invalid_span_empty_and_oversized_sources() {
        let (_dir, input, output) = fixture();
        fs::create_dir_all(&output).unwrap();
        fs::write(output.join(DENOISED_NAME), b"keep me").unwrap();
        assert!(run_preview(&input, &output, 0, 64).is_err());
        assert_eq!(fs::read(output.join(DENOISED_NAME)).unwrap(), b"keep me");

        let empty = AudioBuffer::new(
            vec![],
            AudioConfig {
                sample_rate: 16_000,
                channels: 1,
                sample_format: SampleFormat::F32,
            },
        );
        assert!(validate_preview_source(&empty).is_err());
        assert!(
            NoiseProfile::estimate(&AudioBuffer::new(vec![0.1; 8], empty.config), 4, 4).is_err()
        );
        let over = AudioBuffer::new(
            vec![0.1; RepairLimits::DEFAULT.max_samples + 1],
            AudioConfig {
                sample_rate: 16_000,
                channels: 1,
                sample_format: SampleFormat::F32,
            },
        );
        assert!(validate_preview_source(&over).is_err());
    }

    #[test]
    fn rejects_malformed_input_without_leaving_partial_outputs() {
        let dir = tempdir().unwrap();
        let input = dir.path().join("malformed.wav");
        let output = dir.path().join("preview");
        fs::write(&input, b"not a wav").unwrap();
        assert!(run_preview(&input, &output, 0, 1).is_err());
        assert!(fs::read_dir(&output).unwrap().next().is_none());
    }
}
