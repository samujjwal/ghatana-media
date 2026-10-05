//! Microphone recording utilities.

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use hound::{SampleFormat as WavSampleFormat, WavSpec, WavWriter};
use once_cell::sync::Lazy;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::{sync::mpsc, thread};

use crate::buffer::SampleAccumulator;
use crate::config::AudioRuntimeConfig;
use crate::device::AudioDeviceManager;
use crate::error::{AppError, AppResult};
use crate::metrics::AudioRuntimeMetrics;
use crate::pool::{AudioDeviceLeaseKind, AudioDevicePool};
use crate::resilience::CircuitBreaker;

static RECORDING_BREAKER: Lazy<CircuitBreaker> = Lazy::new(|| {
    let config = AudioRuntimeConfig::current();
    CircuitBreaker::new(
        "recording",
        config.circuit_breaker_failure_threshold,
        std::time::Duration::from_millis(config.circuit_breaker_cooldown_ms),
    )
});

pub struct RecordingHandle {
    stop_tx: mpsc::Sender<()>,
    join: Option<thread::JoinHandle<AppResult<f64>>>,
}

impl RecordingHandle {
    pub fn start_default(output_path: PathBuf) -> AppResult<Self> {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        AudioRuntimeMetrics::global().record_recording_started();

        let join = thread::spawn(move || {
            let _lease = AudioDevicePool::global().acquire(AudioDeviceLeaseKind::Input, "recording")?;
            let selection = match RECORDING_BREAKER.run("start", AudioDeviceManager::default_input)
            {
                Ok(selection) => selection,
                Err(error) => {
                    AudioRuntimeMetrics::global().record_recording_failure();
                    return Err(error);
                }
            };

            let crate::device::DeviceSelection {
                device,
                config: supported_config,
                name,
            } = selection;

            let sample_format = supported_config.sample_format();
            let config: StreamConfig = supported_config.into();

            let sample_rate = config.sample_rate.0;
            let channels = config.channels as usize;
            let initial_capacity = sample_rate as usize
                * AudioRuntimeConfig::current().recording_initial_buffer_seconds;

            tracing::info!(
                "Starting mic recording: device={} sample_rate={} channels={} format={:?}",
                name,
                sample_rate,
                channels,
                sample_format
            );

            let is_recording = Arc::new(AtomicBool::new(true));
            let is_recording_stream = Arc::clone(&is_recording);

            let samples: Arc<Mutex<SampleAccumulator>> = Arc::new(Mutex::new(
                SampleAccumulator::with_capacity(initial_capacity),
            ));
            let samples_clone = Arc::clone(&samples);

            let err_fn = |err| {
                tracing::error!("Mic recording stream error: {}", err);
            };

            let stream = match sample_format {
                SampleFormat::F32 => device
                    .build_input_stream(
                        &config,
                        move |data: &[f32], _: &cpal::InputCallbackInfo| {
                            if !is_recording_stream.load(Ordering::SeqCst) {
                                return;
                            }
                            push_mono_samples_f32(data, channels, &samples_clone)
                        },
                        err_fn,
                        None,
                    )
                    .map_err(|e| AppError::Audio(format!("Failed to build input stream: {}", e)))?,
                SampleFormat::I16 => device
                    .build_input_stream(
                        &config,
                        move |data: &[i16], _: &cpal::InputCallbackInfo| {
                            if !is_recording_stream.load(Ordering::SeqCst) {
                                return;
                            }
                            push_mono_samples_i16(data, channels, &samples_clone)
                        },
                        err_fn,
                        None,
                    )
                    .map_err(|e| AppError::Audio(format!("Failed to build input stream: {}", e)))?,
                SampleFormat::U16 => device
                    .build_input_stream(
                        &config,
                        move |data: &[u16], _: &cpal::InputCallbackInfo| {
                            if !is_recording_stream.load(Ordering::SeqCst) {
                                return;
                            }
                            push_mono_samples_u16(data, channels, &samples_clone)
                        },
                        err_fn,
                        None,
                    )
                    .map_err(|e| AppError::Audio(format!("Failed to build input stream: {}", e)))?,
                other => {
                    return Err(AppError::Audio(format!(
                        "Unsupported input sample format: {:?}",
                        other
                    )))
                }
            };

            stream
                .play()
                .map_err(|e| AppError::Audio(format!("Failed to start input stream: {}", e)))?;

            let _ = stop_rx.recv();
            is_recording.store(false, Ordering::SeqCst);
            drop(stream);

            let samples = {
                let guard = samples
                    .lock()
                    .map_err(|_| AppError::Audio("Failed to lock sample buffer".to_string()))?;
                guard.snapshot()
            };

            if let Some(parent) = output_path.parent() {
                std::fs::create_dir_all(parent).ok();
            }

            let spec = WavSpec {
                channels: 1,
                sample_rate,
                bits_per_sample: 16,
                sample_format: WavSampleFormat::Int,
            };

            let mut writer = WavWriter::create(&output_path, spec)
                .map_err(|e| AppError::Audio(format!("Failed to create WAV writer: {}", e)))?;

            for s in &samples {
                writer
                    .write_sample(*s)
                    .map_err(|e| AppError::Audio(format!("Failed to write WAV sample: {}", e)))?;
            }

            writer
                .finalize()
                .map_err(|e| AppError::Audio(format!("Failed to finalize WAV file: {}", e)))?;

            let duration = samples.len() as f64 / sample_rate as f64;
            Ok(duration)
        });

        Ok(Self {
            stop_tx,
            join: Some(join),
        })
    }

    pub fn stop(mut self) -> AppResult<f64> {
        let _ = self.stop_tx.send(());

        let join = self
            .join
            .take()
            .ok_or_else(|| AppError::Audio("Recording thread not available".to_string()))?;

        join.join()
            .map_err(|_| AppError::Audio("Recording thread panicked".to_string()))?
    }
}

fn push_mono_samples_f32(data: &[f32], channels: usize, buf: &Arc<Mutex<SampleAccumulator>>) {
    let mut guard = match buf.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    guard.push_f32_frames(data, channels);
}

fn push_mono_samples_i16(data: &[i16], channels: usize, buf: &Arc<Mutex<SampleAccumulator>>) {
    let mut guard = match buf.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    guard.push_i16_frames(data, channels);
}

fn push_mono_samples_u16(data: &[u16], channels: usize, buf: &Arc<Mutex<SampleAccumulator>>) {
    let mut guard = match buf.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    guard.push_u16_frames(data, channels);
}
