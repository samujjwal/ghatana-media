package com.ghatana.media.launcher;

import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.stt.local.LocalSpeechException;
import com.ghatana.stt.local.LocalWhisperCppRunner;
import com.ghatana.stt.local.PcmWav;
import com.ghatana.stt.provider.LocalWhisperCppSttProvider;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Stream;

/**
 * DEV_ONLY audio restoration and measured comparison (outside the canonical manifest/OpenAPI), journey J-07.
 *
 * <p><b>Restore.</b> One exact owner-visible PCM16 WAV version plus a bounded, typed operation set (declip, 50/60 Hz
 * dehum, FFT denoise, optional loudness normalization that is OFF unless requested) becomes a NEW immutable
 * {@code audio/wav} artifact version. The filter graph is built only from validated numbers (an argument array, a
 * cleared environment, no shell, no caller text on the command line) and run through {@link BoundedProcessRunner}
 * with a wall-clock deadline and an output-size ceiling. The source is read once and never written. Lineage records
 * the source version digest, the exact filter graph, the typed parameters and the engine version.</p>
 *
 * <p><b>Honest outcome.</b> A run whose FFmpeg process did not finish (killed, timed out, over the output ceiling)
 * is {@code AUDIO_RESTORATION_OUTCOME_UNKNOWN}: nothing is registered and the claim is released so a retry of the same
 * requestId runs again and registers exactly once (the registration is idempotent by key, and the durable request
 * ledger maps the requestId to its single output).</p>
 *
 * <p><b>Compare.</b> Measures source against restored (and against a clean reference when given): SNR, segmental SNR,
 * clipped-sample count, noise-floor level and spectral flatness, and optionally a Whisper transcript diff against the
 * clean transcript. The numbers are registered as an immutable JSON artifact. A verdict is derived from the numbers
 * only; without a reference no quality improvement is claimed.</p>
 *
 * <p>Rights: {@code Scope.PROCESSING} is re-resolved for the exact source (and reference) version on every call,
 * replays included. Honesty boundary: a restoration is an engine output with no perceptual-quality, rights, approval
 * or delivery claim.</p>
 */
public final class MediaDevAudioRestorationRuntime {
    public static final String SCHEMA_RESTORATION = "media.dev.audio-restoration.v1";
    public static final String SCHEMA_COMPARISON = "media.dev.audio-comparison.v1";
    public static final String KIND_RESTORED = "LOCAL_AUDIO_RESTORED";
    public static final String KIND_COMPARISON = "LOCAL_AUDIO_COMPARISON";
    public static final String ENV_TIMEOUT = "MEDIA_DEV_AUDIO_RESTORE_TIMEOUT_SECONDS";
    static final String LANE_RESTORE = "audio.restore";
    static final String LANE_COMPARE = "audio.compare";
    static final int MAX_SOURCE_BYTES = 8 * 1024 * 1024;
    static final int MAX_COMPARISON_DOCUMENT_BYTES = 256 * 1024;
    static final int MAX_REFERENCE_TEXT_CHARS = 2000;
    static final double VERDICT_EPSILON_DB = 0.5;
    private static final Set<String> WAV_TYPES = Set.of("audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave");
    private static final tools.jackson.databind.ObjectMapper JSON = tools.jackson.databind.json.JsonMapper.builder().build();
    private static final List<String> LINEAGE_KEYS = List.of("restorationSchema", "comparisonSchema", "scope", "kind",
            "requestId", "source", "restored", "reference", "operations", "filterGraph", "engine", "format",
            "rightsDecision", "transcript", "note");

    // ---- typed operation set ----

    public record Denoise(double reductionDb, double noiseFloorDb, boolean trackNoise) {
        public Denoise {
            requireRange(reductionDb, 1, 40, "denoise.reductionDb");
            requireRange(noiseFloorDb, -80, -20, "denoise.noiseFloorDb");
        }
    }

    public record Declip(int threshold) {
        public Declip {
            if (threshold < 1 || threshold > 100) throw invalid("declip.threshold must be an integer within [1, 100]");
        }
    }

    public record Dehum(int frequencyHz) {
        public Dehum {
            if (frequencyHz != 50 && frequencyHz != 60) throw invalid("dehum.frequencyHz must be 50 or 60");
        }
    }

    public record Normalize(double targetLufs) {
        public Normalize {
            requireRange(targetLufs, -30, -10, "normalize.targetLufs");
        }
    }

    /** At least one operation; each is optional and absent means that stage does not run (normalize is off by default). */
    public record Operations(Declip declip, Dehum dehum, Denoise denoise, Normalize normalize) {
        public Operations {
            if (declip == null && dehum == null && denoise == null && normalize == null) {
                throw invalid("at least one restoration operation is required");
            }
        }

        String canonical() {
            StringBuilder out = new StringBuilder();
            if (declip != null) out.append("declip(threshold=").append(declip.threshold()).append(");");
            if (dehum != null) out.append("dehum(frequencyHz=").append(dehum.frequencyHz()).append(");");
            if (denoise != null) {
                out.append("denoise(reductionDb=").append(num(denoise.reductionDb())).append(",noiseFloorDb=")
                        .append(num(denoise.noiseFloorDb())).append(",trackNoise=").append(denoise.trackNoise()).append(");");
            }
            if (normalize != null) out.append("normalize(targetLufs=").append(num(normalize.targetLufs())).append(");");
            return out.toString();
        }

        Map<String, Object> view() {
            Map<String, Object> view = new LinkedHashMap<>();
            if (declip != null) view.put("declip", Map.of("threshold", declip.threshold()));
            if (dehum != null) view.put("dehum", Map.of("frequencyHz", dehum.frequencyHz()));
            if (denoise != null) {
                view.put("denoise", Map.of("reductionDb", denoise.reductionDb(), "noiseFloorDb", denoise.noiseFloorDb(),
                        "trackNoise", denoise.trackNoise()));
            }
            view.put("normalize", normalize == null ? Map.of("enabled", false)
                    : Map.of("enabled", true, "targetLufs", normalize.targetLufs()));
            return view;
        }

