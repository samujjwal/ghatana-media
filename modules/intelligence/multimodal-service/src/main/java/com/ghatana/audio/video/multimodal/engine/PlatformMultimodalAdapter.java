package com.ghatana.audio.video.multimodal.engine;

import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.media.AudioVideoLibrary;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Objects;
import java.io.IOException;
import java.util.concurrent.CancellationException;

/**
 * @doc.type class
 * @doc.purpose Thin product adapter that delegates multimodal media processing to the platform library
 * @doc.layer product
 * @doc.pattern Adapter
 */
public final class PlatformMultimodalAdapter implements MultimodalMediaGateway {

    private static final Logger LOG = LoggerFactory.getLogger(PlatformMultimodalAdapter.class);

    private final AudioVideoRuntimeSettings settings;
    private final AudioVideoLibrary library;
    private final VideoFrameExtractor frameExtractor;
    private final SttClientAdapter sttClientAdapter;
    private final VisionClientAdapter visionClientAdapter;

    public PlatformMultimodalAdapter() {
        this(AudioVideoRuntimeSettings.load(), null, new VideoFrameExtractor(),
                audioData -> AudioResult.error("STT_PROVIDER_NOT_ADMITTED"),
                new VisionClientAdapter() {
                    @Override
                    public VisualResult detectObjects(byte[] imageData) {
                        return VisualResult.error("VISION_PROVIDER_NOT_ADMITTED");
                    }

                    @Override
                    public VisualResult analyseVideo(byte[] videoData, int sampleFps, int maxFrames) {
                        return VisualResult.error("VISION_PROVIDER_NOT_ADMITTED");
                    }
                });
    }

    PlatformMultimodalAdapter(
            AudioVideoRuntimeSettings settings,
            AudioVideoLibrary library,
            VideoFrameExtractor frameExtractor,
            SttClientAdapter sttClientAdapter) {
        this(settings, library, frameExtractor, sttClientAdapter,
                new PlatformVisionClientAdapter(
                        Objects.requireNonNull(library.getVisionEngine(), "public VisionEngine SPI unavailable"),
                        frameExtractor, settings));
    }

    PlatformMultimodalAdapter(
            AudioVideoRuntimeSettings settings,
            AudioVideoLibrary library,
            VideoFrameExtractor frameExtractor,
            SttClientAdapter sttClientAdapter,
            VisionClientAdapter visionClientAdapter) {
        this.settings = Objects.requireNonNull(settings, "settings");
        // A null library is reserved for the no-provider default composition above.
        // Qualified runtimes use the injected constructor and own a concrete library.
        this.library = library;
        this.frameExtractor = Objects.requireNonNull(frameExtractor, "frameExtractor");
        this.sttClientAdapter = Objects.requireNonNull(sttClientAdapter, "sttClientAdapter");
        this.visionClientAdapter = Objects.requireNonNull(visionClientAdapter, "visionClientAdapter");
    }

    @Override
    public AudioResult transcribe(byte[] audioData) {
        try {
            AudioResult result = sttClientAdapter.transcribe(audioData);
            if (result == null) {
                throw new IllegalStateException("STT provider returned no result");
            }
            return result;
        } catch (Exception e) {
            rethrowOutcomeSignal(e);
            throw new MultimodalException("Platform STT processing failed", e);
        }
    }

    @Override
    public VisualResult analyseImage(byte[] imageData) {
        try {
            VisualResult result = visionClientAdapter.detectObjects(imageData);
            if (result == null) throw new IllegalStateException("Vision provider returned no result");
            return result;
        } catch (Exception e) {
            rethrowOutcomeSignal(e);
            throw new MultimodalException("Platform vision processing failed", e);
        }
    }

    @Override
    public VisualResult analyseVideo(byte[] videoData, int sampleFps, int maxFrames) {
        int resolvedSampleFps = sampleFps > 0 ? sampleFps : settings.defaultVideoSampleFps();
        int resolvedMaxFrames = maxFrames > 0 ? maxFrames : settings.defaultVideoMaxFrames();
        try {
            VisualResult result = visionClientAdapter.analyseVideo(videoData, resolvedSampleFps, resolvedMaxFrames);
            if (result == null) throw new IllegalStateException("Vision provider returned no result");
            return result;
        } catch (Exception e) {
            rethrowOutcomeSignal(e);
            throw new MultimodalException("Platform video analysis failed", e);
        }
    }

    @Override
    public VideoFrameExtractor.ExtractedAudioTrack extractAudioTrack(byte[] videoData) throws IOException {
        return frameExtractor.extractAudioTrack(videoData);
    }

    /** Preserve child cancellation and deadline signals so callers can report uncertain finality. */
    private static void rethrowOutcomeSignal(Exception failure) {
        if (failure instanceof CancellationException cancellation) throw cancellation;
        if (failure instanceof io.grpc.StatusRuntimeException grpcFailure) {
            io.grpc.Status.Code code = grpcFailure.getStatus().getCode();
            if (code == io.grpc.Status.Code.CANCELLED || code == io.grpc.Status.Code.DEADLINE_EXCEEDED) {
                throw grpcFailure;
            }
        }
    }

    @Override
    public String backendName() {
        return library == null ? "not-admitted" : "platform-audio-video";
    }

    @Override
    public boolean metricsEnabled() {
        return settings.metricsEnabled();
    }

    @Override
    public void close() {
        if (sttClientAdapter instanceof AutoCloseable closeable) {
            try {
                closeable.close();
            } catch (Exception e) {
                LOG.debug("Failed to close STT adapter", e);
            }
        }
        if (library != null) {
            library.close();
        }
    }

}
