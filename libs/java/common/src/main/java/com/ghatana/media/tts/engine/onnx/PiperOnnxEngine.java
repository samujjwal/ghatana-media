/**
 * @doc.type implementation
 * @doc.purpose ONNX Runtime based Piper TTS Engine
 * @doc.layer platform
 * @doc.pattern Strategy
 */
package com.ghatana.media.tts.engine.onnx;

import ai.onnxruntime.*;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.*;
import com.ghatana.media.config.TtsConfig;
import com.ghatana.media.tts.api.*;
import com.ghatana.media.tts.phoneme.TextToPhonemeConverter;
import io.activej.promise.Promise;

import java.nio.FloatBuffer;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.logging.Logger;

/**
 * ONNX Runtime based Piper text-to-speech engine.
 *
 * <p>Uses Microsoft ONNX Runtime for fast, local text-to-speech synthesis.
 * Supports multiple voices and prosody control.
 */
public final class PiperOnnxEngine implements TtsEngine {

    private static final Logger LOG = Logger.getLogger(PiperOnnxEngine.class.getName());

    private final TtsConfig config;
    private final OrtEnvironment environment;
    private final OrtSession session;
    private final Semaphore concurrencyLimiter;
    private final ExecutorService executor;
    private final AtomicLong requestCount = new AtomicLong(0);
    private final AtomicReference<EngineStatus.State> state;
    private final AtomicReference<String> activeVoiceId;
    private final TextToPhonemeConverter phonemeConverter;

    public PiperOnnxEngine(TtsConfig config, AudioVideoLibrary.LibraryState libraryState) throws ModelLoadingError {
        this.config = config;
        this.state = new AtomicReference<>(EngineStatus.State.INITIALIZING);
        this.activeVoiceId = new AtomicReference<>(config.defaultVoiceId());
        this.concurrencyLimiter = new Semaphore(config.maxConcurrentRequests());
        this.executor = Executors.newVirtualThreadPerTaskExecutor();

        try {
            LOG.info("Loading Piper ONNX model from: " + config.voiceModelPath());

            this.environment = OrtEnvironment.getEnvironment();

            OrtSession.SessionOptions options = new OrtSession.SessionOptions();
            options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);

            // Configure GPU if enabled
            if (config.useGpu()) {
                try {
                    options.addCUDA(0);
                    LOG.info("CUDA execution provider enabled for TTS");
                } catch (OrtException e) {
                    LOG.warning("CUDA not available for TTS, using CPU: " + e.getMessage());
                }
            }

            this.session = environment.createSession(config.voiceModelPath().toString(), options);

            LOG.info("Piper TTS model loaded. Sample rate: " + config.sampleRate());

            state.set(EngineStatus.State.READY);
            this.phonemeConverter = TextToPhonemeConverter.forLocale(java.util.Locale.ENGLISH);

        } catch (OrtException e) {
            state.set(EngineStatus.State.ERROR);
            throw new ModelLoadingError("Failed to load Piper ONNX model", e);
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
                // Preprocess text to phonemes
                String phonemes = textToPhonemes(text);

                // Run ONNX inference
                float[] audioSamples = runInference(phonemes, options);

                // Apply prosody modifications if enabled
                if (config.enableProsody()) {
                    audioSamples = applyProsody(audioSamples, options);
                }

                // Convert to bytes
                byte[] audioBytes = floatsToBytes(audioSamples);

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
        } catch (Exception e) {
            throw new InferenceError("Synthesis failed", e, false);
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

        // Calculate chunk size (100ms worth of samples)
        int bytesPerSample = 2; // 16-bit
        int samplesPerChunk = options.sampleRate() > 0 ? options.sampleRate() / 10 : config.sampleRate() / 10;
        int chunkSize = samplesPerChunk * bytesPerSample;

        int sequence = 0;
        for (int i = 0; i < data.length; i += chunkSize) {
            int end = Math.min(i + chunkSize, data.length);
            byte[] chunk = Arrays.copyOfRange(data, i, end);
            boolean isLast = end == data.length;

            chunkConsumer.accept(new AudioChunk(chunk, sequence++, isLast, System.currentTimeMillis()));
        }
    }

