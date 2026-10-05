package com.ghatana.audio.video.multimodal.engine;

/**
 * Port for the Vision service — decouples the multimodal engine from the gRPC wire format.
  * @doc.type interface
 * @doc.purpose Provides vision client adapter functionality.
 * @doc.layer product
 * @doc.pattern Adapter
*/
public interface VisionClientAdapter {

    /**
     * Detect objects in a single image.
     *
     * @param imageData raw image bytes
     * @return visual result with detections and scene description
     */
    VisualResult detectObjects(byte[] imageData);

    /**
     * Analyse a video file: extract frames and run object detection on each.
     *
     * @param videoData  raw video bytes
     * @param sampleFps  frames per second to sample
     * @param maxFrames  maximum number of frames to analyse
     * @return visual result with per-frame detections
     */
    VisualResult analyseVideo(byte[] videoData, int sampleFps, int maxFrames);
}
