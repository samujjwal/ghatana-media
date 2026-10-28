/**
 * @doc.type implementation
 * @doc.purpose ONNX Runtime based Whisper STT Engine
 * @doc.layer platform
 * @doc.pattern Strategy
 */
package com.ghatana.media.stt.engine.onnx;

import ai.onnxruntime.*;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.*;
import com.ghatana.media.config.SttConfig;
import com.ghatana.media.stt.api.*;
import io.activej.promise.Promise;

import java.nio.FloatBuffer;
import java.nio.LongBuffer;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.Consumer;
import java.util.logging.Logger;

/**
 * ONNX Runtime based Whisper speech-to-text engine.
 *
 * <p>Uses Microsoft ONNX Runtime for cross-platform inference.
 * Supports GPU acceleration via CUDA/Metal/DirectML execution providers.
 */
public final class WhisperOnnxEngine implements SttEngine {

    private static final Logger LOG = Logger.getLogger(WhisperOnnxEngine.class.getName());
    private static final ConcurrentMap<Integer, float[]> HANN_WINDOW_CACHE = new ConcurrentHashMap<>();
    private static final ConcurrentMap<String, float[][]> MEL_FILTER_CACHE = new ConcurrentHashMap<>();

    // Model constants
    private static final int SAMPLE_RATE = 16000;
    private static final int N_MELS = 80;
    private static final int N_FFT = 400;
    private static final int HOP_LENGTH = 160;
    private static final int CHUNK_LENGTH = 30; // seconds
    private static final int N_SAMPLES = CHUNK_LENGTH * SAMPLE_RATE;
    private static final String REFERENCE_ENCODER = "encoder_model_quantized.onnx";
    private static final String REFERENCE_DECODER = "decoder_model_merged_quantized.onnx";
    private static final String REFERENCE_MEL_FILTERS = "mel_filters.npz";
    private static final long REFERENCE_ENCODER_BYTES = 10_124_990L;
    private static final String REFERENCE_ENCODER_SHA256 = "2af4a414ca47aa30f61246017e5fe82b0a8d229281d1255ba666a2a7f6b84d19";
    private static final long REFERENCE_DECODER_BYTES = 30_719_241L;
    private static final String REFERENCE_DECODER_SHA256 = "25e807a962b6349356d0ea5d0dfe530b7e5bf0e2a484aeca0359d03143faddd3";
    private static final int MAX_GENERATED_TOKENS = 444;
    private static final double[][] DFT_COS = referenceDftCos();
    private static final double[][] DFT_SIN = referenceDftSin();
    private static final double[] REFERENCE_HANN_WINDOW = referenceHannWindow();

    private final SttConfig config;
    private final OrtEnvironment environment;
    /** Single-graph compatibility path. The pinned Whisper reference uses the split sessions below. */
    private final OrtSession session;
    private final OrtSession encoderSession;
    private final OrtSession decoderSession;
    private final float[][] pinnedMelFilters;
    private final boolean splitWhisperProfile;
    private final WhisperTokenizer tokenizer;
    private final Semaphore concurrencyLimiter;
    private final ExecutorService executor;
    private final AtomicLong requestCount = new AtomicLong(0);
    private final AtomicLong errorCount = new AtomicLong(0);
    private final AtomicLong totalLatency = new AtomicLong(0);
    private final AtomicReference<EngineStatus.State> state;