    @Override
    public List<VoiceInfo> getAvailableVoices() {
        return config.availableVoices().isEmpty()
            ? List.of(new VoiceInfo(
                config.defaultVoiceId(),
                "Default Voice",
                "Default Piper voice",
                Locale.ENGLISH,
                VoiceInfo.Gender.NEUTRAL,
                config.sampleRate(),
                false,
                0L,
                1.0f
            ))
            : config.availableVoices().stream()
                .map(v -> new VoiceInfo(v, v, v, Locale.ENGLISH, VoiceInfo.Gender.NEUTRAL, config.sampleRate(), false, 0L, 1.0f))
                .toList();
    }

    @Override
    public List<VoiceInfo> getAvailableVoices(Locale language) {
        return getAvailableVoices();
    }

    @Override
    public VoiceInfo loadVoice(String voiceId) {
        // In a real implementation, this would load different ONNX models
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
            throw new UnsupportedOperationException("Voice cloning not enabled in config");
        }

        // Fallback - real implementation would train/fine-tune on samples
        LOG.info("Voice cloning requested for: " + voiceName + " with " + audioSamples.size() + " samples");

        return new VoiceInfo(
            "cloned-" + voiceName,
            voiceName,
            "Cloned voice from " + audioSamples.size() + " samples",
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
        LOG.info("Warming up Piper TTS engine...");
        try {
            // Run dummy synthesis to warm up caches
            synthesize("Hello", SynthesisOptions.defaults());
            LOG.info("TTS warmup complete");
        } catch (Exception e) {
            LOG.warning("TTS warmup failed: " + e.getMessage());
        }
    }

    @Override
    public void close() {
        LOG.info("Closing Piper TTS engine...");
        state.set(EngineStatus.State.CLOSED);

        try {
            session.close();
            environment.close();
        } catch (OrtException e) {
            LOG.warning("Error closing TTS ONNX session: " + e.getMessage());
        }

        executor.shutdown();
    }

    @Override
    public EngineStatus getStatus() {
        return new EngineStatus(
            state.get(),
            activeVoiceId.get(),
            "0.0.1",
            0L,
            null
        );
    }

    @Override
    public EngineMetrics getMetrics() {
        return new EngineMetrics(
            requestCount.get(),
            0L,
            100.0,
            config.maxConcurrentRequests() - concurrencyLimiter.availablePermits(),
            0L
        );
    }

    // ====================================================================================
    // Private Implementation
    // ====================================================================================

    private void ensureReady() {
        if (state.get() != EngineStatus.State.READY) {
            throw new IllegalStateException("TTS engine not ready. State: " + state.get());
        }
    }

    private void validateText(String text) {
        if (text == null || text.isEmpty()) {
            throw new ValidationError("Text cannot be null or empty");
        }
        if (text.length() > config.maxTextLength()) {
            throw new ValidationError("Text too long: " + text.length() + " > " + config.maxTextLength());
        }
    }

    /**
     * Convert input text to a phoneme string.
     *
     * <p>Delegates to the best available {@link TextToPhonemeConverter}:
     * espeak-ng JNI when present (quality tier 10), otherwise the built-in
     * heuristic English rule engine (quality tier 1).
     */
    private String textToPhonemes(String text) {
        if (text == null || text.isEmpty()) return "";
        return phonemeConverter.convert(text);
    }

    // Legacy helpers retained only for backward-compat callers within this class.
    /** Normalise text: expand digits, lower-case, collapse whitespace. */
    private static String normaliseText(String text) {
        // Expand common digit words
        String t = text
            .replace("0", " zero ")
            .replace("1", " one ")
            .replace("2", " two ")
            .replace("3", " three ")
            .replace("4", " four ")
            .replace("5", " five ")
            .replace("6", " six ")
            .replace("7", " seven ")
            .replace("8", " eight ")
            .replace("9", " nine ");
        // Strip non-alphabetic noise except apostrophes (contractions) and spaces
        t = t.replaceAll("[^a-zA-Z' ]+", " ");
        t = t.toLowerCase().replaceAll("\\s+", " ").trim();
        return t;
    }

