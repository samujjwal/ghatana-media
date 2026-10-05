package com.ghatana.audio.video.multimodal.engine;

import com.ghatana.media.config.ConfigurationProvider;

/**
 * @doc.type record
 * @doc.purpose Shared runtime settings aligned with the audio-video cross-language config schema
 * @doc.layer product
 * @doc.pattern Configuration
 */
public record AudioVideoRuntimeSettings(
        String languageTag,
        int sttSampleRate,
        int sttChannels,
        int sttBitsPerSample,
        int defaultImageWidth,
        int defaultImageHeight,
        int syncToleranceMs,
        int syncAudioBufferMs,
        int syncVideoBufferMs,
        int defaultVideoSampleFps,
        int defaultVideoMaxFrames,
        String sttModelId,
        String visionModelId,
        String ttsVoiceId,
        boolean metricsEnabled,
        int maxInputStreams,
        int maxOutputStreams,
        long deviceAcquireTimeoutMs,
        long leakDetectionThresholdMs) {

    public static AudioVideoRuntimeSettings load() {
        ConfigurationProvider config = ConfigurationProvider.getInstance();
        return new AudioVideoRuntimeSettings(
                config.getString("media.language.tag", "en-US"),
                config.getInt("media.stt.sample_rate", 16000),
                config.getInt("media.stt.channels", 1),
                config.getInt("media.stt.bits_per_sample", 16),
                config.getInt("media.vision.default_image_width", 640),
                config.getInt("media.vision.default_image_height", 480),
                config.getInt("media.sync.tolerance_ms", 40),
                config.getInt("media.sync.audio_buffer_ms", 500),
                config.getInt("media.sync.video_buffer_ms", 200),
                config.getInt("media.video.sample_fps", 1),
                config.getInt("media.video.max_frames", 50),
                config.getString("media.stt.model_id", "whisper-base"),
                config.getString("media.vision.model_id", "yolov8n"),
                config.getString("media.tts.voice_id", "piper-en"),
                config.getBoolean("media.metrics.enabled", true),
                config.getInt("media.max_input_streams", 2),
                config.getInt("media.max_output_streams", 2),
                config.getLong("media.device_acquire_timeout_ms", 2500L),
                config.getLong("media.leak_detection_threshold_ms", 30000L));
    }

    static AudioVideoRuntimeSettings defaults() {
        return new AudioVideoRuntimeSettings("en-US", 16000, 1, 16, 640, 480, 40, 500, 200,
                1, 50, "whisper-base", "yolov8n", "piper-en", true, 2, 2, 2500L, 30000L);
    }

}