        /**
         * Order: declip first (before any level change), then hum notches, then FFT denoise, then optional loudness.
         * Only validated numbers are formatted into the graph. The FFT denoiser delays its output by sampleRate/40
         * samples (measured on FFmpeg 7.0.2); the delay is absorbed by padding the input and trimming the start, so the
         * restored audio stays sample-aligned with the source, and a final pad/trim fixes the exact frame count.
         */
        String filterGraph(int sampleRate, long frames) {
            List<String> stages = new java.util.ArrayList<>();
            if (declip != null) {
                stages.add("adeclip=threshold=" + declip.threshold() + ":window=55:overlap=75:method=a");
            }
            if (dehum != null) {
                int f = dehum.frequencyHz();
                for (int harmonic = 1; harmonic <= 3; harmonic++) {
                    stages.add("bandreject=f=" + f * harmonic + ":t=q:w=30");
                }
            }
            if (denoise != null) {
                int delay = sampleRate / 40;
                stages.add("apad=pad_len=" + delay);
                stages.add("afftdn=nr=" + num(denoise.reductionDb()) + ":nf=" + num(denoise.noiseFloorDb()) + ":tn="
                        + (denoise.trackNoise() ? 1 : 0));
                stages.add("atrim=start_sample=" + delay);
                stages.add("asetpts=PTS-STARTPTS");
            }
            if (normalize != null) {
                stages.add("loudnorm=I=" + num(normalize.targetLufs()) + ":TP=-1.5:LRA=11");
                stages.add("aresample=" + sampleRate);
            }
            stages.add("aformat=sample_fmts=s16");
            stages.add("apad=whole_len=" + frames);
            stages.add("atrim=end_sample=" + frames);
            return String.join(",", stages);
        }
    }

    private static String num(double value) {
        return String.format(Locale.ROOT, "%.1f", value);
    }

    private static void requireRange(double value, double min, double max, String name) {
        if (!Double.isFinite(value) || value < min || value > max) {
            throw invalid(name + " must be a number within [" + (long) min + ", " + (long) max + "]");
        }
    }

    private static AudioRefusedException invalid(String message) {
        return new AudioRefusedException(422, "AUDIO_PARAMETERS_INVALID", message, Map.of());
    }

    // ---- requests and results ----

    public record RestoreRequest(String requestId, String artifactId, String artifactVersionId, Operations operations) {
        public RestoreRequest {
            requestId = boundedId(requestId, "requestId");
            artifactId = boundedId(artifactId, "artifactId");
            artifactVersionId = Objects.requireNonNull(artifactVersionId, "artifactVersionId");
            Objects.requireNonNull(operations, "operations");
        }
    }

    public record VersionRef(String artifactId, String artifactVersionId) {
        public VersionRef {
            artifactId = boundedId(artifactId, "artifactId");
            artifactVersionId = Objects.requireNonNull(artifactVersionId, "artifactVersionId");
        }
    }

    /** Optional Whisper diff: the clean transcript is the caller's known text or Whisper over the clean reference. */
    public record TranscriptRequest(String language, String referenceText) {
        public TranscriptRequest {
            language = language == null ? "en" : language;
            if (!language.matches("[a-z]{2,3}")) throw invalid("transcript.language must be a 2-3 letter language code");
            if (referenceText != null && (referenceText.isBlank() || referenceText.length() > MAX_REFERENCE_TEXT_CHARS)) {
                throw invalid("transcript.referenceText must be 1-" + MAX_REFERENCE_TEXT_CHARS + " characters");
            }
        }
    }

    public record CompareRequest(String requestId, VersionRef source, VersionRef restored, VersionRef reference,
                                 TranscriptRequest transcript) {
        public CompareRequest {
            requestId = boundedId(requestId, "requestId");
            Objects.requireNonNull(source, "source");
            Objects.requireNonNull(restored, "restored");
            if (transcript != null && reference == null && transcript.referenceText() == null) {
                throw new AudioRefusedException(422, "TRANSCRIPT_REFERENCE_REQUIRED",
                        "a transcript comparison needs a clean reference version or a known reference text", Map.of());
            }
        }
    }

    /** A registered restoration or comparison; {@code document} is the comparison report (null for a restoration). */
    public record AudioOutput(String kind, MediaArtifact artifact, Map<String, Object> lineage,
                              Map<String, Object> document, boolean replayed) { }

    public static final class AudioRefusedException extends RuntimeException {
        private final int status;
        private final String code;
        private final Map<String, Object> details;
        AudioRefusedException(int status, String code, String message, Map<String, Object> details) {
            super(message, null, false, false);
            this.status = status;
            this.code = code;
            this.details = details;
        }
        public int status() { return status; }
        public String code() { return code; }
        public Map<String, Object> details() { return details; }
    }

    /** The engine did not finish; nothing was registered and a retry of the same requestId runs again. */
    public static final class AudioOutcomeUnknownException extends RuntimeException {
        private final String reason;
        AudioOutcomeUnknownException(String reason) {
            super("the local audio engine did not complete", null, false, false);
            this.reason = reason;
        }
        public String reason() { return reason; }
    }

    public static final class AudioRegistrationFailedException extends IllegalStateException {
        AudioRegistrationFailedException(Throwable cause) {
            super("the audio output could not be registered as an immutable artifact", cause);
        }
    }

    public static final class AudioRequestReusedException extends IllegalStateException {
        AudioRequestReusedException() { super("requestId already used with a different audio request"); }
    }

    // ---- composition ----

    private final MediaRuntime runtime;
    private final MediaDevProjectRenderRuntime.OutputRegistrar registrar;
    private final RightsConsentResolver rights;
    private final MediaDevRequestLedger ledger;
    private final LocalWhisperCppSttProvider stt;
    private final Path ffmpeg;
    private final Duration timeout;
    private volatile Map<String, Object> engineIdentity;

