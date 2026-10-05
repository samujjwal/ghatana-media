/**
 * @doc.type adapter
 * @doc.purpose Native Coqui TTS adapter
 * @doc.layer platform
 * @doc.pattern Adapter
 *
 * <p>This adapter loads the native Coqui TTS shared library and provides
 * JNI bindings for high-performance local text-to-speech synthesis.
 *
 * <p>Requires:
 * <ul>
 *   <li>libcoqui_tts.so (Linux) / libcoqui_tts.dylib (macOS) / coqui_tts.dll (Windows)</li>
 *   <li>Vocoder and synthesizer model files</li>
 * </ul>
 */
package com.ghatana.media.tts.engine.native_coqui;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.*;
import com.ghatana.media.config.TtsConfig;
import com.ghatana.media.tts.api.*;
import io.activej.promise.Promise;

import java.io.File;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.logging.Logger;

/**
 * Native Coqui TTS adapter implementing TtsEngine.
 *
 * <p>Provides high-quality text-to-speech using the native Coqui TTS
 * library via JNI. Supports multiple voices and prosody control.
 */
public final class CoquiTtsAdapter implements TtsEngine {

    private static final Logger LOG = Logger.getLogger(CoquiTtsAdapter.class.getName());

    private static final String LIBRARY_NAME = "coqui_tts";
    private static final int DEFAULT_SAMPLE_RATE = 22050;

    private final TtsConfig config;
    private final long ttsContext; // Native context pointer
    private final Semaphore concurrencyLimiter;
    private final ExecutorService executor;
    private final AtomicLong requestCount = new AtomicLong(0);
    private final AtomicReference<String> activeVoiceId;
    private final AtomicReference<EngineStatus.State> state;

    static {
        try {
            System.loadLibrary(LIBRARY_NAME);
            LOG.info("Loaded native Coqui TTS library from system path");
        } catch (UnsatisfiedLinkError e) {
            loadNativeLibraryFromPath();
        }
    }

    private static void loadNativeLibraryFromPath() {
        String[] paths = {
            "native/libcoqui_tts.so",
            "native/libcoqui_tts.dylib",
            "native/coqui_tts.dll"
        };

        for (String path : paths) {
            File f = new File(path);
            if (f.exists()) {
                try {
                    System.load(f.getAbsolutePath());
                    LOG.info("Loaded Coqui TTS from: " + path);
                    return;
                } catch (UnsatisfiedLinkError e) {
                    LOG.warning("Failed to load " + path);
                }
            }
        }

        throw new UnsatisfiedLinkError("Could not load native Coqui TTS library");
    }

    public CoquiTtsAdapter(TtsConfig config, AudioVideoLibrary.LibraryState libraryState) throws ModelLoadingError {
        this.config = config;
        this.state = new AtomicReference<>(EngineStatus.State.INITIALIZING);
        this.activeVoiceId = new AtomicReference<>(config.defaultVoiceId());
        this.concurrencyLimiter = new Semaphore(config.maxConcurrentRequests());
        this.executor = Executors.newVirtualThreadPerTaskExecutor();

        try {
            LOG.info("Initializing Coqui TTS with model: " + config.voiceModelPath());

            String modelPath = config.voiceModelPath().toString();
            String configPath = modelPath.replace(".pth", ".json");

            this.ttsContext = coqui_tts_init(modelPath, configPath, config.sampleRate());

            if (this.ttsContext == 0) {
                throw new ModelLoadingError("Failed to initialize Coqui TTS");
            }

            LOG.info("Coqui TTS initialized successfully");
            state.set(EngineStatus.State.READY);

        } catch (Exception e) {
            state.set(EngineStatus.State.ERROR);
            throw new ModelLoadingError("Failed to load Coqui TTS", e);
        }
    }

