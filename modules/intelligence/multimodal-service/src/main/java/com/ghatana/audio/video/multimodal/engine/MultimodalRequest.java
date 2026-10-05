package com.ghatana.audio.video.multimodal.engine;

/**
 * Input request for multimodal analysis.
 * @doc.type class
 * @doc.purpose Provides multimodal request functionality.
 * @doc.layer product
 * @doc.pattern Component
 */
public final class MultimodalRequest {

    private final byte[] audioData;
    private final byte[] imageData;
    private final byte[] videoData;
    private final String text;
    private final int videoSampleFps;
    private final int videoMaxFrames;

    private MultimodalRequest(Builder builder) {
        this.audioData = builder.audioData;
        this.imageData = builder.imageData;
        this.videoData = builder.videoData;
        this.text = builder.text;
        this.videoSampleFps = builder.videoSampleFps;
        this.videoMaxFrames = builder.videoMaxFrames;
    }

    public static Builder builder() {
        return new Builder();
    }

    public boolean hasAudio() {
        return audioData != null && audioData.length > 0;
    }

    public boolean hasImage() {
        return imageData != null && imageData.length > 0;
    }

    public boolean hasVideo() {
        return videoData != null && videoData.length > 0;
    }

    public byte[] getAudioData() {
        return audioData;
    }

    public byte[] getImageData() {
        return imageData;
    }

    public byte[] getVideoData() {
        return videoData;
    }

    public String getText() {
        return text != null ? text : "";
    }

    public int getVideoSampleFps() {
        return videoSampleFps > 0 ? videoSampleFps : 1;
    }

    public int getVideoMaxFrames() {
        return videoMaxFrames > 0 ? videoMaxFrames : 50;
    }

    public static class Builder {
        private byte[] audioData;
        private byte[] imageData;
        private byte[] videoData;
        private String text = "";
        private int videoSampleFps = 1;
        private int videoMaxFrames = 50;

        public Builder audioData(byte[] a) {
            this.audioData = a;
            return this;
        }

        public Builder imageData(byte[] i) {
            this.imageData = i;
            return this;
        }

        public Builder videoData(byte[] v) {
            this.videoData = v;
            return this;
        }

        public Builder text(String t) {
            this.text = t;
            return this;
        }

        public Builder videoSampleFps(int fps) {
            this.videoSampleFps = fps;
            return this;
        }

        public Builder videoMaxFrames(int max) {
            this.videoMaxFrames = max;
            return this;
        }

        public MultimodalRequest build() {
            return new MultimodalRequest(this);
        }
    }
}
