package com.ghatana.media.launcher;

import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Stream;

/**
 * DEV_ONLY stems, foley, mix and master (J-17 {@code media.dev.outcome-music-effects-master}).
 *
 * <p><b>Lawful inputs.</b> A stem is either (a) ORIGINAL audio Media synthesizes itself from a typed generator spec
 * (tones, chords, drum hits, noise-based foley; no model, no third-party sample; the spec is the provenance and the
 * mix re-derives the stem from it, bit for bit, to prove it is Media's own output), or (b) a user-uploaded WAV that
 * carries an ADMITTED {@code PROCESSING} rights statement resolved on every call, replays included. A missing or revoked
 * statement is a typed 403 and nothing is read or registered. No rights clearance is claimed that was not made.</p>
 *
 * <p><b>Master.</b> The placed stems (gain, pan, sample-exact start, linear fades) are summed in double precision and
 * landed on an integrated-loudness target under a true-peak ceiling by {@link MediaDevMasterDsp#master}; the result is a
 * stored 16-bit stereo WAV, a lossless FLAC (re-decoded by FFmpeg and compared sample for sample) and a JSON report whose
 * numbers are measured on the exact output samples, with lineage to every stem. A silent mix, an unreachable target or a
 * gain beyond the cap is a typed abstention (422), never unbounded gain.</p>
 *
 * <p><b>Exactly once.</b> The durable request ledger maps a requestId to its outputs; registration keys are derived from
 * the content request, so a run killed mid-encode is UNKNOWN until a retry (or a takeover after a launcher restart)
 * completes it with exactly one set of artifacts.</p>
 */
final class MediaDevMasterRuntime {
    static final String SCHEMA_STEM = "media.dev.stem.v1";
    static final String SCHEMA_MASTER = "media.dev.master.v1";
    static final String SCHEMA_REPORT = "media.dev.master-report.v1";
    static final String KIND_STEM = "STEM_GENERATED";
    static final String KIND_WAV = "MASTER_WAV";
    static final String KIND_FLAC = "MASTER_FLAC";
    static final String KIND_REPORT = "MASTER_REPORT";
    static final String LANE_STEM = "master.stem";
    static final String LANE_MASTER = "master.mix";
    static final int MAX_STEM_BYTES = 8 * 1024 * 1024;
    static final long MAX_AGGREGATE_BYTES = 32L * 1024 * 1024;
    static final int MAX_DOCUMENT_BYTES = 1024 * 1024;
    private static final Duration ENCODE_TIMEOUT = Duration.ofMinutes(2);
    private static final Set<String> WAV_TYPES = Set.of("audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave");
    // Map keys are sorted so every digest and stored document is independent of Map implementation and JVM instance
    // (Map.of iteration order is randomized per JVM; a restart must not change a request fingerprint or a stored report).
    private static final ObjectMapper JSON = JsonMapper.builder()
            .enable(tools.jackson.databind.SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS).build();
    private static final List<String> LINEAGE_KEYS = List.of("stemSchema", "masterSchema", "scope", "kind", "generatorSpec",
            "generatorSpecSha256", "generator", "format", "specSha256", "stems", "sources", "parent", "siblings", "target",
            "measurement", "rightsDecision", "engine", "claims");

    /** A typed refusal with an HTTP status; carries no request content or process output. */
    static final class MasterRefusedException extends RuntimeException {
        private final int status;
        private final String code;
        private final Map<String, Object> details;

        MasterRefusedException(int status, String code, String message, Map<String, Object> details) {
            super(message, null, false, false);
            this.status = status;
            this.code = code;
            this.details = details;
        }

        int status() { return status; }
        String code() { return code; }
        Map<String, Object> details() { return details; }
    }

    /** The FFmpeg encode did not finish (killed, timed out): the outcome is UNKNOWN and nothing was registered. */
    static final class MasterOutcomeUnknownException extends RuntimeException {
        MasterOutcomeUnknownException(String phase) {
            super("the " + phase + " process did not finish; the outcome is unknown", null, false, false);
        }
    }

    static final class MasterRequestReusedException extends IllegalStateException {
        MasterRequestReusedException() { super("requestId was already used with a different master request"); }
    }

    static final class MasterRegistrationFailedException extends IllegalStateException {
        MasterRegistrationFailedException(Throwable cause) {
            super("the master output could not be registered as an immutable artifact", cause);
        }
    }

    record StemResult(MediaArtifact artifact, Map<String, Object> lineage, boolean replayed)
            implements MediaDevRenderAdmission.ReplayAware {
        @Override public boolean replayedResult() { return replayed; }
    }

    record MasterResult(MediaArtifact wav, MediaArtifact flac, MediaArtifact report, Map<String, Object> document,
                        boolean replayed) implements MediaDevRenderAdmission.ReplayAware {
        @Override public boolean replayedResult() { return replayed; }
    }

    /** A stem visible to the caller, how it was classified and what admitted it. */
    private record Resolved(MediaArtifact artifact, boolean generated, MediaDevMasterSpec.Stem generator,
                            Resolution resolution, String firstPath) { }

    private record Loaded(Resolved resolved, MediaDevAudioWav.Pcm pcm) { }

    private final MediaRuntime runtime;
    private final Path ffmpeg;
    private final RightsConsentResolver rights;
    private final MediaDevProjectRenderRuntime.OutputRegistrar registrar;
    private final MediaDevRequestLedger ledger;
    private volatile String ffmpegVersion;

