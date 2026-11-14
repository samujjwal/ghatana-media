package com.ghatana.media.launcher;

import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.production.audio.AudioRepairComparison;
import com.ghatana.media.production.audio.BoundedPcmDeclipper;
import com.ghatana.media.production.simulation.PhysicalSimulation;
import com.ghatana.media.production.simulation.SimulationSemanticValidator;
import com.ghatana.media.production.spatial.SpatialRigEngine;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaSimulationContracts;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import javax.sound.sampled.AudioFileFormat;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import javax.sound.sampled.UnsupportedAudioFileException;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * DEV_ONLY "creative outputs" lane. Hosts two existing, tested engines behind the canonical idempotent artifact
 * registration path and binds every registered output to the exact inputs and engine that produced it:
 *
 * <ul>
 *   <li>audio repair: one exact owner-visible 16-bit PCM WAV artifact version is declipped by
 *       {@link BoundedPcmDeclipper}; the candidate is registered as a NEW artifact with the engine's own
 *       {@link AudioRepairComparison} metrics (sample statistics only; no perceptual quality claim). The source
 *       artifact is immutable and never modified;</li>
 *   <li>simulation: an explicit bounded scenario is run by {@link PhysicalSimulation} and checked by
 *       {@link SimulationSemanticValidator}; only a VALID pass is registered, always labelled as simulated model
 *       output and never as a measurement.</li>
 * </ul>
 *
 * <p>Both engines are deterministic for identical inputs, so a retry with the same requestId re-derives identical
 * bytes and resumes the same durable upload; a reused requestId with different inputs is refused by the upload
 * idempotency fingerprint. No production admission, rights or quality claim is made.
 */
public final class MediaDevCreativeOutputRuntime {
    public static final String SCHEMA = "media.dev.creative-output.v1";
    public static final String AUDIO_REPAIR_ENGINE = "production.audio.BoundedPcmDeclipper/linear-interpolation";
    public static final String AUDIO_COMPARISON_ENGINE = "production.audio.AudioRepairComparison";
    public static final String SIMULATION_ENGINE = "production.simulation.PhysicalSimulation/velocity-verlet";
    public static final String SPATIAL_ENGINE = "production.spatial.SpatialRigEngine/glb-export";
    public static final String KIND_SPATIAL_GLB = "SPATIAL_GLB_EXPORT";
    public static final String KIND_AUDIO_REPAIR = "AUDIO_REPAIR_CANDIDATE";
    public static final String KIND_SIMULATION = "SIMULATED_OUTPUT_NOT_MEASUREMENT";
    static final int MAX_SOURCE_WAV_BYTES = BoundedPcmDeclipper.MAX_PCM_BYTES + 64 * 1024;
    static final int MAX_SIMULATION_OUTPUT_BYTES = 8 * 1024 * 1024;
    private static final Set<String> WAV_TYPES = Set.of("audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave");
    /** Lineage fields; store-added artifact metadata (classification, retention, ...) is not lineage. */
    private static final List<String> LINEAGE_KEYS = List.of("creativeSchema", "scope", "kind", "engine", "requestId",
            "comparisonEngine", "source", "profile", "sourcePcmSha256", "repairedPcmSha256", "metrics",
            "scenarioSha256", "evidenceClass", "solver", "inputReferences", "validation", "solverStats", "note",
            "rigId", "sourceProjectRevisionRef", "sources", "coordinateFrame", "timeEncoding", "lossDisposition",
            "float32LossFields", "rightsDecision", "glbSha256");
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    private final MediaRuntime runtime;
    private final MediaDevProjectRenderRuntime.OutputRegistrar registrar;

    public MediaDevCreativeOutputRuntime(MediaRuntime runtime) {
        this(runtime, MediaDevProjectRenderRuntime.canonicalRegistrar(runtime));
    }

