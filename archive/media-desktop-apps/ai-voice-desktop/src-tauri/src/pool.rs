use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::config::AudioRuntimeConfig;
use crate::error::{AppError, AppResult};
use crate::metrics::AudioRuntimeMetrics;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioDeviceLeaseKind {
    Input,
    Output,
}

#[derive(Debug)]
struct LeaseRecord {
    kind: AudioDeviceLeaseKind,
    acquired_at: Instant,
    owner: &'static str,
    leak_reported: bool,
}

#[derive(Debug, Default)]
struct PoolState {
    active_input: usize,
    active_output: usize,
    next_lease_id: u64,
    leases: HashMap<u64, LeaseRecord>,
}

pub struct AudioDevicePool {
    config: AudioRuntimeConfig,
    state: Mutex<PoolState>,
    condvar: Condvar,
}

pub struct AudioDeviceLease {
    pool: &'static AudioDevicePool,
    lease_id: u64,
    kind: AudioDeviceLeaseKind,
}

impl AudioDevicePool {
    pub fn global() -> &'static Self {
        static POOL: Lazy<AudioDevicePool> = Lazy::new(|| AudioDevicePool::new(*AudioRuntimeConfig::current()));
        &POOL
    }

    fn new(config: AudioRuntimeConfig) -> Self {
        Self {
            config,
            state: Mutex::new(PoolState::default()),
            condvar: Condvar::new(),
        }
    }

    pub fn acquire(
        &'static self,
        kind: AudioDeviceLeaseKind,
        owner: &'static str,
    ) -> AppResult<AudioDeviceLease> {
        let timeout = Duration::from_millis(self.config.device_acquire_timeout_ms);
        let start = Instant::now();
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut backpressure_recorded = false;

        loop {
            self.detect_leaks_locked(&mut state);
            if self.has_capacity(&state, kind) {
                state.next_lease_id += 1;
                let lease_id = state.next_lease_id;
                state.leases.insert(
                    lease_id,
                    LeaseRecord {
                        kind,
                        acquired_at: Instant::now(),
                        owner,
                        leak_reported: false,
                    },
                );
                match kind {
                    AudioDeviceLeaseKind::Input => {
                        state.active_input += 1;
                        AudioRuntimeMetrics::global().record_input_lease_acquired();
                    }
                    AudioDeviceLeaseKind::Output => {
                        state.active_output += 1;
                        AudioRuntimeMetrics::global().record_output_lease_acquired();
                    }
                }
                return Ok(AudioDeviceLease {
                    pool: self,
                    lease_id,
                    kind,
                });
            }

            if !backpressure_recorded {
                AudioRuntimeMetrics::global().record_device_backpressure();
                backpressure_recorded = true;
            }

            let elapsed = start.elapsed();
            if elapsed >= timeout {
                AudioRuntimeMetrics::global().record_device_acquire_timeout();
                return Err(AppError::Audio(format!(
                    "Timed out waiting for {:?} device capacity after {}ms",
                    kind,
                    timeout.as_millis()
                )));
            }

            let remaining = timeout.saturating_sub(elapsed);
            let (next_state, wait_result) = self
                .condvar
                .wait_timeout(state, remaining)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state = next_state;
            if wait_result.timed_out() {
                AudioRuntimeMetrics::global().record_device_acquire_timeout();
                return Err(AppError::Audio(format!(
                    "Timed out waiting for {:?} device capacity after {}ms",
                    kind,
                    timeout.as_millis()
                )));
            }
        }
    }

    fn has_capacity(&self, state: &PoolState, kind: AudioDeviceLeaseKind) -> bool {
        match kind {
            AudioDeviceLeaseKind::Input => state.active_input < self.config.max_input_streams,
            AudioDeviceLeaseKind::Output => state.active_output < self.config.max_output_streams,
        }
    }

    fn detect_leaks_locked(&self, state: &mut PoolState) {
        let threshold = Duration::from_millis(self.config.leak_detection_threshold_ms);
        for lease in state.leases.values_mut() {
            if !lease.leak_reported && lease.acquired_at.elapsed() >= threshold {
                lease.leak_reported = true;
                tracing::warn!(
                    owner = lease.owner,
                    kind = ?lease.kind,
                    elapsed_ms = lease.acquired_at.elapsed().as_millis(),
                    "Audio device lease exceeded leak detection threshold"
                );
                AudioRuntimeMetrics::global().record_leak_detection();
            }
        }
    }

    fn release(&self, lease_id: u64, kind: AudioDeviceLeaseKind) {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.leases.remove(&lease_id).is_some() {
            match kind {
                AudioDeviceLeaseKind::Input => {
                    state.active_input = state.active_input.saturating_sub(1);
                    AudioRuntimeMetrics::global().record_input_lease_released();
                }
                AudioDeviceLeaseKind::Output => {
                    state.active_output = state.active_output.saturating_sub(1);
                    AudioRuntimeMetrics::global().record_output_lease_released();
                }
            }
            self.condvar.notify_one();
        }
    }
}

impl Drop for AudioDeviceLease {
    fn drop(&mut self) {
        self.pool.release(self.lease_id, self.kind);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> AudioRuntimeConfig {
        AudioRuntimeConfig {
            waveform_bucket_limit: 10,
            playback_poll_interval_ms: 10,
            recording_initial_buffer_seconds: 1,
            circuit_breaker_failure_threshold: 1,
            circuit_breaker_cooldown_ms: 10,
            max_input_streams: 1,
            max_output_streams: 1,
            device_acquire_timeout_ms: 10,
            leak_detection_threshold_ms: 1,
            sync_tolerance_ms: 40,
        }
    }

    #[test]
    fn acquires_and_releases_input_leases() {
        let pool = Box::leak(Box::new(AudioDevicePool::new(test_config())));

        {
            let _lease = pool.acquire(AudioDeviceLeaseKind::Input, "test").unwrap();
            assert_eq!(AudioRuntimeMetrics::global().snapshot().active_input_leases, 1);
        }

        assert_eq!(AudioRuntimeMetrics::global().snapshot().active_input_leases, 0);
    }

    #[test]
    fn times_out_when_capacity_is_exhausted() {
        let pool = Box::leak(Box::new(AudioDevicePool::new(test_config())));
        let _lease = pool.acquire(AudioDeviceLeaseKind::Output, "first").unwrap();

        let result = pool.acquire(AudioDeviceLeaseKind::Output, "second");
        assert!(result.is_err());
    }
}