    MediaDevMasterRuntime(MediaRuntime runtime, Path ffmpeg, RightsConsentResolver rights,
                          MediaDevProjectRenderRuntime.OutputRegistrar registrar, MediaDevRequestLedger ledger) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        if (ffmpeg != null && !ffmpeg.isAbsolute()) throw new IllegalArgumentException("ffmpeg path must be absolute");
        this.ffmpeg = ffmpeg;
        this.rights = rights == null ? RightsConsentResolver.unavailable() : rights;
        this.registrar = Objects.requireNonNull(registrar, "registrar");
        this.ledger = Objects.requireNonNull(ledger, "ledger");
    }

    /** Stem generation needs no external tool; the master needs the absolute FFmpeg path (never resolved through PATH). */
    static MediaDevMasterRuntime compose(MediaRuntime runtime, Map<String, String> environment,
                                         RightsConsentResolver rights, MediaDevRequestLedger ledger) {
        String configured = environment.get(MediaDevProjectRenderRuntime.FFMPEG_ENV);
        Path ffmpeg = configured == null || configured.isBlank() ? null : Path.of(configured);
        return new MediaDevMasterRuntime(runtime, ffmpeg, rights, MediaDevProjectRenderRuntime.canonicalRegistrar(runtime),
                ledger);
    }

    Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("scope", "DEV_ONLY");
        out.put("stemReady", true);
        out.put("masterReady", ffmpeg != null);
        out.put("stemSchema", MediaDevMasterSpec.STEM_SCHEMA);
        Map<String, Object> limits = new LinkedHashMap<>();
        limits.put("sampleRateHz", MediaDevMasterSpec.RATE);
        limits.put("channels", List.of(1, 2));
        limits.put("minStemMs", MediaDevMasterSpec.MIN_STEM_MS);
        limits.put("maxStemMs", MediaDevMasterSpec.MAX_STEM_MS);
        limits.put("maxPlacements", MediaDevMasterSpec.MAX_PLACEMENTS);
        limits.put("maxMasterFrames", MediaDevMasterSpec.MAX_MASTER_FRAMES);
        limits.put("minMasterFrames", MediaDevMasterSpec.MIN_MASTER_FRAMES);
        limits.put("maxUploadedStemBytes", MAX_STEM_BYTES);
        limits.put("maxAggregateStemBytes", MAX_AGGREGATE_BYTES);
        limits.put("gainDb", List.of(MediaDevMasterSpec.MIN_GAIN_DB, MediaDevMasterSpec.MAX_GAIN_DB));
        limits.put("maxPreLimiterGainDb", MediaDevMasterDsp.MAX_PRE_GAIN_DB);
        out.put("limits", limits);
        out.put("generators", Map.of("kinds", List.of("TONE", "CHORD", "DRUM", "FOLEY"),
                "drums", List.of("KICK", "SNARE", "HAT"), "foley", List.of("FOOTSTEP", "WHOOSH", "IMPACT"),
                "origin", "ORIGINAL_PROCEDURAL_SYNTHESIS (no model, no third-party sample)"));
        out.put("target", Map.of("integratedLufs", Map.of("min", -30.0, "max", -9.0, "default", -16.0),
                "truePeakDbtp", Map.of("min", -6.0, "max", -0.1, "default", -1.0)));
        out.put("outputs", List.of("audio/wav (PCM16 stereo 48 kHz)", "audio/flac (lossless)", "application/json report"));
        out.put("rightsAuthority", Map.of("resolverId", rights.resolverId(), "ready", rights.ready(),
                "scope", Scope.PROCESSING.name(), "appliesTo", "uploaded stems"));
        return out;
    }

    // ------------------------------------------------------------------ stems

    StemResult generateStem(String tenantId, String principalId, MediaDevMasterSpec.StemRequest request) {
        Objects.requireNonNull(request, "request");
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "audio_stem", tenantId, () -> {
            String specSha = MediaDevProjectRenderRuntime.sha256Hex(json(request.stem().canonical()));
            String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.master.stem.v1", specSha);
            return ledger.run(tenantId, principalId, LANE_STEM, request.requestId(), fingerprint,
                    outputs -> replayStem(tenantId, principalId, outputs),
                    () -> produceStem(tenantId, principalId, request.stem(), specSha),
                    result -> List.of(new OutputRef("stem", result.artifact().artifactId(), result.artifact().version().value())),
                    MasterRequestReusedException::new);
        });
    }

    private StemResult produceStem(String tenantId, String principalId, MediaDevMasterSpec.Stem stem, String specSha) {
        short[] pcm = MediaDevMasterDsp.synthesize(stem);
        byte[] wav = MediaDevAudioWav.write(new MediaDevAudioWav.Pcm(MediaDevMasterSpec.RATE, stem.channels(), pcm),
                ownerComment("original procedural stem", tenantId, principalId));
        double peak = 0;
        double energy = 0;
        for (short sample : pcm) {
            peak = Math.max(peak, Math.abs((int) sample));
            energy += (double) sample * sample;
        }
        Map<String, Object> lineage = new LinkedHashMap<>();
        lineage.put("stemSchema", SCHEMA_STEM);
        lineage.put("scope", "DEV_ONLY");
        lineage.put("kind", KIND_STEM);
        lineage.put("generatorSpec", stem.canonical());
        lineage.put("generatorSpecSha256", specSha);
        Map<String, Object> generator = new LinkedHashMap<>();
        generator.put("algorithm", MediaDevMasterDsp.SYNTH_ALGORITHM);
        generator.put("version", MediaDevMasterDsp.SYNTH_VERSION);
        generator.put("arithmetic", "StrictMath, SplitMix64 noise, 16-bit scale 32767, no dither");
        generator.put("origin", "ORIGINAL_PROCEDURAL_SYNTHESIS");
        generator.put("thirdPartyMaterial", false);
        lineage.put("generator", generator);
        lineage.put("format", Map.of("sampleRate", MediaDevMasterSpec.RATE, "channels", stem.channels(),
                "bitsPerSample", 16, "frames", stem.frames()));
        Map<String, Object> measurement = new LinkedHashMap<>();
        measurement.put("samplePeakDbfs", MediaDevMasterDsp.db(peak / 32768.0));
        measurement.put("rmsDbfs", MediaDevMasterDsp.db(Math.sqrt(energy / pcm.length) / 32768.0));
        lineage.put("measurement", measurement);
        Map<String, Object> rightsDecision = new LinkedHashMap<>();
        rightsDecision.put("kind", "ORIGINAL_PROCEDURAL_SYNTHESIS");
        rightsDecision.put("basis", "generated by Media from the recorded generator spec; contains no third-party "
                + "material, sample library or model output");
        rightsDecision.put("legalClearanceClaimed", false);
        rightsDecision.put("productionGrant", false);
        lineage.put("rightsDecision", rightsDecision);
        lineage.put("claims", "DEV_ONLY original procedural audio; no rights clearance, quality, approval or production claim");
        MediaArtifact artifact = registerOne(tenantId, principalId, "dev-stem:" + specSha, wav, "audio/wav",
                "stem-" + stem.kind().name().toLowerCase(Locale.ROOT) + ".wav", lineage);
        return new StemResult(artifact, lineage, false);
    }

    private StemResult replayStem(String tenantId, String principalId, List<OutputRef> outputs) {
        OutputRef ref = outputs.getFirst();
        return reopenStem(tenantId, principalId, ref.artifactId())
                .filter(found -> found.artifact().version().value().equals(ref.versionId()))
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE_STEM));
    }

    Optional<StemResult> reopenStem(String tenantId, String principalId, String artifactId) {
        return runtime.artifact(tenantId, principalId, artifactId)
                .filter(artifact -> SCHEMA_STEM.equals(artifact.metadata().get("stemSchema"))
                        && KIND_STEM.equals(artifact.metadata().get("kind")))
                .map(artifact -> new StemResult(artifact, lineageOf(artifact), true));
    }

    // ------------------------------------------------------------------ master

    MasterResult master(String tenantId, String principalId, MediaDevMasterSpec.Master request) {
        Objects.requireNonNull(request, "request");
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "audio_master", tenantId,
                () -> masterAdmitted(tenantId, principalId, request));
    }

    private MasterResult masterAdmitted(String tenantId, String principalId, MediaDevMasterSpec.Master request) {
        if (ffmpeg == null) {
            throw new MasterRefusedException(503, "AUDIO_ENGINE_UNAVAILABLE",
                    "no absolute FFmpeg path is configured for the DEV_ONLY master encode", Map.of());
        }
        Map<String, Resolved> resolved = resolve(tenantId, principalId, request);
        List<Loaded> loaded = new ArrayList<>();
        Map<String, Loaded> byKey = new LinkedHashMap<>();
        for (Map.Entry<String, Resolved> entry : resolved.entrySet()) {
            Loaded stem = load(tenantId, principalId, entry.getValue());
            byKey.put(entry.getKey(), stem);
            loaded.add(stem);
        }
        // Frame arithmetic is exact and checked before any DSP.
        int frames = 0;
        for (int i = 0; i < request.placements().size(); i++) {
            MediaDevMasterSpec.Placement p = request.placements().get(i);
            int length = byKey.get(key(p)).pcm().frames();
            String path = "$.stems[" + i + "]";
            long end = (long) p.startFrame() + length;
            if (end > MediaDevMasterSpec.MAX_MASTER_FRAMES) {
                throw MediaDevMasterSpec.budget(path + ".startFrame", "master frames", MediaDevMasterSpec.MAX_MASTER_FRAMES, end);
            }
            if ((long) p.fadeInFrames() + p.fadeOutFrames() > length) {
                throw MediaDevMasterSpec.invalid(path + ".fadeOutFrames", "fadeInFrames + fadeOutFrames must not exceed the stem length ("
                        + length + " frames)");
            }
            frames = Math.max(frames, (int) end);
        }
        if (request.durationFrames() != null) {
            if (request.durationFrames() < frames) {
                throw new MasterRefusedException(422, "MASTER_STEM_PAST_END",
                        "a stem extends past durationFrames; nothing is trimmed implicitly",
                        Map.of("path", "$.durationFrames", "requiredFrames", frames));
            }
            frames = request.durationFrames();
        }
        if (frames < MediaDevMasterSpec.MIN_MASTER_FRAMES) {
            throw new MasterRefusedException(422, "MASTER_TOO_SHORT_TO_MEASURE",
                    "a master shorter than one 400 ms gating block has no defined integrated loudness",
                    Map.of("path", request.durationFrames() == null ? "$.stems" : "$.durationFrames",
                            "frames", frames, "minimumFrames", MediaDevMasterSpec.MIN_MASTER_FRAMES));
        }
        final int masterFrames = frames;
        Map<String, Object> canonical = request.canonical();
        canonical.put("resolvedDurationFrames", masterFrames);
        String specSha = MediaDevProjectRenderRuntime.sha256Hex(json(canonical));
        StringBuilder digests = new StringBuilder();
        for (Loaded stem : loaded) digests.append(stem.resolved().artifact().sha256()).append(';');
        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.master.v1", specSha, digests.toString());
        return ledger.run(tenantId, principalId, LANE_MASTER, request.requestId(), fingerprint,
                outputs -> replayMaster(tenantId, principalId, outputs),
                () -> produceMaster(tenantId, principalId, request, byKey, masterFrames, specSha, fingerprint),
                result -> List.of(
                        new OutputRef("report", result.report().artifactId(), result.report().version().value()),
                        new OutputRef("wav", result.wav().artifactId(), result.wav().version().value()),
                        new OutputRef("flac", result.flac().artifactId(), result.flac().version().value())),
                MasterRequestReusedException::new);
    }

    private static String key(MediaDevMasterSpec.Placement p) {
        return p.artifactId() + "@" + p.artifactVersionId();
    }

    /** Exact visible version, type, size and origin or rights admission; no content is read before all pass. */
    private Map<String, Resolved> resolve(String tenantId, String principalId, MediaDevMasterSpec.Master request) {
        Map<String, Resolved> out = new LinkedHashMap<>();
        long aggregate = 0;
        for (int i = 0; i < request.placements().size(); i++) {
            MediaDevMasterSpec.Placement p = request.placements().get(i);
            String path = "$.stems[" + i + "]";
            if (out.containsKey(key(p))) continue;
            MediaArtifact artifact = runtime.artifact(tenantId, principalId, p.artifactId())
                    .filter(found -> found.version().value().equals(p.artifactVersionId()))
                    .orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
            if (!WAV_TYPES.contains(artifact.contentType().toLowerCase(Locale.ROOT))) {
                throw new MasterRefusedException(422, "STEM_FORMAT_NOT_SUPPORTED",
                        "a stem must be an audio/wav (PCM16) artifact version", Map.of("path", path + ".artifactId"));
            }
            if (artifact.sizeBytes() > MAX_STEM_BYTES) {
                throw MediaDevMasterSpec.budget(path + ".artifactId", "stem bytes", MAX_STEM_BYTES, artifact.sizeBytes());
            }
            aggregate += artifact.sizeBytes();
            if (aggregate > MAX_AGGREGATE_BYTES) {
                throw MediaDevMasterSpec.budget("$.stems", "aggregate stem bytes", MAX_AGGREGATE_BYTES, aggregate);
            }
            MediaDevMasterSpec.Stem generator = generatorOf(tenantId, principalId, artifact);
            if (generator != null) {
                out.put(key(p), new Resolved(artifact, true, generator, null, path));
            } else {
                out.put(key(p), new Resolved(artifact, false, null, admit(tenantId, artifact, path + ".artifactId"), path));
            }
        }
        return out;
    }

    /**
     * The generator spec when this artifact is provably Media's own procedural output: the recorded spec re-synthesizes
     * to exactly the stored digest. Metadata alone is never trusted (an upload can carry any metadata).
     */
    private static MediaDevMasterSpec.Stem generatorOf(String tenantId, String principalId, MediaArtifact artifact) {
        if (!SCHEMA_STEM.equals(artifact.metadata().get("stemSchema"))
                || !(artifact.metadata().get("generatorSpec") instanceof Map<?, ?> spec)) return null;
        try {
            MediaDevMasterSpec.Stem stem = MediaDevMasterSpec.parseStem(spec, "$");
            byte[] wav = MediaDevAudioWav.write(new MediaDevAudioWav.Pcm(MediaDevMasterSpec.RATE, stem.channels(),
                    MediaDevMasterDsp.synthesize(stem)), ownerComment("original procedural stem", tenantId, principalId));
            return MediaDevProjectRenderRuntime.sha256Hex(wav).equals(artifact.sha256()) ? stem : null;
        } catch (MasterRefusedException notGenerated) {
            return null;
        }
    }

    private Resolution admit(String tenantId, MediaArtifact artifact, String path) {
        Resolution resolution;
        try {
            resolution = rights.resolve(new ResolutionRequest(tenantId, artifact.artifactId(),
                    artifact.version().value(), artifact.sha256(), Scope.PROCESSING));
        } catch (RuntimeException failure) {
            resolution = Resolution.unavailable(rights.resolverId());
        }
        if (resolution.admitted()) return resolution;
        boolean unavailable = resolution.verdict() == Verdict.UNAVAILABLE;
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("scope", "PROCESSING");
        details.put("path", path);
        details.put("artifactId", artifact.artifactId());
        details.put("verdict", resolution.verdict().name());
        details.put("reasons", resolution.reasons().stream().map(Enum::name).sorted().toList());
        throw new MasterRefusedException(unavailable ? 503 : 403,
                unavailable ? "RIGHTS_AUTHORITY_UNAVAILABLE" : "RIGHTS_NOT_ADMITTED",
                "an uploaded stem has no current PROCESSING rights and consent admission; nothing was mixed", details);
    }

    private Loaded load(String tenantId, String principalId, Resolved resolved) {
        MediaArtifact artifact = resolved.artifact();
        ByteArrayOutputStream content = new ByteArrayOutputStream((int) Math.max(1, artifact.sizeBytes()));
        try {
            runtime.copyArtifactContent(tenantId, principalId, artifact.artifactId(), artifact.version(), content,
                    MAX_STEM_BYTES).orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
        } catch (IOException unreadable) {
            throw new MasterRefusedException(503, "STEM_CONTENT_UNAVAILABLE",
                    "a stem could not be read; nothing was mixed", Map.of("path", resolved.firstPath()));
        }
        byte[] bytes = content.toByteArray();
        if (!MediaDevProjectRenderRuntime.sha256Hex(bytes).equals(artifact.sha256())) {
            throw new MasterRefusedException(502, "SOURCE_CONTENT_DIGEST_MISMATCH",
                    "the stored bytes do not match the registered digest; nothing was processed",
                    Map.of("path", resolved.firstPath()));
        }
        MediaDevAudioWav.Pcm pcm;
        try {
            pcm = MediaDevAudioWav.parse(bytes, true);
        } catch (MediaDevAudioWav.WavException refused) {
            throw new MasterRefusedException(422, "STEM_FORMAT_NOT_SUPPORTED", refused.getMessage(),
                    Map.of("path", resolved.firstPath() + ".artifactId", "reason", refused.code()));
        }
        if (pcm.sampleRate() != MediaDevMasterSpec.RATE) {
            throw new MasterRefusedException(422, "STEM_FORMAT_NOT_SUPPORTED",
                    "stems must be 48000 Hz; no resampling is applied",
                    Map.of("path", resolved.firstPath() + ".artifactId", "sampleRate", pcm.sampleRate()));
        }
        if (pcm.frames() > MediaDevMasterSpec.MAX_MASTER_FRAMES) {
            throw MediaDevMasterSpec.budget(resolved.firstPath() + ".artifactId", "stem frames",
                    MediaDevMasterSpec.MAX_MASTER_FRAMES, pcm.frames());
        }
        return new Loaded(resolved, pcm);
    }

    private MasterResult produceMaster(String tenantId, String principalId, MediaDevMasterSpec.Master request,
                                       Map<String, Loaded> loaded, int frames, String specSha, String fingerprint) {
        List<MediaDevMasterDsp.Placed> placed = new ArrayList<>();
        List<Map<String, Object>> stemLineage = new ArrayList<>();
        for (int i = 0; i < request.placements().size(); i++) {
            MediaDevMasterSpec.Placement p = request.placements().get(i);
            Loaded stem = loaded.get(key(p));
            MediaDevAudioWav.Pcm pcm = stem.pcm();
            placed.add(new MediaDevMasterDsp.Placed(pcm.samples(), pcm.channels(), p.gainDb(), p.pan(), p.startFrame(),
                    p.fadeInFrames(), p.fadeOutFrames()));
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("index", i);
            entry.putAll(MediaDevDubSupport.ref(stem.resolved().artifact()));
            entry.put("origin", stem.resolved().generated() ? "ORIGINAL_PROCEDURAL_SYNTHESIS" : "UPLOADED_WITH_PROCESSING_RIGHTS");
            if (stem.resolved().generated()) {
                entry.put("generatorSpec", stem.resolved().generator().canonical());
            } else {
                Map<String, Object> admission = new LinkedHashMap<>();
                admission.put("scope", "PROCESSING");
                admission.put("verdict", stem.resolved().resolution().verdict().name());
                admission.put("resolverId", stem.resolved().resolution().resolverId());
                admission.put("attestationIds", stem.resolved().resolution().attestationIds());
                entry.put("rights", admission);
            }
            entry.put("channels", pcm.channels());
            entry.put("channelHandling", pcm.channels() == 1 ? "MONO_PANNED_TO_STEREO" : "STEREO_BALANCED");
            entry.put("frames", pcm.frames());
            entry.put("gainDb", p.gainDb());
            entry.put("pan", p.pan());
            entry.put("startFrame", p.startFrame());
            entry.put("fadeInFrames", p.fadeInFrames());
            entry.put("fadeOutFrames", p.fadeOutFrames());
            stemLineage.add(entry);
        }
        double[][] bus = MediaDevMasterDsp.mix(placed, frames);
        MediaDevMasterDsp.Mastered mastered = MediaDevMasterDsp.master(bus[0], bus[1], request.targetLufs(), request.truePeakDbtp());
        String comment = ownerComment("master", tenantId, principalId);
        byte[] wav = MediaDevAudioWav.write(new MediaDevAudioWav.Pcm(MediaDevMasterSpec.RATE, 2, mastered.pcm()), comment);
        byte[] flac = encodeFlac(wav, mastered.pcm().length * 2, comment);

        // Distinct sources in first-use order; erasure and rights follow parent/sources to the derived outputs.
        List<Map<String, Object>> sources = new ArrayList<>();
        Map<String, Boolean> seen = new LinkedHashMap<>();
        Map<String, Object> parent = null;
        for (Loaded stem : loaded.values()) {
            if (seen.put(stem.resolved().artifact().artifactId() + "@" + stem.resolved().artifact().version().value(), true) != null) continue;
            Map<String, Object> ref = MediaDevDubSupport.ref(stem.resolved().artifact());
            ref.put("origin", stem.resolved().generated() ? "ORIGINAL_PROCEDURAL_SYNTHESIS" : "UPLOADED_WITH_PROCESSING_RIGHTS");
            sources.add(ref);
            if (parent == null || (!stem.resolved().generated() && "ORIGINAL_PROCEDURAL_SYNTHESIS".equals(parent.get("origin")))) parent = ref;
        }
        List<String> attestations = new ArrayList<>();
        int uploaded = 0;
        int generated = 0;
        for (Loaded stem : loaded.values()) {
            if (stem.resolved().generated()) generated++;
            else {
                uploaded++;
                attestations.addAll(stem.resolved().resolution().attestationIds());
            }
        }
        Map<String, Object> rightsDecision = new LinkedHashMap<>();
        rightsDecision.put("kind", "RIGHTS_CONSENT_ATTESTATION_AND_ORIGINAL_SYNTHESIS");
        rightsDecision.put("scope", Scope.PROCESSING.name());
        rightsDecision.put("uploadedStems", uploaded);
        rightsDecision.put("attestationIds", attestations);
        rightsDecision.put("originalProceduralStems", generated);
        rightsDecision.put("legalClearanceClaimed", false);
        rightsDecision.put("productionGrant", false);

        Map<String, Object> target = Map.of("integratedLufs", request.targetLufs(), "truePeakDbtp", request.truePeakDbtp());
        Map<String, Object> engine = new LinkedHashMap<>();
        engine.put("mixer", MediaDevMasterDsp.MASTER_ENGINE + "@" + MediaDevMasterDsp.MASTER_ENGINE_VERSION);
        engine.put("loudness", "ITU-R BS.1770 K-weighting, 400 ms blocks, 75% overlap, -70 LUFS and -10 LU gates");
        engine.put("truePeak", "Kaiser-windowed sinc, 8x oversampled on the 16-bit output (4x for the limiter)");
        engine.put("limiter", "look-ahead true-peak limiter, +-" + (2 * 48 + 1) + " frame window");
        engine.put("flacEncoder", ffmpegVersion());
        Map<String, Object> measurement = new LinkedHashMap<>();
        measurement.put("measuredOn", "the exact 16-bit output samples (the WAV, and the FLAC decoded back to them)");
        measurement.put("integratedLufs", mastered.integratedLufs());
        measurement.put("truePeakDbtp", mastered.truePeakDbtp());
        measurement.put("samplePeakDbfs", mastered.samplePeakDbfs());
        measurement.put("clippedSamples", mastered.clippedSamples());
        measurement.put("preLimiterGainDb", mastered.preGainDb());
        measurement.put("limiter", Map.of("maxGainReductionDb", mastered.maxReductionDb(), "limitedFrames", mastered.limitedFrames(),
                "internalCeilingDbtp", mastered.ceilingUsedDbtp()));
        measurement.put("solverIterations", mastered.iterations());
        measurement.put("mix", Map.of("integratedLufs", mastered.mixIntegratedLufs(), "samplePeakDbfs", mastered.mixSamplePeakDbfs(),
                "truePeakDbtp4x", mastered.mixTruePeakDbtp()));
        measurement.put("targetMet", Math.abs(mastered.integratedLufs() - request.targetLufs()) <= 0.25
                && mastered.truePeakDbtp() <= request.truePeakDbtp());
        Map<String, Object> format = Map.of("sampleRate", MediaDevMasterSpec.RATE, "channels", 2, "bitsPerSample", 16,
                "frames", frames, "durationSeconds", (double) frames / MediaDevMasterSpec.RATE);
        String claims = "DEV_ONLY mix and master: loudness and true peak are measured on the exact output samples; the "
                + "FLAC decodes bit-exactly to the WAV. No rights clearance beyond the recorded statements, no "
                + "perceptual-quality, approval or production claim";
        String wavSha = MediaDevProjectRenderRuntime.sha256Hex(wav);
        String flacSha = MediaDevProjectRenderRuntime.sha256Hex(flac);

        Map<String, Object> shared = new LinkedHashMap<>();
        shared.put("masterSchema", SCHEMA_MASTER);
        shared.put("scope", "DEV_ONLY");
        shared.put("specSha256", specSha);
        shared.put("format", format);
        shared.put("sources", sources);
        shared.put("parent", parent);
        shared.put("target", target);
        shared.put("measurement", measurement);
        shared.put("rightsDecision", rightsDecision);
        shared.put("engine", engine);
        shared.put("claims", claims);
        String keyBase = "dev-master:" + MediaDevProjectRenderRuntime.sha256Hex(tenantId + "\u0000" + principalId + "\u0000" + fingerprint);

        Map<String, Object> wavLineage = new LinkedHashMap<>(shared);
        wavLineage.put("kind", KIND_WAV);
        MediaArtifact wavArtifact = registerOne(tenantId, principalId, keyBase + ":wav", wav, "audio/wav", "master.wav", wavLineage);
        Map<String, Object> flacLineage = new LinkedHashMap<>(shared);
        flacLineage.put("kind", KIND_FLAC);
        MediaArtifact flacArtifact = registerOne(tenantId, principalId, keyBase + ":flac", flac, "audio/flac", "master.flac", flacLineage);

        Map<String, Object> document = new LinkedHashMap<>();
        document.put("schema", SCHEMA_REPORT);
        document.put("scope", "DEV_ONLY");
        document.put("specSha256", specSha);
        document.put("request", request.canonical());
        document.put("resolvedDurationFrames", frames);
        document.put("format", format);
        document.put("stems", stemLineage);
        document.put("target", target);
        document.put("measurement", measurement);
        document.put("outputs", Map.of(
                "wav", Map.of("artifactId", wavArtifact.artifactId(), "artifactVersionId", wavArtifact.version().value(),
                        "sha256", wavSha, "bytes", wav.length, "contentType", "audio/wav"),
                "flac", Map.of("artifactId", flacArtifact.artifactId(), "artifactVersionId", flacArtifact.version().value(),
                        "sha256", flacSha, "bytes", flac.length, "contentType", "audio/flac",
                        "verification", "decoded by FFmpeg and compared sample for sample with the WAV: identical")));
        document.put("rightsDecision", rightsDecision);
        document.put("engine", engine);
        document.put("claims", claims);
        Map<String, Object> reportLineage = new LinkedHashMap<>(shared);
        reportLineage.put("kind", KIND_REPORT);
        reportLineage.put("siblings", Map.of("wav", MediaDevDubSupport.ref(wavArtifact), "flac", MediaDevDubSupport.ref(flacArtifact)));
        MediaArtifact report = registerOne(tenantId, principalId, keyBase + ":report", json(document),
                "application/json", "master-report.json", reportLineage);
        return new MasterResult(wavArtifact, flacArtifact, report, document, false);
    }

    private MasterResult replayMaster(String tenantId, String principalId, List<OutputRef> outputs) {
        OutputRef ref = outputs.stream().filter(candidate -> candidate.role().equals("report")).findFirst()
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE_MASTER));
        return reopenMaster(tenantId, principalId, ref.artifactId())
                .filter(found -> found.report().version().value().equals(ref.versionId()))
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE_MASTER));
    }

    Optional<MasterResult> reopenMaster(String tenantId, String principalId, String reportArtifactId) {
        Optional<MediaArtifact> report = runtime.artifact(tenantId, principalId, reportArtifactId)
                .filter(artifact -> SCHEMA_MASTER.equals(artifact.metadata().get("masterSchema"))
                        && KIND_REPORT.equals(artifact.metadata().get("kind")));
        if (report.isEmpty()) return Optional.empty();
        if (!(report.get().metadata().get("siblings") instanceof Map<?, ?> siblings)) return Optional.empty();
        Optional<MediaArtifact> wav = sibling(tenantId, principalId, siblings.get("wav"), KIND_WAV);
        Optional<MediaArtifact> flac = sibling(tenantId, principalId, siblings.get("flac"), KIND_FLAC);
        if (wav.isEmpty() || flac.isEmpty()) return Optional.empty();
        return Optional.of(new MasterResult(wav.get(), flac.get(), report.get(),
                readDocument(tenantId, principalId, report.get()), true));
    }

    private Optional<MediaArtifact> sibling(String tenantId, String principalId, Object ref, String kind) {
        if (!(ref instanceof Map<?, ?> map) || !(map.get("artifactId") instanceof String id)
                || !(map.get("artifactVersionId") instanceof String version)) return Optional.empty();
        return runtime.artifact(tenantId, principalId, id)
                .filter(artifact -> artifact.version().value().equals(version) && kind.equals(artifact.metadata().get("kind")));
    }

    private Map<String, Object> readDocument(String tenantId, String principalId, MediaArtifact report) {
        if (report.sizeBytes() > MAX_DOCUMENT_BYTES) {
            throw new MasterRefusedException(422, "MASTER_REPORT_TOO_LARGE", "the report exceeds the byte ceiling", Map.of());
        }
        ByteArrayOutputStream content = new ByteArrayOutputStream((int) Math.max(1, report.sizeBytes()));
        try {
            runtime.copyArtifactContent(tenantId, principalId, report.artifactId(), report.version(), content,
                    MAX_DOCUMENT_BYTES).orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
            return JSON.readValue(content.toByteArray(), new TypeReference<LinkedHashMap<String, Object>>() { });
        } catch (IOException | RuntimeException unreadable) {
            if (unreadable instanceof MediaDevProjectRenderRuntime.SourceVersionUnavailableException missing) throw missing;
            throw new MasterRefusedException(422, "MASTER_REPORT_INVALID", "the stored report is not a readable JSON document", Map.of());
        }
    }

    // ------------------------------------------------------------------ encode

    /** Encodes the WAV to FLAC with the real FFmpeg and requires it to decode back to exactly the same samples. */
    private byte[] encodeFlac(byte[] wav, int pcmBytes, String comment) {
        Path dir = privateTempDirectory();
        try {
            Path in = dir.resolve("in.wav");
            Path out = dir.resolve("out.flac");
            Path decoded = dir.resolve("decoded.pcm");
            Files.write(in, wav);
            long ceiling = wav.length + 1024L * 1024;
            BoundedProcessRunner.Result encode = BoundedProcessRunner.run(List.of(ffmpeg.toString(), "-nostdin", "-hide_banner",
                    "-v", "error", "-nostats", "-i", in.toString(), "-map_metadata", "-1", "-metadata", "comment=" + comment, "-c:a", "flac",
                    "-compression_level", "8", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-y", out.toString()),
                    dir, Map.of(), ENCODE_TIMEOUT, 1024, 8192, BoundedProcessRunner.CancellationToken.NEVER, out, ceiling);
            classify(encode, "encode");
            if (!Files.isRegularFile(out) || Files.size(out) == 0) {
                throw new MasterRefusedException(502, "MASTER_ENCODE_FAILED", "the FLAC encode produced no output; nothing was registered", Map.of());
            }
            BoundedProcessRunner.Result decode = BoundedProcessRunner.run(List.of(ffmpeg.toString(), "-nostdin", "-hide_banner",
                    "-v", "error", "-nostats", "-i", out.toString(), "-f", "s16le", "-acodec", "pcm_s16le", "-y", decoded.toString()),
                    dir, Map.of(), ENCODE_TIMEOUT, 1024, 8192, BoundedProcessRunner.CancellationToken.NEVER, decoded, ceiling);
            classify(decode, "verify");
            byte[] expected = Arrays.copyOfRange(wav, 44, 44 + pcmBytes);
            if (!Files.isRegularFile(decoded) || !Arrays.equals(Files.readAllBytes(decoded), expected)) {
                throw new MasterRefusedException(502, "MASTER_ENCODE_VERIFICATION_FAILED",
                        "the FLAC does not decode to the master samples; nothing was registered", Map.of());
            }
            return Files.readAllBytes(out);
        } catch (IOException failure) {
            throw new MasterRefusedException(503, "AUDIO_ENGINE_UNAVAILABLE",
                    "the audio tools could not be run; nothing was registered", Map.of());
        } finally {
            deleteTree(dir);
        }
    }

    /** Throws unless FFmpeg exited 0. A signal exit or a timeout is UNKNOWN; any other exit is a typed failure. */
    private static void classify(BoundedProcessRunner.Result result, String phase) {
        if (result.succeeded()) return;
        boolean signalled = result.end() == BoundedProcessRunner.End.EXITED && (result.exitCode() >= 128 || result.exitCode() < 0);
        if (result.end() == BoundedProcessRunner.End.TIMED_OUT || result.end() == BoundedProcessRunner.End.CANCELLED || signalled) {
            throw new MasterOutcomeUnknownException(phase);
        }
        throw new MasterRefusedException(502, "MASTER_ENCODE_FAILED", "the " + phase + " step failed; nothing was registered", Map.of());
    }

    private String ffmpegVersion() {
        String known = ffmpegVersion;
        if (known != null) return known;
        try {
            BoundedProcessRunner.Result result = BoundedProcessRunner.run(List.of(ffmpeg.toString(), "-version"), null,
                    Map.of(), Duration.ofSeconds(20), 8192, 8192, BoundedProcessRunner.CancellationToken.NEVER, null, 0);
            String first = new String(result.stdout(), StandardCharsets.UTF_8).lines().findFirst().orElse("ffmpeg");
            known = first.length() > 120 ? first.substring(0, 120) : first;
        } catch (IOException failure) {
            known = "ffmpeg (version unavailable)";
        }
        ffmpegVersion = known;
        return known;
    }

    // ------------------------------------------------------------------ registration

    private MediaArtifact registerOne(String tenantId, String principalId, String keyPart, byte[] bytes, String contentType,
                                      String fileName, Map<String, Object> lineage) {
        String sha256 = MediaDevProjectRenderRuntime.sha256Hex(bytes);
        Map<String, Object> metadata = new LinkedHashMap<>(lineage);
        metadata.put("purpose", "audio-master-output");
        UploadRequest upload = new UploadRequest(tenantId, principalId, fileName, contentType, bytes.length, sha256,
                "INTERNAL", Duration.ofDays(30), metadata);
        // Content-derived key: the same request always maps to the same registration (exactly once, across retries and
        // launcher restarts); the durable ledger separately maps each requestId to its outputs.
        String idempotencyKey = keyPart.startsWith("dev-master:") ? keyPart
                : keyPart + ":" + MediaDevProjectRenderRuntime.sha256Hex(tenantId + "\u0000" + principalId);
        MediaDevProjectRenderRuntime.Registered registered;
        try {
            registered = registrar.register(tenantId, principalId, upload, idempotencyKey, bytes);
        } catch (IllegalArgumentException conflict) {
            if (conflict.getMessage() != null && conflict.getMessage().contains("Idempotency-Key")) {
                throw new MasterRequestReusedException();
            }
            throw new MasterRegistrationFailedException(conflict);
        } catch (RuntimeException failure) {
            throw new MasterRegistrationFailedException(failure);
        }
        MediaArtifact artifact = registered.artifact();
        if (!artifact.sha256().equals(sha256)) {
            throw new MasterRegistrationFailedException(new IllegalStateException("registered artifact digest does not match produced bytes"));
        }
        return artifact;
    }

    /** Owner-specific comment: the store keeps one artifact per (tenant, digest, size), so two owners must not share bytes. */
    static String ownerComment(String purpose, String tenantId, String principalId) {
        return "ghatana-media DEV_ONLY " + purpose + " owner=" + MediaDevProjectRenderRuntime
                .sha256Hex(tenantId + "\u0000" + principalId).substring(0, 16);
    }

    private static byte[] json(Object value) {
        try {
            return JSON.writeValueAsBytes(value);
        } catch (RuntimeException failure) {
            throw new MasterRegistrationFailedException(failure);
        }
    }

    static Map<String, Object> lineageOf(MediaArtifact artifact) {
        Map<String, Object> lineage = new LinkedHashMap<>();
        for (String key : LINEAGE_KEYS) {
            if (artifact.metadata().containsKey(key)) lineage.put(key, artifact.metadata().get(key));
        }
        return lineage;
    }

    private static Path privateTempDirectory() {
        try {
            return Files.createTempDirectory("media-dev-master-",
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        } catch (IOException failure) {
            throw new IllegalStateException("private working directory could not be created", failure);
        }
    }

    private static void deleteTree(Path dir) {
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(path -> path.toFile().delete());
        } catch (IOException ignored) {
            // best effort: the directory is private (0700) under the OS temp root
        }
    }
}
