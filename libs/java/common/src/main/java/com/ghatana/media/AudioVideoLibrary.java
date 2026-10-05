package com.ghatana.media;

import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.capability.MediaCapabilityInventory;
import com.ghatana.media.config.SttConfig;
import com.ghatana.media.config.TtsConfig;
import com.ghatana.media.config.VisionConfig;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.stt.api.SttEngineFactory;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.media.tts.api.TtsEngineFactory;
import com.ghatana.media.vision.api.VisionEngine;
import com.ghatana.media.vision.api.VisionEngineFactory;
import io.activej.promise.Promise;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.util.Objects;
import java.util.EnumMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.logging.Logger;

/**
 * Unified embeddable Audio/Video library for STT, TTS, and Vision engines.
 *
 * <p>The library owns every cached engine. Getter methods return borrowed non-closing interface
 * views so HTTP/gRPC request handlers and try-with-resources callers cannot close the shared engine
 * after one request. Closing the library closes each underlying engine exactly once in reverse order.
 *
 * <pre>{@code
 * try (AudioVideoLibrary library = AudioVideoLibrary.builder()
 *         .withTtsConfig(ttsConfig)
 *         .build()) {
 *     TtsEngine tts = library.getTtsEngine();
 *     AudioData audio = tts.synthesize("Hello");
 * }
 * }</pre>
 *
 * @doc.type library-root
 * @doc.purpose Lifecycle-owning unified Audio/Video processing facade
 * @doc.layer platform
 * @doc.pattern Facade
 */
public final class AudioVideoLibrary implements AutoCloseable {

    private static final Logger LOG = Logger.getLogger(AudioVideoLibrary.class.getName());

    private final LibraryConfig config;
    private final LibraryState state = new LibraryState();
    private final AtomicBoolean closed = new AtomicBoolean();

    private volatile SttEngine ownedSttEngine;
    private volatile TtsEngine ownedTtsEngine;
    private volatile VisionEngine ownedVisionEngine;

    private volatile SttEngine borrowedSttEngine;
    private volatile TtsEngine borrowedTtsEngine;
    private volatile VisionEngine borrowedVisionEngine;

    private AudioVideoLibrary(LibraryConfig config) {
        this.config = Objects.requireNonNull(config, "config");
        LOG.info("AudioVideoLibrary initialized");
    }

    public static Builder builder() {
        return new Builder();
    }

    public SttEngine getSttEngine() {
        ensureNotClosed();
        if (config.sttConfig() == null) {
            throw new IllegalStateException("STT not configured. Use builder.withSttConfig()");
        }
        if (borrowedSttEngine == null) {
            synchronized (this) {
                if (borrowedSttEngine == null) {
                    ownedSttEngine = SttEngineFactory.create(config.sttConfig(), state);
                    borrowedSttEngine = borrowedView(SttEngine.class, ownedSttEngine);
                }
            }
        }
        return borrowedSttEngine;
    }

    public TtsEngine getTtsEngine() {
        ensureNotClosed();
        if (config.ttsConfig() == null) {
            throw new IllegalStateException("TTS not configured. Use builder.withTtsConfig()");
        }
        if (borrowedTtsEngine == null) {
            synchronized (this) {
                if (borrowedTtsEngine == null) {
                    ownedTtsEngine = TtsEngineFactory.create(config.ttsConfig(), state);
                    borrowedTtsEngine = borrowedView(TtsEngine.class, ownedTtsEngine);
                }
            }
        }
        return borrowedTtsEngine;
    }

    public VisionEngine getVisionEngine() {
        ensureNotClosed();
        if (config.visionConfig() == null) {
            throw new IllegalStateException("Vision not configured. Use builder.withVisionConfig()");
        }
        if (borrowedVisionEngine == null) {
            synchronized (this) {
                if (borrowedVisionEngine == null) {
                    ownedVisionEngine = VisionEngineFactory.create(config.visionConfig(), state);
                    borrowedVisionEngine = borrowedView(VisionEngine.class, ownedVisionEngine);
                }
            }
        }
        return borrowedVisionEngine;
    }

    public boolean isSttEnabled() {
        return config.sttConfig() != null;
    }

    public boolean isTtsEnabled() {
        return config.ttsConfig() != null;
    }

    public boolean isVisionEnabled() {
        return config.visionConfig() != null;
    }

    /**
     * Returns the conservative capability inventory for this composed library graph. Provider
     * optional capabilities are never advertised as runtime-supported until their provider
     * exposes a matching capability contract.
     */
    public MediaCapabilityInventory capabilityInventory() {
        EnumMap<MediaCapabilityInventory.Capability, MediaCapabilityInventory.Status> values =
                new EnumMap<>(MediaCapabilityInventory.Capability.class);
        values.put(MediaCapabilityInventory.Capability.STT,
                isSttEnabled()
                        ? MediaCapabilityInventory.Status.RUNTIME_SUPPORTED
                        : MediaCapabilityInventory.Status.PROVIDER_OPTIONAL);
        values.put(MediaCapabilityInventory.Capability.TTS,
                isTtsEnabled()
                        ? MediaCapabilityInventory.Status.RUNTIME_SUPPORTED
                        : MediaCapabilityInventory.Status.PROVIDER_OPTIONAL);
        values.put(MediaCapabilityInventory.Capability.OBJECT_DETECTION,
                isVisionEnabled()
                        ? MediaCapabilityInventory.Status.RUNTIME_SUPPORTED
                        : MediaCapabilityInventory.Status.PROVIDER_OPTIONAL);
        values.put(MediaCapabilityInventory.Capability.CLASSIFICATION,
                MediaCapabilityInventory.Status.PROVIDER_OPTIONAL);
        values.put(MediaCapabilityInventory.Capability.CAPTION,
                MediaCapabilityInventory.Status.NOT_IMPLEMENTED);
        values.put(MediaCapabilityInventory.Capability.SEGMENTATION,
                MediaCapabilityInventory.Status.NOT_IMPLEMENTED);
        values.put(MediaCapabilityInventory.Capability.TRACKING,
                MediaCapabilityInventory.Status.NOT_IMPLEMENTED);
        values.put(MediaCapabilityInventory.Capability.AUDIO,
                MediaCapabilityInventory.Status.LIBRARY_ONLY);
        values.put(MediaCapabilityInventory.Capability.VIDEO,
                MediaCapabilityInventory.Status.LIBRARY_ONLY);
        values.put(MediaCapabilityInventory.Capability.TRANSCODING,
                MediaCapabilityInventory.Status.LIBRARY_ONLY);
        values.put(MediaCapabilityInventory.Capability.MULTIMODAL,
                MediaCapabilityInventory.Status.PROVIDER_OPTIONAL);
        return new MediaCapabilityInventory(values);
    }