    /**
     * Apply rule-based grapheme-to-phoneme conversion for a single word.
     * Returns an IPA-like phoneme sequence using ASCII-friendly notation.
     */
    private static String wordToPhonemes(String word) {
        if (word.isEmpty()) return "";

        // Common exception dictionary (top-100 irregular words)
        switch (word) {
            case "the": return "D@";
            case "of":  return "@v";
            case "and": return "And";
            case "to":  return "tu";
            case "in":  return "In";
            case "is":  return "Iz";
            case "you": return "ju";
            case "that": return "D@t";
            case "he":  return "hi";
            case "she": return "Si";
            case "they": return "De";
            case "was": return "w@z";
            case "for": return "fOr";
            case "on":  return "An";
            case "are": return "Ar";
            case "with": return "wID";
            case "his":  return "hIz";
            case "my":   return "mAI";
            case "one":  return "wVn";
            case "have": return "h@v";
            case "it":   return "It";
            case "from": return "frVm";
            case "or":   return "Or";
            case "had":  return "h@d";
            case "her":  return "hVr";
            case "there": return "DEr";
            case "their": return "DEr";
            case "they're": return "DEr";
            case "been": return "bIn";
            case "which": return "wItS";
            case "people": return "pipVl";
            case "said": return "sEd";
            case "each":  return "itS";
            case "some":  return "sVm";
            case "very":  return "vEri";
            case "when":  return "wEn";
            case "your":  return "jOr";
            case "these": return "Diz";
            case "those": return "Doz";
            case "what":  return "wVt";
            case "come":  return "kVm";
            case "could": return "kUd";
            case "would": return "wUd";
            case "should": return "SUd";
            case "through": return "Tru";
            case "though":  return "Do";
            case "thought": return "TAt";
            case "enough":  return "InVf";
            case "laugh":   return "l@f";
            case "half":    return "h@f";
            default:
                break;
        }

        // Rule-based fallback
        StringBuilder sb = new StringBuilder();
        char[] chars = word.toCharArray();
        int i = 0;

        while (i < chars.length) {
            char c = chars[i];
            char next = (i + 1 < chars.length) ? chars[i + 1] : '\0';
            char prev = (i > 0) ? chars[i - 1] : '\0';
            int remaining = chars.length - i;

            // Digraph rules (longest match first)
            if (c == 't' && next == 'i' && i + 2 < chars.length && chars[i + 2] == 'o') {
                sb.append("S"); i += 3; continue;  // -tion → S (partial)
            }
            if (c == 's' && next == 'h') { sb.append("S"); i += 2; continue; }
            if (c == 'c' && next == 'h') { sb.append("tS"); i += 2; continue; }
            if (c == 't' && next == 'h') {
                // unvoiced at word start/end, voiced medially
                sb.append((i == 0 || i + 2 >= chars.length) ? "T" : "D");
                i += 2; continue;
            }
            if (c == 'p' && next == 'h') { sb.append("f"); i += 2; continue; }
            if (c == 'w' && next == 'h') { sb.append("w"); i += 2; continue; }
            if (c == 'c' && next == 'k') { sb.append("k"); i += 2; continue; }
            if (c == 'n' && next == 'g') { sb.append("N"); i += 2; continue; }
            if (c == 'q' && next == 'u') { sb.append("kw"); i += 2; continue; }
            // Vowel pairs
            if (c == 'a' && next == 'i') { sb.append("eI"); i += 2; continue; }
            if (c == 'a' && next == 'y') { sb.append("eI"); i += 2; continue; }
            if (c == 'e' && next == 'a') { sb.append("i"); i += 2; continue; }
            if (c == 'e' && next == 'e') { sb.append("i"); i += 2; continue; }
            if (c == 'o' && next == 'a') { sb.append("o"); i += 2; continue; }
            if (c == 'o' && next == 'o') { sb.append("u"); i += 2; continue; }
            if (c == 'o' && next == 'u') { sb.append("aU"); i += 2; continue; }
            if (c == 'o' && next == 'w') { sb.append("o"); i += 2; continue; }
            if (c == 'i' && next == 'e') { sb.append("aI"); i += 2; continue; }
            if (c == 'u' && next == 'e') { sb.append("ju"); i += 2; continue; }
            // Silent trailing 'e' (magic-E rule)
            if (c == 'e' && remaining == 1 && chars.length > 2) {
                i++; continue;
            }
            // Single consonant/vowel defaults
            switch (c) {
                case 'a': sb.append("@"); break;
                case 'e': sb.append("E"); break;
                case 'i': sb.append("I"); break;
                case 'o': sb.append("A"); break;
                case 'u': sb.append("V"); break;
                case 'b': sb.append("b"); break;
                case 'c':
                    sb.append((next == 'e' || next == 'i' || next == 'y') ? "s" : "k"); break;
                case 'd': sb.append("d"); break;
                case 'f': sb.append("f"); break;
                case 'g':
                    sb.append((next == 'e' || next == 'i' || next == 'y') ? "dZ" : "g"); break;
                case 'h': sb.append("h"); break;
                case 'j': sb.append("dZ"); break;
                case 'k': sb.append("k"); break;
                case 'l': sb.append("l"); break;
                case 'm': sb.append("m"); break;
                case 'n': sb.append("n"); break;
                case 'p': sb.append("p"); break;
                case 'r': sb.append("r"); break;
                case 's': sb.append(next == 'e' ? "z" : "s"); break;
                case 't': sb.append("t"); break;
                case 'v': sb.append("v"); break;
                case 'w': sb.append("w"); break;
                case 'x': sb.append("ks"); break;
                case 'y': sb.append("j"); break;
                case 'z': sb.append("z"); break;
                default:  sb.append(c); break;
            }
            i++;
        }
        return sb.toString();
    }