    public WhisperOnnxEngine(SttConfig config, AudioVideoLibrary.LibraryState libraryState) throws ModelLoadingError {
        this.config = config;
        this.state = new AtomicReference<>(EngineStatus.State.INITIALIZING);
        this.concurrencyLimiter = new Semaphore(config.maxConcurrentRequests());
        this.executor = Executors.newVirtualThreadPerTaskExecutor();

        try {
            LOG.info("Loading Whisper ONNX model from: " + config.modelPath());

            this.environment = OrtEnvironment.getEnvironment();

            try (OrtSession.SessionOptions options = new OrtSession.SessionOptions()) {
                options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);

                // An explicit, bounded CPU tuning profile applies to both the encoder and
                // decoder sessions. The unset profile preserves ORT defaults; changing it
                // requires a measured same-model/same-source A/B result, not a guessed
                // global default. Request text/audio cannot alter this value.
                int intraOpThreads = WhisperOnnxThreadPolicy.intraOpThreads(
                        System.getenv(), Runtime.getRuntime().availableProcessors());
                if (intraOpThreads > 0) {
                    options.setIntraOpNumThreads(intraOpThreads);
                }
                LOG.info("Whisper ONNX CPU intra-op threads: "
                        + (intraOpThreads == 0 ? "ORT_DEFAULT_UNQUALIFIED" : intraOpThreads));

                // Configure GPU if enabled
                if (config.useGpu()) {
                    try {
                        options.addCUDA(0);
                        LOG.info("CUDA execution provider enabled");
                    } catch (OrtException e) {
                        LOG.warning("CUDA not available, falling back to CPU: " + e.getMessage());
                    }
                }

                boolean pinnedReference = config.modelPath() != null && config.modelPath().getFileName() != null
                        && REFERENCE_ENCODER.equals(config.modelPath().getFileName().toString());
                if (pinnedReference) {
                    this.tokenizer = WhisperTokenizer.loadPinnedTiktoken(
                            config.modelPath().toAbsolutePath().getParent().resolve("multilingual.tiktoken"));
                    Path profileDirectory = config.modelPath().toAbsolutePath().getParent();
                    Path decoderPath = profileDirectory.resolve(REFERENCE_DECODER);
                    Path melPath = profileDirectory.resolve(REFERENCE_MEL_FILTERS);
                    verifyPinnedAsset(config.modelPath(), REFERENCE_ENCODER_BYTES, REFERENCE_ENCODER_SHA256, "encoder");
                    verifyPinnedAsset(decoderPath, REFERENCE_DECODER_BYTES, REFERENCE_DECODER_SHA256, "decoder");
                    this.pinnedMelFilters = WhisperMelFilterBank.load(melPath);
                    this.encoderSession = environment.createSession(config.modelPath().toString(), options);
                    this.decoderSession = environment.createSession(decoderPath.toString(), options);
                    this.session = null;
                    this.splitWhisperProfile = true;
                    verifySplitSessionContract();
                    LOG.info("Pinned multilingual Whisper ONNX profile loaded. Encoder input: "
                            + encoderSession.getInputNames() + ", decoder inputs: " + decoderSession.getInputNames());
                } else {
                    this.tokenizer = WhisperTokenizer.load(config.modelPath());
                    this.session = environment.createSession(config.modelPath().toString(), options);
                    this.encoderSession = null;
                    this.decoderSession = null;
                    this.pinnedMelFilters = null;
                    this.splitWhisperProfile = false;
                    LOG.info("Whisper model loaded successfully. Input: " + session.getInputNames() +
                             ", Output: " + session.getOutputNames());
                }
            }

            state.set(EngineStatus.State.READY);

        } catch (OrtException e) {
            state.set(EngineStatus.State.ERROR);
            throw new ModelLoadingError("Failed to load Whisper ONNX model", e);
        } catch (java.io.IOException e) {
            state.set(EngineStatus.State.ERROR);
            throw new ModelLoadingError("Failed to verify pinned Whisper ONNX profile", e);
        }
    }

    @Override
    public TranscriptionResult transcribe(AudioData audio, TranscriptionOptions options) {
        ensureReady();
        validateAudio(audio);
        if (splitWhisperProfile && options.enableTimestamps()) {
            throw new ValidationError("Pinned Whisper reference profile does not provide qualified word timestamps");
        }

        long startTime = System.currentTimeMillis();
        requestCount.incrementAndGet();
        if (!concurrencyLimiter.tryAcquire()) {
            errorCount.incrementAndGet();
            throw new ResourceExhaustedError("Whisper request concurrency limit is saturated");
        }
        try {
            String text = runAudioInference(audio, options);

            long latency = System.currentTimeMillis() - startTime;
            totalLatency.addAndGet(latency);

            // This inference path does not expose provider word alignment. Do not
            // synthesize equal-duration words and present them as timing observations.
            List<WordTiming> words = List.of();

            return resultWithoutConfidence(
                text,
                words,
                List.of(), // alternatives
                java.time.Duration.ofMillis(latency),
                options.language().toLanguageTag(),
                config.modelId()
            );
        } catch (Exception e) {
            errorCount.incrementAndGet();
            throw new InferenceError("Transcription failed", e, false);
        } finally {
            concurrencyLimiter.release();
        }
    }

    static TranscriptionResult resultWithoutConfidence(String text, List<WordTiming> words,
            List<Alternative> alternatives, java.time.Duration processingTime, String language, String modelId) {
        return TranscriptionResult.withoutConfidence(
                text, words, alternatives, processingTime, language, modelId);
    }

    @Override
    public Promise<TranscriptionResult> transcribeAsync(AudioData audio, TranscriptionOptions options) {
        return Promise.ofBlocking(executor, () -> transcribe(audio, options));
    }

    @Override
    public StreamingSession createStreamingSession() {
        return createStreamingSession(null);
    }

    @Override
    public StreamingSession createStreamingSession(UserProfile profile) {
        ensureReady();
        return new WhisperStreamingSession(profile, config, this);
    }

    @Override
    public UserProfile createProfile(String profileId, java.util.List<com.ghatana.media.common.AudioData> enrollmentAudio) {
        // Fallback - would extract speaker embedding from enrollment audio
        return new UserProfile(
            profileId,
            "User " + profileId,
            Locale.getDefault(),
            List.of(),
            new byte[0]
        );
    }

    @Override
    public Optional<UserProfile> loadProfile(String profileId) {
        return Optional.of(createProfile(profileId, List.of()));
    }

    @Override
    public void saveProfile(UserProfile profile) {
        // Persist to storage
    }

    @Override
    public boolean deleteProfile(String profileId) {
        return true;
    }

    @Override
    public List<String> listProfiles() {
        return List.of();
    }

    @Override
    public List<ModelInfo> getAvailableModels() {
        return List.of(
            new ModelInfo("whisper-tiny", "Whisper Tiny", "1.0", new Locale[]{Locale.ENGLISH}, 39000000L, false),
            new ModelInfo("whisper-base", "Whisper Base", "1.0", new Locale[]{Locale.ENGLISH}, 74000000L, true),
            new ModelInfo("whisper-small", "Whisper Small", "1.0", new Locale[]{Locale.ENGLISH}, 244000000L, true),
            new ModelInfo("whisper-medium", "Whisper Medium", "1.0", new Locale[]{Locale.ENGLISH}, 769000000L, true),
            new ModelInfo("whisper-large", "Whisper Large", "1.0", new Locale[]{Locale.ENGLISH}, 1550000000L, true)
        );
    }

    @Override
    public void loadModel(String modelId) {
        // Model hot-swapping would be implemented here
        LOG.info("Model switching not yet implemented for: " + modelId);
    }

    @Override
    public ModelInfo getActiveModel() {
        return new ModelInfo(
            config.modelId(),
            config.modelId(),
            "1.0",
            new Locale[]{Locale.ENGLISH},
            0L,
            config.useGpu()
        );
    }

    @Override
    public void warmup() {
        LOG.info("Warming up Whisper engine...");
        try {
            // Run a dummy inference to warm up caches
            float[][] dummyInput = new float[3000][N_MELS];
            runInference(dummyInput, TranscriptionOptions.defaults());
            LOG.info("Warmup complete");
        } catch (Exception e) {
            LOG.warning("Warmup failed: " + e.getMessage());
        }
    }

    @Override
    public void close() {
        LOG.info("Closing Whisper ONNX engine...");
        state.set(EngineStatus.State.CLOSED);

        try {
            if (session != null) session.close();
            if (encoderSession != null) encoderSession.close();
            if (decoderSession != null) decoderSession.close();
            environment.close();
        } catch (OrtException e) {
            LOG.warning("Error closing ONNX session: " + e.getMessage());
        }

        executor.shutdown();
    }

    @Override
    public EngineStatus getStatus() {
        return new EngineStatus(
            state.get(),
            config.modelId(),
            "0.0.1",
            0L,
            null
        );
    }

    @Override
    public EngineMetrics getMetrics() {
        long requests = requestCount.get();
        long errors = errorCount.get();
        long avgLatency = requests > 0 ? totalLatency.get() / requests : 0;

        return new EngineMetrics(
            requests,
            errors,
            avgLatency,
            config.maxConcurrentRequests() - concurrencyLimiter.availablePermits(),
            0L
        );
    }

    // ====================================================================================
    // Private Implementation
    // ====================================================================================

    private void ensureReady() {
        if (state.get() != EngineStatus.State.READY) {
            throw new IllegalStateException("Whisper engine not ready. State: " + state.get());
        }
    }

    private void validateAudio(AudioData audio) {
        if (audio == null) {
            throw new ValidationError("Audio data cannot be null");
        }
        if (audio.data() == null || audio.data().length == 0) {
            throw new ValidationError("Audio data cannot be empty");
        }
        if (audio.sampleRate() != SAMPLE_RATE) {
            throw new ValidationError("Audio must be 16kHz, got: " + audio.sampleRate());
        }
        if (audio.channels() != 1) {
            throw new ValidationError("Whisper ONNX requires mono audio, got: " + audio.channels() + " channels");
        }
        if (audio.bitsPerSample() != 16 || audio.data().length % Short.BYTES != 0) {
            throw new ValidationError("Whisper ONNX requires complete signed 16-bit PCM samples");
        }
        if (audio.duration() != null && audio.duration().getSeconds() > config.maxAudioLengthSeconds()) {
            throw new ValidationError("Audio too long: " + audio.duration().getSeconds() + "s > " + config.maxAudioLengthSeconds() + "s");
        }
        long maximumSamples = (long) config.maxAudioLengthSeconds() * SAMPLE_RATE;
        long samples = audio.data().length / Math.max(1, audio.bitsPerSample() / 8);
        if (samples > maximumSamples) {
            throw new ValidationError("Audio exceeds configured maximum duration of "
                    + config.maxAudioLengthSeconds() + " seconds");
        }
    }

    /**
     * Preprocess audio to mel spectrogram.
     */
    private float[][] preprocess(AudioData audio) {
        // Convert bytes to float samples
        float[] samples = bytesToFloats(audio.data(), audio.bitsPerSample());

        // Pad or trim to N_SAMPLES
        if (samples.length > N_SAMPLES) {
            samples = Arrays.copyOf(samples, N_SAMPLES);
        } else if (samples.length < N_SAMPLES) {
            samples = Arrays.copyOf(samples, N_SAMPLES); // Zero-pad
        }

        if (splitWhisperProfile) return computeReferenceMelSpectrogram(samples, pinnedMelFilters);
        // Compute mel spectrogram for the legacy single-graph compatibility profile.
        return computeMelSpectrogram(samples, SAMPLE_RATE, N_MELS, N_FFT, HOP_LENGTH);
    }

    private String runAudioInference(AudioData audio, TranscriptionOptions options) throws OrtException {
        float[] samples = bytesToFloats(audio.data(), audio.bitsPerSample());
        if (isExactlySilent(samples)) return "";
        if (!splitWhisperProfile) return runInference(preprocess(audio), options);

        StringBuilder result = new StringBuilder();
        for (int offset = 0; offset < samples.length; offset += N_SAMPLES) {
            int length = Math.min(N_SAMPLES, samples.length - offset);
            float[] chunk = Arrays.copyOfRange(samples, offset, offset + length);
            if (isExactlySilent(chunk)) continue;
            float[][] melSpectrogram = computeReferenceMelSpectrogram(chunk, pinnedMelFilters);
            String chunkText = runSplitWhisperInference(melSpectrogram, options);
            if (!chunkText.isBlank()) {
                if (!result.isEmpty()) result.append(' ');
                result.append(chunkText.trim());
            }
        }
        return result.toString();
    }

    private static boolean isExactlySilent(float[] values) {
        for (float value : values) if (value != 0.0f) return false;
        return true;
    }

    private float[] bytesToFloats(byte[] data, int bitsPerSample) {
        return AudioConverter.pcmToFloatSamples(data, bitsPerSample);
    }

    private float[][] computeMelSpectrogram(float[] samples, int sampleRate, int nMels, int nFft, int hopLength) {
        int nFrames = (samples.length - nFft) / hopLength + 1;
        if (nFrames <= 0) {
            nFrames = 1;
        }

        // Pre-compute Hann window
        float[] hannWindow = HANN_WINDOW_CACHE.computeIfAbsent(nFft, WhisperOnnxEngine::computeHannWindow);

        // Pre-compute mel filterbank [nMels x (nFft/2 + 1)]
        String melCacheKey = sampleRate + ":" + nFft + ":" + nMels;
        float[][] melFilters = MEL_FILTER_CACHE.computeIfAbsent(
            melCacheKey,
            ignored -> computeMelFilterbank(sampleRate, nFft, nMels)
        );

        float[][] logMelSpec = new float[nFrames][nMels];

        for (int frame = 0; frame < nFrames; frame++) {
            int start = frame * hopLength;

            // Extract and window the frame
            float[] windowed = new float[nFft];
            for (int i = 0; i < nFft; i++) {
                int sampleIdx = start + i;
                float s = (sampleIdx < samples.length) ? samples[sampleIdx] : 0f;
                windowed[i] = s * hannWindow[i];
            }

            // FFT magnitude spectrum
            float[] magnitude = computeMagnitudeSpectrum(windowed, nFft);

            // Apply mel filterbank (sum power per mel band)
            for (int m = 0; m < nMels; m++) {
                float energy = 0f;
                for (int k = 0; k < magnitude.length; k++) {
                    energy += melFilters[m][k] * magnitude[k] * magnitude[k];
                }
                // Log compression with stability floor (matches Whisper's log10 + 4 offset)
                logMelSpec[frame][m] = Math.max((float) Math.log10(Math.max(energy, 1e-10f)), -10f);
            }
        }

        // Normalise: bring max to 0, then clip at -8 and scale to [-1, 1]
        float maxVal = Float.NEGATIVE_INFINITY;
        for (float[] row : logMelSpec) {
            for (float v : row) {
                if (v > maxVal) maxVal = v;
            }
        }
        if (maxVal != Float.NEGATIVE_INFINITY) {
            for (float[] row : logMelSpec) {
                for (int j = 0; j < row.length; j++) {
                    row[j] = (Math.max(row[j], maxVal - 8f) + 4f) / 4f;
                }
            }
        }

        return logMelSpec;
    }

    /**
     * Reproduces the pinned OpenAI Whisper frontend: 30 second input, centered 400 point periodic-Hann
     * STFT, power spectrum, the source mel matrix, log10 floor, dynamic range clipping and scaling.
     */
    static float[][] computeReferenceMelSpectrogram(float[] input, float[][] filters) {
        if (input == null || filters == null || filters.length != N_MELS) {
            throw new IllegalArgumentException("Whisper frontend requires audio and the pinned 80-band filter bank");
        }
        for (float[] filter : filters) {
            if (filter == null || filter.length != N_FFT / 2 + 1) {
                throw new IllegalArgumentException("Whisper mel filter bank dimensions are invalid");
            }
        }

        float[] samples = Arrays.copyOf(input, N_SAMPLES);
        for (float sample : samples) {
            if (!Float.isFinite(sample) || Math.abs(sample) > 1.0f) {
                throw new IllegalArgumentException("Whisper frontend samples must be finite and normalized to [-1,1]");
            }
        }
        float[][] logMel = new float[N_SAMPLES / HOP_LENGTH][N_MELS];
        for (float[] row : logMel) Arrays.fill(row, -10.0f);

        int framesWithInput = Math.min(logMel.length,
                Math.max(1, (samples.length + N_FFT / 2 + HOP_LENGTH - 1) / HOP_LENGTH));
        double[] power = new double[N_FFT / 2 + 1];
        for (int frame = 0; frame < framesWithInput; frame++) {
            int frameStart = frame * HOP_LENGTH - N_FFT / 2;
            Arrays.fill(power, 0.0d);
            for (int bin = 0; bin < power.length; bin++) {
                double real = 0.0d;
                double imaginary = 0.0d;
                for (int sample = 0; sample < N_FFT; sample++) {
                    int sampleIndex = reflectIndex(frameStart + sample, N_SAMPLES);
                    double value = samples[sampleIndex] * REFERENCE_HANN_WINDOW[sample];
                    real += value * DFT_COS[bin][sample];
                    imaginary += value * DFT_SIN[bin][sample];
                }
                power[bin] = real * real + imaginary * imaginary;
            }
            for (int mel = 0; mel < N_MELS; mel++) {
                double energy = 0.0d;
                for (int bin = 0; bin < power.length; bin++) energy += filters[mel][bin] * power[bin];
                logMel[frame][mel] = (float) Math.log10(Math.max(energy, 1.0e-10d));
            }
        }

        float maximum = -10.0f;
        for (float[] row : logMel) {
            for (float value : row) maximum = Math.max(maximum, value);
        }
        float floor = maximum - 8.0f;
        for (float[] row : logMel) {
            for (int mel = 0; mel < row.length; mel++) {
                row[mel] = (Math.max(row[mel], floor) + 4.0f) / 4.0f;
            }
        }
        return logMel;
    }

    private static int reflectIndex(int index, int length) {
        if (length < 2) return 0;
        int reflected = index;
        while (reflected < 0 || reflected >= length) {
            if (reflected < 0) reflected = -reflected;
            if (reflected >= length) reflected = 2 * length - 2 - reflected;
        }
        return reflected;
    }

    private static double[][] referenceDftCos() {
        double[][] values = new double[N_FFT / 2 + 1][N_FFT];
        for (int bin = 0; bin < values.length; bin++) {
            for (int sample = 0; sample < N_FFT; sample++) {
                values[bin][sample] = Math.cos(2.0d * Math.PI * bin * sample / N_FFT);
            }
        }
        return values;
    }

    private static double[][] referenceDftSin() {
        double[][] values = new double[N_FFT / 2 + 1][N_FFT];
        for (int bin = 0; bin < values.length; bin++) {
            for (int sample = 0; sample < N_FFT; sample++) {
                values[bin][sample] = -Math.sin(2.0d * Math.PI * bin * sample / N_FFT);
            }
        }
        return values;
    }

    private static double[] referenceHannWindow() {
        double[] values = new double[N_FFT];
        for (int sample = 0; sample < N_FFT; sample++) {
            values[sample] = 0.5d * (1.0d - Math.cos(2.0d * Math.PI * sample / N_FFT));
        }
        return values;
    }

    private void verifySplitSessionContract() throws OrtException {
        if (!encoderSession.getInputNames().contains("input_features")
                || !encoderSession.getOutputNames().contains("last_hidden_state")
                || !decoderSession.getInputNames().contains("input_ids")
                || !decoderSession.getInputNames().contains("encoder_hidden_states")
                || !decoderSession.getInputNames().contains("use_cache_branch")
                || !decoderSession.getOutputNames().contains("logits")) {
            throw new ModelLoadingError("Pinned Whisper ONNX graphs do not expose the expected encoder/decoder interface");
        }
        verifyTensorContract(encoderSession.getInputInfo(), "input_features", OnnxJavaType.FLOAT,
                new long[]{1, N_MELS, N_SAMPLES / HOP_LENGTH});
        verifyTensorContract(encoderSession.getOutputInfo(), "last_hidden_state", OnnxJavaType.FLOAT,
                new long[]{1, 1_500, 384});
        verifyTensorContract(decoderSession.getInputInfo(), "input_ids", OnnxJavaType.INT64,
                new long[]{1, -1});
        verifyTensorContract(decoderSession.getInputInfo(), "encoder_hidden_states", OnnxJavaType.FLOAT,
                new long[]{1, 1_500, 384});
        verifyTensorContract(decoderSession.getInputInfo(), "use_cache_branch", OnnxJavaType.BOOL,
                new long[]{1});
        verifyTensorContract(decoderSession.getOutputInfo(), "logits", OnnxJavaType.FLOAT,
                new long[]{1, -1, 51_865});
        for (int layer = 0; layer < 4; layer++) {
            for (String attention : List.of("decoder", "encoder")) {
                for (String dimension : List.of("key", "value")) {
                    String suffix = layer + "." + attention + "." + dimension;
                    String input = "past_key_values." + suffix;
                    String output = "present." + suffix;
                    if (!decoderSession.getInputNames().contains(input)
                            || !decoderSession.getOutputNames().contains(output)) {
                        throw new ModelLoadingError("Pinned Whisper decoder cache interface is incomplete");
                    }
                    verifyTensorContract(decoderSession.getInputInfo(), input, OnnxJavaType.FLOAT,
                            new long[]{1, 6, -1, 64});
                    verifyTensorContract(decoderSession.getOutputInfo(), output, OnnxJavaType.FLOAT,
                            new long[]{1, 6, -1, 64});
                }
            }
        }
    }

    private static void verifyTensorContract(
            Map<String, NodeInfo> nodes, String name, OnnxJavaType expectedType, long[] expectedShape) {
        NodeInfo node = nodes.get(name);
        if (node == null || !(node.getInfo() instanceof TensorInfo tensor)) {
            throw new ModelLoadingError("Pinned Whisper ONNX graph omitted tensor metadata for " + name);
        }
        if (tensor.type != expectedType) {
            throw new ModelLoadingError("Pinned Whisper ONNX tensor " + name + " has an unexpected element type");
        }
        long[] actualShape = tensor.getShape();
        if (actualShape.length != expectedShape.length) {
            throw new ModelLoadingError("Pinned Whisper ONNX tensor " + name + " has an unexpected rank");
        }
        for (int axis = 0; axis < expectedShape.length; axis++) {
            long expected = expectedShape[axis];
            long actual = actualShape[axis];
            if (expected >= 0 && actual >= 0 && expected != actual) {
                throw new ModelLoadingError("Pinned Whisper ONNX tensor " + name + " has an unexpected shape");
            }
        }
    }

    private static void verifyPinnedAsset(Path path, long expectedSize, String expectedSha256, String label)
            throws java.io.IOException {
        if (path == null || Files.isSymbolicLink(path)
                || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)
                || Files.size(path) != expectedSize) {
            throw new ModelLoadingError("Pinned Whisper " + label + " asset is missing or has an unexpected size");
        }
        final MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("JDK does not provide SHA-256", impossible);
        }
        long readBytes = 0;
        try (java.io.InputStream input = Files.newInputStream(path, LinkOption.NOFOLLOW_LINKS)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                readBytes += read;
                if (readBytes > expectedSize) {
                    throw new ModelLoadingError("Pinned Whisper " + label + " asset changed while reading");
                }
                digest.update(buffer, 0, read);
            }
        }
        String actual = HexFormat.of().formatHex(digest.digest());
        if (readBytes != expectedSize || !expectedSha256.equals(actual)) {
            throw new ModelLoadingError("Pinned Whisper " + label + " asset SHA-256 does not match the qualification pin");
        }
    }

    /** Compute a Hann window of length {@code n}. */
    private static float[] computeHannWindow(int n) {
        float[] w = new float[n];
        for (int i = 0; i < n; i++) {
            w[i] = 0.5f * (1f - (float) Math.cos(2.0 * Math.PI * i / (n - 1)));
        }
        return w;
    }

    /**
     * Compute the one-sided magnitude spectrum (|FFT|) of a windowed frame.
     * Uses a radix-2 Cooley-Tukey FFT with zero-padding to the next power of 2.
     */
    private static float[] computeMagnitudeSpectrum(float[] windowed, int nFft) {
        // Zero-pad to next power of two
        int fftSize = Integer.highestOneBit(nFft);
        if (fftSize < nFft) fftSize <<= 1;

        double[] real = new double[fftSize];
        double[] imag = new double[fftSize];
        for (int i = 0; i < windowed.length; i++) {
            real[i] = windowed[i];
        }

        fftInPlace(real, imag, fftSize);

        // One-sided spectrum (0 … nFft/2 inclusive)
        int bins = nFft / 2 + 1;
        float[] mag = new float[bins];
        for (int k = 0; k < bins; k++) {
            mag[k] = (float) Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
        }
        return mag;
    }

    /** In-place radix-2 DIT FFT. {@code n} must be a power of 2. */
    private static void fftInPlace(double[] re, double[] im, int n) {
        // Bit-reversal permutation
        for (int i = 1, j = 0; i < n; i++) {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) {
                j ^= bit;
            }
            j ^= bit;
            if (i < j) {
                double tmp = re[i]; re[i] = re[j]; re[j] = tmp;
                tmp       = im[i]; im[i] = im[j]; im[j] = tmp;
            }
        }
        // Butterfly computation
        for (int len = 2; len <= n; len <<= 1) {
            double angle = -2.0 * Math.PI / len;
            double wRe = Math.cos(angle);
            double wIm = Math.sin(angle);
            for (int i = 0; i < n; i += len) {
                double curRe = 1.0, curIm = 0.0;
                for (int j = 0; j < len / 2; j++) {
                    double uRe = re[i + j];
                    double uIm = im[i + j];
                    double vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
                    double vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
                    re[i + j] = uRe + vRe;
                    im[i + j] = uIm + vIm;
                    re[i + j + len / 2] = uRe - vRe;
                    im[i + j + len / 2] = uIm - vIm;
                    double nextCurRe = curRe * wRe - curIm * wIm;
                    curIm = curRe * wIm + curIm * wRe;
                    curRe = nextCurRe;
                }
            }
        }
    }

    /**
     * Compute a mel filterbank matrix of shape {@code [nMels x (nFft/2 + 1)]}.
     * Uses the HTK mel scale: mel = 2595 * log10(1 + hz/700).
     */
    private static float[][] computeMelFilterbank(int sampleRate, int nFft, int nMels) {
        int bins = nFft / 2 + 1;
        float fMin = 0f;
        float fMax = sampleRate / 2f;

        double melMin = hzToMel(fMin);
        double melMax = hzToMel(fMax);

        // nMels + 2 equally-spaced mel points
        double[] melPoints = new double[nMels + 2];
        for (int i = 0; i < melPoints.length; i++) {
            melPoints[i] = melMin + (melMax - melMin) * i / (nMels + 1);
        }

        // Convert mel points to Hz, then to FFT bin indices
        double[] hzPoints = new double[melPoints.length];
        for (int i = 0; i < melPoints.length; i++) {
            hzPoints[i] = melToHz(melPoints[i]);
        }

        int[] binIndices = new int[melPoints.length];
        for (int i = 0; i < melPoints.length; i++) {
            binIndices[i] = (int) Math.floor((nFft + 1) * hzPoints[i] / sampleRate);
            binIndices[i] = Math.max(0, Math.min(bins - 1, binIndices[i]));
        }

        float[][] filters = new float[nMels][bins];
        for (int m = 0; m < nMels; m++) {
            int left   = binIndices[m];
            int center = binIndices[m + 1];
            int right  = binIndices[m + 2];

            for (int k = left; k < center; k++) {
                if (center != left) {
                    filters[m][k] = (float) (k - left) / (center - left);
                }
            }
            for (int k = center; k < right; k++) {
                if (right != center) {
                    filters[m][k] = (float) (right - k) / (right - center);
                }
            }
        }
        return filters;
    }

    private static double hzToMel(double hz) {
        return 2595.0 * Math.log10(1.0 + hz / 700.0);
    }

    private static double melToHz(double mel) {
        return 700.0 * (Math.pow(10.0, mel / 2595.0) - 1.0);
    }

    /**
     * Run ONNX inference.
     *
     * <p>The Whisper ONNX export consumed here follows the standard single-pass
     * encoder–decoder topology where:
     * <ul>
     *   <li>Input:  {@code "input_features"} — float32[1, N_MELS, T]</li>
     *   <li>Output: {@code "output_ids"} or {@code "sequences"} — int64[1, S]
     *               token IDs decoded by a greedy strategy.</li>
     * </ul>
     *
     * <p>Token IDs are decoded with the vocab.json/merges.txt profile adjacent
     * to the configured model. A missing profile is a model-loading failure.
     */
    private String runInference(float[][] melSpectrogram, TranscriptionOptions options) throws OrtException {
        if (splitWhisperProfile) return runSplitWhisperInference(melSpectrogram, options);
        int nFrames = melSpectrogram.length;

        // Flatten [nFrames × N_MELS] → float[1 × N_MELS × nFrames] (batch=1)
        float[] flatInput = new float[N_MELS * nFrames];
        for (int mel = 0; mel < N_MELS; mel++) {
            for (int t = 0; t < nFrames; t++) {
                flatInput[mel * nFrames + t] = melSpectrogram[t][mel];
            }
        }

        String inputName = session.getInputNames().iterator().next();
        OnnxTensor inputTensor = OnnxTensor.createTensor(
            environment,
            FloatBuffer.wrap(flatInput),
            new long[]{1L, N_MELS, nFrames}
        );

        Map<String, OnnxTensor> inputs = new HashMap<>();
        inputs.put(inputName, inputTensor);

        try (OrtSession.Result results = session.run(inputs)) {
            // Locate the first scalar-text or sequence output
            for (Map.Entry<String, OnnxValue> entry : results) {
                OnnxValue value = entry.getValue();
                if (value.getType() == OnnxValue.OnnxValueType.ONNX_TYPE_TENSOR) {
                    OnnxTensor outTensor = (OnnxTensor) value;
                    TensorInfo info = outTensor.getInfo();

                    // String tensor: decoder has already detokenised
                    if (info.type == OnnxJavaType.STRING) {
                        Object raw = outTensor.getValue();
                        if (raw instanceof String[][] arr && arr.length > 0 && arr[0].length > 0) {
                            return arr[0][0].trim();
                        }
                        if (raw instanceof String[] arr && arr.length > 0) {
                            return arr[0].trim();
                        }
                    }

                    // Integer / long token-ID tensor: perform greedy decoding
                    if (info.type == OnnxJavaType.INT64 || info.type == OnnxJavaType.INT32) {
                        return decodeTokenIds(outTensor);
                    }
                }
            }
        } finally {
            inputTensor.close();
        }

        return "";
    }

    private String runSplitWhisperInference(float[][] melSpectrogram, TranscriptionOptions options)
            throws OrtException {
        int frames = melSpectrogram.length;
        float[] flatInput = new float[N_MELS * frames];
        for (int mel = 0; mel < N_MELS; mel++) {
            for (int frame = 0; frame < frames; frame++) flatInput[mel * frames + frame] = melSpectrogram[frame][mel];
        }
        OnnxTensor features = OnnxTensor.createTensor(environment, FloatBuffer.wrap(flatInput),
                new long[]{1L, N_MELS, frames});
        try (OrtSession.Result encoded = encoderSession.run(Map.of("input_features", features))) {
            OnnxTensor hiddenStates = findTensor(encoded, "last_hidden_state");
            long[] decoderIds = WhisperTokenizer.transcriptionPrompt(options.language());
            long[] generated = new long[MAX_GENERATED_TOKENS];
            int generatedCount = 0;
            double sumLogProbability = 0.0d;
            double noSpeechProbability = Double.NaN;
            boolean useCache = false;
            OrtSession.Result priorDecoderResult = null;
            try {
                for (int step = 0; step < MAX_GENERATED_TOKENS; step++) {
                    Map<String, OnnxTensor> inputs = new HashMap<>();
                    List<OnnxTensor> temporary = new ArrayList<>();
                    OnnxTensor tokenTensor = OnnxTensor.createTensor(environment, LongBuffer.wrap(decoderIds),
                            new long[]{1L, decoderIds.length});
                    ByteBuffer cacheBranchValue = ByteBuffer.allocateDirect(1);
                    cacheBranchValue.put((byte) (useCache ? 1 : 0)).flip();
                    OnnxTensor cacheBranch = OnnxTensor.createTensor(environment,
                            cacheBranchValue, new long[]{1L}, OnnxJavaType.BOOL);
                    temporary.add(tokenTensor);
                    temporary.add(cacheBranch);
                    inputs.put("input_ids", tokenTensor);
                    inputs.put("encoder_hidden_states", hiddenStates);
                    inputs.put("use_cache_branch", cacheBranch);
                    for (String inputName : decoderSession.getInputNames()) {
                        if (!inputName.startsWith("past_key_values.")) continue;
                        String outputName = inputName.replaceFirst("^past_key_values\\.", "present.");
                        if (priorDecoderResult == null) {
                            OnnxTensor emptyCache = OnnxTensor.createTensor(environment, FloatBuffer.allocate(0),
                                    new long[]{1L, 6L, 0L, 64L});
                            temporary.add(emptyCache);
                            inputs.put(inputName, emptyCache);
                        } else {
                            inputs.put(inputName, findTensor(priorDecoderResult, outputName));
                        }
                    }

                    OrtSession.Result current = null;
                    try {
                        current = decoderSession.run(inputs);
                    } finally {
                        for (OnnxTensor tensor : temporary) tensor.close();
                    }
                    DecoderStep decoderStep;
                    try {
                        decoderStep = selectDecoderStep(findTensor(current, "logits"), step == 0);
                    } catch (RuntimeException | OrtException failure) {
                        current.close();
                        throw failure;
                    }
                    if (step == 0) noSpeechProbability = decoderStep.noSpeechProbability();
                    sumLogProbability += decoderStep.logProbability();
                    long nextToken = decoderStep.tokenId();
                    if (nextToken == WhisperTokenizer.endOfTextToken()) {
                        current.close();
                        return finishDecodedTranscript(generated, generatedCount, sumLogProbability, noSpeechProbability);
                    }
                    generated[generatedCount++] = nextToken;
                    if (priorDecoderResult != null) priorDecoderResult.close();
                    priorDecoderResult = current;
                    decoderIds = new long[]{nextToken};
                    useCache = true;
                }
                return finishDecodedTranscript(generated, generatedCount, sumLogProbability, noSpeechProbability);
            } finally {
                if (priorDecoderResult != null) priorDecoderResult.close();
            }
        } finally {
            features.close();
        }
    }

    private static OnnxTensor findTensor(OrtSession.Result result, String name) throws OrtException {
        for (Map.Entry<String, OnnxValue> entry : result) {
            if (name.equals(entry.getKey()) && entry.getValue() instanceof OnnxTensor tensor) return tensor;
        }
        throw new IllegalArgumentException("Whisper ONNX graph omitted required tensor: " + name);
    }

    private String finishDecodedTranscript(long[] generated, int generatedCount,
            double sumLogProbability, double noSpeechProbability) {
        double averageLogProbability = sumLogProbability / (generatedCount + 1.0d);
        if (shouldSuppressAsNoSpeech(noSpeechProbability, averageLogProbability)) return "";
        return tokenizer.decode(Arrays.copyOf(generated, generatedCount));
    }

    static boolean shouldSuppressAsNoSpeech(double noSpeechProbability, double averageLogProbability) {
        return Double.isFinite(noSpeechProbability) && noSpeechProbability > 0.6d
                && Double.isFinite(averageLogProbability) && averageLogProbability < -1.0d;
    }

    private static DecoderStep selectDecoderStep(OnnxTensor logits, boolean firstGeneratedToken) throws OrtException {
        if (logits.getInfo().type != OnnxJavaType.FLOAT) {
            throw new IllegalArgumentException("Whisper decoder logits must be float32");
        }
        Object value = logits.getValue();
        if (value instanceof float[][][] batch) {
            return selectDecoderStep(batch, firstGeneratedToken);
        } else if (value instanceof float[][] rows) {
            return selectDecoderStep(rows, firstGeneratedToken);
        }
        throw new IllegalArgumentException("Whisper decoder logits have an unsupported shape");
    }

    static DecoderStep selectDecoderStep(float[][][] batch, boolean firstGeneratedToken) {
        if (batch == null || batch.length != 1 || batch[0] == null || batch[0].length == 0) {
            throw new IllegalArgumentException("Whisper decoder logits must have a non-empty single-item batch");
        }
        return selectDecoderStep(batch[0][batch[0].length - 1], firstGeneratedToken);
    }

    static DecoderStep selectDecoderStep(float[][] rows, boolean firstGeneratedToken) {
        if (rows == null || rows.length == 0) {
            throw new IllegalArgumentException("Whisper decoder logits must contain at least one token position");
        }
        return selectDecoderStep(rows[rows.length - 1], firstGeneratedToken);
    }

    static DecoderStep selectDecoderStep(float[] tokenScores, boolean firstGeneratedToken) {
        if (tokenScores == null || tokenScores.length != 51_865) {
            throw new IllegalArgumentException("Whisper decoder logits must match the pinned 51865-token vocabulary");
        }
        double noSpeechProbability = firstGeneratedToken
                ? softmaxProbability(tokenScores, (int) WhisperTokenizer.noSpeechToken())
                : Double.NaN;
        int bestIndex = -1;
        float bestScore = Float.NEGATIVE_INFINITY;
        for (int token = 0; token < tokenScores.length; token++) {
            float score = tokenScores[token];
            if (isSuppressedDecoderToken(token, firstGeneratedToken)) continue;
            if (Float.isFinite(score) && score > bestScore) {
                bestScore = score;
                bestIndex = token;
            }
        }
        if (bestIndex < 0) throw new IllegalArgumentException("Whisper decoder emitted no finite token score");
        return new DecoderStep(bestIndex, bestScore - logSumExp(tokenScores, firstGeneratedToken), noSpeechProbability);
    }

    private static boolean isSuppressedDecoderToken(int tokenId, boolean firstGeneratedToken) {
        if (tokenId >= WhisperTokenizer.endOfTextToken() + 1 && tokenId <= 51_864) return true;
        if (firstGeneratedToken && tokenId == WhisperTokenizer.blankTokenId()) return true;
        return firstGeneratedToken && tokenId == WhisperTokenizer.endOfTextToken();
    }

    private static double softmaxProbability(float[] logits, int tokenId) {
        if (tokenId < 0 || tokenId >= logits.length) {
            throw new IllegalArgumentException("Whisper no-speech token is outside decoder vocabulary");
        }
        double logNormalizer = rawLogSumExp(logits);
        float tokenScore = logits[tokenId];
        if (!Float.isFinite(tokenScore) || !Double.isFinite(logNormalizer)) return 0.0d;
        return Math.exp(tokenScore - logNormalizer);
    }

    private static double rawLogSumExp(float[] logits) {
        double maximum = Double.NEGATIVE_INFINITY;
        for (float score : logits) if (Float.isFinite(score)) maximum = Math.max(maximum, score);
        if (!Double.isFinite(maximum)) return Double.NEGATIVE_INFINITY;
        double sum = 0.0d;
        for (float score : logits) if (Float.isFinite(score)) sum += Math.exp(score - maximum);
        return maximum + Math.log(sum);
    }

    private static double logSumExp(float[] logits, boolean firstGeneratedToken) {
        double maximum = Double.NEGATIVE_INFINITY;
        for (int token = 0; token < logits.length; token++) {
            if (isSuppressedDecoderToken(token, firstGeneratedToken)) continue;
            float score = logits[token];
            if (Float.isFinite(score)) maximum = Math.max(maximum, score);
        }
        if (!Double.isFinite(maximum)) return Double.NEGATIVE_INFINITY;
        double sum = 0.0d;
        for (int token = 0; token < logits.length; token++) {
            if (isSuppressedDecoderToken(token, firstGeneratedToken)) continue;
            float score = logits[token];
            if (Float.isFinite(score)) sum += Math.exp(score - maximum);
        }
        return maximum + Math.log(sum);
    }

    record DecoderStep(int tokenId, double logProbability, double noSpeechProbability) { }

    /**
     * Decode token IDs through the configured Whisper tokenizer profile.
     */
    private String decodeTokenIds(OnnxTensor tensor) throws OrtException {
        Object rawIds = tensor.getValue();
        long[] ids;
        if (rawIds instanceof long[][] arr2d) {
            ids = arr2d.length > 0 ? arr2d[0] : new long[0];
        } else if (rawIds instanceof long[] arr1d) {
            ids = arr1d;
        } else if (rawIds instanceof int[][] arr2d) {
            ids = arr2d.length > 0 ? Arrays.stream(arr2d[0]).asLongStream().toArray() : new long[0];
        } else if (rawIds instanceof int[] arr1d) {
            ids = Arrays.stream(arr1d).asLongStream().toArray();
        } else {
            throw new IllegalArgumentException("Whisper token output has unsupported tensor shape");
        }
        return tokenizer.decode(ids);
    }

    // ====================================================================================
    // Streaming Implementation
    // ====================================================================================

    private static class WhisperStreamingSession implements StreamingSession {
        private final UserProfile profile;
        private final SttConfig config;
        private final WhisperOnnxEngine engine;
        private final AtomicReference<Consumer<StreamingTranscription>> transcriptionCallback = new AtomicReference<>();
        private final AtomicReference<Consumer<ProcessingError>> errorCallback = new AtomicReference<>();
        private final AtomicBoolean active = new AtomicBoolean(true);
        private final List<AudioChunk> buffer = new ArrayList<>();
        private final StringBuilder accumulatedText = new StringBuilder();

        WhisperStreamingSession(UserProfile profile, SttConfig config, WhisperOnnxEngine engine) {
            this.profile = profile;
            this.config = config;
            this.engine = engine;
        }

        @Override
        public void feedAudio(AudioChunk chunk) {
            if (!active.get()) {
                throw new IllegalStateException("Session not active");
            }

            buffer.add(chunk);

            // Process when buffer reaches threshold or isLast
            if (chunk.isLast() || buffer.size() >= 30) { // 3 seconds of audio
                processBuffer();
            }
        }

        @Override
        public void onTranscription(Consumer<StreamingTranscription> callback) {
            transcriptionCallback.set(callback);
        }

        @Override
        public void onError(java.util.function.Consumer<com.ghatana.media.common.ProcessingError> callback) {
            errorCallback.set(callback);
        }

        @Override
        public void endStream() {
            active.set(false);
            processBuffer(); // Process remaining audio
        }

        @Override
        public boolean isActive() {
            return active.get();
        }

        @Override
        public void close() {
            active.set(false);
        }

        private void processBuffer() {
            if (buffer.isEmpty()) return;

            // Combine chunks
            int totalLength = buffer.stream().mapToInt(c -> c.data().length).sum();
            byte[] combined = new byte[totalLength];
            int offset = 0;
            for (AudioChunk chunk : buffer) {
                System.arraycopy(chunk.data(), 0, combined, offset, chunk.data().length);
                offset += chunk.data().length;
            }
            buffer.clear();

            // Create audio data
            AudioData audio = AudioData.builder()
                .data(combined)
                .sampleRate(SAMPLE_RATE)
                .channels(1)
                .bitsPerSample(16)
                .build();

            // Transcribe
            try {
                TranscriptionResult result = engine.transcribe(audio, TranscriptionOptions.builder()
                    .language(Locale.getDefault())
                    .enablePunctuation(false) // Disable for streaming
                    .build());

                accumulatedText.append(result.getText()).append(" ");

                var callback = transcriptionCallback.get();
                if (callback != null) {
                    callback.accept(new StreamingTranscription(
                        accumulatedText.toString().trim(),
                        !active.get(), // isFinal when stream ends
                        result.confidence(),
                        result.words(),
                        result.confidenceAvailability()
                    ));
                }
            } catch (Exception e) {
                var callback = errorCallback.get();
                if (callback != null) {
                    callback.accept(new InferenceError("Streaming transcription failed", e, true));
                }
            }
        }
    }
}
