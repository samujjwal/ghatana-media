use once_cell::sync::Lazy;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct AudioMetricsSnapshot {
    pub audio_load_attempts: u64,
    pub audio_load_failures: u64,
    pub playbacks_started: u64,
    pub playback_failures: u64,
    pub recordings_started: u64,
    pub recording_failures: u64,
    pub active_input_leases: u64,
    pub active_output_leases: u64,
    pub device_backpressure_events: u64,
    pub device_acquire_timeouts: u64,
    pub leak_detections: u64,
    pub sync_drift_observations: u64,
    pub last_sync_drift_ms: u64,
}

#[derive(Default)]
pub struct AudioRuntimeMetrics {
    audio_load_attempts: AtomicU64,
    audio_load_failures: AtomicU64,
    playbacks_started: AtomicU64,
    playback_failures: AtomicU64,
    recordings_started: AtomicU64,
    recording_failures: AtomicU64,
    active_input_leases: AtomicU64,
    active_output_leases: AtomicU64,
    device_backpressure_events: AtomicU64,
    device_acquire_timeouts: AtomicU64,
    leak_detections: AtomicU64,
    sync_drift_observations: AtomicU64,
    last_sync_drift_ms: AtomicU64,
}

impl AudioRuntimeMetrics {
    pub fn global() -> &'static Self {
        static METRICS: Lazy<AudioRuntimeMetrics> = Lazy::new(AudioRuntimeMetrics::default);
        &METRICS
    }

    pub fn record_audio_load_attempt(&self) {
        self.audio_load_attempts.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_audio_load_failure(&self) {
        self.audio_load_failures.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_playback_started(&self) {
        self.playbacks_started.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_playback_failure(&self) {
        self.playback_failures.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_recording_started(&self) {
        self.recordings_started.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_recording_failure(&self) {
        self.recording_failures.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_input_lease_acquired(&self) {
        self.active_input_leases.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_input_lease_released(&self) {
        self.active_input_leases.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn record_output_lease_acquired(&self) {
        self.active_output_leases.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_output_lease_released(&self) {
        self.active_output_leases.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn record_device_backpressure(&self) {
        self.device_backpressure_events.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_device_acquire_timeout(&self) {
        self.device_acquire_timeouts.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_leak_detection(&self) {
        self.leak_detections.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_sync_drift(&self, drift_ms: i64) {
        self.sync_drift_observations.fetch_add(1, Ordering::Relaxed);
        self.last_sync_drift_ms
            .store(drift_ms.unsigned_abs(), Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> AudioMetricsSnapshot {
        AudioMetricsSnapshot {
            audio_load_attempts: self.audio_load_attempts.load(Ordering::Relaxed),
            audio_load_failures: self.audio_load_failures.load(Ordering::Relaxed),
            playbacks_started: self.playbacks_started.load(Ordering::Relaxed),
            playback_failures: self.playback_failures.load(Ordering::Relaxed),
            recordings_started: self.recordings_started.load(Ordering::Relaxed),
            recording_failures: self.recording_failures.load(Ordering::Relaxed),
            active_input_leases: self.active_input_leases.load(Ordering::Relaxed),
            active_output_leases: self.active_output_leases.load(Ordering::Relaxed),
            device_backpressure_events: self.device_backpressure_events.load(Ordering::Relaxed),
            device_acquire_timeouts: self.device_acquire_timeouts.load(Ordering::Relaxed),
            leak_detections: self.leak_detections.load(Ordering::Relaxed),
            sync_drift_observations: self.sync_drift_observations.load(Ordering::Relaxed),
            last_sync_drift_ms: self.last_sync_drift_ms.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metrics_snapshot_reflects_updates() {
        let metrics = AudioRuntimeMetrics::default();
        metrics.record_audio_load_attempt();
        metrics.record_audio_load_failure();
        metrics.record_playback_started();
        metrics.record_recording_started();
        metrics.record_input_lease_acquired();
        metrics.record_input_lease_released();
        metrics.record_device_backpressure();
        metrics.record_device_acquire_timeout();
        metrics.record_leak_detection();
        metrics.record_sync_drift(52);

        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.audio_load_attempts, 1);
        assert_eq!(snapshot.audio_load_failures, 1);
        assert_eq!(snapshot.playbacks_started, 1);
        assert_eq!(snapshot.recordings_started, 1);
        assert_eq!(snapshot.active_input_leases, 0);
        assert_eq!(snapshot.device_backpressure_events, 1);
        assert_eq!(snapshot.device_acquire_timeouts, 1);
        assert_eq!(snapshot.leak_detections, 1);
        assert_eq!(snapshot.sync_drift_observations, 1);
        assert_eq!(snapshot.last_sync_drift_ms, 52);
    }
}