    MediaDevCreativeOutputRuntime(MediaRuntime runtime, MediaDevProjectRenderRuntime.OutputRegistrar registrar) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.registrar = Objects.requireNonNull(registrar, "registrar");
    }

    /** Durable view of a registered creative output, reconstructible from the artifact alone after restart. */
    public record CreativeResult(MediaArtifact artifact, Map<String, Object> lineage, boolean replayed) { }

    public record AudioRepairRequest(String requestId, String artifactId, String artifactVersionId,
                                     double threshold, int maxRunFrames) {
        public AudioRepairRequest {
            requestId = boundedId(requestId, "requestId");
            artifactId = Objects.requireNonNull(artifactId, "artifactId");
            artifactVersionId = Objects.requireNonNull(artifactVersionId, "artifactVersionId");
            if (!Double.isFinite(threshold) || threshold < 0.5 || threshold > 1.0
                    || maxRunFrames < 1 || maxRunFrames > BoundedPcmDeclipper.MAX_RUN_FRAMES) {
                throw new IllegalArgumentException("threshold must be within [0.5, 1.0] and maxRunFrames within [1, "
                        + BoundedPcmDeclipper.MAX_RUN_FRAMES + "]");
            }
        }
    }

    /** Parsed bounded scenario: engine types plus the exact canonical digest of each declared input part. */
    public record SimulationRequest(String requestId, PhysicalSimulation.Model model,
                                    PhysicalSimulation.InitialState initial, PhysicalSimulation.SolverPolicy policy,
                                    PhysicalSimulation.Quantity expectedDuration,
                                    List<SimulationSemanticValidator.DeclaredInvariant> invariants,
                                    Map<String, Object> scenario, Map<String, String> partDigests) {
        public SimulationRequest {
            requestId = boundedId(requestId, "requestId");
            invariants = List.copyOf(invariants);
            scenario = sortedCopy(scenario);
            partDigests = Map.copyOf(partDigests);
        }
    }

    public static final class CreativeUnsupportedException extends IllegalArgumentException {
        private final String code;
        private final Map<String, Object> details;
        CreativeUnsupportedException(String code, String message) { this(code, message, Map.of()); }
        CreativeUnsupportedException(String code, String message, Map<String, Object> details) {
            super(message);
            this.code = code;
            this.details = details;
        }
        public String code() { return code; }
        public Map<String, Object> details() { return details; }
    }

    public static final class CreativeRegistrationFailedException extends IllegalStateException {
        CreativeRegistrationFailedException(Throwable cause) {
            super("creative output could not be registered as an immutable artifact", cause);
        }
    }

    public static final class CreativeRequestReusedException extends IllegalStateException {
        CreativeRequestReusedException(Throwable cause) {
            super("creative output requestId was already used for a different request", cause);
        }
    }

    // ---- audio repair ----

    public CreativeResult repairAudio(String tenantId, String principalId, AudioRepairRequest request) {
        Objects.requireNonNull(request, "request");
        MediaArtifact source = runtime.artifact(tenantId, principalId, request.artifactId())
                .filter(found -> found.version().value().equals(request.artifactVersionId()))
                .orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
        if (!WAV_TYPES.contains(source.contentType().toLowerCase(Locale.ROOT))) {
            throw new CreativeUnsupportedException("SOURCE_FORMAT_NOT_SUPPORTED",
                    "audio repair requires an audio/wav source artifact version");
        }
        if (source.sizeBytes() > MAX_SOURCE_WAV_BYTES) {
            throw new CreativeUnsupportedException("CREATIVE_LIMIT_EXCEEDED", "source exceeds the byte ceiling");
        }
        ByteArrayOutputStream staged = new ByteArrayOutputStream((int) source.sizeBytes());
        try {
            runtime.copyArtifactContent(tenantId, principalId, source.artifactId(), source.version(), staged,
                    MAX_SOURCE_WAV_BYTES).orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
        } catch (IOException failure) {
            throw new IllegalStateException("source artifact content could not be read", failure);
        }
        byte[] sourceWav = staged.toByteArray();
        AudioData input = readPcm16Wav(sourceWav);

        AudioData candidate;
        try {
            candidate = BoundedPcmDeclipper.repair(input, request.threshold(), request.maxRunFrames());
        } catch (BoundedPcmDeclipper.RepairException refused) {
            throw new CreativeUnsupportedException("AUDIO_REPAIR_" + refused.code().name(), refused.getMessage());
        }
        AudioRepairComparison comparison = AudioRepairComparison.compare(input, candidate);
        AudioRepairComparison.Metrics metrics = comparison.metrics();
        if (metrics.changedSampleCount() == 0) {
            throw new CreativeUnsupportedException("AUDIO_REPAIR_NOTHING_TO_REPAIR",
                    "no clipped samples were found at this threshold; no repair candidate exists");
        }
        byte[] repairedWav = encodePcmWav(comparison.repaired());
        // Independent readback of the exact bytes that will be registered.
        AudioData reread = readPcm16Wav(repairedWav);
        if (!Arrays.equals(reread.data(), comparison.repaired().data())) {
            throw new IllegalStateException("encoded candidate WAV does not decode to the engine's repaired PCM");
        }

        Map<String, Object> lineage = baseLineage(KIND_AUDIO_REPAIR, AUDIO_REPAIR_ENGINE, request.requestId());
        lineage.put("comparisonEngine", AUDIO_COMPARISON_ENGINE);
        Map<String, Object> sourceRef = new LinkedHashMap<>();
        sourceRef.put("artifactId", source.artifactId());
        sourceRef.put("artifactVersionId", source.version().value());
        sourceRef.put("sha256", source.sha256());
        sourceRef.put("contentType", source.contentType());
        lineage.put("source", sourceRef);
        Map<String, Object> profile = new LinkedHashMap<>();
        profile.put("algorithm", "BoundedPcmDeclipper.linear-interpolation");
        profile.put("threshold", request.threshold());
        profile.put("maxRunFrames", request.maxRunFrames());
        lineage.put("profile", profile);
        lineage.put("sourcePcmSha256", comparison.sourceSha256());
        lineage.put("repairedPcmSha256", comparison.repairedSha256());
        lineage.put("metrics", metricsView(metrics));
        lineage.put("note", "Engine-reported sample statistics for the A/B pair; the source artifact version is "
                + "unchanged. Declipping estimates missing samples and implies no perceptual or restoration quality.");
        return register(tenantId, principalId, "audio-repair", request.requestId(), repairedWav, "audio/wav", "wav",
                "audio-repair-" + safeName(source.artifactId()), lineage);
    }

    private static Map<String, Object> metricsView(AudioRepairComparison.Metrics metrics) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("sourceRms", number(metrics.sourceRms()));
        view.put("repairedRms", number(metrics.repairedRms()));
        view.put("sourcePeak", metrics.sourcePeak());
        view.put("repairedPeak", metrics.repairedPeak());
        view.put("sourceNearClipSampleCount", metrics.sourceNearClipSampleCount());
        view.put("repairedNearClipSampleCount", metrics.repairedNearClipSampleCount());
        view.put("changedSampleCount", metrics.changedSampleCount());
        view.put("rmsChangeDb", number(metrics.rmsChangeDb()));
        view.put("hasIndependentReference", metrics.hasIndependentReference());
        // The engine reports NaN when no independent reference exists; that is "absent", not a value.
        view.put("snrDbVsReference", metrics.hasIndependentReference() ? number(metrics.snrDbVsReference()) : null);
        view.put("sourceStereoCorrelation", metrics.sourceStereoCorrelation());
        view.put("repairedStereoCorrelation", metrics.repairedStereoCorrelation());
        view.put("stereoCorrelationDelta", metrics.stereoCorrelationDelta());
        return view;
    }

    /** Finite doubles as numbers; non-finite engine values as explicit strings so JSON never loses them. */
    private static Object number(double value) {
        if (Double.isFinite(value)) return value;
        if (Double.isNaN(value)) return "NaN";
        return value > 0 ? "+Infinity" : "-Infinity";
    }

    static AudioData readPcm16Wav(byte[] wavBytes) {
        try {
            if (!AudioFileFormat.Type.WAVE.equals(
                    AudioSystem.getAudioFileFormat(new ByteArrayInputStream(wavBytes)).getType())) {
                throw new CreativeUnsupportedException("SOURCE_AUDIO_INVALID", "source must be a WAVE file");
            }
            try (AudioInputStream stream = AudioSystem.getAudioInputStream(new ByteArrayInputStream(wavBytes))) {
                javax.sound.sampled.AudioFormat format = stream.getFormat();
                int channels = format.getChannels();
                if (!javax.sound.sampled.AudioFormat.Encoding.PCM_SIGNED.equals(format.getEncoding())
                        || format.isBigEndian() || format.getSampleSizeInBits() != 16
                        || (channels != 1 && channels != 2) || !Float.isFinite(format.getSampleRate())
                        || format.getSampleRate() < 1 || format.getSampleRate() != Math.rint(format.getSampleRate())
                        || format.getFrameSize() != channels * 2) {
                    throw new CreativeUnsupportedException("AUDIO_FORMAT_NOT_SUPPORTED",
                            "audio repair supports little-endian signed 16-bit PCM WAV, mono or stereo");
                }
                byte[] pcm = stream.readNBytes(BoundedPcmDeclipper.MAX_PCM_BYTES + 1);
                if (pcm.length == 0 || pcm.length > BoundedPcmDeclipper.MAX_PCM_BYTES
                        || pcm.length % format.getFrameSize() != 0) {
                    throw new CreativeUnsupportedException("CREATIVE_LIMIT_EXCEEDED",
                            "WAV PCM must be non-empty, complete-frame, and at most 16 MiB");
                }
                long frames = pcm.length / format.getFrameSize();
                int rate = (int) format.getSampleRate();
                Duration duration = Duration.ofSeconds(frames / rate,
                        ((frames % rate) * 1_000_000_000L + rate / 2L) / rate);
                return new AudioData(pcm, rate, channels, 16, duration, AudioFormat.PCM);
            }
        } catch (UnsupportedAudioFileException | IOException invalid) {
            throw new CreativeUnsupportedException("SOURCE_AUDIO_INVALID", "source is not a decodable WAV file");
        }
    }

    static byte[] encodePcmWav(AudioData audio) {
        int frameSize = audio.channels() * (audio.bitsPerSample() / 8);
        javax.sound.sampled.AudioFormat format = new javax.sound.sampled.AudioFormat(
                javax.sound.sampled.AudioFormat.Encoding.PCM_SIGNED, audio.sampleRate(), audio.bitsPerSample(),
                audio.channels(), frameSize, audio.sampleRate(), false);
        byte[] pcm = audio.data();
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (AudioInputStream stream = new AudioInputStream(new ByteArrayInputStream(pcm), format,
                pcm.length / frameSize)) {
            if (AudioSystem.write(stream, AudioFileFormat.Type.WAVE, output) <= 0) {
                throw new IllegalStateException("WAV writer produced no output");
            }
        } catch (IOException failure) {
            throw new IllegalStateException("WAV encoding failed", failure);
        }
        return output.toByteArray();
    }

    // ---- simulation ----

    public CreativeResult simulate(String tenantId, String principalId, SimulationRequest request) {
        Objects.requireNonNull(request, "request");
        PhysicalSimulation.Result result;
        try {
            result = PhysicalSimulation.simulate(request.model(), request.initial(), request.policy());
        } catch (PhysicalSimulation.SolverLimitException abstained) {
            throw new CreativeUnsupportedException("SIMULATION_SOLVER_ABSTAINED",
                    "the bounded solver abstained within the declared step/iteration limits");
        } catch (PhysicalSimulation.InvalidSimulationInputException invalid) {
            throw new CreativeUnsupportedException("SIMULATION_INPUT_INVALID", invalid.getMessage());
        }
        // Input references are content-addressed to the digests of this request's own payload; there is no external
        // owner currentness authority in this DEV_ONLY lane, so the verifier only proves self-consistency.
        List<SimulationSemanticValidator.VersionedInput> inputs = List.of(
                input(SimulationSemanticValidator.InputRole.PHYSICAL_MODEL, "request.scenario.model",
                        request.partDigests().get("model")),
                input(SimulationSemanticValidator.InputRole.INITIAL_CONDITIONS, "request.scenario.initialState",
                        request.partDigests().get("initialState")),
                new SimulationSemanticValidator.VersionedInput(SimulationSemanticValidator.InputRole.SOLVER,
                        "solver.velocity-verlet.step-doubling", MediaSimulationContracts.VELOCITY_VERLET_SOLVER_V1,
                        MediaDevProjectRenderRuntime.sha256Hex(MediaSimulationContracts.VELOCITY_VERLET_SOLVER_V1)),
                input(SimulationSemanticValidator.InputRole.SOLVER_POLICY, "request.scenario.solverPolicy",
                        request.partDigests().get("solverPolicy")));
        SimulationSemanticValidator.RunBinding binding = new SimulationSemanticValidator.RunBinding(
                request.requestId(), inputs, request.invariants(), request.expectedDuration());
        SimulationSemanticValidator.Validation validation = SimulationSemanticValidator.validate(binding, result,
                reference -> inputs.contains(reference) ? SimulationSemanticValidator.ReferenceStatus.CURRENT
                        : SimulationSemanticValidator.ReferenceStatus.UNKNOWN);
        if (validation.disposition() != SimulationSemanticValidator.Disposition.VALID) {
            List<Map<String, Object>> findings = new ArrayList<>();
            for (SimulationSemanticValidator.Finding finding : validation.findings()) {
                findings.add(Map.of("reason", finding.reason().name(), "subject", finding.subject(),
                        "detail", finding.detail()));
            }
            throw new CreativeUnsupportedException("SIMULATION_VALIDATION_" + validation.disposition().name(),
                    "the simulation pass was not validated against its declared invariants; no output was registered",
                    Map.of("disposition", validation.disposition().name(), "findings", findings,
                            "evidenceClass", validation.evidenceClass()));
        }

        List<Map<String, Object>> inputRefs = new ArrayList<>();
        for (var ref : inputs) {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("role", ref.role().name());
            view.put("identity", ref.identity());
            view.put("version", ref.version());
            view.put("sha256", ref.sha256());
            inputRefs.add(view);
        }
        Map<String, Object> validationView = new LinkedHashMap<>();
        validationView.put("disposition", validation.disposition().name());
        validationView.put("findings", List.of());
        validationView.put("resultKind", validation.resultKind().name());
        validationView.put("referenceAuthority", "SELF_CONTENT_ADDRESSED_REQUEST_PAYLOAD_ONLY");
        Map<String, Object> stats = new LinkedHashMap<>();
        stats.put("acceptedSteps", result.acceptedSteps());
        stats.put("solverIterations", result.solverIterations());
        stats.put("finalLocalErrorRatio", result.finalLocalErrorRatio());
        stats.put("deterministic", result.deterministic());

        Map<String, Object> document = new LinkedHashMap<>();
        document.put("schema", "media.dev.simulation-output.v1");
        document.put("scope", "DEV_ONLY");
        document.put("outputKind", KIND_SIMULATION);
        document.put("evidenceClass", result.evidenceClass());
        document.put("disclaimer", "Deterministic model output from a declared scenario. It is not a measurement and "
                + "is not evidence about any physical system.");
        document.put("requestId", request.requestId());
        document.put("solver", MediaSimulationContracts.VELOCITY_VERLET_SOLVER_V1);
        document.put("scenario", request.scenario());
        document.put("inputReferences", inputRefs);
        document.put("validation", validationView);
        document.put("solverStats", stats);
        document.put("units", Map.of("time", "SECOND", "position", "METER", "velocity", "METER_PER_SECOND",
                "acceleration", "METER_PER_SECOND_SQUARED", "totalEnergy", "JOULE"));
        List<Map<String, Object>> observations = new ArrayList<>(result.observations().size());
        for (PhysicalSimulation.Observation observation : result.observations()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("time", observation.timeSeconds());
            row.put("position", observation.positionMeters());
            row.put("velocity", observation.velocityMetersPerSecond());
            row.put("acceleration", observation.accelerationMetersPerSecondSquared());
            row.put("totalEnergy", observation.totalEnergyJoules());
            Map<String, Object> uncertainty = new LinkedHashMap<>();
            uncertainty.put("status", observation.uncertainty().status().name());
            uncertainty.put("position", observation.uncertainty().positionMeters());
            uncertainty.put("velocity", observation.uncertainty().velocityMetersPerSecond());
            row.put("uncertainty", uncertainty);
            observations.add(row);
        }
        document.put("observations", observations);
        byte[] bytes;
        try {
            bytes = JSON.writeValueAsString(document).getBytes(StandardCharsets.UTF_8);
        } catch (RuntimeException failure) {
            throw new IllegalStateException("simulation output could not be serialized", failure);
        }
        if (bytes.length > MAX_SIMULATION_OUTPUT_BYTES) {
            throw new CreativeUnsupportedException("CREATIVE_LIMIT_EXCEEDED", "simulation output exceeds the byte ceiling");
        }

        Map<String, Object> lineage = baseLineage(KIND_SIMULATION, SIMULATION_ENGINE, request.requestId());
        lineage.put("scenarioSha256", MediaDevProjectRenderRuntime.sha256Hex(canonical(request.scenario())));
        lineage.put("evidenceClass", result.evidenceClass());
        lineage.put("solver", MediaSimulationContracts.VELOCITY_VERLET_SOLVER_V1);
        lineage.put("inputReferences", inputRefs);
        lineage.put("validation", validationView);
        lineage.put("solverStats", stats);
        lineage.put("note", "Simulated model output; never a measurement. Input references are content-addressed "
                + "to this request's payload, not to an external owner currentness authority.");
        return register(tenantId, principalId, "simulation", request.requestId(), bytes, "application/json", "json",
                "simulation-output", lineage);
    }

    private static SimulationSemanticValidator.VersionedInput input(
            SimulationSemanticValidator.InputRole role, String identity, String digest) {
        return new SimulationSemanticValidator.VersionedInput(role, identity, "sha256:" + digest, digest);
    }

    /** Deep copy with sorted keys so the echoed scenario (and so the output bytes) is independent of key order. */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> sortedCopy(Map<String, Object> value) {
        return (Map<String, Object>) sortedValue(value);
    }

    private static Object sortedValue(Object value) {
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> sorted = new java.util.TreeMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) sorted.put(String.valueOf(entry.getKey()), sortedValue(entry.getValue()));
            return java.util.Collections.unmodifiableMap(sorted);
        }
        if (value instanceof List<?> list) {
            return list.stream().map(MediaDevCreativeOutputRuntime::sortedValue).toList();
        }
        return value;
    }

    /** Stable canonical text for digesting parsed JSON: sorted keys, numbers normalized by value. */
    static String canonical(Object value) {
        StringBuilder out = new StringBuilder();
        appendCanonical(out, value);
        return out.toString();
    }

    private static void appendCanonical(StringBuilder out, Object value) {
        if (value instanceof Map<?, ?> map) {
            out.append('{');
            boolean first = true;
            for (Object key : new java.util.TreeSet<>(map.keySet().stream().map(String::valueOf).toList())) {
                if (!first) out.append(',');
                first = false;
                out.append(JSON.writeValueAsString(key)).append(':');
                appendCanonical(out, map.get(key));
            }
            out.append('}');
        } else if (value instanceof List<?> list) {
            out.append('[');
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) out.append(',');
                appendCanonical(out, list.get(i));
            }
            out.append(']');
        } else if (value instanceof Number number) {
            var decimal = new java.math.BigDecimal(number.toString());
            out.append(decimal.signum() == 0 ? "0" : decimal.stripTrailingZeros().toString());
        } else {
            out.append(JSON.writeValueAsString(value));
        }
    }

    // ---- spatial GLB ----

    /** Plain-data rig request; engine types are built (and engine refusals typed) inside {@link #exportSpatialGlb}. */
    public record SpatialRigRequest(String requestId, String rigId, String sourceProjectRevisionRef,
                                    SpatialFrame frame, List<SpatialSource> sources, List<SpatialBone> bones,
                                    Map<String, List<SpatialKey>> tracks) {
        public SpatialRigRequest {
            requestId = boundedId(requestId, "requestId");
            sources = List.copyOf(sources);
            bones = List.copyOf(bones);
            Map<String, List<SpatialKey>> copy = new LinkedHashMap<>();
            tracks.forEach((bone, keys) -> copy.put(bone, List.copyOf(keys)));
            tracks = java.util.Collections.unmodifiableMap(copy);
        }
    }

    public record SpatialFrame(String frameRef, String frameVersionRef, SpatialRigEngine.Handedness handedness,
                               SpatialRigEngine.AxisDirection xAxis, SpatialRigEngine.AxisDirection yAxis,
                               SpatialRigEngine.AxisDirection zAxis, String positionUnitRef,
                               String orientationUnitRef) { }

    public record SpatialSource(String artifactId, String artifactVersionId) { }

    /** Position is x,y,z; orientation is the engine's explicit UNIT_QUATERNION_XYZW (x,y,z,w). */
    public record SpatialPose(double[] position, double[] orientation) { }

    public record SpatialBone(String id, String parentId, SpatialPose restPose, SpatialRigEngine.JointKind jointKind,
                              double maxAngularDeviationRadians) { }

    public record SpatialKey(long numerator, long denominator, SpatialPose pose) { }

    public CreativeResult exportSpatialGlb(String tenantId, String principalId, SpatialRigRequest request) {
        Objects.requireNonNull(request, "request");
        // Every named source must be one of this principal's own artifact versions, exactly.
        List<Map<String, Object>> sourceViews = new ArrayList<>();
        List<SpatialRigEngine.SourceVersionRef> exact = new ArrayList<>();
        for (SpatialSource ref : request.sources()) {
            MediaArtifact source = runtime.artifact(tenantId, principalId, ref.artifactId())
                    .filter(found -> found.version().value().equals(ref.artifactVersionId()))
                    .orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("tenantId", tenantId);
            view.put("artifactId", source.artifactId());
            view.put("artifactVersionId", source.version().value());
            view.put("sha256", source.sha256());
            view.put("contentType", source.contentType());
            sourceViews.add(view);
            try {
                exact.add(new SpatialRigEngine.SourceVersionRef(tenantId, source.artifactId(), source.version().value()));
            } catch (IllegalArgumentException invalid) {
                throw new CreativeUnsupportedException("SPATIAL_RIG_INVALID", invalid.getMessage());
            }
        }
        SpatialRigEngine.GlbArtifact glb;
        try {
            SpatialFrame f = request.frame();
            var frame = new SpatialRigEngine.CoordinateFrame(f.frameRef(), f.frameVersionRef(), f.handedness(),
                    f.xAxis(), f.yAxis(), f.zAxis(), f.positionUnitRef(), f.orientationUnitRef());
            List<SpatialRigEngine.Bone> bones = new ArrayList<>();
            for (SpatialBone bone : request.bones()) {
                bones.add(new SpatialRigEngine.Bone(bone.id(), bone.parentId(), transform(bone.restPose()),
                        new SpatialRigEngine.JointConstraint(bone.jointKind(), bone.maxAngularDeviationRadians())));
            }
            Map<String, List<SpatialRigEngine.PoseKeyframe>> tracks = new LinkedHashMap<>();
            request.tracks().forEach((boneId, keys) -> {
                List<SpatialRigEngine.PoseKeyframe> converted = new ArrayList<>();
                for (SpatialKey key : keys) {
                    converted.add(new SpatialRigEngine.PoseKeyframe(
                            SpatialRigEngine.RationalTime.of(key.numerator(), key.denominator()),
                            transform(key.pose())));
                }
                tracks.put(boneId, converted);
            });
            var rig = new SpatialRigEngine.Rig(request.rigId(), frame, "UNIT_QUATERNION_XYZW", exact, bones, tracks,
                    request.sourceProjectRevisionRef());
            if (exact.isEmpty()) {
                throw new SpatialRigEngine.SpatialExportBlockedException(
                        SpatialRigEngine.ExportBlocker.SOURCE_VERSION_MISSING);
            }
            // DEV_ONLY owner-scope decision: the engine's rights port is answered ELIGIBLE only for a source version
            // this principal was just shown to own. It is not a production rights grant or licence determination.
            java.util.Set<SpatialRigEngine.SourceVersionRef> ownerVisible = new java.util.HashSet<>(exact);
            glb = new SpatialRigEngine().exportGlb(rig, ref -> ownerVisible.contains(ref)
                    ? SpatialRigEngine.RightsOutcome.ELIGIBLE : SpatialRigEngine.RightsOutcome.UNKNOWN);
        } catch (SpatialRigEngine.SpatialExportBlockedException blocked) {
            throw new CreativeUnsupportedException("SPATIAL_EXPORT_" + blocked.blocker().name(), blocked.getMessage());
        } catch (SpatialRigEngine.SourceRightsDeniedException denied) {
            throw new CreativeUnsupportedException("SPATIAL_SOURCE_RIGHTS_" + denied.outcome().name(),
                    denied.getMessage());
        } catch (IllegalArgumentException | ArithmeticException invalid) {
            throw new CreativeUnsupportedException("SPATIAL_RIG_INVALID", String.valueOf(invalid.getMessage()));
        }
        byte[] bytes = glb.bytes();
        Map<String, Object> embedded = glbSpatialMetadata(bytes);

        Map<String, Object> lineage = baseLineage(KIND_SPATIAL_GLB, SPATIAL_ENGINE, request.requestId());
        lineage.put("rigId", glb.rigId());
        lineage.put("sourceProjectRevisionRef", glb.sourceProjectRevisionRef());
        lineage.put("sources", sourceViews);
        Map<String, Object> frameView = new LinkedHashMap<>();
        frameView.put("frameRef", glb.frameRef());
        frameView.put("frameVersionRef", glb.frameVersionRef());
        frameView.put("handedness", embedded.get("handedness"));
        frameView.put("axisDirections", embedded.get("axisDirections"));
        frameView.put("positionUnitRef", embedded.get("positionUnitRef"));
        frameView.put("orientationUnitRef", embedded.get("orientationUnitRef"));
        lineage.put("coordinateFrame", frameView);
        lineage.put("timeEncoding", glb.timeEncoding());
        lineage.put("lossDisposition", glb.lossDisposition());
        lineage.put("float32LossFields", embedded.get("float32LossFields"));
        lineage.put("glbSha256", glb.sha256());
        Map<String, Object> rights = new LinkedHashMap<>();
        rights.put("authority", "DEV_ONLY_OWNER_SCOPE_VISIBILITY");
        rights.put("outcome", "ELIGIBLE");
        rights.put("basis", "each source version was read as an existing artifact of the requesting principal");
        rights.put("productionGrant", false);
        lineage.put("rightsDecision", rights);
        lineage.put("note", "Engine GLB export under its bounded local profile (right-handed +X/+Y/+Z, metre, unit "
                + "quaternion XYZW) with FLOAT32 time/translation/rotation approximation. The rights decision is a "
                + "DEV_ONLY owner-scope check, not a licence or production grant; no target profile registry, "
                + "transform, 360 or viewer fidelity claim is made.");
        return register(tenantId, principalId, "spatial-glb", request.requestId(), bytes, glb.mimeType(), "glb",
                "spatial-rig-" + safeName(glb.rigId()), lineage);
    }

    private static SpatialRigEngine.LocalTransform transform(SpatialPose pose) {
        return new SpatialRigEngine.LocalTransform(
                new SpatialRigEngine.Vec3(pose.position()[0], pose.position()[1], pose.position()[2]),
                new SpatialRigEngine.Quaternion(pose.orientation()[0], pose.orientation()[1],
                        pose.orientation()[2], pose.orientation()[3]));
    }

    /**
     * Independent GLB readback: validates the container header/length and returns the {@code extras.mediaSpatial}
     * block the engine embedded, so the registered lineage repeats what the engine reports rather than a copy.
     */
    static Map<String, Object> glbSpatialMetadata(byte[] glb) {
        java.nio.ByteBuffer buffer = java.nio.ByteBuffer.wrap(glb).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        if (glb.length < 20 || buffer.getInt(0) != 0x46546c67 || buffer.getInt(4) != 2
                || buffer.getInt(8) != glb.length || buffer.getInt(16) != 0x4e4f534a) {
            throw new IllegalStateException("engine GLB does not have a valid glTF 2.0 container header");
        }
        int jsonLength = buffer.getInt(12);
        if (jsonLength < 0 || 20L + jsonLength > glb.length) {
            throw new IllegalStateException("engine GLB JSON chunk exceeds the container");
        }
        Map<String, Object> document = JSON.readValue(
                new String(glb, 20, jsonLength, StandardCharsets.UTF_8).trim(),
                new tools.jackson.core.type.TypeReference<Map<String, Object>>() { });
        Object extras = document.get("extras");
        Object spatial = extras instanceof Map<?, ?> map ? map.get("mediaSpatial") : null;
        if (!(spatial instanceof Map<?, ?> metadata)) {
            throw new IllegalStateException("engine GLB carries no mediaSpatial metadata");
        }
        Map<String, Object> copy = new LinkedHashMap<>();
        metadata.forEach((key, value) -> copy.put(String.valueOf(key), value));
        return copy;
    }

    // ---- shared registration and reopen ----

    private static Map<String, Object> baseLineage(String kind, String engine, String requestId) {
        Map<String, Object> lineage = new LinkedHashMap<>();
        lineage.put("creativeSchema", SCHEMA);
        lineage.put("scope", "DEV_ONLY");
        lineage.put("kind", kind);
        lineage.put("engine", engine);
        lineage.put("requestId", requestId);
        return lineage;
    }

    private CreativeResult register(String tenantId, String principalId, String lane, String requestId, byte[] bytes,
                                    String contentType, String extension, String namePrefix,
                                    Map<String, Object> lineage) {
        String sha256 = MediaDevProjectRenderRuntime.sha256Hex(bytes);
        Map<String, Object> metadata = new LinkedHashMap<>(lineage);
        metadata.put("purpose", "creative-output");
        UploadRequest upload = new UploadRequest(tenantId, principalId,
                namePrefix + "." + extension, contentType, bytes.length, sha256, "INTERNAL",
                Duration.ofDays(30), metadata);
        String idempotencyKey = "dev-creative:" + lane + ":" + MediaDevProjectRenderRuntime.sha256Hex(
                tenantId + "\u0000" + principalId + "\u0000" + requestId);
        MediaDevProjectRenderRuntime.Registered registered;
        try {
            registered = registrar.register(tenantId, principalId, upload, idempotencyKey, bytes);
        } catch (IllegalArgumentException conflict) {
            if (conflict.getMessage() != null && conflict.getMessage().contains("Idempotency-Key")) {
                throw new CreativeRequestReusedException(conflict);
            }
            throw new CreativeRegistrationFailedException(conflict);
        } catch (RuntimeException failure) {
            throw new CreativeRegistrationFailedException(failure);
        }
        MediaArtifact artifact = registered.artifact();
        if (!artifact.sha256().equals(sha256)) {
            throw new CreativeRegistrationFailedException(
                    new IllegalStateException("registered artifact digest does not match produced bytes"));
        }
        return new CreativeResult(artifact, lineage, registered.replayed());
    }

    /** Reopens a registered creative output for its owner; anything else is absent. */
    public Optional<CreativeResult> reopen(String tenantId, String principalId, String artifactId) {
        return runtime.artifact(tenantId, principalId, artifactId)
                .filter(artifact -> SCHEMA.equals(artifact.metadata().get("creativeSchema")))
                .map(artifact -> {
                    Map<String, Object> lineage = new LinkedHashMap<>();
                    for (String key : LINEAGE_KEYS) {
                        if (artifact.metadata().containsKey(key)) lineage.put(key, artifact.metadata().get(key));
                    }
                    return new CreativeResult(artifact, lineage, true);
                });
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
