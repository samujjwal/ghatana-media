package com.ghatana.media.launcher;

import com.ghatana.media.production.spatial.SpatialRigEngine;
import com.ghatana.media.production.timeline.InMemoryProjectTimelineStore;
import com.ghatana.media.runtime.ManagedProjectTimelineStore;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Created;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Project;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectTimelineStore;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Revision;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.TimelineSnapshot;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * DEV_ONLY creative-output lane through the real HTTP host: source-preserving audio repair (A/B), validated
 * simulation output, idempotent replay, divergent reuse, restart reopen, denial and typed refusals. Output bytes are
 * decoded independently with javax.sound / Jackson rather than trusting the engine's own report.
 */
class MediaDevCreativeOutputHttpTest {
    private static final String TENANT = "tenant-local";
    private static final String PRINCIPAL = "principal-local";
    private static final String OTHER = "principal-other";
    private static final String SECRET = "test-only-dev-project-secret-at-least-32-bytes";
    private static final String ISSUER = "urn:ghatana:media:dev-only";
    private static final String AUDIENCE = "ghatana-media-dev";
    private static final java.time.Clock CLOCK =
            java.time.Clock.fixed(Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC);
    private static final Set<String> PERMISSIONS = Set.of(
            "media:project:dev:create", "media:project:dev:read", "media:project:dev:write",
            "media:artifact:read", "media:artifact:create");
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final String AUDIO = "/dev/v1/creative-outputs/audio-repairs";
    private static final String SIM = "/dev/v1/creative-outputs/simulations";
    private static final String SPATIAL = "/dev/v1/creative-outputs/spatial-glb";
    private static final int RATE = 8_000;

    // ---------- audio repair ----------

    @Test
    void repairsExactSourceVersionIntoNewArtifactWithEngineMetricsReplaysAndReopensAfterRestart() throws Exception {
        Path root = Files.createTempDirectory("media-dev-creative-audio-");
        MediaRuntime runtime = runtime(root);
        HttpServer server = server(runtime, null);
        String outputId;
        String sha;
        Map<String, Object> first;
        MediaArtifact source;
        byte[] sourceWav = clippedWav(RATE, 36_000);
        try {
            String base = base(server);
            source = upload(runtime, "clipped.wav", "audio/wav", sourceWav, "audio-source");
            HttpResponse<String> response = send(base, "POST", AUDIO, audioRequest("repair-1", source, 0.94, 64),
                    PRINCIPAL, PERMISSIONS);
            assertThat(response.statusCode()).as(response.body()).isEqualTo(201);
            first = read(response.body());
            assertThat(first).containsEntry("replayed", false).containsEntry("scope", "DEV_ONLY");
            Map<String, Object> artifact = object(first.get("artifact"));
            outputId = (String) first.get("outputId");
            sha = (String) artifact.get("sha256");
            assertThat(outputId).isNotEqualTo(source.artifactId());
            assertThat(artifact).containsEntry("contentType", "audio/wav");

            Map<String, Object> lineage = object(first.get("lineage"));
            assertThat(lineage).containsEntry("kind", "AUDIO_REPAIR_CANDIDATE")
                    .containsEntry("engine", MediaDevCreativeOutputRuntime.AUDIO_REPAIR_ENGINE)
                    .containsEntry("comparisonEngine", MediaDevCreativeOutputRuntime.AUDIO_COMPARISON_ENGINE)
                    .containsEntry("requestId", "repair-1");
            assertThat(object(lineage.get("source")))
                    .containsEntry("artifactId", source.artifactId())
                    .containsEntry("artifactVersionId", source.version().value())
                    .containsEntry("sha256", source.sha256());
            assertThat(object(lineage.get("profile"))).containsEntry("threshold", 0.94)
                    .containsEntry("maxRunFrames", 64);

            // Independent readback: decode both WAVs and recompute the engine-independent expectations.
            short[] src = pcm16(sourceWav);
            short[] out = pcm16(artifactBytes(runtime, outputId));
            assertThat(out).hasSameSizeAs(src);
            int clipLevel = (int) Math.ceil(32767 * 0.94);
            int changed = 0;
            int srcNearClip = 0;
            int outNearClip = 0;
            int nearClipThreshold = (int) Math.ceil(32767 * 0.999);
            long srcPeak = 0;
            long outPeak = 0;
            for (int i = 0; i < src.length; i++) {
                if (Math.abs(src[i]) < clipLevel) assertThat(out[i]).as("unclipped sample %d untouched", i).isEqualTo(src[i]);
                else assertThat(Math.abs(out[i])).as("clipped sample %d lowered", i).isLessThan(Math.abs(src[i]));
                if (src[i] != out[i]) changed++;
                if (Math.abs(src[i]) >= nearClipThreshold) srcNearClip++;
                if (Math.abs(out[i]) >= nearClipThreshold) outNearClip++;
                srcPeak = Math.max(srcPeak, Math.abs(src[i]));
                outPeak = Math.max(outPeak, Math.abs(out[i]));
            }
            assertThat(changed).isPositive();
            Map<String, Object> metrics = object(lineage.get("metrics"));
            assertThat(((Number) metrics.get("changedSampleCount")).intValue()).isEqualTo(changed);
            assertThat(((Number) metrics.get("sourceNearClipSampleCount")).intValue()).isEqualTo(srcNearClip);
            assertThat(((Number) metrics.get("repairedNearClipSampleCount")).intValue()).isEqualTo(outNearClip);
            assertThat(((Number) metrics.get("sourcePeak")).longValue()).isEqualTo(srcPeak);
            assertThat(((Number) metrics.get("repairedPeak")).longValue()).isEqualTo(outPeak);
            assertThat(metrics).containsEntry("hasIndependentReference", false);
            assertThat(metrics.get("snrDbVsReference")).isNull();
            assertThat(metrics.get("sourceStereoCorrelation")).isNull();

            // Source-preserving: the source version is byte-identical after the repair.
            assertThat(artifactBytes(runtime, source.artifactId())).isEqualTo(sourceWav);
            assertThat(runtime.artifact(TENANT, PRINCIPAL, source.artifactId()).orElseThrow().version())
                    .isEqualTo(source.version());

            HttpResponse<String> duplicate = send(base, "POST", AUDIO, audioRequest("repair-1", source, 0.94, 64),
                    PRINCIPAL, PERMISSIONS);
            assertThat(duplicate.statusCode()).as(duplicate.body()).isEqualTo(200);
            assertThat(read(duplicate.body())).containsEntry("outputId", outputId).containsEntry("replayed", true);

            HttpResponse<String> divergent = send(base, "POST", AUDIO, audioRequest("repair-1", source, 0.9, 64),
                    PRINCIPAL, PERMISSIONS);
            assertThat(divergent.statusCode()).as(divergent.body()).isEqualTo(409);
            assertThat(divergent.body()).contains("CREATIVE_REQUEST_ID_REUSED");
        } finally {
            server.stop(0);
            runtime.close();
        }

        MediaRuntime restarted = runtime(root);
        HttpServer again = server(restarted, null);
        try {
            String base = base(again);
            HttpResponse<String> reopened = send(base, "GET", "/dev/v1/creative-outputs/" + outputId, null,
                    PRINCIPAL, PERMISSIONS);
            assertThat(reopened.statusCode()).as(reopened.body()).isEqualTo(200);
            Map<String, Object> view = read(reopened.body());
            assertThat(object(view.get("artifact"))).containsEntry("sha256", sha);
            assertThat(JSON.writeValueAsString(view.get("lineage")))
                    .isEqualTo(JSON.writeValueAsString(first.get("lineage")));
            assertThat(send(base, "POST", AUDIO, audioRequest("repair-1", source, 0.94, 64), PRINCIPAL, PERMISSIONS)
                    .statusCode()).isEqualTo(200);

            assertThat(send(base, "GET", "/dev/v1/creative-outputs/" + outputId, null, OTHER, PERMISSIONS)
                    .statusCode()).isIn(403, 404);
            assertThat(send(base, "POST", AUDIO, audioRequest("repair-other", source, 0.94, 64), OTHER, PERMISSIONS)
                    .statusCode()).isIn(403, 404);
            assertThat(send(base, "GET", "/dev/v1/creative-outputs/" + source.artifactId(), null, PRINCIPAL,
                    PERMISSIONS).statusCode()).isEqualTo(404);
            Set<String> noCreate = Set.of("media:project:dev:read", "media:project:dev:write", "media:artifact:read");
            assertThat(send(base, "POST", AUDIO, audioRequest("repair-2", source, 0.94, 64), PRINCIPAL, noCreate)
                    .statusCode()).isEqualTo(403);
            Set<String> noRead = Set.of("media:project:dev:read", "media:project:dev:write", "media:artifact:create");
            assertThat(send(base, "GET", "/dev/v1/creative-outputs/" + outputId, null, PRINCIPAL, noRead)
                    .statusCode()).isEqualTo(403);
            Set<String> noProject = Set.of("media:artifact:read", "media:artifact:create");
            assertThat(send(base, "POST", AUDIO, audioRequest("repair-3", source, 0.94, 64), PRINCIPAL, noProject)
                    .statusCode()).isEqualTo(403);
        } finally {
            again.stop(0);
            restarted.close();
        }
    }