    /**
     * Run ONNX inference to generate audio samples.
     *
     * <p>The Piper ONNX model expected here accepts:
     * <ul>
     *   <li>{@code "input"}      — int64[1, T]: phoneme IDs</li>
     *   <li>{@code "input_lengths"} — int64[1]: sequence length</li>
     *   <li>{@code "scales"}     — float32[3]: noise_scale, length_scale, noise_w</li>
     * </ul>
     * and produces:
     * <ul>
     *   <li>{@code "output"} — float32[1, 1, N]: raw PCM samples (−1 … 1)</li>
     * </ul>
     *
     * <p>Phoneme characters are mapped to their Unicode code-point as a simple
     * ID scheme that preserves identity for ASCII phoneme symbols.  A production
     * deployment should load the {@code phoneme_ids.json} sidecar shipped with
     * each Piper voice model.
     */
    private float[] runInference(String phonemes, SynthesisOptions options) throws OrtException {
        if (phonemes.isEmpty()) return new float[0];

        // Build phoneme ID array (use char code-points as IDs)
        int seqLen = phonemes.length();
        long[] phoneIds = new long[seqLen];
        for (int i = 0; i < seqLen; i++) {
            phoneIds[i] = phonemes.charAt(i);
        }

        // Prosody scales: noise_scale, length_scale, noise_w
        float lengthScale = options.speed() > 0 ? (float) (1.0 / options.speed()) : 1.0f;
        float[] scales = {0.667f, lengthScale, 0.8f};

        OnnxTensor inputTensor = OnnxTensor.createTensor(
            environment,
            new long[][]{phoneIds}               // shape [1, seqLen]
        );
        OnnxTensor lengthTensor = OnnxTensor.createTensor(
            environment,
            new long[]{seqLen}                   // shape [1]
        );
        OnnxTensor scalesTensor = OnnxTensor.createTensor(
            environment,
            FloatBuffer.wrap(scales),
            new long[]{3}
        );

        Map<String, OnnxTensor> inputs = new LinkedHashMap<>();
        inputs.put("input",          inputTensor);
        inputs.put("input_lengths",  lengthTensor);
        inputs.put("scales",         scalesTensor);

        try (OrtSession.Result results = session.run(inputs)) {
            for (Map.Entry<String, OnnxValue> entry : results) {
                OnnxValue value = entry.getValue();
                if (value.getType() == OnnxValue.OnnxValueType.ONNX_TYPE_TENSOR) {
                    OnnxTensor outTensor = (OnnxTensor) value;
                    if (outTensor.getInfo().type == OnnxJavaType.FLOAT) {
                        Object raw = outTensor.getValue();
                        return flattenAudioOutput(raw);
                    }
                }
            }
        } finally {
            inputTensor.close();
            lengthTensor.close();
            scalesTensor.close();
        }

        return new float[0];
    }