    @Override
    public AudioData synthesize(String text, SynthesisOptions options) {
        ensureReady();
        validateText(text);

        requestCount.incrementAndGet();

        try {
            concurrencyLimiter.acquire();
            try {
                // Set voice if specified
                if (options.voiceId() != null && !options.voiceId().isEmpty()) {
                    coqui_tts_set_voice(ttsContext, options.voiceId());
                }

                // Set prosody parameters
                if (config.enableProsody()) {
                    coqui_tts_set_speed(ttsContext, (float) options.speed());
                    coqui_tts_set_pitch(ttsContext, (float) options.pitch());
                }

                // Synthesize
                float[] samples = coqui_tts_synthesize(ttsContext, text);

                if (samples == null || samples.length == 0) {
                    throw new InferenceError("Synthesis produced no output", null, false);
                }

                // Convert to bytes
                byte[] audioBytes = floatsToBytes(samples);

                return AudioData.builder()
                    .data(audioBytes)
                    .sampleRate(options.sampleRate() > 0 ? options.sampleRate() : config.sampleRate())
                    .channels(1)
                    .bitsPerSample(16)
                    .build();

            } finally {
                concurrencyLimiter.release();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new InferenceError("Synthesis interrupted", e, true);
        }
    }

    @Override
    public Promise<AudioData> synthesizeAsync(String text, SynthesisOptions options) {
        return Promise.ofBlocking(executor, () -> synthesize(text, options));
    }

    @Override
    public void synthesizeStreaming(String text, SynthesisOptions options, java.util.function.Consumer<com.ghatana.media.common.AudioChunk> chunkConsumer) {
        AudioData audio = synthesize(text, options);
        byte[] data = audio.data();

        int chunkSamples = config.sampleRate() / 10; // 100ms
        int chunkBytes = chunkSamples * 2;

        int sequence = 0;
        for (int i = 0; i < data.length; i += chunkBytes) {
            int end = Math.min(i + chunkBytes, data.length);
            byte[] chunk = Arrays.copyOfRange(data, i, end);

            chunkConsumer.accept(new AudioChunk(
                chunk,
                sequence++,
                end == data.length,
                System.currentTimeMillis()
            ));
        }
    }

    @Override
    public List<VoiceInfo> getAvailableVoices() {
        String[] voiceIds = coqui_tts_list_voices(ttsContext);

        if (voiceIds == null || voiceIds.length == 0) {
            return List.of(new VoiceInfo(
                config.defaultVoiceId(),
                "Default",
                "Default Coqui voice",
                Locale.ENGLISH,
                VoiceInfo.Gender.NEUTRAL,
                config.sampleRate(),
                false,
                0L,
                1.0f
            ));
        }

        return Arrays.stream(voiceIds)
            .map(v -> new VoiceInfo(v, v, v, Locale.ENGLISH, VoiceInfo.Gender.NEUTRAL, config.sampleRate(), false, 0L, 1.0f))
            .toList();
    }

    @Override
    public List<VoiceInfo> getAvailableVoices(Locale language) {
        return getAvailableVoices();
    }

    @Override
    public VoiceInfo loadVoice(String voiceId) {
        coqui_tts_set_voice(ttsContext, voiceId);
        activeVoiceId.set(voiceId);

        return new VoiceInfo(voiceId, voiceId, voiceId, Locale.ENGLISH, VoiceInfo.Gender.NEUTRAL, config.sampleRate(), false, 0L, 1.0f);
    }

    @Override
    public VoiceInfo getActiveVoice() {
        return loadVoice(activeVoiceId.get());
    }

    @Override
    public void setActiveVoice(String voiceId) {
        loadVoice(voiceId);
    }

    @Override
    public VoiceInfo cloneVoice(String voiceName, java.util.List<com.ghatana.media.common.AudioData> audioSamples, CloneOptions options) {
        if (!config.enableVoiceCloning()) {
            throw new UnsupportedOperationException("Voice cloning not enabled");
        }

        LOG.info("Cloning voice: " + voiceName);

        // Convert samples to native format
        float[][] nativeSamples = new float[audioSamples.size()][];
        for (int i = 0; i < audioSamples.size(); i++) {
            nativeSamples[i] = bytesToFloats(audioSamples.get(i).data(), audioSamples.get(i).bitsPerSample());
        }

        String clonedVoiceId = coqui_tts_clone_voice(ttsContext, voiceName, nativeSamples, options.epochs());

        return new VoiceInfo(
            clonedVoiceId,
            voiceName,
            "Cloned voice",
            Locale.ENGLISH,
            VoiceInfo.Gender.NEUTRAL,
            config.sampleRate(),
            true,
            0L,
            computeCloningSimilarityScore(audioSamples.size(), options.epochs())
        );
    }

    @Override
    public TtsProfile createProfile(String profileId, String displayName, ProfileSettings settings) {
        return new TtsProfile(profileId, displayName, activeVoiceId.get(), settings, List.of());
    }

    @Override
    public Optional<TtsProfile> loadProfile(String profileId) {
        return Optional.of(createProfile(profileId, "User", ProfileSettings.builder().build()));
    }

    @Override
    public void saveProfile(TtsProfile profile) {
        // Persist to storage
    }

    @Override
    public boolean deleteProfile(String profileId) {
        return true;
    }

    @Override
    public void warmup() {
        LOG.info("Warming up Coqui TTS...");
        try {
            synthesize("Hello", SynthesisOptions.defaults());
            LOG.info("Warmup complete");
        } catch (Exception e) {
            LOG.warning("Warmup failed: " + e.getMessage());
        }
    }

    @Override
    public void close() {
        LOG.info("Closing Coqui TTS adapter...");
        state.set(EngineStatus.State.CLOSED);

        if (ttsContext != 0) {
            coqui_tts_free(ttsContext);
        }

        executor.shutdown();
    }

    @Override
    public EngineStatus getStatus() {
        return new EngineStatus(state.get(), activeVoiceId.get(), "0.0.1", 0L, null);
    }

    @Override
    public EngineMetrics getMetrics() {
        return new EngineMetrics(requestCount.get(), 0L, 100.0, 0L, 0L);
    }

    // ====================================================================================
    // Private Implementation
    // ====================================================================================

    private void ensureReady() {
        if (state.get() != EngineStatus.State.READY) {
            throw new IllegalStateException("TTS engine not ready: " + state.get());
        }
    }

    private void validateText(String text) {
        if (text == null || text.isEmpty()) {
            throw new ValidationError("Text cannot be null or empty");
        }
        if (text.length() > config.maxTextLength()) {
            throw new ValidationError("Text too long: " + text.length());
        }
    }

    private float[] bytesToFloats(byte[] data, int bitsPerSample) {
        return AudioConverter.pcmToFloatSamples(data, bitsPerSample);
    }

    private byte[] floatsToBytes(float[] samples) {
        return AudioConverter.floatSamplesToPcm16(samples);
    }

    /**
     * Heuristic speaker-similarity score for a cloned voice.
     * Baseline 0.55; +0.05 per additional sample (beyond the first, capped +0.25);
     * +0.05 bonus for high-epoch training (≥ 200). Maximum 0.95.
     * A real ML-computed score replaces this once {@code coqui_tts_clone_voice}
     * returns a similarity metric from its speaker-encoder output.
     */
    private static float computeCloningSimilarityScore(int sampleCount, int epochs) {
        float base = 0.55f;
        float sampleBonus = Math.min(0.25f, Math.max(0, sampleCount - 1) * 0.05f);
        float epochBonus = epochs >= 200 ? 0.05f : 0.0f;
        return Math.min(0.95f, base + sampleBonus + epochBonus);
    }

    // ====================================================================================
    // Native Methods
    // ====================================================================================

    private static native long coqui_tts_init(String modelPath, String configPath, int sampleRate);
    private static native void coqui_tts_free(long ctx);
    private static native float[] coqui_tts_synthesize(long ctx, String text);
    private static native void coqui_tts_set_voice(long ctx, String voiceId);
    private static native void coqui_tts_set_speed(long ctx, float speed);
    private static native void coqui_tts_set_pitch(long ctx, float pitch);
    private static native String[] coqui_tts_list_voices(long ctx);
    private static native String coqui_tts_clone_voice(long ctx, String name, float[][] samples, int epochs);
}