    MediaDevAudioRestorationRuntime(MediaRuntime runtime, MediaDevProjectRenderRuntime.OutputRegistrar registrar,
                                    RightsConsentResolver rights, MediaDevRequestLedger ledger,
                                    LocalWhisperCppSttProvider stt, Path ffmpeg, Duration timeout) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.registrar = Objects.requireNonNull(registrar, "registrar");
        this.rights = rights == null ? RightsConsentResolver.unavailable() : rights;
        this.ledger = Objects.requireNonNull(ledger, "ledger");
        this.stt = stt;
        if (ffmpeg != null && !ffmpeg.isAbsolute()) throw new IllegalArgumentException("ffmpeg path must be absolute");
        this.ffmpeg = ffmpeg;
        this.timeout = Objects.requireNonNull(timeout, "timeout");
    }

    static MediaDevAudioRestorationRuntime compose(MediaRuntime runtime, Map<String, String> environment,
                                                   RightsConsentResolver rights, MediaDevRequestLedger ledger) {
        String configured = environment.get(MediaDevProjectRenderRuntime.FFMPEG_ENV);
        Path ffmpeg = configured == null || configured.isBlank() ? null : Path.of(configured);
        long seconds = 60;
        String raw = environment.get(ENV_TIMEOUT);
        if (raw != null && !raw.isBlank()) {
            try {
                seconds = Long.parseLong(raw.trim());
            } catch (NumberFormatException invalid) {
                throw new IllegalArgumentException(ENV_TIMEOUT + " must be an integer within [2, 300]");
            }
            if (seconds < 2 || seconds > 300) throw new IllegalArgumentException(ENV_TIMEOUT + " must be an integer within [2, 300]");
        }
        return new MediaDevAudioRestorationRuntime(runtime, MediaDevProjectRenderRuntime.canonicalRegistrar(runtime),
                rights, ledger, LocalWhisperCppSttProvider.fromEnvironment(environment), ffmpeg, Duration.ofSeconds(seconds));
    }

    // ---- status ----

    public Map<String, Object> status() {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("scope", "DEV_ONLY");
        Map<String, Object> engine = new LinkedHashMap<>();
        engine.put("configured", ffmpeg != null);
        Map<String, Object> identity = ffmpeg == null ? null : engineIdentity();
        engine.put("ready", identity != null);
        if (identity != null) engine.putAll(identity);
        view.put("engine", engine);
        view.put("transcriptDiff", Map.of("ready", stt != null && stt.ready()));
        view.put("limits", Map.of("maxSourceBytes", MAX_SOURCE_BYTES, "deadlineSeconds", timeout.toSeconds(),
                "sampleRatesHz", List.of(MediaDevAudioWav.MIN_RATE, MediaDevAudioWav.MAX_RATE),
                "channels", MediaDevAudioWav.MAX_CHANNELS, "format", "PCM16 WAV"));
        view.put("operations", Map.of(
                "denoise", Map.of("reductionDb", List.of(1, 40), "noiseFloorDb", List.of(-80, -20), "trackNoise", "boolean"),
                "declip", Map.of("threshold", List.of(1, 100)),
                "dehum", Map.of("frequencyHz", List.of(50, 60)),
                "normalize", Map.of("targetLufs", List.of(-30, -10), "default", "OFF")));
        return view;
    }

    /** Engine name, version line and binary digest; null when the engine cannot report its version. */
    private Map<String, Object> engineIdentity() {
        Map<String, Object> cached = engineIdentity;
        if (cached != null) return cached;
        synchronized (this) {
            if (engineIdentity != null) return engineIdentity;
            try {
                BoundedProcessRunner.Result result = BoundedProcessRunner.run(List.of(ffmpeg.toString(), "-nostdin", "-version"),
                        null, Map.of(), Duration.ofSeconds(10), 16 * 1024, 4096, BoundedProcessRunner.CancellationToken.NEVER,
                        null, 0);
                if (!result.succeeded()) return null;
                String text = new String(result.stdout(), StandardCharsets.UTF_8);
                String first = text.lines().findFirst().orElse("").strip();
                if (!first.startsWith("ffmpeg version")) return null;
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                try (InputStream in = Files.newInputStream(ffmpeg)) {
                    byte[] buffer = new byte[64 * 1024];
                    for (int read; (read = in.read(buffer)) > 0; ) digest.update(buffer, 0, read);
                }
                Map<String, Object> identity = new LinkedHashMap<>();
                identity.put("name", "ffmpeg");
                identity.put("version", first.length() > 200 ? first.substring(0, 200) : first);
                identity.put("binarySha256", HexFormat.of().formatHex(digest.digest()));
                engineIdentity = Map.copyOf(identity);
                return engineIdentity;
            } catch (IOException | java.security.GeneralSecurityException | RuntimeException unavailable) {
                return null;
            }
        }
    }

    // ---- restore ----

    public AudioOutput restore(String tenantId, String principalId, RestoreRequest request) {
        Objects.requireNonNull(request, "request");
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "audio_restore", tenantId,
                () -> restoreAdmitted(tenantId, principalId, request));
    }

    private AudioOutput restoreAdmitted(String tenantId, String principalId, RestoreRequest request) {
        if (ffmpeg == null) {
            throw new AudioRefusedException(503, "AUDIO_ENGINE_UNAVAILABLE",
                    "no absolute FFmpeg path is configured for DEV_ONLY audio restoration", Map.of());
        }
        MediaArtifact source = exactVersion(tenantId, principalId, request.artifactId(), request.artifactVersionId());
        MediaDevAudioWav.Pcm pcm = decode(tenantId, principalId, source);
        String rightsEvidence = requireRights(tenantId, source);
        Map<String, Object> engine = engineIdentity();
        if (engine == null) {
            throw new AudioRefusedException(503, "AUDIO_ENGINE_UNAVAILABLE",
                    "the configured FFmpeg did not report a usable version", Map.of());
        }
        String filterGraph = request.operations().filterGraph(pcm.sampleRate(), pcm.frames());
        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.audio.restore.v1", source.artifactId(),
                source.version().value(), source.sha256(), request.operations().canonical());
        Map<String, Object> lineage = new LinkedHashMap<>();
        lineage.put("restorationSchema", SCHEMA_RESTORATION);
        lineage.put("scope", "DEV_ONLY");
        lineage.put("kind", KIND_RESTORED);
        lineage.put("requestId", request.requestId());
        lineage.put("source", sourceRef(source));
        lineage.put("operations", request.operations().view());
        lineage.put("filterGraph", filterGraph);
        lineage.put("engine", engine);
        lineage.put("format", Map.of("sampleRate", pcm.sampleRate(), "channels", pcm.channels(), "bitsPerSample", 16,
                "frames", pcm.frames()));
        lineage.put("rightsDecision", rightsEvidence);
        lineage.put("note", "Engine output for the exact source version. The source version is unchanged and remains "
                + "available. No perceptual-quality, rights, approval or delivery claim; measure with a comparison.");
        return ledger.run(tenantId, principalId, LANE_RESTORE, request.requestId(), fingerprint,
                outputs -> replay(tenantId, principalId, outputs, LANE_RESTORE),
                () -> produceRestoration(tenantId, principalId, request, source, pcm, filterGraph, lineage),
                output -> List.of(new OutputRef("restored", output.artifact().artifactId(), output.artifact().version().value())),
                () -> new AudioRequestReusedException());
    }

    private AudioOutput produceRestoration(String tenantId, String principalId, RestoreRequest request, MediaArtifact source,
                                           MediaDevAudioWav.Pcm pcm, String filterGraph, Map<String, Object> lineage) {
        byte[] sourceBytes = readContent(tenantId, principalId, source);
        // The registered artifact is content-addressed per tenant (unique sha256+size), so the WAV carries its own
        // provenance comment (validated request id and source digest): a second request never collides with the first.
        String provenance = "ghatana-media DEV_ONLY audio restoration requestId=" + request.requestId() + " source=sha256:" + source.sha256();
        byte[] restored = runFfmpeg(sourceBytes, filterGraph, source.sizeBytes(), provenance);
        MediaDevAudioWav.Pcm out;
        try {
            out = MediaDevAudioWav.parse(restored);
        } catch (MediaDevAudioWav.WavException invalid) {
            throw new AudioRefusedException(502, "AUDIO_RESTORATION_OUTPUT_INVALID",
                    "the engine output is not a valid PCM16 WAV; nothing was registered", Map.of());
        }
        if (out.sampleRate() != pcm.sampleRate() || out.channels() != pcm.channels() || out.frames() != pcm.frames()) {
            throw new AudioRefusedException(502, "AUDIO_RESTORATION_OUTPUT_INVALID",
                    "the engine output does not keep the source format and length; nothing was registered", Map.of());
        }
        if (MediaDevAudioMetrics.peak(pcm) > 0 && MediaDevAudioMetrics.peak(out) == 0) {
            throw new AudioRefusedException(502, "AUDIO_RESTORATION_OUTPUT_INVALID",
                    "the engine produced silence from non-silent input; nothing was registered", Map.of());
        }
        Map<String, Object> metadata = new LinkedHashMap<>(lineage);
        metadata.put("purpose", "audio-restoration");
        String sha = MediaDevProjectRenderRuntime.sha256Hex(restored);
        UploadRequest upload = new UploadRequest(tenantId, principalId, "restored-" + safeName(source.artifactId()) + ".wav",
                "audio/wav", restored.length, sha, source.classification(), Duration.ofDays(30), metadata);
        MediaArtifact artifact = register(tenantId, principalId, upload, "restore", request.requestId(), restored, sha);
        return new AudioOutput("RESTORATION", artifact, lineage, null, false);
    }

    /** Stages the source privately, runs the bounded FFmpeg graph and returns the exact output bytes. */
    private byte[] runFfmpeg(byte[] input, String filterGraph, long sourceSize, String provenance) {
        Path dir = null;
        try {
            dir = Files.createTempDirectory("media-dev-audio-",
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
            Path in = dir.resolve("in.wav");
            Path out = dir.resolve("out.wav");
            Files.write(in, input);
            // Same-format, same-length output: allow the header plus a small margin, never a runaway write.
            long ceiling = sourceSize + 64 * 1024L;
            BoundedProcessRunner.Result result = BoundedProcessRunner.run(
                    List.of(ffmpeg.toString(), "-nostdin", "-v", "error", "-nostats", "-i", in.toString(), "-af", filterGraph,
                            "-map_metadata", "-1", "-metadata", "comment=" + provenance, "-fflags", "+bitexact", "-flags:a", "+bitexact",
                            "-c:a", "pcm_s16le", "-f", "wav", "-y", out.toString()),
                    dir, Map.of(), timeout, 1024, 8192, BoundedProcessRunner.CancellationToken.NEVER, out, ceiling);
            // A signalled child is reported as 128 + signal; FFmpeg's own failures are 1 or 234/255, never in that band.
            boolean signalled = result.exitCode() > 128 && result.exitCode() <= 192 || result.exitCode() < 0;
            if (result.end() != BoundedProcessRunner.End.EXITED || signalled) {
                // Killed, timed out or over the ceiling: whether the engine finished is not known; nothing is registered.
                throw new AudioOutcomeUnknownException(result.end() == BoundedProcessRunner.End.EXITED
                        ? "ENGINE_SIGNALLED" : result.end().name());
            }
            if (!result.succeeded() || !Files.isRegularFile(out) || Files.size(out) == 0) {
                throw new AudioRefusedException(502, "AUDIO_RESTORATION_FAILED",
                        "the audio engine rejected this input; nothing was registered", Map.of());
            }
            return Files.readAllBytes(out);
        } catch (IOException failure) {
            throw new AudioOutcomeUnknownException("ENGINE_IO");
        } finally {
            if (dir != null) {
                try (Stream<Path> walk = Files.walk(dir)) {
                    walk.sorted(Comparator.reverseOrder()).forEach(path -> path.toFile().delete());
                } catch (IOException ignored) { }
            }
        }
    }

    // ---- compare ----

    public AudioOutput compare(String tenantId, String principalId, CompareRequest request) {
        Objects.requireNonNull(request, "request");
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "audio_compare", tenantId,
                () -> compareAdmitted(tenantId, principalId, request));
    }

    private AudioOutput compareAdmitted(String tenantId, String principalId, CompareRequest request) {
        LocalWhisperCppRunner runner = null;
        if (request.transcript() != null) {
            runner = stt == null ? null : stt.runner();
            if (runner == null) {
                throw new AudioRefusedException(503, "SPEECH_RUNTIME_UNAVAILABLE",
                        "no verified local speech-to-text model is installed for the transcript diff", Map.of());
            }
            if (!stt.install().manifest().verifiedLanguages().contains(request.transcript().language())) {
                throw new AudioRefusedException(422, "LANGUAGE_UNSUPPORTED",
                        "this local profile has no verified qualification for language " + request.transcript().language(),
                        Map.of());
            }
        }
        MediaArtifact source = exactVersion(tenantId, principalId, request.source().artifactId(), request.source().artifactVersionId());
        MediaArtifact restored = exactVersion(tenantId, principalId, request.restored().artifactId(), request.restored().artifactVersionId());
        MediaArtifact reference = request.reference() == null ? null
                : exactVersion(tenantId, principalId, request.reference().artifactId(), request.reference().artifactVersionId());
        MediaDevAudioWav.Pcm sourcePcm = decode(tenantId, principalId, source);
        MediaDevAudioWav.Pcm restoredPcm = decode(tenantId, principalId, restored);
        MediaDevAudioWav.Pcm referencePcm = reference == null ? null : decode(tenantId, principalId, reference);
        // The restored version must be a recorded restoration OF this source (lineage digest), never an arbitrary clip.
        if (!SCHEMA_RESTORATION.equals(restored.metadata().get("restorationSchema"))
                || !(restored.metadata().get("source") instanceof Map<?, ?> lineageSource)
                || !source.sha256().equals(lineageSource.get("sha256"))
                || !source.artifactId().equals(lineageSource.get("artifactId"))) {
            throw new AudioRefusedException(422, "COMPARISON_LINEAGE_MISMATCH",
                    "the restored version is not a recorded restoration of the named source version", Map.of());
        }
        requireSameShape(sourcePcm, restoredPcm, "source and restored");
        if (referencePcm != null) requireSameShape(sourcePcm, referencePcm, "source and reference");
        String sourceRights = requireRights(tenantId, source);
        String referenceRights = reference == null ? null : requireRights(tenantId, reference);

        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.audio.compare.v1", source.artifactId(),
                source.version().value(), source.sha256(), restored.artifactId(), restored.version().value(),
                restored.sha256(), reference == null ? null : reference.artifactId(),
                reference == null ? null : reference.sha256(),
                request.transcript() == null ? null : request.transcript().language(),
                request.transcript() == null ? null : request.transcript().referenceText());
        final LocalWhisperCppRunner whisper = runner;
        return ledger.run(tenantId, principalId, LANE_COMPARE, request.requestId(), fingerprint,
                outputs -> replay(tenantId, principalId, outputs, LANE_COMPARE),
                () -> produceComparison(tenantId, principalId, request, source, restored, reference, sourcePcm,
                        restoredPcm, referencePcm, sourceRights, referenceRights, whisper),
                output -> List.of(new OutputRef("comparison", output.artifact().artifactId(), output.artifact().version().value())),
                () -> new AudioRequestReusedException());
    }

    private AudioOutput produceComparison(String tenantId, String principalId, CompareRequest request, MediaArtifact source,
                                          MediaArtifact restored, MediaArtifact reference, MediaDevAudioWav.Pcm sourcePcm,
                                          MediaDevAudioWav.Pcm restoredPcm, MediaDevAudioWav.Pcm referencePcm,
                                          String sourceRights, String referenceRights, LocalWhisperCppRunner whisper) {
        Map<String, Object> document = new LinkedHashMap<>();
        document.put("schema", SCHEMA_COMPARISON);
        document.put("requestId", request.requestId());
        document.put("source", sourceRef(source));
        document.put("restored", sourceRef(restored));
        if (reference != null) document.put("reference", sourceRef(reference));
        document.put("format", Map.of("sampleRate", sourcePcm.sampleRate(), "channels", sourcePcm.channels(),
                "frames", sourcePcm.frames()));
        Map<String, Object> sourceSide = side(sourcePcm, referencePcm);
        Map<String, Object> restoredSide = side(restoredPcm, referencePcm);
        Map<String, Object> metrics = new LinkedHashMap<>();
        metrics.put("source", sourceSide);
        metrics.put("restored", restoredSide);
        if (referencePcm != null) metrics.put("reference", side(referencePcm, null));
        Map<String, Object> delta = new LinkedHashMap<>();
        Double snrDelta = delta(restoredSide.get("snrDb"), sourceSide.get("snrDb"));
        Double segDelta = delta(restoredSide.get("segmentalSnrDb"), sourceSide.get("segmentalSnrDb"));
        long clippedDelta = (Long) restoredSide.get("clippedSamples") - (Long) sourceSide.get("clippedSamples");
        Double floorDelta = delta(nested(restoredSide, "noiseFloor", "rmsDbfs"), nested(sourceSide, "noiseFloor", "rmsDbfs"));
        Double flatnessDelta = delta(nested(restoredSide, "noiseFloor", "spectralFlatness"),
                nested(sourceSide, "noiseFloor", "spectralFlatness"));
        delta.put("snrDb", snrDelta);
        delta.put("segmentalSnrDb", segDelta);
        delta.put("clippedSamples", clippedDelta);
        delta.put("noiseFloorDbfs", floorDelta);
        delta.put("noiseFloorSpectralFlatness", flatnessDelta);
        metrics.put("delta", delta);
        document.put("metrics", metrics);
        Map<String, Object> verdict = verdict(snrDelta, segDelta, clippedDelta, floorDelta, referencePcm != null);
        document.put("verdict", verdict);
        Map<String, Object> transcript = new LinkedHashMap<>();
        if (request.transcript() == null) {
            transcript.put("status", "NOT_REQUESTED");
        } else {
            transcript.putAll(transcribeDiff(request.transcript(), whisper, source, restored, reference, sourcePcm,
                    restoredPcm, referencePcm, tenantId, principalId));
        }
        document.put("transcript", transcript);
        document.put("definitions", definitions());
        document.put("scope", "DEV_ONLY");
        document.put("note", "Numbers measured from decoded PCM16 samples. A verdict is derived from those numbers only; "
                + "without a clean reference no quality improvement is claimed. No perceptual-quality, rights, approval "
                + "or delivery claim.");

        byte[] bytes;
        try {
            bytes = JSON.writeValueAsBytes(document);
        } catch (RuntimeException failure) {
            throw new AudioRegistrationFailedException(failure);
        }
        if (bytes.length > MAX_COMPARISON_DOCUMENT_BYTES) {
            throw new AudioRefusedException(422, "COMPARISON_LIMIT_EXCEEDED", "the comparison report exceeds its byte ceiling", Map.of());
        }
        Map<String, Object> lineage = new LinkedHashMap<>();
        lineage.put("comparisonSchema", SCHEMA_COMPARISON);
        lineage.put("scope", "DEV_ONLY");
        lineage.put("kind", KIND_COMPARISON);
        lineage.put("requestId", request.requestId());
        lineage.put("source", sourceRef(source));
        lineage.put("restored", sourceRef(restored));
        if (reference != null) lineage.put("reference", sourceRef(reference));
        lineage.put("rightsDecision", sourceRights + (referenceRights == null ? "" : ";" + referenceRights));
        lineage.put("transcript", Map.of("status", String.valueOf(transcript.get("status"))));
        lineage.put("note", "Measured comparison report; derived data only, the compared versions are unchanged.");
        Map<String, Object> metadata = new LinkedHashMap<>(lineage);
        metadata.put("purpose", "audio-comparison");
        String sha = MediaDevProjectRenderRuntime.sha256Hex(bytes);
        UploadRequest upload = new UploadRequest(tenantId, principalId, "comparison-" + safeName(restored.artifactId()) + ".json",
                "application/json", bytes.length, sha, source.classification(), Duration.ofDays(30), metadata);
        MediaArtifact artifact = register(tenantId, principalId, upload, "compare", request.requestId(), bytes, sha);
        return new AudioOutput("COMPARISON", artifact, lineage, document, false);
    }

    private Map<String, Object> side(MediaDevAudioWav.Pcm pcm, MediaDevAudioWav.Pcm reference) {
        Map<String, Object> side = new LinkedHashMap<>();
        side.put("clippedSamples", MediaDevAudioMetrics.clippedSamples(pcm));
        side.put("peakAbs", MediaDevAudioMetrics.peak(pcm));
        side.put("rmsDbfs", finite(MediaDevAudioMetrics.rmsDbfs(pcm)));
        MediaDevAudioMetrics.NoiseFloor floor = MediaDevAudioMetrics.noiseFloor(pcm);
        Map<String, Object> floorView = null;
        if (floor != null) {
            floorView = new LinkedHashMap<>();
            floorView.put("rmsDbfs", finite(floor.rmsDbfs()));
            floorView.put("spectralFlatness", finite(floor.spectralFlatness()));
            floorView.put("frames", floor.frames());
        }
        side.put("noiseFloor", floorView);
        side.put("snrDb", reference == null ? null : finite(MediaDevAudioMetrics.snrDb(pcm, reference)));
        side.put("segmentalSnrDb", reference == null ? null : finite(MediaDevAudioMetrics.segmentalSnrDb(pcm, reference)));
        return side;
    }

    private static Double finite(Double value) {
        return value == null || value.isNaN() || value.isInfinite() ? null : value;
    }

    private static Double delta(Object after, Object before) {
        if (!(after instanceof Number a) || !(before instanceof Number b)) return null;
        return a.doubleValue() - b.doubleValue();
    }

    private static Object nested(Map<String, Object> side, String key, String leaf) {
        return side.get(key) instanceof Map<?, ?> map ? map.get(leaf) : null;
    }

    /** Verdicts come only from the numbers; without a reference the quality verdict is NOT_MEASURED. */
    static Map<String, Object> verdict(Double snrDelta, Double segDelta, long clippedDelta, Double floorDelta,
                                       boolean hasReference) {
        Map<String, Object> verdict = new LinkedHashMap<>();
        verdict.put("snr", level(snrDelta, VERDICT_EPSILON_DB, true));
        verdict.put("segmentalSnr", level(segDelta, VERDICT_EPSILON_DB, true));
        verdict.put("clipping", clippedDelta < 0 ? "REDUCED" : clippedDelta > 0 ? "INCREASED" : "UNCHANGED");
        verdict.put("noiseFloorLevel", floorDelta == null ? "NOT_MEASURED"
                : floorDelta <= -1.0 ? "LOWER" : floorDelta >= 1.0 ? "HIGHER" : "UNCHANGED");
        String overall;
        if (!hasReference || snrDelta == null || segDelta == null) {
            overall = "NOT_MEASURED_AGAINST_REFERENCE";
        } else if (snrDelta >= VERDICT_EPSILON_DB && segDelta >= VERDICT_EPSILON_DB) {
            overall = "IMPROVED";
        } else if (snrDelta <= -VERDICT_EPSILON_DB && segDelta <= -VERDICT_EPSILON_DB) {
            overall = "DEGRADED";
        } else if (snrDelta > -VERDICT_EPSILON_DB && segDelta > -VERDICT_EPSILON_DB
                && snrDelta < VERDICT_EPSILON_DB && segDelta < VERDICT_EPSILON_DB) {
            overall = "NO_MEASURABLE_CHANGE";
        } else {
            overall = "MIXED";
        }
        verdict.put("overall", overall);
        return verdict;
    }

    private static String level(Double delta, double epsilon, boolean higherIsBetter) {
        if (delta == null) return "NOT_MEASURED";
        if (delta >= epsilon) return higherIsBetter ? "IMPROVED" : "DEGRADED";
        if (delta <= -epsilon) return higherIsBetter ? "DEGRADED" : "IMPROVED";
        return "UNCHANGED";
    }

    private Map<String, Object> transcribeDiff(TranscriptRequest request, LocalWhisperCppRunner whisper, MediaArtifact source,
                                               MediaArtifact restored, MediaArtifact reference, MediaDevAudioWav.Pcm sourcePcm,
                                               MediaDevAudioWav.Pcm restoredPcm, MediaDevAudioWav.Pcm referencePcm,
                                               String tenantId, String principalId) {
        Map<String, Object> out = new LinkedHashMap<>();
        try {
            String sourceText = whisperText(whisper, readContent(tenantId, principalId, source), request.language());
            String restoredText = whisperText(whisper, readContent(tenantId, principalId, restored), request.language());
            String clean;
            String cleanFrom;
            if (request.referenceText() != null) {
                clean = request.referenceText();
                cleanFrom = "REFERENCE_TEXT";
            } else {
                clean = whisperText(whisper, readContent(tenantId, principalId, reference), request.language());
                cleanFrom = "WHISPER_ON_REFERENCE";
            }
            Double sourceWer = MediaDevAudioMetrics.wordErrorRate(clean, sourceText);
            Double restoredWer = MediaDevAudioMetrics.wordErrorRate(clean, restoredText);
            out.put("status", sourceWer == null || restoredWer == null ? "NOT_MEASURED" : "MEASURED");
            out.put("engine", "whisper.cpp/" + stt.providerVersion() + "+" + LocalWhisperCppSttProvider.MODEL_KEY);
            out.put("language", request.language());
            out.put("cleanTranscriptFrom", cleanFrom);
            out.put("cleanText", clean);
            out.put("sourceText", sourceText);
            out.put("restoredText", restoredText);
            out.put("sourceWordErrorRate", sourceWer);
            out.put("restoredWordErrorRate", restoredWer);
            if (sourceWer != null && restoredWer != null) {
                out.put("deltaWordErrorRate", restoredWer - sourceWer);
                out.put("intelligibility", restoredWer < sourceWer ? "IMPROVED"
                        : restoredWer > sourceWer ? "REGRESSED" : "UNCHANGED");
                out.put("wordsInCleanText", MediaDevAudioMetrics.words(clean).size());
            }
            return out;
        } catch (LocalSpeechException failure) {
            throw new AudioRefusedException(503, "AUDIO_TRANSCRIPT_UNAVAILABLE",
                    "the local recognizer did not complete; nothing was registered, retry the same requestId", Map.of());
        }
    }

    private static String whisperText(LocalWhisperCppRunner runner, byte[] wav, String language)
            throws LocalSpeechException {
        byte[] mono16k = PcmWav.toMono16k(wav);
        return runner.transcribe(mono16k, language, Duration.ofMinutes(5), BoundedProcessRunner.CancellationToken.NEVER)
                .text().strip();
    }

    private static Map<String, Object> definitions() {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("snrDb", "10*log10(sum(ref^2)/sum((x-ref)^2)) over all samples; computed only against a supplied clean reference");
        d.put("segmentalSnrDb", "mean of per-20ms-frame SNR against the reference, each clamped to [-10, 35] dB");
        d.put("clippedSamples", "samples in a run of >=3 identical values with magnitude >= max(1024, 25% of channel peak) (flat-top plateaus)");
        d.put("noiseFloor", "quietest 10% of 1024-sample Hann frames of the mono mix: RMS in dBFS and spectral flatness "
                + "(geometric/arithmetic mean of the averaged power spectrum; 1.0 white, near 0 tonal)");
        d.put("wordErrorRate", "word edit distance to the clean transcript divided by its word count (lowercased words)");
        return d;
    }

    // ---- reopen / replay ----

    public Optional<AudioOutput> reopen(String tenantId, String principalId, String artifactId) {
        Optional<MediaArtifact> found = runtime.artifact(tenantId, principalId, artifactId);
        if (found.isEmpty()) return Optional.empty();
        MediaArtifact artifact = found.get();
        Object restoration = artifact.metadata().get("restorationSchema");
        Object comparison = artifact.metadata().get("comparisonSchema");
        if (SCHEMA_RESTORATION.equals(restoration) && "audio/wav".equals(artifact.contentType())) {
            return Optional.of(new AudioOutput("RESTORATION", artifact, lineageOf(artifact), null, true));
        }
        if (SCHEMA_COMPARISON.equals(comparison)) {
            ByteArrayOutputStream content = new ByteArrayOutputStream();
            try {
                runtime.copyArtifactContent(tenantId, principalId, artifact.artifactId(), artifact.version(), content,
                        MAX_COMPARISON_DOCUMENT_BYTES).orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
                @SuppressWarnings("unchecked")
                Map<String, Object> document = JSON.readValue(content.toByteArray(), Map.class);
                return Optional.of(new AudioOutput("COMPARISON", artifact, lineageOf(artifact), document, true));
            } catch (IOException | RuntimeException unreadable) {
                if (unreadable instanceof MediaDevProjectRenderRuntime.SourceVersionUnavailableException) return Optional.empty();
                throw new AudioRegistrationFailedException(unreadable);
            }
        }
        return Optional.empty();
    }

    private AudioOutput replay(String tenantId, String principalId, List<OutputRef> outputs, String lane) {
        OutputRef ref = outputs.getFirst();
        return reopen(tenantId, principalId, ref.artifactId())
                .filter(found -> found.artifact().version().value().equals(ref.versionId()))
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(lane));
    }

    // ---- shared helpers ----

    private MediaArtifact exactVersion(String tenantId, String principalId, String artifactId, String versionId) {
        MediaArtifact found = runtime.artifact(tenantId, principalId, artifactId)
                .orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
        if (!found.version().value().equals(versionId)) {
            throw new AudioRefusedException(409, "SOURCE_VERSION_STALE",
                    "the named version is not the current version of this artifact; reload it",
                    Map.of("requestedVersionId", versionId, "currentVersionId", found.version().value()));
        }
        return found;
    }

    private MediaDevAudioWav.Pcm decode(String tenantId, String principalId, MediaArtifact artifact) {
        if (!WAV_TYPES.contains(artifact.contentType().toLowerCase(Locale.ROOT))) {
            throw new AudioRefusedException(422, "SOURCE_FORMAT_NOT_SUPPORTED",
                    "audio restoration requires an audio/wav (PCM16) artifact version", Map.of());
        }
        if (artifact.sizeBytes() > MAX_SOURCE_BYTES) {
            throw new AudioRefusedException(422, "AUDIO_LIMIT_EXCEEDED", "the audio exceeds the byte ceiling",
                    Map.of("maxBytes", MAX_SOURCE_BYTES));
        }
        byte[] bytes = readContent(tenantId, principalId, artifact);
        if (!MediaDevProjectRenderRuntime.sha256Hex(bytes).equals(artifact.sha256())) {
            throw new AudioRefusedException(502, "SOURCE_CONTENT_DIGEST_MISMATCH",
                    "the stored bytes do not match the registered digest; nothing was processed", Map.of());
        }
        try {
            return MediaDevAudioWav.parse(bytes);
        } catch (MediaDevAudioWav.WavException refused) {
            throw new AudioRefusedException(422, refused.code(), refused.getMessage(), Map.of());
        }
    }

    private byte[] readContent(String tenantId, String principalId, MediaArtifact artifact) {
        ByteArrayOutputStream staged = new ByteArrayOutputStream((int) Math.min(artifact.sizeBytes(), MAX_SOURCE_BYTES));
        try {
            runtime.copyArtifactContent(tenantId, principalId, artifact.artifactId(), artifact.version(), staged,
                    MAX_SOURCE_BYTES).orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
        } catch (IOException failure) {
            throw new IllegalStateException("artifact content could not be read", failure);
        }
        return staged.toByteArray();
    }

    private static void requireSameShape(MediaDevAudioWav.Pcm a, MediaDevAudioWav.Pcm b, String what) {
        if (a.sampleRate() != b.sampleRate() || a.channels() != b.channels() || a.frames() != b.frames()) {
            throw new AudioRefusedException(422, "COMPARISON_SHAPE_MISMATCH",
                    what + " must have the same sample rate, channels and length; no alignment is guessed",
                    Map.of("what", what));
        }
    }

    private String requireRights(String tenantId, MediaArtifact artifact) {
        Resolution resolution;
        try {
            resolution = rights.resolve(new ResolutionRequest(tenantId, artifact.artifactId(), artifact.version().value(),
                    artifact.sha256(), Scope.PROCESSING));
        } catch (RuntimeException unavailable) {
            throw new AudioRefusedException(503, "RIGHTS_AUTHORITY_UNAVAILABLE",
                    "source rights and consent could not be resolved; nothing was processed", Map.of("scope", "PROCESSING"));
        }
        return switch (resolution.verdict()) {
            case ADMITTED -> "rights-attestation:" + String.join(",", resolution.attestationIds());
            case UNAVAILABLE -> throw new AudioRefusedException(503, "RIGHTS_AUTHORITY_UNAVAILABLE",
                    "source rights and consent could not be resolved; nothing was processed", Map.of("scope", "PROCESSING"));
            case DENIED -> throw denied("RIGHTS_DECISION_DENIED");
            case REVOKED -> throw denied("RIGHTS_DECISION_REVOKED");
            case STALE -> throw denied("RIGHTS_DECISION_STALE");
            case MISMATCH -> throw denied("RIGHTS_DECISION_MISMATCH");
        };
    }

    private static AudioRefusedException denied(String code) {
        return new AudioRefusedException(403, code,
                "source rights and consent do not admit this operation; nothing was processed or registered",
                Map.of("scope", "PROCESSING"));
    }

    private MediaArtifact register(String tenantId, String principalId, UploadRequest upload, String lane, String requestId,
                                   byte[] bytes, String sha) {
        // One registration per (principal, lane, requestId): a retry after an UNKNOWN run collides in the durable
        // idempotency store instead of creating a second artifact.
        String idempotencyKey = "dev-audio:" + lane + ":" + MediaDevProjectRenderRuntime.sha256Hex(
                (tenantId + "\u0000" + principalId + "\u0000" + requestId).getBytes(StandardCharsets.UTF_8));
        MediaDevProjectRenderRuntime.Registered registered;
        try {
            registered = registrar.register(tenantId, principalId, upload, idempotencyKey, bytes);
        } catch (IllegalArgumentException conflict) {
            if (conflict.getMessage() != null && conflict.getMessage().contains("Idempotency-Key")) {
                throw new AudioRequestReusedException();
            }
            throw new AudioRegistrationFailedException(conflict);
        } catch (RuntimeException failure) {
            throw new AudioRegistrationFailedException(failure);
        }
        if (!registered.artifact().sha256().equals(sha)) {
            throw new AudioRegistrationFailedException(
                    new IllegalStateException("registered artifact digest does not match produced bytes"));
        }
        return registered.artifact();
    }

    private static Map<String, Object> sourceRef(MediaArtifact artifact) {
        Map<String, Object> ref = new LinkedHashMap<>();
        ref.put("artifactId", artifact.artifactId());
        ref.put("artifactVersionId", artifact.version().value());
        ref.put("sha256", artifact.sha256());
        ref.put("contentType", artifact.contentType());
        return ref;
    }

    static Map<String, Object> lineageOf(MediaArtifact artifact) {
        Map<String, Object> lineage = new LinkedHashMap<>();
        for (String key : LINEAGE_KEYS) {
            if (artifact.metadata().containsKey(key)) lineage.put(key, artifact.metadata().get(key));
        }
        return lineage;
    }

    private static String safeName(String value) {
        String safe = value.replaceAll("[^A-Za-z0-9._-]", "_");
        return safe.length() > 64 ? safe.substring(0, 64) : safe;
    }

    private static String boundedId(String value, String name) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw new IllegalArgumentException(name + " must be a 1-128 character opaque id");
        }
        return value;
    }
}