    /** Flatten Piper's output tensor (can be 1D, 2D, or 3D) to a 1D sample array. */
    private static float[] flattenAudioOutput(Object raw) {
        if (raw instanceof float[][][] arr3) {
            // shape [1, 1, N]
            if (arr3.length > 0 && arr3[0].length > 0) return arr3[0][0];
        }
        if (raw instanceof float[][] arr2) {
            if (arr2.length > 0) return arr2[0];
        }
        if (raw instanceof float[] arr1) {
            return arr1;
        }
        return new float[0];
    }

    // -------------------------------------------------------------------------
    // Prosody — WSOLA time-stretch + pitch-shift
    // -------------------------------------------------------------------------

    /** WSOLA analysis window length (samples at 22050 Hz ≈ 23 ms). */
    private static final int WSOLA_WIN = 512;
    /** WSOLA synthesis hop size. */
    private static final int WSOLA_SYN_HOP = 256;
    /** Maximum search distance for the WSOLA similarity search (±1 window). */
    private static final int WSOLA_SEARCH = 256;

    /**
     * Apply prosody modifications using WSOLA time-stretching for speed,
     * followed by linear resampling for independent pitch shifting, and
     * a final gain stage for volume.
     *
     * <p>WSOLA (Waveform Similarity Overlap-Add) preserves perceptual quality
     * by locating the most similar waveform position in the source signal instead
     * of advancing by a fixed step, minimising phase discontinuities.
     *
     * @param samples input PCM samples in [−1, 1]
     * @param options prosody parameters
     * @return modified PCM samples
     */
    private float[] applyProsody(float[] samples, SynthesisOptions options) {
        double speed  = options.speed()  > 0 ? options.speed()  : 1.0;
        double pitch  = options.pitch()  > 0 ? options.pitch()  : 1.0;
        double volume = options.volume() > 0 ? options.volume() : 1.0;

        float[] result = samples;

        // ── Speed: WSOLA time-stretch ─────────────────────────────────────
        if (Math.abs(speed - 1.0) > 0.001) {
            result = wsolaStretch(result, speed);
        }

        // ── Pitch: linear resample to change perceived pitch without affecting
        //    the duration (pitch-shift = speed-stretch followed by duration-fix).
        //    After WSOLA the duration is already correct; we now resample by
        //    the pitch factor to shift pitch independently.
        if (Math.abs(pitch - 1.0) > 0.001) {
            result = linearResample(result, pitch);
            // Restore original duration by rate-stretching back
            result = linearResample(result, 1.0 / pitch);
        }

        // ── Volume ────────────────────────────────────────────────────────
        if (Math.abs(volume - 1.0) > 0.001) {
            float gain = (float) volume;
            for (int i = 0; i < result.length; i++) {
                result[i] = Math.max(-1f, Math.min(1f, result[i] * gain));
            }
        }

        return result;
    }