    @Test
    void unsupportedAudioInputsAreTypedAndNeverRegisterAnOutput() throws Exception {
        Path root = Files.createTempDirectory("media-dev-creative-audio-422-");
        MediaRuntime runtime = runtime(root);
        HttpServer server = server(runtime, null);
        try {
            String base = base(server);
            MediaArtifact notWav = upload(runtime, "x.bin", "application/octet-stream", new byte[] {1, 2, 3}, "k1");
            assertError(send(base, "POST", AUDIO, audioRequest("r-fmt", notWav, 0.94, 64), PRINCIPAL, PERMISSIONS),
                    422, "SOURCE_FORMAT_NOT_SUPPORTED");
            MediaArtifact garbage = upload(runtime, "x.wav", "audio/wav", new byte[] {1, 2, 3, 4, 5}, "k2");
            assertError(send(base, "POST", AUDIO, audioRequest("r-bad", garbage, 0.94, 64), PRINCIPAL, PERMISSIONS),
                    422, "SOURCE_AUDIO_INVALID");
            MediaArtifact wide = upload(runtime, "wide.wav", "audio/wav", wavOf(new int[] {0, 100, 200, 100}, 24), "k3");
            assertError(send(base, "POST", AUDIO, audioRequest("r-24", wide, 0.94, 64), PRINCIPAL, PERMISSIONS),
                    422, "AUDIO_FORMAT_NOT_SUPPORTED");
            MediaArtifact clean = upload(runtime, "clean.wav", "audio/wav", clippedWav(RATE, 8_000), "k4");
            assertError(send(base, "POST", AUDIO, audioRequest("r-clean", clean, 0.94, 64), PRINCIPAL, PERMISSIONS),
                    422, "AUDIO_REPAIR_NOTHING_TO_REPAIR");
            // A run longer than maxRunFrames is refused by the engine rather than guessed at.
            MediaArtifact longRun = upload(runtime, "long.wav", "audio/wav",
                    wavOf(new int[] {0, 100, 32767, 32767, 32767, 32767, 100, 0}, 16), "k5");
            assertError(send(base, "POST", AUDIO, audioRequest("r-run", longRun, 0.94, 2), PRINCIPAL, PERMISSIONS),
                    422, "AUDIO_REPAIR_UNREPAIRABLE_RUN");
            // The failed request ids registered nothing, so reusing one is a fresh request, not a replay.
            HttpResponse<String> retry = send(base, "POST", AUDIO, audioRequest("r-run", longRun, 0.94, 8),
                    PRINCIPAL, PERMISSIONS);
            assertThat(retry.statusCode()).as(retry.body()).isEqualTo(201);
            assertThat(read(retry.body())).containsEntry("replayed", false);

            MediaArtifact real = upload(runtime, "real.wav", "audio/wav", clippedWav(RATE, 36_000), "k6");
            HttpResponse<String> staleVersion = send(base, "POST", AUDIO, JSON.writeValueAsString(Map.of(
                    "requestId", "r-ver", "source", Map.of("artifactId", real.artifactId(),
                            "artifactVersionId", "sha256:" + "0".repeat(64)),
                    "profile", Map.of("threshold", 0.94, "maxRunFrames", 64))), PRINCIPAL, PERMISSIONS);
            assertThat(staleVersion.statusCode()).isEqualTo(404);
            assertThat(staleVersion.body()).contains("SOURCE_VERSION_NOT_FOUND");
            assertThat(send(base, "POST", AUDIO, audioRequest("r-thr", real, 0.2, 64), PRINCIPAL, PERMISSIONS)
                    .statusCode()).isEqualTo(400);
            assertThat(send(base, "POST", AUDIO, "{\"requestId\":\"r\"}", PRINCIPAL, PERMISSIONS).statusCode())
                    .isEqualTo(400);
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    @Test
    void failedRegistrationIsTypedAndResumesToTheSameOutput() throws Exception {
        Path root = Files.createTempDirectory("media-dev-creative-resume-");
        MediaRuntime runtime = runtime(root);
        AtomicInteger attempts = new AtomicInteger();
        MediaDevProjectRenderRuntime.OutputRegistrar crashBeforeComplete = (tenant, principal, request, key, bytes) -> {
            attempts.incrementAndGet();
            var session = runtime.beginUpload(request, key);
            runtime.appendChunk(tenant, principal, session.uploadId(), 0, Arrays.copyOf(bytes,
                    Math.min(bytes.length, runtime.config().maximumChunkBytes())));
            throw new IllegalStateException("simulated process loss before completion");
        };
        HttpServer failing = server(runtime, new MediaDevCreativeOutputRuntime(runtime, crashBeforeComplete));
        MediaArtifact source = upload(runtime, "clipped.wav", "audio/wav", clippedWav(RATE, 36_000), "k");
        try {
            HttpResponse<String> failed = send(base(failing), "POST", AUDIO,
                    audioRequest("resume-1", source, 0.94, 64), PRINCIPAL, PERMISSIONS);
            assertThat(failed.statusCode()).as(failed.body()).isEqualTo(502);
            assertThat(failed.body()).contains("CREATIVE_OUTPUT_REGISTRATION_FAILED");
            assertThat(attempts).hasValue(1);
        } finally {
            failing.stop(0);
        }
        HttpServer healthy = server(runtime, null);
        try {
            HttpResponse<String> resumed = send(base(healthy), "POST", AUDIO,
                    audioRequest("resume-1", source, 0.94, 64), PRINCIPAL, PERMISSIONS);
            assertThat(resumed.statusCode()).as(resumed.body()).isEqualTo(201);
            Map<String, Object> body = read(resumed.body());
            assertThat(pcm16(artifactBytes(runtime, (String) body.get("outputId")))).isNotEmpty();
            HttpResponse<String> replay = send(base(healthy), "POST", AUDIO,
                    audioRequest("resume-1", source, 0.94, 64), PRINCIPAL, PERMISSIONS);
            assertThat(read(replay.body())).containsEntry("outputId", body.get("outputId"))
                    .containsEntry("replayed", true);
        } finally {
            healthy.stop(0);
            runtime.close();
        }
    }

    // ---------- simulation ----------

    @Test
    void validatedSimulationIsRegisteredAsSimulatedOutputReplaysAndReopens() throws Exception {
        Path root = Files.createTempDirectory("media-dev-creative-sim-");
        MediaRuntime runtime = runtime(root);
        HttpServer server = server(runtime, null);
        String outputId;
        Map<String, Object> first;
        try {
            String base = base(server);
            HttpResponse<String> response = send(base, "POST", SIM, simulationRequest("sim-1", 6.0), PRINCIPAL, PERMISSIONS);
            assertThat(response.statusCode()).as(response.body()).isEqualTo(201);
            first = read(response.body());
            outputId = (String) first.get("outputId");
            Map<String, Object> artifact = object(first.get("artifact"));
            assertThat(artifact).containsEntry("contentType", "application/json");
            Map<String, Object> lineage = object(first.get("lineage"));
            assertThat(lineage).containsEntry("kind", "SIMULATED_OUTPUT_NOT_MEASUREMENT")
                    .containsEntry("evidenceClass", "DETERMINISTIC_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE")
                    .containsEntry("engine", MediaDevCreativeOutputRuntime.SIMULATION_ENGINE);
            assertThat(object(lineage.get("validation"))).containsEntry("disposition", "VALID");
            assertThat(((List<?>) lineage.get("inputReferences"))).hasSize(4);

            // Independent parse of the registered bytes: F=6 N, m=2 kg => a=3, x(2)=6 m, v(2)=6 m/s.
            Map<String, Object> document = read(new String(artifactBytes(runtime, outputId), StandardCharsets.UTF_8));
            assertThat(document).containsEntry("outputKind", "SIMULATED_OUTPUT_NOT_MEASUREMENT")
                    .containsEntry("scope", "DEV_ONLY")
                    .containsEntry("evidenceClass", "DETERMINISTIC_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE");
            assertThat(String.valueOf(document.get("disclaimer"))).contains("not a measurement");
            assertThat(object(document.get("units"))).containsEntry("position", "METER").containsEntry("time", "SECOND");
            List<?> observations = (List<?>) document.get("observations");
            assertThat(observations.size()).isGreaterThanOrEqualTo(2);
            Map<String, Object> firstRow = object(observations.getFirst());
            Map<String, Object> last = object(observations.getLast());
            assertThat(((Number) firstRow.get("time")).doubleValue()).isZero();
            assertThat(((Number) last.get("time")).doubleValue()).isEqualTo(2.0);
            assertThat(((Number) last.get("position")).doubleValue()).isCloseTo(6.0, org.assertj.core.data.Offset.offset(1e-8));
            assertThat(((Number) last.get("velocity")).doubleValue()).isCloseTo(6.0, org.assertj.core.data.Offset.offset(1e-8));
            double previous = -1;
            for (Object row : observations) {
                double t = ((Number) object(row).get("time")).doubleValue();
                assertThat(t).isGreaterThan(previous);
                previous = t;
            }

            HttpResponse<String> duplicate = send(base, "POST", SIM, simulationRequest("sim-1", 6.0), PRINCIPAL, PERMISSIONS);
            assertThat(duplicate.statusCode()).as(duplicate.body()).isEqualTo(200);
            assertThat(read(duplicate.body())).containsEntry("outputId", outputId).containsEntry("replayed", true);
            // Same requestId, different declared scenario (a different force), is a conflict, never a second output.
            HttpResponse<String> divergent = send(base, "POST", SIM, simulationRequest("sim-1", 12.0, 12.0),
                    PRINCIPAL, PERMISSIONS);
            assertThat(divergent.statusCode()).as(divergent.body()).isEqualTo(409);
        } finally {
            server.stop(0);
            runtime.close();
        }
        MediaRuntime restarted = runtime(root);
        HttpServer again = server(restarted, null);
        try {
            String base = base(again);
            HttpResponse<String> reopened = send(base, "GET", "/dev/v1/creative-outputs/" + outputId, null,
                    PRINCIPAL, PERMISSIONS);
            assertThat(reopened.statusCode()).as(reopened.body()).isEqualTo(200);
            assertThat(JSON.writeValueAsString(read(reopened.body()).get("lineage")))
                    .isEqualTo(JSON.writeValueAsString(first.get("lineage")));
            assertThat(send(base, "POST", SIM, simulationRequest("sim-1", 6.0), PRINCIPAL, PERMISSIONS).statusCode())
                    .isEqualTo(200);
            assertThat(send(base, "GET", "/dev/v1/creative-outputs/" + outputId, null, OTHER, PERMISSIONS)
                    .statusCode()).isIn(403, 404);
            Set<String> noCreate = Set.of("media:project:dev:read", "media:project:dev:write", "media:artifact:read");
            assertThat(send(base, "POST", SIM, simulationRequest("sim-2", 6.0), PRINCIPAL, noCreate).statusCode())
                    .isEqualTo(403);
        } finally {
            again.stop(0);
            restarted.close();
        }
    }

    @Test
    void rejectedAbstainedOrInvalidSimulationsReturnTyped422WithoutAnArtifact() throws Exception {
        Path root = Files.createTempDirectory("media-dev-creative-sim-422-");
        MediaRuntime runtime = runtime(root);
        HttpServer server = server(runtime, null);
        try {
            String base = base(server);
            // Declared invariant (terminal position 99 m) contradicts the model output: REJECTED, nothing registered.
            HttpResponse<String> rejected = send(base, "POST", SIM, simulationRequest("sim-bad", 99.0), PRINCIPAL, PERMISSIONS);
            assertError(rejected, 422, "SIMULATION_VALIDATION_REJECTED");
            assertThat(object(read(rejected.body()).get("error")).toString()).contains("SEMANTIC_INVARIANT_FAILED");
            // Because nothing was registered for that requestId, the corrected request is new (201), not a replay.
            HttpResponse<String> corrected = send(base, "POST", SIM, simulationRequest("sim-bad", 6.0), PRINCIPAL, PERMISSIONS);
            assertThat(corrected.statusCode()).as(corrected.body()).isEqualTo(201);
            assertThat(read(corrected.body())).containsEntry("replayed", false);

            // No declared invariant: the validator abstains rather than blessing the pass.
            Map<String, Object> noInvariants = scenario(6.0, 6.0);
            noInvariants.put("invariants", List.of());
            assertError(send(base, "POST", SIM, JSON.writeValueAsString(Map.of("requestId", "sim-abstain",
                    "scenario", noInvariants)), PRINCIPAL, PERMISSIONS), 422, "SIMULATION_VALIDATION_ABSTAIN");

            // A force expressed in kilograms is an engine-level unit error.
            Map<String, Object> badUnits = scenario(6.0, 6.0);
            object(object(badUnits.get("model")).get("force")).put("value", quantity(6, "KILOGRAM"));
            assertError(send(base, "POST", SIM, JSON.writeValueAsString(Map.of("requestId", "sim-units",
                    "scenario", badUnits)), PRINCIPAL, PERMISSIONS), 422, "SIMULATION_INPUT_INVALID");

            // Unknown unit names and unknown fields are malformed requests (400), not engine refusals.
            Map<String, Object> unknownUnit = scenario(6.0, 6.0);
            object(object(unknownUnit.get("expectedDuration"))).put("unit", "PARSEC");
            assertThat(send(base, "POST", SIM, JSON.writeValueAsString(Map.of("requestId", "sim-parsec",
                    "scenario", unknownUnit)), PRINCIPAL, PERMISSIONS).statusCode()).isEqualTo(400);
            Map<String, Object> extra = scenario(6.0, 6.0);
            extra.put("measuredValue", 1);
            assertThat(send(base, "POST", SIM, JSON.writeValueAsString(Map.of("requestId", "sim-extra",
                    "scenario", extra)), PRINCIPAL, PERMISSIONS).statusCode()).isEqualTo(400);
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    // ---------- spatial GLB ----------

    @Test
    void exportsSpatialGlbBoundToExactSourcesReplaysConflictsAndReopensAfterRestart() throws Exception {
        Path root = Files.createTempDirectory("media-dev-creative-spatial-");
        MediaRuntime runtime = runtime(root);
        HttpServer server = server(runtime, null);
        String outputId;
        String sha;
        Map<String, Object> first;
        MediaArtifact sourceA;
        MediaArtifact sourceB;
        try {
            String base = base(server);
            sourceA = upload(runtime, "rig-a.bin", "application/octet-stream", "rig source a".getBytes(StandardCharsets.UTF_8), "sp-a");
            sourceB = upload(runtime, "rig-b.bin", "application/octet-stream", "rig source b".getBytes(StandardCharsets.UTF_8), "sp-b");
            HttpResponse<String> response = send(base, "POST", SPATIAL, spatialRequest("spatial-1", "rig-1",
                    List.of(sourceB, sourceA), 0.5), PRINCIPAL, PERMISSIONS);
            assertThat(response.statusCode()).as(response.body()).isEqualTo(201);
            first = read(response.body());
            assertThat(first).containsEntry("replayed", false).containsEntry("scope", "DEV_ONLY");
            Map<String, Object> artifact = object(first.get("artifact"));
            outputId = (String) first.get("outputId");
            sha = (String) artifact.get("sha256");
            assertThat(artifact).containsEntry("contentType", "model/gltf-binary");
            assertThat(outputId).isNotIn(sourceA.artifactId(), sourceB.artifactId());

            Map<String, Object> lineage = object(first.get("lineage"));
            assertThat(lineage).containsEntry("kind", "SPATIAL_GLB_EXPORT")
                    .containsEntry("engine", MediaDevCreativeOutputRuntime.SPATIAL_ENGINE)
                    .containsEntry("requestId", "spatial-1").containsEntry("rigId", "rig-1")
                    .containsEntry("sourceProjectRevisionRef", "project:edit:revision-8")
                    .containsEntry("timeEncoding", "FLOAT32_SECONDS")
                    .containsEntry("lossDisposition", "FLOAT32_APPROXIMATION");
            assertThat(lineage.get("float32LossFields")).isEqualTo(List.of(
                    "animation.inputTimeSeconds", "animation.outputTranslation", "animation.outputRotation"));
            assertThat(object(lineage.get("coordinateFrame")))
                    .containsEntry("frameRef", "urn:media:frame:glb").containsEntry("frameVersionRef", "v1")
                    .containsEntry("handedness", "RIGHT_HANDED")
                    .containsEntry("positionUnitRef", SpatialRigEngine.GLB_METRE_UNIT_REF)
                    .containsEntry("orientationUnitRef", SpatialRigEngine.GLB_QUATERNION_UNIT_REF);
            assertThat(object(lineage.get("rightsDecision")))
                    .containsEntry("authority", "DEV_ONLY_OWNER_SCOPE_VISIBILITY").containsEntry("productionGrant", false);
            List<Map<String, Object>> sources = objects(lineage.get("sources"));
            assertThat(sources).extracting(m -> m.get("artifactId"))
                    .containsExactlyInAnyOrder(sourceA.artifactId(), sourceB.artifactId());
            for (Map<String, Object> source : sources) {
                MediaArtifact expected = source.get("artifactId").equals(sourceA.artifactId()) ? sourceA : sourceB;
                assertThat(source).containsEntry("artifactVersionId", expected.version().value())
                        .containsEntry("sha256", expected.sha256()).containsEntry("tenantId", TENANT);
            }

            // Independent readback of the registered bytes (not the engine's own report).
            byte[] glb = artifactBytes(runtime, outputId);
            assertThat(HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(glb)))
                    .isEqualTo(sha);
            assertGlb(glb, sourceA, sourceB);
            // The engine's own container + lineage validator accepts exactly these bytes and metadata.
            var exact = List.of(sourceA, sourceB).stream().map(a -> new SpatialRigEngine.SourceVersionRef(
                    TENANT, a.artifactId(), a.version().value())).toList();
            new SpatialRigEngine.GlbArtifact("rig-1", "project:edit:revision-8", "urn:media:frame:glb", "v1", exact,
                    "model/gltf-binary", "FLOAT32_SECONDS", "FLOAT32_APPROXIMATION", sha, glb);
            assertThat(artifactBytes(runtime, sourceA.artifactId())).isEqualTo("rig source a".getBytes(StandardCharsets.UTF_8));

            HttpResponse<String> duplicate = send(base, "POST", SPATIAL, spatialRequest("spatial-1", "rig-1",
                    List.of(sourceB, sourceA), 0.5), PRINCIPAL, PERMISSIONS);
            assertThat(duplicate.statusCode()).as(duplicate.body()).isEqualTo(200);
            assertThat(read(duplicate.body())).containsEntry("outputId", outputId).containsEntry("replayed", true);

            HttpResponse<String> divergent = send(base, "POST", SPATIAL, spatialRequest("spatial-1", "rig-1",
                    List.of(sourceB, sourceA), 0.6), PRINCIPAL, PERMISSIONS);
            assertThat(divergent.statusCode()).as(divergent.body()).isEqualTo(409);
            assertThat(divergent.body()).contains("CREATIVE_REQUEST_ID_REUSED");
        } finally {
            server.stop(0);
            runtime.close();
        }

        MediaRuntime restarted = runtime(root);
        HttpServer again = server(restarted, null);
        try {
            String base = base(again);
            HttpResponse<String> reopened = send(base, "GET", "/dev/v1/creative-outputs/" + outputId, null,
                    PRINCIPAL, PERMISSIONS);
            assertThat(reopened.statusCode()).as(reopened.body()).isEqualTo(200);
            Map<String, Object> view = read(reopened.body());
            assertThat(object(view.get("artifact"))).containsEntry("sha256", sha);
            assertThat(view.get("lineage")).isEqualTo(first.get("lineage"));
            assertThat(send(base, "POST", SPATIAL, spatialRequest("spatial-1", "rig-1", List.of(sourceB, sourceA), 0.5),
                    PRINCIPAL, PERMISSIONS).statusCode()).isEqualTo(200);

            // Another principal can neither see the output nor reference this principal's sources.
            assertThat(send(base, "GET", "/dev/v1/creative-outputs/" + outputId, null, OTHER, PERMISSIONS)
                    .statusCode()).isIn(403, 404);
            HttpResponse<String> foreign = send(base, "POST", SPATIAL, spatialRequest("spatial-other", "rig-1",
                    List.of(sourceA), 0.5), OTHER, PERMISSIONS);
            assertThat(foreign.statusCode()).isIn(403, 404);
            Set<String> noCreate = Set.of("media:project:dev:read", "media:project:dev:write", "media:artifact:read");
            assertThat(send(base, "POST", SPATIAL, spatialRequest("spatial-2", "rig-1", List.of(sourceA), 0.5),
                    PRINCIPAL, noCreate).statusCode()).isEqualTo(403);
            Set<String> noRead = Set.of("media:project:dev:read", "media:project:dev:write", "media:artifact:create");
            assertThat(send(base, "POST", SPATIAL, spatialRequest("spatial-2", "rig-1", List.of(sourceA), 0.5),
                    PRINCIPAL, noRead).statusCode()).isEqualTo(403);
            Set<String> noProject = Set.of("media:artifact:read", "media:artifact:create");
            assertThat(send(base, "POST", SPATIAL, spatialRequest("spatial-3", "rig-1", List.of(sourceA), 0.5),
                    PRINCIPAL, noProject).statusCode()).isEqualTo(403);
            assertThat(send(base, "GET", SPATIAL, null, PRINCIPAL, PERMISSIONS).statusCode()).isEqualTo(405);
        } finally {
            again.stop(0);
            restarted.close();
        }
    }

    @Test
    void spatialSourcesMustBeTheCallersExactArtifactVersionsAndEngineRefusalsAreTyped422() throws Exception {
        Path root = Files.createTempDirectory("media-dev-creative-spatial-refuse-");
        MediaRuntime runtime = runtime(root);
        HttpServer server = server(runtime, null);
        try {
            String base = base(server);
            MediaArtifact source = upload(runtime, "rig.bin", "application/octet-stream", "src".getBytes(StandardCharsets.UTF_8), "k1");

            // Missing artifact, wrong version, and any one bad reference among good ones: 404, nothing registered.
            Map<String, Object> missing = spatialBody("sp-missing", "rig", List.of(Map.of("artifactId", "no-such-artifact",
                    "artifactVersionId", "v1")), 0.5);
            assertError(send(base, "POST", SPATIAL, JSON.writeValueAsString(missing), PRINCIPAL, PERMISSIONS), 404,
                    "SOURCE_VERSION_NOT_FOUND");
            Map<String, Object> wrongVersion = spatialBody("sp-wrongver", "rig", List.of(Map.of(
                    "artifactId", source.artifactId(), "artifactVersionId", source.version().value() + "-nope")), 0.5);
            assertError(send(base, "POST", SPATIAL, JSON.writeValueAsString(wrongVersion), PRINCIPAL, PERMISSIONS), 404,
                    "SOURCE_VERSION_NOT_FOUND");
            Map<String, Object> mixed = spatialBody("sp-mixed", "rig", List.of(sourceRef(source),
                    Map.of("artifactId", "ghost", "artifactVersionId", "v1")), 0.5);
            assertError(send(base, "POST", SPATIAL, JSON.writeValueAsString(mixed), PRINCIPAL, PERMISSIONS), 404,
                    "SOURCE_VERSION_NOT_FOUND");
            assertError(send(base, "POST", SPATIAL, spatialRequest("sp-foreign", "rig", List.of(source), 0.5), OTHER,
                    PERMISSIONS), 404, "SOURCE_VERSION_NOT_FOUND");

            // Engine refusals.
            Map<String, Object> noRevision = spatialBody("sp-norev", "rig", List.of(sourceRef(source)), 0.5);
            object(noRevision.get("rig")).remove("sourceProjectRevisionRef");
            assertError(send(base, "POST", SPATIAL, JSON.writeValueAsString(noRevision), PRINCIPAL, PERMISSIONS), 422,
                    "SPATIAL_EXPORT_PROJECT_REVISION_MISSING");
            assertError(send(base, "POST", SPATIAL, JSON.writeValueAsString(spatialBody("sp-nosrc", "rig", List.of(), 0.5)),
                    PRINCIPAL, PERMISSIONS), 422, "SPATIAL_EXPORT_SOURCE_VERSION_MISSING");

            Map<String, Object> leftHanded = spatialBody("sp-left", "rig", List.of(sourceRef(source)), 0.5);
            object(object(leftHanded.get("rig")).get("coordinateFrame")).put("handedness", "LEFT_HANDED");
            object(object(leftHanded.get("rig")).get("coordinateFrame")).put("axisDirections",
                    List.of("POS_X", "POS_Y", "NEG_Z"));
            assertError(send(base, "POST", SPATIAL, JSON.writeValueAsString(leftHanded), PRINCIPAL, PERMISSIONS), 422,
                    "SPATIAL_EXPORT_COORDINATE_PROFILE_UNSUPPORTED");
            Map<String, Object> otherUnit = spatialBody("sp-unit", "rig", List.of(sourceRef(source)), 0.5);
            object(object(otherUnit.get("rig")).get("coordinateFrame")).put("positionUnitRef", "urn:example:unit:foot");
            assertError(send(base, "POST", SPATIAL, JSON.writeValueAsString(otherUnit), PRINCIPAL, PERMISSIONS), 422,
                    "SPATIAL_EXPORT_COORDINATE_PROFILE_UNSUPPORTED");

            // Joint bound: a 90 degree key against a 0.1 rad constraint.
            Map<String, Object> constrained = spatialBody("sp-joint", "rig", List.of(sourceRef(source)), 0.5);
            objects(object(constrained.get("rig")).get("bones")).get(0).put("constraint",
                    Map.of("kind", "BALL", "maxAngularDeviationRadians", 0.1));
            assertError(send(base, "POST", SPATIAL, JSON.writeValueAsString(constrained), PRINCIPAL, PERMISSIONS), 422,
                    "SPATIAL_EXPORT_MOTION_CONSTRAINT_INVALID");

            // Float32 collapse of two distinct exact times is refused, not silently exported.
            Map<String, Object> collapsed = spatialBody("sp-float", "rig", List.of(sourceRef(source)), 0.5);
            Map<String, Object> pose = Map.of("position", List.of(0, 0, 0), "orientation", List.of(0, 0, 0, 1));
            object(object(collapsed.get("rig")).get("tracks")).put("root", List.of(
                    Map.of("time", Map.of("numerator", 100_000_000, "denominator", 1), "pose", pose),
                    Map.of("time", Map.of("numerator", 100_000_001, "denominator", 1), "pose", pose)));
            assertError(send(base, "POST", SPATIAL, JSON.writeValueAsString(collapsed), PRINCIPAL, PERMISSIONS), 422,
                    "SPATIAL_EXPORT_NON_MONOTONIC_FLOAT_TIME");

            // Engine input bounds / structure.
            Map<String, Object> huge = spatialBody("sp-bounds", "rig", List.of(sourceRef(source)), 0.5);
            objects(object(huge.get("rig")).get("bones")).get(0).put("restPose",
                    Map.of("position", List.of(2_000_000, 0, 0), "orientation", List.of(0, 0, 0, 1)));
            assertError(send(base, "POST", SPATIAL, JSON.writeValueAsString(huge), PRINCIPAL, PERMISSIONS), 422,
                    "SPATIAL_RIG_INVALID");
            Map<String, Object> zeroQuaternion = spatialBody("sp-quat", "rig", List.of(sourceRef(source)), 0.5);
            objects(object(zeroQuaternion.get("rig")).get("bones")).get(0).put("restPose",
                    Map.of("position", List.of(0, 0, 0), "orientation", List.of(0, 0, 0, 0)));
            assertError(send(base, "POST", SPATIAL, JSON.writeValueAsString(zeroQuaternion), PRINCIPAL, PERMISSIONS), 422,
                    "SPATIAL_RIG_INVALID");
            Map<String, Object> duplicateBones = spatialBody("sp-dupbone", "rig", List.of(sourceRef(source)), 0.5);
            List<Map<String, Object>> bones = objects(object(duplicateBones.get("rig")).get("bones"));
            bones.add(new LinkedHashMap<>(bones.get(0)));
            assertError(send(base, "POST", SPATIAL, JSON.writeValueAsString(duplicateBones), PRINCIPAL, PERMISSIONS), 422,
                    "SPATIAL_RIG_INVALID");
            Map<String, Object> badTime = spatialBody("sp-badtime", "rig", List.of(sourceRef(source)), 0.5);
            object(object(badTime.get("rig")).get("tracks")).put("root", List.of(Map.of(
                    "time", Map.of("numerator", 1, "denominator", 0),
                    "pose", Map.of("position", List.of(0, 0, 0), "orientation", List.of(0, 0, 0, 1)))));
            assertError(send(base, "POST", SPATIAL, JSON.writeValueAsString(badTime), PRINCIPAL, PERMISSIONS), 422,
                    "SPATIAL_RIG_INVALID");
            Map<String, Object> dupSources = spatialBody("sp-dupsrc", "rig", List.of(sourceRef(source), sourceRef(source)), 0.5);
            assertError(send(base, "POST", SPATIAL, JSON.writeValueAsString(dupSources), PRINCIPAL, PERMISSIONS), 422,
                    "SPATIAL_RIG_INVALID");

            // Shape errors are request errors, not engine refusals.
            Map<String, Object> shape = spatialBody("sp-shape", "rig", List.of(sourceRef(source)), 0.5);
            object(shape.get("rig")).put("unexpected", true);
            assertThat(send(base, "POST", SPATIAL, JSON.writeValueAsString(shape), PRINCIPAL, PERMISSIONS).statusCode())
                    .isEqualTo(400);

            // A refused request never registered anything: a good retry with a refused requestId still creates.
            HttpResponse<String> ok = send(base, "POST", SPATIAL, spatialRequest("sp-joint", "rig", List.of(source), 0.5),
                    PRINCIPAL, PERMISSIONS);
            assertThat(ok.statusCode()).as(ok.body()).isEqualTo(201);
        } finally {
            server.stop(0);
            runtime.close();
        }
    }

    private static Map<String, Object> sourceRef(MediaArtifact source) {
        return Map.of("artifactId", source.artifactId(), "artifactVersionId", source.version().value());
    }

    private static String spatialRequest(String requestId, String rigId, List<MediaArtifact> sources, double alpha)
            throws Exception {
        List<Map<String, Object>> refs = new ArrayList<>();
        for (MediaArtifact source : sources) refs.add(sourceRef(source));
        return JSON.writeValueAsString(spatialBody(requestId, rigId, refs, alpha));
    }

    /** Two-bone rig with exact rational keyframes (0, 1/3, 1); {@code midX} perturbs the middle key. */
    private static Map<String, Object> spatialBody(String requestId, String rigId, List<Map<String, Object>> sources,
                                                   double midX) {
        double half = Math.sin(Math.PI / 12);
        double halfW = Math.cos(Math.PI / 12);
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("frameRef", "urn:media:frame:glb");
        frame.put("frameVersionRef", "v1");
        frame.put("handedness", "RIGHT_HANDED");
        frame.put("axisDirections", new ArrayList<>(List.of("POS_X", "POS_Y", "POS_Z")));
        frame.put("positionUnitRef", SpatialRigEngine.GLB_METRE_UNIT_REF);
        frame.put("orientationUnitRef", SpatialRigEngine.GLB_QUATERNION_UNIT_REF);
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("id", "root");
        root.put("restPose", Map.of("position", List.of(0, 0, 0), "orientation", List.of(0, 0, 0, 1)));
        root.put("constraint", new LinkedHashMap<>(Map.of("kind", "BALL", "maxAngularDeviationRadians", Math.PI)));
        Map<String, Object> child = new LinkedHashMap<>();
        child.put("id", "child");
        child.put("parentId", "root");
        child.put("restPose", Map.of("position", List.of(0, 1, 0), "orientation", List.of(0, 0, 0, 1)));
        child.put("constraint", new LinkedHashMap<>(Map.of("kind", "BALL", "maxAngularDeviationRadians", Math.PI)));
        Map<String, Object> track = new LinkedHashMap<>();
        track.put("root", new ArrayList<>(List.of(
                key(0, 1, 0, 0, 0, 0, 1),
                key(1, 3, midX, 0, 0, 0, 0, half, halfW),
                key(1, 1, 1, 0, 0, 0, 0, 0.7071067811865476, 0.7071067811865476))));
        Map<String, Object> rig = new LinkedHashMap<>();
        rig.put("id", rigId);
        rig.put("sourceProjectRevisionRef", "project:edit:revision-8");
        rig.put("coordinateFrame", frame);
        rig.put("sourceVersions", new ArrayList<>(sources));
        rig.put("bones", new ArrayList<>(List.of(root, child)));
        rig.put("tracks", track);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("rig", rig);
        return body;
    }

    private static Map<String, Object> key(long num, long den, double x, double y, double z, double qx, double qy,
                                           double qz, double qw) {
        return Map.of("time", Map.of("numerator", num, "denominator", den),
                "pose", Map.of("position", List.of(x, y, z), "orientation", List.of(qx, qy, qz, qw)));
    }

    private static Map<String, Object> key(long num, long den, double x, double y, double z, double qx, double qw) {
        return key(num, den, x, y, z, qx, 0, 0, qw);
    }

    /** Parses the GLB container by hand and checks the lineage the engine embedded against this test's inputs. */
    private static void assertGlb(byte[] glb, MediaArtifact sourceA, MediaArtifact sourceB) throws Exception {
        ByteBuffer buffer = ByteBuffer.wrap(glb).order(ByteOrder.LITTLE_ENDIAN);
        assertThat(buffer.getInt(0)).isEqualTo(0x46546c67);
        assertThat(buffer.getInt(4)).isEqualTo(2);
        assertThat(buffer.getInt(8)).isEqualTo(glb.length);
        int jsonLength = buffer.getInt(12);
        assertThat(buffer.getInt(16)).isEqualTo(0x4e4f534a);
        Map<String, Object> document = read(new String(glb, 20, jsonLength, StandardCharsets.UTF_8).trim());
        assertThat(object(document.get("asset"))).containsEntry("version", "2.0");
        assertThat(objects(document.get("nodes"))).hasSize(2);
        assertThat(objects(document.get("animations"))).hasSize(1);
        Map<String, Object> meta = object(object(document.get("extras")).get("mediaSpatial"));
        assertThat(meta).containsEntry("rigId", "rig-1")
                .containsEntry("sourceProjectRevisionRef", "project:edit:revision-8")
                .containsEntry("frameRef", "urn:media:frame:glb").containsEntry("frameVersionRef", "v1")
                .containsEntry("timeEncoding", "FLOAT32_SECONDS").containsEntry("lossDisposition", "FLOAT32_APPROXIMATION");
        assertThat(meta.get("float32LossFields")).isEqualTo(List.of(
                "animation.inputTimeSeconds", "animation.outputTranslation", "animation.outputRotation"));
        assertThat(objects(meta.get("sourceVersions"))).extracting(m -> m.get("artifactId"))
                .containsExactlyInAnyOrder(sourceA.artifactId(), sourceB.artifactId());
        assertThat(JSON.writeValueAsString(meta.get("exactKeyframeTimes"))).contains("\"1\"").contains("3");
        // BIN chunk follows the JSON chunk and keyframe input times decode as float32 0, 1/3, 1.
        int binOffset = 20 + jsonLength;
        assertThat(buffer.getInt(binOffset + 4)).isEqualTo(0x004e4942);
        Map<String, Object> sampler = objects(object(objects(document.get("animations")).get(0)).get("samplers")).stream()
                .findFirst().orElseThrow();
        Map<String, Object> accessor = objects(document.get("accessors")).get(((Number) sampler.get("input")).intValue());
        Map<String, Object> view = objects(document.get("bufferViews")).get(((Number) accessor.get("bufferView")).intValue());
        int at = binOffset + 8 + ((Number) view.get("byteOffset")).intValue();
        assertThat(((Number) accessor.get("count")).intValue()).isEqualTo(3);
        assertThat(buffer.getFloat(at)).isEqualTo(0f);
        assertThat(buffer.getFloat(at + 4)).isEqualTo((float) (1.0 / 3.0));
        assertThat(buffer.getFloat(at + 8)).isEqualTo(1f);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> objects(Object value) { return (List<Map<String, Object>>) value; }

    // ---------- helpers ----------

    private static void assertError(HttpResponse<String> response, int status, String code) {
        assertThat(response.statusCode()).as(response.body()).isEqualTo(status);
        assertThat(response.body()).contains(code);
    }

    private static String audioRequest(String requestId, MediaArtifact source, double threshold, int maxRunFrames)
            throws Exception {
        return JSON.writeValueAsString(Map.of("requestId", requestId,
                "source", Map.of("artifactId", source.artifactId(), "artifactVersionId", source.version().value()),
                "profile", Map.of("threshold", threshold, "maxRunFrames", maxRunFrames)));
    }

    private static Map<String, Object> quantity(double value, String unit) {
        Map<String, Object> q = new LinkedHashMap<>();
        q.put("value", value);
        q.put("unit", unit);
        return q;
    }

    private static Map<String, Object> measurement(double value, String unit) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("value", quantity(value, unit));
        m.put("standardUncertainty", quantity(0, unit));
        return m;
    }

    /** Constant force 6 N on 2 kg for 2 s from rest: terminal position/velocity are both 6. */
    private static Map<String, Object> scenario(double expectedPosition, double force) {
        Map<String, Object> model = new LinkedHashMap<>();
        model.put("type", "CONSTANT_FORCE");
        model.put("mass", measurement(2, "KILOGRAM"));
        model.put("force", measurement(force, "NEWTON"));
        Map<String, Object> initial = new LinkedHashMap<>();
        initial.put("position", measurement(0, "METER"));
        initial.put("velocity", measurement(0, "METER_PER_SECOND"));
        Map<String, Object> policy = new LinkedHashMap<>();
        policy.put("duration", quantity(2, "SECOND"));
        policy.put("maxStep", quantity(0.25, "SECOND"));
        policy.put("minStep", quantity(1e-5, "SECOND"));
        policy.put("absolutePositionTolerance", quantity(1e-8, "METER"));
        policy.put("absoluteVelocityTolerance", quantity(1e-8, "METER_PER_SECOND"));
        policy.put("maxAcceptedSteps", 100);
        policy.put("maxIterations", 1000);
        Map<String, Object> invariant = new LinkedHashMap<>();
        invariant.put("id", "terminal-position");
        invariant.put("observable", "POSITION");
        invariant.put("expected", quantity(expectedPosition, "METER"));
        invariant.put("absoluteTolerance", quantity(1e-8, "METER"));
        Map<String, Object> scenario = new LinkedHashMap<>();
        scenario.put("model", model);
        scenario.put("initialState", initial);
        scenario.put("solverPolicy", policy);
        scenario.put("expectedDuration", quantity(2, "SECOND"));
        scenario.put("invariants", new ArrayList<>(List.of(invariant)));
        return scenario;
    }

    private static String simulationRequest(String requestId, double expectedPosition) throws Exception {
        return simulationRequest(requestId, expectedPosition, 6.0);
    }

    private static String simulationRequest(String requestId, double expectedPosition, double force) throws Exception {
        return JSON.writeValueAsString(Map.of("requestId", requestId, "scenario", scenario(expectedPosition, force)));
    }

    /** Mono 16-bit sine whose peaks exceed full scale and are hard-clipped; ends on unclipped neighbours. */
    private static byte[] clippedWav(int sampleRate, int amplitude) {
        int[] samples = new int[sampleRate];
        for (int i = 0; i < samples.length; i++) {
            long v = Math.round(amplitude * Math.sin(2 * Math.PI * 440 * i / (double) sampleRate));
            samples[i] = (int) Math.max(-32768, Math.min(32767, v));
        }
        return wavOf(samples, 16);
    }

    private static byte[] wavOf(int[] samples, int bits) {
        int bytes = bits / 8;
        ByteBuffer wav = ByteBuffer.allocate(44 + samples.length * bytes).order(ByteOrder.LITTLE_ENDIAN);
        wav.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + samples.length * bytes)
                .put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1)
                .putInt(RATE).putInt(RATE * bytes).putShort((short) bytes).putShort((short) bits)
                .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(samples.length * bytes);
        for (int sample : samples) {
            if (bits == 16) wav.putShort((short) sample);
            else { wav.put((byte) sample).put((byte) (sample >> 8)).put((byte) (sample >> 16)); }
        }
        return wav.array();
    }

    private static short[] pcm16(byte[] wav) throws Exception {
        try (AudioInputStream stream = AudioSystem.getAudioInputStream(new ByteArrayInputStream(wav))) {
            assertThat(stream.getFormat().getSampleSizeInBits()).isEqualTo(16);
            byte[] raw = stream.readAllBytes();
            short[] out = new short[raw.length / 2];
            ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(out);
            return out;
        }
    }

    private static MediaArtifact upload(MediaRuntime runtime, String name, String contentType, byte[] bytes,
                                        String key) throws Exception {
        String digest = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        var session = runtime.beginUpload(new UploadRequest(TENANT, PRINCIPAL, name, contentType, bytes.length,
                digest, "INTERNAL", Duration.ofMinutes(30), Map.of()), key);
        int chunk = runtime.config().maximumChunkBytes();
        for (int offset = 0, index = 0; offset < bytes.length; offset += chunk, index++) {
            runtime.appendChunk(TENANT, PRINCIPAL, session.uploadId(), index,
                    Arrays.copyOfRange(bytes, offset, Math.min(bytes.length, offset + chunk)));
        }
        return runtime.completeUpload(TENANT, PRINCIPAL, session.uploadId());
    }

    private static byte[] artifactBytes(MediaRuntime runtime, String artifactId) throws Exception {
        MediaArtifact artifact = runtime.artifact(TENANT, PRINCIPAL, artifactId).orElseThrow();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        runtime.copyArtifactContent(TENANT, PRINCIPAL, artifactId, artifact.version(), out, 16 * 1024 * 1024)
                .orElseThrow();
        return out.toByteArray();
    }

    private static MediaRuntime runtime(Path root) {
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "dev", 8093, 1_048_576, 131_072, 1_048_576,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(false),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                List.of(new NoEffectProvider()),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    private static HttpServer server(MediaRuntime runtime, MediaDevCreativeOutputRuntime creative) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        MediaHttpHandler handler = new MediaHttpHandler(runtime, null, null,
                new MediaDevProjectTimelineRuntime(new InMemoryManagedStore()), (MediaDevReviewRuntime) null,
                creative == null ? new MediaDevCreativeOutputRuntime(runtime) : creative);
        server.createContext("/", new MediaSecurityFilter(handler, "dev", devEnvironment(), CLOCK));
        server.start();
        return server;
    }

    private static String base(HttpServer server) { return "http://127.0.0.1:" + server.getAddress().getPort(); }

    private static HttpResponse<String> send(String base, String method, String path, String body,
                                             String principal, Set<String> permissions) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(base + path))
                .header("Authorization", "Bearer " + token(principal, permissions))
                .header("X-Tenant-Id", TENANT);
        if (body != null) request.header("Content-Type", "application/json");
        request.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private static String token(String principal, Set<String> permissions) throws Exception {
        String header = encode("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String permissionJson = permissions.stream().sorted().map(permission -> "\"" + permission + "\"")
                .collect(java.util.stream.Collectors.joining(","));
        String payload = "{\"sub\":\"" + principal + "\",\"tenant_id\":\"" + TENANT
                + "\",\"iss\":\"" + ISSUER + "\",\"aud\":\"" + AUDIENCE + "\",\"dev_only\":true,"
                + "\"iat\":" + CLOCK.instant().getEpochSecond() + ",\"exp\":"
                + CLOCK.instant().plusSeconds(120).getEpochSecond() + ",\"permissions\":[" + permissionJson + "]}";
        String signingInput = header + "." + encode(payload);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return signingInput + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
    }

