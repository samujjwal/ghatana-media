use once_cell::sync::Lazy;
#[cfg(test)]
use serde::Deserialize;
#[cfg(test)]
use std::fs;
#[cfg(test)]
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy)]
pub struct AudioRuntimeConfig {
    pub waveform_bucket_limit: usize,
    pub playback_poll_interval_ms: u64,
    pub recording_initial_buffer_seconds: usize,
    pub circuit_breaker_failure_threshold: u32,
    pub circuit_breaker_cooldown_ms: u64,
    pub max_input_streams: usize,
    pub max_output_streams: usize,
    pub device_acquire_timeout_ms: u64,
    pub leak_detection_threshold_ms: u64,
    pub sync_tolerance_ms: i64,
}

impl AudioRuntimeConfig {
    pub fn current() -> &'static Self {
        static CONFIG: Lazy<AudioRuntimeConfig> = Lazy::new(AudioRuntimeConfig::from_env);
        &CONFIG
    }

    fn from_env() -> Self {
        Self {
            waveform_bucket_limit: read_env_aliases(
                &["GHATANA_MEDIA_WAVEFORM_BUCKET_LIMIT", "AI_VOICE_WAVEFORM_BUCKET_LIMIT"],
                2048usize,
            ),
            playback_poll_interval_ms: read_env_aliases(
                &["GHATANA_MEDIA_PLAYBACK_POLL_MS", "AI_VOICE_PLAYBACK_POLL_MS"],
                10u64,
            ),
            recording_initial_buffer_seconds: read_env_aliases(
                &["GHATANA_MEDIA_RECORDING_BUFFER_SECONDS", "AI_VOICE_RECORDING_BUFFER_SECONDS"],
                30usize,
            ),
            circuit_breaker_failure_threshold: read_env_aliases(
                &["GHATANA_MEDIA_AUDIO_BREAKER_FAILURES", "AI_VOICE_AUDIO_BREAKER_FAILURES"],
                3u32,
            ),
            circuit_breaker_cooldown_ms: read_env_aliases(
                &["GHATANA_MEDIA_AUDIO_BREAKER_COOLDOWN_MS", "AI_VOICE_AUDIO_BREAKER_COOLDOWN_MS"],
                1500u64,
            ),
            max_input_streams: read_env_aliases(
                &["GHATANA_MEDIA_MAX_INPUT_STREAMS", "AI_VOICE_MAX_INPUT_STREAMS"],
                2usize,
            ),
            max_output_streams: read_env_aliases(
                &["GHATANA_MEDIA_MAX_OUTPUT_STREAMS", "AI_VOICE_MAX_OUTPUT_STREAMS"],
                2usize,
            ),
            device_acquire_timeout_ms: read_env_aliases(
                &["GHATANA_MEDIA_DEVICE_ACQUIRE_TIMEOUT_MS", "AI_VOICE_DEVICE_ACQUIRE_TIMEOUT_MS"],
                2500u64,
            ),
            leak_detection_threshold_ms: read_env_aliases(
                &["GHATANA_MEDIA_LEAK_DETECTION_THRESHOLD_MS", "AI_VOICE_LEAK_DETECTION_THRESHOLD_MS"],
                30000u64,
            ),
            sync_tolerance_ms: read_env_aliases(
                &["GHATANA_MEDIA_SYNC_TOLERANCE_MS", "AI_VOICE_SYNC_TOLERANCE_MS"],
                40i64,
            ),
        }
    }
}

fn read_env_aliases<T>(names: &[&str], default: T) -> T
where
    T: std::str::FromStr + Copy,
{
    names
        .iter()
        .find_map(|name| std::env::var(name).ok().and_then(|value| value.parse::<T>().ok()))
        .unwrap_or(default)
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
struct MediaContractFixtures {
    #[serde(rename = "runtimeConfig")]
    runtime_config: RuntimeConfigFixture,
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
struct RuntimeConfigFixture {
    #[serde(rename = "maxInputStreams")]
    max_input_streams: usize,
    #[serde(rename = "maxOutputStreams")]
    max_output_streams: usize,
    #[serde(rename = "deviceAcquireTimeoutMs")]
    device_acquire_timeout_ms: u64,
    #[serde(rename = "leakDetectionThresholdMs")]
    leak_detection_threshold_ms: u64,
    #[serde(rename = "syncToleranceMs")]
    sync_tolerance_ms: i64,
}

#[cfg(test)]
fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(path) = current {
        if path.join("settings.gradle.kts").exists()
            && path.join("pnpm-workspace.yaml").exists()
            && path.join("platform").is_dir()
        {
            return Some(path.to_path_buf());
        }
        current = path.parent();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_sane() {
        let config = AudioRuntimeConfig::from_env();
        assert!(config.waveform_bucket_limit > 0);
        assert!(config.playback_poll_interval_ms > 0);
        assert!(config.recording_initial_buffer_seconds > 0);
        assert!(config.circuit_breaker_failure_threshold > 0);
        assert!(config.circuit_breaker_cooldown_ms > 0);
        assert!(config.max_input_streams > 0);
        assert!(config.max_output_streams > 0);
        assert!(config.device_acquire_timeout_ms > 0);
        assert!(config.leak_detection_threshold_ms > 0);
        assert!(config.sync_tolerance_ms > 0);
    }

    #[test]
    fn aligns_with_shared_media_contract_fixture() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo_root = find_repo_root(&manifest_dir).expect("repo root");
        let fixture_path = repo_root.join("products/audio-video/test-fixtures/media-contract-fixtures.json");
        let fixture: MediaContractFixtures = serde_json::from_str(
            &fs::read_to_string(fixture_path).expect("fixture file"),
        )
        .expect("fixture json");

        assert_eq!(fixture.runtime_config.max_input_streams, 3);
        assert_eq!(fixture.runtime_config.max_output_streams, 4);
        assert_eq!(fixture.runtime_config.device_acquire_timeout_ms, 4200);
        assert_eq!(fixture.runtime_config.leak_detection_threshold_ms, 61000);
        assert_eq!(fixture.runtime_config.sync_tolerance_ms, 55);
    }
}