    public LibraryStatus getStatus() {
        return new LibraryStatus(
                state.isHealthy(),
                ownedSttEngine == null ? null : ownedSttEngine.getStatus(),
                ownedTtsEngine == null ? null : ownedTtsEngine.getStatus(),
                ownedVisionEngine == null ? null : ownedVisionEngine.getStatus(),
                state.getMetrics());
    }

    public Promise<LibraryStatus> initializeAsync() {
        ensureNotClosed();
        if (isSttEnabled()) getSttEngine().warmup();
        if (isTtsEnabled()) getTtsEngine().warmup();
        if (isVisionEnabled()) getVisionEngine().warmup();
        return Promise.of(getStatus());
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        LOG.info("Shutting down AudioVideoLibrary");
        closeOwned(ownedVisionEngine, "VisionEngine");
        closeOwned(ownedTtsEngine, "TtsEngine");
        closeOwned(ownedSttEngine, "SttEngine");
        borrowedVisionEngine = null;
        borrowedTtsEngine = null;
        borrowedSttEngine = null;
        state.shutdown();
    }

    private static void closeOwned(AutoCloseable resource, String name) {
        if (resource == null) return;
        try {
            resource.close();
        } catch (Exception exception) {
            LOG.warning("Error closing " + name + ": " + exception.getMessage());
        }
    }

    private void ensureNotClosed() {
        if (closed.get()) {
            throw new IllegalStateException("AudioVideoLibrary has been closed");
        }
    }

    @SuppressWarnings("unchecked")
    private static <T> T borrowedView(Class<T> contract, T ownedDelegate) {
        return (T) Proxy.newProxyInstance(
                contract.getClassLoader(),
                new Class<?>[] {contract},
                (proxy, method, args) -> {
                    if (method.getName().equals("close") && method.getParameterCount() == 0) {
                        return null;
                    }
                    try {
                        return method.invoke(ownedDelegate, args);
                    } catch (InvocationTargetException exception) {
                        throw exception.getCause();
                    }
                });
    }

    /** Builder for one library-owned engine graph. */
    public static final class Builder {
        private SttConfig sttConfig;
        private TtsConfig ttsConfig;
        private VisionConfig visionConfig;
        private boolean enableMetrics = true;
        private boolean enableTracing;

        private Builder() {}

        public Builder withSttConfig(SttConfig config) {
            this.sttConfig = Objects.requireNonNull(config, "config");
            return this;
        }

        public Builder withTtsConfig(TtsConfig config) {
            this.ttsConfig = Objects.requireNonNull(config, "config");
            return this;
        }

        public Builder withVisionConfig(VisionConfig config) {
            this.visionConfig = Objects.requireNonNull(config, "config");
            return this;
        }

        public Builder withMetrics(boolean enable) {
            this.enableMetrics = enable;
            return this;
        }

        public Builder withTracing(boolean enable) {
            this.enableTracing = enable;
            return this;
        }

        public AudioVideoLibrary build() {
            if (sttConfig == null && ttsConfig == null && visionConfig == null) {
                throw new IllegalStateException(
                        "At least one engine must be configured. Use withSttConfig(), "
                                + "withTtsConfig(), or withVisionConfig()");
            }
            return new AudioVideoLibrary(new LibraryConfig(
                    sttConfig,
                    ttsConfig,
                    visionConfig,
                    enableMetrics,
                    enableTracing));
        }
    }

    private record LibraryConfig(
            SttConfig sttConfig,
            TtsConfig ttsConfig,
            VisionConfig visionConfig,
            boolean enableMetrics,
            boolean enableTracing) {}

    /** Shared health/cache state for the owned engine graph. */
    public static final class LibraryState {
        private final ConcurrentHashMap<String, Object> sharedCache = new ConcurrentHashMap<>();
        private final AtomicBoolean healthy = new AtomicBoolean(true);
        private final AtomicReference<String> healthIssue = new AtomicReference<>();

        public void markUnhealthy(String reason) {
            healthy.set(false);
            healthIssue.set(reason == null ? "unspecified" : reason);
        }

        public boolean isHealthy() {
            return healthy.get();
        }

        public String healthIssue() {
            return healthIssue.get();
        }

        public LibraryMetrics getMetrics() {
            return new LibraryMetrics(
                    sharedCache.size(),
                    Runtime.getRuntime().freeMemory());
        }

        public void shutdown() {
            sharedCache.clear();
            healthIssue.set("closed");
            healthy.set(false);
        }
    }

    public record LibraryStatus(
            boolean healthy,
            EngineStatus sttStatus,
            EngineStatus ttsStatus,
            EngineStatus visionStatus,
            LibraryMetrics metrics) {}

    public record LibraryMetrics(int cacheEntries, long freeMemory) {}
}