    private static String encode(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static Map<String, String> devEnvironment() {
        return Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true", "MEDIA_DEV_JWT_HMAC_SECRET", SECRET);
    }

    private static Map<String, Object> read(String json) throws Exception {
        return JSON.readValue(json, new TypeReference<Map<String, Object>>() { });
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value) { return (Map<String, Object>) value; }

    private static final class InMemoryManagedStore implements ManagedProjectTimelineStore {
        private final ProjectTimelineStore delegate = new InMemoryProjectTimelineStore();
        @Override public Created create(Actor actor, String workspaceId, String title, String requestId,
                                        String projectId, String initialRevisionId) {
            return delegate.create(actor, workspaceId, title, requestId, projectId, initialRevisionId);
        }
        @Override public Project project(Actor actor, String projectId) { return delegate.project(actor, projectId); }
        @Override public Revision revision(Actor actor, String projectId, String revisionId) {
            return delegate.revision(actor, projectId, revisionId);
        }
        @Override public Revision commit(Actor actor, String projectId, String expectedHeadRevisionId,
                                         String newRevisionId, List<TimelineSnapshot> timelines) {
            return delegate.commit(actor, projectId, expectedHeadRevisionId, newRevisionId, timelines);
        }
        @Override public void close() { }
    }

    private static final class NoEffectProvider implements MediaProcessingProvider {
        @Override public String providerId() { return "dev-creative-http-no-effect"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 0; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            return CompletableFuture.failedFuture(new AssertionError("creative routes must not invoke processing"));
        }
    }
}
