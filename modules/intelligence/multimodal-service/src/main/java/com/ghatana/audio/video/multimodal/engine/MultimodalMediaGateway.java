package com.ghatana.audio.video.multimodal.engine;

/**
 * @doc.type interface
 * @doc.purpose Product-level multimodal gateway backed by the platform audio-video library
 * @doc.layer product
 * @doc.pattern Port
 */
public interface MultimodalMediaGateway extends AutoCloseable {

    AudioResult transcribe(byte[] audioData);

    VisualResult analyseImage(byte[] imageData);

    VisualResult analyseVideo(byte[] videoData, int sampleFps, int maxFrames);

    /** Demuxes a bounded, allow-listed video's first audio stream; never treats container bytes as PCM. */
    default com.ghatana.audio.video.vision.video.VideoFrameExtractor.ExtractedAudioTrack extractAudioTrack(
            byte[] videoData) throws java.io.IOException {
        throw new java.io.IOException("VIDEO_AUDIO_TRACK_NOT_ADMITTED: no governed demuxer is configured");
    }

    String backendName();

    boolean metricsEnabled();

    @Override
    void close();
}
