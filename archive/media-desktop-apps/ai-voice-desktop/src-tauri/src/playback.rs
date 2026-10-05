use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::SampleFormat;
use once_cell::sync::Lazy;

use crate::buffer::PlaybackCursor;
use crate::config::AudioRuntimeConfig;
use crate::device::AudioDeviceManager;
use crate::error::{AppError, AppResult};
use crate::metrics::AudioRuntimeMetrics;
use crate::pool::{AudioDeviceLeaseKind, AudioDevicePool};
use crate::resilience::CircuitBreaker;

static PLAYBACK_BREAKER: Lazy<CircuitBreaker> = Lazy::new(|| {
    let config = AudioRuntimeConfig::current();
    CircuitBreaker::new(
        "playback",
        config.circuit_breaker_failure_threshold,
        std::time::Duration::from_millis(config.circuit_breaker_cooldown_ms),
    )
});

pub struct PlaybackHandle {
    stop_flag: Arc<AtomicBool>,
    stop_tx: mpsc::Sender<()>,
    join: Option<thread::JoinHandle<AppResult<()>>>,
}

impl PlaybackHandle {
    pub fn start_default(path: PathBuf) -> AppResult<Self> {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop_flag_thread = Arc::clone(&stop_flag);
        AudioRuntimeMetrics::global().record_playback_started();

        let join = thread::spawn(move || {
            let _lease = AudioDevicePool::global().acquire(AudioDeviceLeaseKind::Output, "playback")?;
            let input_path = path
                .to_str()
                .ok_or_else(|| AppError::Audio("Invalid audio path".to_string()))?;
            let buffer = match PLAYBACK_BREAKER.run("decode", || crate::audio::load_wav_as_audio_buffer(input_path)) {
                Ok(buffer) => buffer,
                Err(error) => {
                    AudioRuntimeMetrics::global().record_playback_failure();
                    return Err(error);
                }
            };

            tracing::info!(
                "Playback input: sample_rate={} channels={}",
                buffer.config.sample_rate,
                buffer.config.channels
            );

            let selection = match PLAYBACK_BREAKER.run("open-output-device", AudioDeviceManager::default_output) {
                Ok(selection) => selection,
                Err(error) => {
                    AudioRuntimeMetrics::global().record_playback_failure();
                    return Err(error);
                }
            };

            let crate::device::DeviceSelection {
                device,
                config: supported_config,
                name,
            } = selection;

            let config: cpal::StreamConfig = supported_config.clone().into();
            let out_channels = config.channels as usize;
            let out_sample_rate = config.sample_rate.0;
            let out_format = supported_config.sample_format();

            tracing::info!(
                "Playback output: sample_rate={} channels={} format={:?}",
                out_sample_rate,
                out_channels,
                out_format
            );
            tracing::info!("Playback device={}", name);

            let resampler = speech_audio_rust::Resampler::new(out_sample_rate);
            let buffer = resampler
                .resample(&buffer)
                .map_err(|e| AppError::Audio(format!("Resample failed: {}", e)))?;

            // Adapt channels to match output device.
            let in_channels = buffer.config.channels as usize;
            let out_samples: Vec<f32> = if in_channels == out_channels {
                buffer.samples
            } else if in_channels == 1 {
                // Mono -> N channel: duplicate.
                let mut v = Vec::with_capacity(buffer.samples.len() * out_channels);
                for s in buffer.samples {
                    for _ in 0..out_channels {
                        v.push(s);
                    }
                }
                v
            } else {
                // N channel -> M channel: simple channel map.
                let frames = buffer.samples.len() / in_channels;
                let mut v = Vec::with_capacity(frames * out_channels);
                for f in 0..frames {
                    let base = f * in_channels;
                    for c in 0..out_channels {
                        let src_c = c.min(in_channels - 1);
                        v.push(buffer.samples[base + src_c]);
                    }
                }
                v
            };

            let cursor = Arc::new(PlaybackCursor::new(out_samples));
            let cursor_cb = Arc::clone(&cursor);

            let done = Arc::new(AtomicBool::new(false));
            let done_cb = Arc::clone(&done);

            let stop_flag_cb = Arc::clone(&stop_flag_thread);

            let err_fn = |err| {
                tracing::error!("Playback stream error: {}", err);
            };

            let stream = match out_format {
                SampleFormat::F32 => {
                    device
                        .build_output_stream(
                            &config,
                            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                                if stop_flag_cb.load(Ordering::SeqCst) {
                                    for s in data.iter_mut() {
                                        *s = 0.0;
                                    }
                                    done_cb.store(true, Ordering::SeqCst);
                                    return;
                                }
                                if cursor_cb.fill_f32(data) {
                                    done_cb.store(true, Ordering::SeqCst);
                                }
                            },
                            err_fn,
                            None,
                        )
                        .map_err(|e| {
                            AppError::Audio(format!("Failed to create output stream: {}", e))
                        })?
                }
                SampleFormat::I16 => {
                    device
                        .build_output_stream(
                            &config,
                            move |data: &mut [i16], _: &cpal::OutputCallbackInfo| {
                                if stop_flag_cb.load(Ordering::SeqCst) {
                                    for s in data.iter_mut() {
                                        *s = 0;
                                    }
                                    done_cb.store(true, Ordering::SeqCst);
                                    return;
                                }
                                if cursor_cb.fill_i16(data) {
                                    done_cb.store(true, Ordering::SeqCst);
                                }
                            },
                            err_fn,
                            None,
                        )
                        .map_err(|e| {
                            AppError::Audio(format!("Failed to create output stream: {}", e))
                        })?
                }
                SampleFormat::U16 => {
                    device
                        .build_output_stream(
                            &config,
                            move |data: &mut [u16], _: &cpal::OutputCallbackInfo| {
                                if stop_flag_cb.load(Ordering::SeqCst) {
                                    for s in data.iter_mut() {
                                        *s = u16::MAX / 2;
                                    }
                                    done_cb.store(true, Ordering::SeqCst);
                                    return;
                                }
                                if cursor_cb.fill_u16(data) {
                                    done_cb.store(true, Ordering::SeqCst);
                                }
                            },
                            err_fn,
                            None,
                        )
                        .map_err(|e| {
                            AppError::Audio(format!("Failed to create output stream: {}", e))
                        })?
                }
                _ => {
                    return Err(AppError::Audio(
                        "Unsupported output sample format".to_string(),
                    ));
                }
            };

            stream
                .play()
                .map_err(|e| AppError::Audio(format!("Failed to start playback: {}", e)))?;

            while !done.load(Ordering::SeqCst) {
                if stop_rx.try_recv().is_ok() {
                    stop_flag_thread.store(true, Ordering::SeqCst);
                }
                thread::sleep(std::time::Duration::from_millis(
                    AudioRuntimeConfig::current().playback_poll_interval_ms,
                ));
            }

            drop(stream);
            Ok(())
        });

        Ok(Self {
            stop_flag,
            stop_tx,
            join: Some(join),
        })
    }

    pub fn stop(mut self) -> AppResult<()> {
        self.stop_flag.store(true, Ordering::SeqCst);
        let _ = self.stop_tx.send(());

        let join = self
            .join
            .take()
            .ok_or_else(|| AppError::Audio("Playback thread not available".to_string()))?;

        join.join()
            .map_err(|_| AppError::Audio("Playback thread panicked".to_string()))?
    }
}
