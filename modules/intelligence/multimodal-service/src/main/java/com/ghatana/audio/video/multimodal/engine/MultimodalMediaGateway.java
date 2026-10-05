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

    String backendName();

    boolean metricsEnabled();

    @Override
    void close();
}