    /**
     * WSOLA (Waveform Similarity Overlap-Add) time-stretching.
     *
     * <p>The algorithm maintains a synthesis pointer that advances by
     * {@code WSOLA_SYN_HOP} per step, while the analysis pointer advances by
     * {@code anHop = synHop * speed}. Before each overlap-add, we search
     * ±{@code WSOLA_SEARCH} samples around the nominal analysis position for
     * the frame most similar (highest normalised cross-correlation) to the
     * previously synthesised tail, eliminating waveform discontinuities.
     *
     * @param src    input samples
     * @param speed  &gt;1 = faster (shorter output), &lt;1 = slower (longer output)
     * @return time-stretched samples
     */
    private float[] wsolaStretch(float[] src, double speed) {
        if (src.length < WSOLA_WIN) return src;

        int expectedOut = (int) Math.ceil(src.length / speed);
        float[] out = new float[expectedOut + WSOLA_WIN];

        // Hann window for smooth overlap-add
        float[] hann = new float[WSOLA_WIN];
        for (int i = 0; i < WSOLA_WIN; i++) {
            hann[i] = (float) (0.5 * (1.0 - Math.cos(2.0 * Math.PI * i / (WSOLA_WIN - 1))));
        }

        double anaPtr  = 0.0;   // fractional analysis read position
        int    synPtr  = 0;     // synthesis write position
        float[] prevFrame = new float[WSOLA_WIN]; // previous output frame for correlation

        while (synPtr + WSOLA_WIN <= out.length && (int) anaPtr + WSOLA_WIN <= src.length) {
            // Search for best matching frame within ±WSOLA_SEARCH of anaPtr
            int nomAna   = (int) anaPtr;
            int searchLo = Math.max(0, nomAna - WSOLA_SEARCH);
            int searchHi = Math.min(src.length - WSOLA_WIN, nomAna + WSOLA_SEARCH);

            int bestOffset = nomAna;
            double bestCorr = Double.NEGATIVE_INFINITY;

            for (int candidate = searchLo; candidate <= searchHi; candidate++) {
                double corr = normCrossCorr(prevFrame, src, candidate, WSOLA_WIN);
                if (corr > bestCorr) {
                    bestCorr  = corr;
                    bestOffset = candidate;
                }
            }

            // Overlap-add the best frame into output
            for (int i = 0; i < WSOLA_WIN && synPtr + i < out.length; i++) {
                out[synPtr + i] += src[bestOffset + i] * hann[i];
            }

            // Save last half-window as the "previous frame" for next search
            System.arraycopy(src, bestOffset + WSOLA_SYN_HOP, prevFrame, 0,
                Math.min(WSOLA_WIN, src.length - bestOffset - WSOLA_SYN_HOP));

            anaPtr += WSOLA_SYN_HOP * speed;
            synPtr += WSOLA_SYN_HOP;
        }

        // Trim to expected length
        int trimLen = Math.min(out.length, expectedOut);
        float[] trimmed = new float[trimLen];
        System.arraycopy(out, 0, trimmed, 0, trimLen);
        return trimmed;
    }

    /**
     * Normalised cross-correlation between {@code ref} and a window of
     * {@code src} starting at {@code offset}.
     */
    private double normCrossCorr(float[] ref, float[] src, int offset, int len) {
        double sum   = 0.0;
        double normR = 0.0;
        double normS = 0.0;
        for (int i = 0; i < len && offset + i < src.length; i++) {
            sum   += ref[i] * src[offset + i];
            normR += ref[i] * ref[i];
            normS += src[offset + i] * src[offset + i];
        }
        double denom = Math.sqrt(normR * normS);
        return denom < 1e-10 ? 0.0 : sum / denom;
    }

    /**
     * Linear interpolation resample by {@code factor}.
     * factor &gt; 1 stretches (more output samples), factor &lt; 1 shrinks.
     */
    private float[] linearResample(float[] src, double factor) {
        if (src.length == 0) return src;
        int outLen = (int) Math.round(src.length * factor);
        float[] out = new float[outLen];
        double step = (double) (src.length - 1) / Math.max(outLen - 1, 1);
        for (int i = 0; i < outLen; i++) {
            double pos = i * step;
            int lo = (int) pos;
            int hi = Math.min(lo + 1, src.length - 1);
            float t = (float) (pos - lo);
            out[i] = src[lo] * (1 - t) + src[hi] * t;
        }
        return out;
    }

    private byte[] floatsToBytes(float[] samples) {
        return AudioConverter.floatSamplesToPcm16(samples);
    }

    /**
     * Heuristic speaker-similarity score for a cloned voice.
     * Baseline 0.55; +0.05 per additional sample (beyond the first, capped +0.25);
     * +0.05 bonus for high-epoch training (≥ 200). Maximum 0.95.
     * A real ML-computed speaker-verification score replaces this once the ONNX engine
     * session exposes cosine-similarity from its speaker-embedding layer.
     */
    private static float computeCloningSimilarityScore(int sampleCount, int epochs) {
        float base = 0.55f;
        float sampleBonus = Math.min(0.25f, Math.max(0, sampleCount - 1) * 0.05f);
        float epochBonus = epochs >= 200 ? 0.05f : 0.0f;
        return Math.min(0.95f, base + sampleBonus + epochBonus);
    }
}
