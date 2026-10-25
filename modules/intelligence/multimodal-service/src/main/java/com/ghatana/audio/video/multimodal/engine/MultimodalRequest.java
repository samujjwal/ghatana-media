package com.ghatana.audio.video.multimodal.engine;

/**
 * Input request for multimodal analysis.
 * @doc.type class
 * @doc.purpose Provides multimodal request functionality.
 * @doc.layer product
 * @doc.pattern Component
 */
public final class MultimodalRequest {
    private static final int MAX_MODALITY_BYTES = 32 * 1024 * 1024;
    private static final int MAX_TOTAL_INPUT_BYTES = 64 * 1024 * 1024;
    private static final int MAX_TEXT_CHARS = 64 * 1024;

    private final byte[] audioData;
    private final byte[] imageData;
    private final byte[] videoData;
    private final String text;
    private final int videoSampleFps;
    private final int videoMaxFrames;

    private MultimodalRequest(Builder builder) {
        validateInput(builder.audioData, builder.imageData, builder.videoData, builder.text);
        this.audioData = copy(builder.audioData);
        this.imageData = copy(builder.imageData);
        this.videoData = copy(builder.videoData);
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
        return copy(audioData);
    }

    public byte[] getImageData() {
        return copy(imageData);
    }

    public byte[] getVideoData() {
        return copy(videoData);
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
            if (videoSampleFps < 0 || videoSampleFps > 60 || videoMaxFrames < 0 || videoMaxFrames > 100) {
                throw new IllegalArgumentException("Video sampling is outside configured limits");
            }
            return new MultimodalRequest(this);
        }
    }

    private static void validateInput(byte[] audio, byte[] image, byte[] video, String text) {
        long total = (long) length(audio) + length(image) + length(video);
        if (length(audio) > MAX_MODALITY_BYTES || length(image) > MAX_MODALITY_BYTES
                || length(video) > MAX_MODALITY_BYTES || total > MAX_TOTAL_INPUT_BYTES
                || text != null && text.length() > MAX_TEXT_CHARS) {
            throw new IllegalArgumentException("Multimodal input exceeds configured limits");
        }
    }

    private static int length(byte[] value) { return value == null ? 0 : value.length; }
    private static byte[] copy(byte[] value) { return value == null ? null : value.clone(); }
}
