package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRightsConsentContracts.Reason;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.InMemoryManagedStore;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.TENANT;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.base;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.object;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.read;
import static com.ghatana.media.launcher.MediaDevProjectRenderHttpTest.send;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * J-17 DEV_ONLY stems, foley, mix and master over the real HTTP host, filter and artifact store with REAL FFmpeg. Loudness
 * and true peak are measured here by FFmpeg's own EBU R128 filter (ebur128 with peak=true), independently of the host's
 * meters. The durable PostgreSQL/S3 path, launcher kill and restart and the browser are covered by
 * {@code MediaDevMasterIT} and the Explorer live test.
 */
class MediaDevMasterHttpTest {
    private static final String OWNER = "test-principal-owner";
    private static final String OTHER = "test-principal-other";
    private static final Set<String> PERMISSIONS = Set.of("media:project:dev:create", "media:project:dev:read",
            "media:project:dev:write", "media:artifact:read", "media:artifact:create");
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final String STEMS = "/dev/v1/masters/stems";
    private static final String MASTERS = "/dev/v1/masters";

    private static Path ffmpeg;
    private static Path root;

    private final Set<String> admitted = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean revoked = new AtomicBoolean();
    private final RightsConsentResolver resolver = new RightsConsentResolver() {
        @Override public String resolverId() { return "test-resolver"; }
        @Override public boolean ready() { return true; }
        @Override public Resolution resolve(ResolutionRequest request) {
            if (!admitted.contains(request.artifactId())) {
                return new Resolution(Verdict.DENIED, Set.of(Reason.NO_ATTESTATION), List.of(), resolverId());
            }
            if (revoked.get()) return new Resolution(Verdict.REVOKED, Set.of(Reason.REVOKED), List.of(), resolverId());
            return new Resolution(Verdict.ADMITTED, Set.of(), List.of("att-" + request.artifactId()), resolverId());
        }
    };

    @BeforeAll
    static void tools() throws Exception {
        String ff = System.getenv("MEDIA_DEV_RENDER_FFMPEG");
        assertThat(ff).as("MEDIA_DEV_RENDER_FFMPEG").isNotBlank();
        ffmpeg = Path.of(ff);
        root = Files.createTempDirectory("media-dev-master-http-");
    }

    @AfterAll
    static void cleanup() {
        if (root != null) deleteTree(root);
    }

    // ---------------------------------------------------------------------------------------------- stems

    @Test
    void stemsAreOriginalDeterministicTypedAndOwnerScoped() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            Map<String, Object> spec = tone(440.0, 500);
            HttpResponse<String> first = send(base, "POST", STEMS, stemBody("stem-1", spec), OWNER, PERMISSIONS);
            assertThat(first.statusCode()).as(first.body()).isEqualTo(201);
            Map<String, Object> view = read(first.body());
            Map<String, Object> artifact = object(view.get("artifact"));
            assertThat(artifact).containsEntry("contentType", "audio/wav");
            Map<String, Object> lineage = object(view.get("lineage"));
            assertThat(object(lineage.get("generator"))).containsEntry("origin", "ORIGINAL_PROCEDURAL_SYNTHESIS")
                    .containsEntry("thirdPartyMaterial", false);
            assertThat(object(lineage.get("rightsDecision"))).containsEntry("legalClearanceClaimed", false)
                    .containsEntry("productionGrant", false);
            MediaDevAudioWav.Pcm pcm = MediaDevAudioWav.parse(content(runtime, (String) artifact.get("artifactId")), true);
            assertThat(pcm.sampleRate()).isEqualTo(48_000);
            assertThat(pcm.frames()).isEqualTo(24_000);

            // identical spec, new requestId: identical bytes, and the content-derived registration is one artifact
            int count = artifactCount(runtime);
            HttpResponse<String> second = send(base, "POST", STEMS, stemBody("stem-2", spec), OWNER, PERMISSIONS);
            assertThat(second.statusCode()).as(second.body()).isEqualTo(201);
            assertThat(object(read(second.body()).get("artifact"))).containsEntry("sha256", artifact.get("sha256"))
                    .containsEntry("artifactId", artifact.get("artifactId"));
            assertThat(artifactCount(runtime)).isEqualTo(count);

            // another owner in the same tenant generating the same spec gets its own artifact: the store keeps one artifact per
            // (tenant, digest, size), so the owner is part of the stem's bytes (a comment chunk), not of its samples
            HttpResponse<String> otherOwner = send(base, "POST", STEMS, stemBody("stem-other-owner", spec), OTHER, PERMISSIONS);
            assertThat(otherOwner.statusCode()).as(otherOwner.body()).isEqualTo(201);
            Map<String, Object> otherArtifact = object(read(otherOwner.body()).get("artifact"));
            assertThat(otherArtifact.get("artifactId")).isNotEqualTo(artifact.get("artifactId"));
            assertThat(otherArtifact.get("sha256")).isNotEqualTo(artifact.get("sha256"));
            MediaDevAudioWav.Pcm ownPcm = MediaDevAudioWav.parse(content(runtime, (String) artifact.get("artifactId")), true);
            assertThat(MediaDevAudioWav.parse(contentAs(runtime, OTHER, (String) otherArtifact.get("artifactId")), true).raw())
                    .as("same samples, different owner").isEqualTo(ownPcm.raw());

            // replay, changed body under the same requestId, reopen, another principal
            assertThat(send(base, "POST", STEMS, stemBody("stem-1", spec), OWNER, PERMISSIONS).statusCode()).isEqualTo(200);
            HttpResponse<String> reused = send(base, "POST", STEMS, stemBody("stem-1", tone(441.0, 500)), OWNER, PERMISSIONS);
            assertThat(reused.statusCode()).isEqualTo(409);
            assertThat(reused.body()).contains("MASTER_REQUEST_ID_REUSED");
            assertThat(send(base, "GET", STEMS + "/" + artifact.get("artifactId"), null, OWNER, PERMISSIONS).statusCode()).isEqualTo(200);
            assertThat(send(base, "GET", STEMS + "/" + artifact.get("artifactId"), null, OTHER, PERMISSIONS).statusCode()).isEqualTo(404);
            assertThat(send(base, "POST", STEMS, stemBody("stem-3", spec), OWNER, Set.of("media:project:dev:write"))
                    .statusCode()).as("artifact permissions are required").isEqualTo(403);

            // typed 422 with the JSON path, and budgets
            Map<String, Map<String, Object>> invalid = new LinkedHashMap<>();
            invalid.put("$.spec.frequencyHz", tone(5.0, 500));
            invalid.put("$.spec.kind", new LinkedHashMap<>(Map.of("kind", "VOCAL", "durationMs", 500)));
            invalid.put("$.spec.drum", new LinkedHashMap<>(Map.of("kind", "TONE", "durationMs", 500, "frequencyHz", 440, "drum", "KICK")));
            invalid.put("$.spec.durationMs", new LinkedHashMap<>(Map.of("kind", "TONE", "durationMs", "long", "frequencyHz", 440)));
            invalid.put("$.spec.amplitudeDb", new LinkedHashMap<>(Map.of("kind", "TONE", "durationMs", 500, "frequencyHz", 440, "amplitudeDb", 3)));
            invalid.put("$.spec.releaseMs", new LinkedHashMap<>(Map.of("kind", "TONE", "durationMs", 500, "frequencyHz", 440, "releaseMs", 600)));
            invalid.put("$.spec.frequenciesHz[1]", new LinkedHashMap<>(Map.of("kind", "CHORD", "durationMs", 500, "frequenciesHz", List.of(440, 99_999))));
            invalid.put("$.spec.seed", new LinkedHashMap<>(Map.of("kind", "DRUM", "drum", "SNARE", "durationMs", 500, "seed", -1)));
            for (Map.Entry<String, Map<String, Object>> entry : invalid.entrySet()) {
                HttpResponse<String> response = send(base, "POST", STEMS, stemBody("bad-" + Math.abs(entry.hashCode()), entry.getValue()), OWNER, PERMISSIONS);
                assertThat(response.statusCode()).as(entry.getKey() + " " + response.body()).isEqualTo(422);
                Map<String, Object> error = object(read(response.body()).get("error"));
                assertThat(error).containsEntry("code", "MASTER_PARAMETERS_INVALID");
                assertThat(object(error.get("details"))).containsEntry("path", entry.getKey());
            }
            HttpResponse<String> over = send(base, "POST", STEMS, stemBody("big-1", tone(440.0, 31_000)), OWNER, PERMISSIONS);
            assertThat(over.statusCode()).isEqualTo(422);
            assertThat(over.body()).contains("MASTER_BUDGET_EXCEEDED").contains("$.spec.durationMs");
            HttpResponse<String> surround = send(base, "POST", STEMS, stemBody("six-1", new LinkedHashMap<>(
                    Map.of("kind", "TONE", "durationMs", 500, "frequencyHz", 440, "channels", 6))), OWNER, PERMISSIONS);
            assertThat(surround.statusCode()).isEqualTo(422);
            assertThat(surround.body()).contains("STEM_FORMAT_NOT_SUPPORTED").contains("$.spec.channels");
            assertThat(send(base, "POST", STEMS, "{\"requestId\":\"dup-1\",\"requestId\":\"dup-2\",\"spec\":{}}", OWNER, PERMISSIONS)
                    .statusCode()).as("duplicate keys are refused").isEqualTo(422);
        } finally {
            server.stop(0);
        }
    }

    // ---------------------------------------------------------------------------------------------- master

    @Test
    void masterMeetsTargetMeasuredByFfmpegPlacesStemsOnTheExactSampleAndShipsADecodableFlac() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            Map<String, Object> kick = stem(base, "kick", new LinkedHashMap<>(Map.of("kind", "DRUM", "drum", "KICK", "durationMs", 300, "seed", 1)));
            Map<String, Object> step = stem(base, "step", new LinkedHashMap<>(Map.of("kind", "FOLEY", "foley", "FOOTSTEP", "durationMs", 400, "seed", 5, "channels", 2)));
            Map<String, Object> chord = stem(base, "chord", new LinkedHashMap<>(Map.of("kind", "CHORD", "durationMs", 1500,
                    "frequenciesHz", List.of(261.63, 329.63, 392.0), "amplitudeDb", -12)));
            List<Map<String, Object>> placements = List.of(
                    placement(chord, -3.0, 0.0, 0, 4_800, 9_600),
                    placement(kick, 0.0, 0.0, 14_400, 0, 0),
                    placement(step, -4.0, 0.5, 38_400, 0, 480),
                    placement(kick, -2.0, -0.5, 62_400, 0, 0));
            HttpResponse<String> response = send(base, "POST", MASTERS, masterBody("m-1", placements, null, -16.0, -1.0), OWNER, PERMISSIONS);
            assertThat(response.statusCode()).as(response.body()).isEqualTo(201);
            Map<String, Object> view = read(response.body());
            Map<String, Object> report = object(view.get("report"));
            Map<String, Object> measurement = object(report.get("measurement"));
            assertThat(measurement).containsEntry("targetMet", true).containsEntry("clippedSamples", 0);
            double lufs = ((Number) measurement.get("integratedLufs")).doubleValue();
            double tp = ((Number) measurement.get("truePeakDbtp")).doubleValue();
            assertThat(lufs).isBetween(-16.25, -15.75);
            assertThat(tp).isLessThanOrEqualTo(-1.0);

            String wavId = (String) object(view.get("wav")).get("artifactId");
            String flacId = (String) object(view.get("flac")).get("artifactId");
            byte[] wav = content(runtime, wavId);
            byte[] flac = content(runtime, flacId);
            assertThat(object(view.get("wav"))).containsEntry("contentType", "audio/wav");
            assertThat(object(view.get("flac"))).containsEntry("contentType", "audio/flac");
            MediaDevAudioWav.Pcm master = MediaDevAudioWav.parse(wav, true);
            assertThat(master.channels()).isEqualTo(2);
            assertThat(master.sampleRate()).isEqualTo(48_000);
            assertThat(master.frames()).isEqualTo(((Number) object(report.get("format")).get("frames")).intValue());

            // ---- independent measurement by FFmpeg's EBU R128 meter (true peak on) on the stored bytes ----
            Path wavFile = root.resolve("m1.wav");
            Files.write(wavFile, wav);
            double[] ffmpegMeasure = ebur128(wavFile);
            System.out.printf("J17-HTTP-EBUR128 host: %.2f LUFS %.2f dBTP | ffmpeg ebur128: %.2f LUFS %.2f dBTP%n", lufs, tp, ffmpegMeasure[0], ffmpegMeasure[1]);
            assertThat(ffmpegMeasure[0]).as("ffmpeg integrated loudness").isBetween(-16.5, -15.5);
            assertThat(Math.abs(ffmpegMeasure[0] - lufs)).as("ffmpeg agrees with the host report").isLessThanOrEqualTo(0.5);
            assertThat(ffmpegMeasure[1]).as("ffmpeg true peak respects the ceiling").isLessThanOrEqualTo(-1.0);
            assertThat(Math.abs(ffmpegMeasure[1] - tp)).as("true peak agrees with the host report").isLessThanOrEqualTo(0.5);
            long fullScale = 0;
            for (short sample : master.raw()) if (Math.abs((int) sample) >= 32767) fullScale++;
            assertThat(fullScale).as("zero clipped samples").isZero();

            // ---- FLAC decodes to exactly the WAV samples ----
            Path flacFile = root.resolve("m1.flac");
            Files.write(flacFile, flac);
            byte[] decoded = runBytes(ffmpeg.toString(), "-nostdin", "-v", "error", "-i", flacFile.toString(), "-f", "s16le", "-acodec", "pcm_s16le", "-");
            assertThat(decoded).isEqualTo(Arrays.copyOfRange(wav, 44, 44 + master.raw().length * 2));

            // ---- sample-exact placement: the master equals an independent re-mix of the stored stems ----
            assertThat(object(measurement.get("limiter"))).containsEntry("limitedFrames", 0);
            MediaDevAudioWav.Pcm chordWav = stemStereo(runtime, chord);
            MediaDevAudioWav.Pcm kickWav = stemStereo(runtime, kick);
            MediaDevAudioWav.Pcm stepWav = stemStereo(runtime, step);
            assertPlacementExact(master.raw(), ((Number) measurement.get("preLimiterGainDb")).doubleValue(), List.of(
                    new Piece(chordWav.raw(), 1, -3.0, 0.0, 0, 4_800, 9_600),
                    new Piece(kickWav.raw(), 1, 0.0, 0.0, 14_400, 0, 0),
                    new Piece(stepWav.raw(), 2, -4.0, 0.5, 38_400, 0, 480),
                    new Piece(kickWav.raw(), 1, -2.0, -0.5, 62_400, 0, 0)));

            // ---- lineage to every stem, with origin and placement; rights record is honest ----
            List<?> lineageStems = (List<?>) report.get("stems");
            assertThat(lineageStems).hasSize(4);
            assertThat(object(lineageStems.get(1))).containsEntry("artifactId", kick.get("artifactId")).containsEntry("startFrame", 14_400)
                    .containsEntry("origin", "ORIGINAL_PROCEDURAL_SYNTHESIS");
            assertThat(object(report.get("rightsDecision"))).containsEntry("originalProceduralStems", 3).containsEntry("uploadedStems", 0)
                    .containsEntry("legalClearanceClaimed", false).containsEntry("productionGrant", false);
            MediaArtifact wavArtifact = runtime.artifact(TENANT, OWNER, wavId).orElseThrow();
            assertThat((List<?>) wavArtifact.metadata().get("sources")).hasSize(3);
            assertThat(object(wavArtifact.metadata().get("parent"))).containsKey("artifactId");

            // ---- replay, changed body, reopen, other principal ----
            int count = artifactCount(runtime);
            HttpResponse<String> replay = send(base, "POST", MASTERS, masterBody("m-1", placements, null, -16.0, -1.0), OWNER, PERMISSIONS);
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(read(replay.body())).containsEntry("replayed", true).containsEntry("masterId", view.get("masterId"));
            HttpResponse<String> changed = send(base, "POST", MASTERS, masterBody("m-1", placements, null, -14.0, -1.0), OWNER, PERMISSIONS);
            assertThat(changed.statusCode()).isEqualTo(409);
            assertThat(changed.body()).contains("MASTER_REQUEST_ID_REUSED");
            assertThat(artifactCount(runtime)).isEqualTo(count);
            // the same content under a new requestId is the same registered output (content-derived registration)
            HttpResponse<String> again = send(base, "POST", MASTERS, masterBody("m-2", placements, null, -16.0, -1.0), OWNER, PERMISSIONS);
            assertThat(again.statusCode()).isEqualTo(201);
            assertThat(read(again.body())).containsEntry("masterId", view.get("masterId"));
            assertThat(artifactCount(runtime)).isEqualTo(count);
            assertThat(send(base, "GET", MASTERS + "/" + view.get("masterId"), null, OWNER, PERMISSIONS).statusCode()).isEqualTo(200);
            assertThat(send(base, "GET", MASTERS + "/" + view.get("masterId"), null, OTHER, PERMISSIONS).statusCode()).isEqualTo(404);
            HttpResponse<String> foreign = send(base, "POST", MASTERS, masterBody("m-3", placements, null, -16.0, -1.0), OTHER, PERMISSIONS);
            assertThat(foreign.statusCode()).as("a stem of another owner is invisible").isEqualTo(404);
            assertThat(foreign.body()).contains("SOURCE_VERSION_NOT_FOUND");
            assertThat(send(base, "GET", MASTERS + "/status", null, OWNER, PERMISSIONS).statusCode()).isEqualTo(200);

            // a different target is a real, measured, different master (-20 LUFS / -3 dBTP)
            HttpResponse<String> quiet = send(base, "POST", MASTERS, masterBody("m-4", placements, null, -20.0, -3.0), OWNER, PERMISSIONS);
            assertThat(quiet.statusCode()).as(quiet.body()).isEqualTo(201);
            Path quietFile = root.resolve("m4.wav");
            Files.write(quietFile, content(runtime, (String) object(read(quiet.body()).get("wav")).get("artifactId")));
            double[] quietMeasure = ebur128(quietFile);
            assertThat(quietMeasure[0]).isBetween(-20.5, -19.5);
            assertThat(quietMeasure[1]).isLessThanOrEqualTo(-3.0);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void monoStereoPanAndExactGainAreHandledSampleForSample() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            Map<String, Object> mono = stem(base, "mono", new LinkedHashMap<>(Map.of("kind", "TONE", "durationMs", 1000, "frequencyHz", 330, "attackMs", 0, "releaseMs", 0)));
            Map<String, Object> stereo = stem(base, "stereo", new LinkedHashMap<>(Map.of("kind", "FOLEY", "foley", "WHOOSH", "durationMs", 1000, "seed", 3, "channels", 2)));
            // centre-panned mono: the master's channels are identical (exact duplication, one gain)
            HttpResponse<String> centre = send(base, "POST", MASTERS, masterBody("mono-centre", List.of(placement(mono, 0, 0.0, 0, 0, 0)), null, -16.0, -1.0), OWNER, PERMISSIONS);
            assertThat(centre.statusCode()).as(centre.body()).isEqualTo(201);
            MediaDevAudioWav.Pcm centred = MediaDevAudioWav.parse(content(runtime, (String) object(read(centre.body()).get("wav")).get("artifactId")), true);
            assertThat(channel(centred, 0)).isEqualTo(channel(centred, 1));
            // hard-left mono: the right channel is exactly silent
            HttpResponse<String> left = send(base, "POST", MASTERS, masterBody("mono-left", List.of(placement(mono, 0, -1.0, 0, 0, 0)), null, -16.0, -1.0), OWNER, PERMISSIONS);
            MediaDevAudioWav.Pcm hardLeft = MediaDevAudioWav.parse(content(runtime, (String) object(read(left.body()).get("wav")).get("artifactId")), true);
            assertThat(channel(hardLeft, 1)).containsOnly((short) 0);
            assertThat(Arrays.stream(toInts(channel(hardLeft, 0))).map(Math::abs).max().orElse(0)).isGreaterThan(1000);
            // a stereo stem keeps its two different channels
            HttpResponse<String> wide = send(base, "POST", MASTERS, masterBody("stereo-1", List.of(placement(stereo, 0, 0.0, 0, 0, 0)), null, -16.0, -1.0), OWNER, PERMISSIONS);
            assertThat(wide.statusCode()).as(wide.body()).isEqualTo(201);
            MediaDevAudioWav.Pcm wideWav = MediaDevAudioWav.parse(content(runtime, (String) object(read(wide.body()).get("wav")).get("artifactId")), true);
            assertThat(channel(wideWav, 0)).isNotEqualTo(channel(wideWav, 1));
        } finally {
            server.stop(0);
        }
    }

    @Test
    void silenceIsAnAbstentionBudgetsAreTypedAndTheOnlyFormatsAreMonoAndStereo48kPcm16() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            // silence-only input (admitted uploader statement): a typed abstention, never infinite gain
            MediaArtifact silence = upload(runtime, "silence.wav", "audio/wav", MediaDevAudioWav.write(new MediaDevAudioWav.Pcm(48_000, 1, new short[48_000])));
            admitted.add(silence.artifactId());
            int beforeSilence = artifactCount(runtime);
            HttpResponse<String> silent = send(base, "POST", MASTERS, masterBody("silent", List.of(placementOf(silence, 0, 0.0, 0, 0, 0)), null, -16.0, -1.0), OWNER, PERMISSIONS);
            assertThat(silent.statusCode()).as(silent.body()).isEqualTo(422);
            Map<String, Object> error = object(read(silent.body()).get("error"));
            assertThat(error).containsEntry("code", "MASTER_LOUDNESS_TARGET_UNREACHABLE");
            assertThat(object(error.get("details"))).containsEntry("reason", "SILENT_INPUT").containsEntry("outcome", "ABSTAINED");
            assertThat(artifactCount(runtime)).as("the abstention registered nothing").isEqualTo(beforeSilence);

            // more than two channels, another rate, a truncated frame and a non-WAV are all refused with the stem's path
            MediaArtifact surround = upload(runtime, "six.wav", "audio/wav", sixChannelWav());
            MediaArtifact cd = upload(runtime, "cd.wav", "audio/wav", MediaDevAudioWav.write(new MediaDevAudioWav.Pcm(44_100, 1, tonePcm(44_100, 440, 44_100))));
            byte[] good = MediaDevAudioWav.write(new MediaDevAudioWav.Pcm(48_000, 2, tonePcm(48_000, 440, 96_000)));
            MediaArtifact partial = upload(runtime, "partial.wav", "audio/wav", Arrays.copyOf(good, good.length - 1));
            MediaArtifact text = upload(runtime, "notes.txt", "text/plain", "not audio".getBytes());
            for (MediaArtifact refused : List.of(surround, cd, partial, text)) admitted.add(refused.artifactId());
            for (MediaArtifact refused : List.of(surround, cd, partial, text)) {
                HttpResponse<String> response = send(base, "POST", MASTERS, masterBody("fmt-" + refused.artifactId(), List.of(placementOf(refused, 0, 0.0, 0, 0, 0)), null, -16.0, -1.0), OWNER, PERMISSIONS);
                assertThat(response.statusCode()).as(refused.artifactId() + " " + response.body()).isEqualTo(422);
                Map<String, Object> failure = object(read(response.body()).get("error"));
                assertThat(failure).containsEntry("code", "STEM_FORMAT_NOT_SUPPORTED");
                assertThat(object(failure.get("details")).get("path").toString()).startsWith("$.stems[0]");
            }

            // very large input: bytes over the per-stem ceiling, and a long mono stem over the frame ceiling
            MediaArtifact fat = upload(runtime, "fat.wav", "audio/wav", MediaDevAudioWav.write(new MediaDevAudioWav.Pcm(48_000, 2, stereoTone(2_200_000))));
            MediaArtifact longMono = upload(runtime, "long.wav", "audio/wav", MediaDevAudioWav.write(new MediaDevAudioWav.Pcm(48_000, 1, tonePcm(48_000, 220, 61 * 48_000))));
            admitted.add(fat.artifactId());
            admitted.add(longMono.artifactId());
            HttpResponse<String> fatResponse = send(base, "POST", MASTERS, masterBody("fat", List.of(placementOf(fat, 0, 0.0, 0, 0, 0)), null, -16.0, -1.0), OWNER, PERMISSIONS);
            assertThat(fatResponse.statusCode()).as(fatResponse.body()).isEqualTo(422);
            assertThat(fatResponse.body()).contains("MASTER_BUDGET_EXCEEDED").contains("$.stems[0].artifactId").contains("stem bytes");
            HttpResponse<String> longResponse = send(base, "POST", MASTERS, masterBody("long", List.of(placementOf(longMono, 0, 0.0, 0, 0, 0)), null, -16.0, -1.0), OWNER, PERMISSIONS);
            assertThat(longResponse.statusCode()).as(longResponse.body()).isEqualTo(422);
            assertThat(longResponse.body()).contains("MASTER_BUDGET_EXCEEDED").contains("stem frames");

            // parameter and placement faults carry their JSON path
            Map<String, Object> tone = stem(base, "t", tone(440.0, 1000));
            Map<String, Map<String, Object>> invalid = new LinkedHashMap<>();
            invalid.put("$.stems[0].pan", rawMaster("p1", List.of(withPlacement(tone, "pan", 2.0)), null, null));
            invalid.put("$.stems[0].gainDb", rawMaster("p2", List.of(withPlacement(tone, "gainDb", 40.0)), null, null));
            invalid.put("$.stems[0].startFrame", rawMaster("p3", List.of(withPlacement(tone, "startFrame", -5)), null, null));
            invalid.put("$.stems[0].fadeInFrames", rawMaster("p4", List.of(withPlacement(tone, "fadeInFrames", 1.5)), null, null));
            invalid.put("$.stems[0].bogus", rawMaster("p5", List.of(withPlacement(tone, "bogus", 1)), null, null));
            invalid.put("$.target.integratedLufs", rawMaster("p6", List.of(placement(tone, 0, 0.0, 0, 0, 0)), null, Map.of("integratedLufs", -5.0)));
            invalid.put("$.target.truePeakDbtp", rawMaster("p7", List.of(placement(tone, 0, 0.0, 0, 0, 0)), null, Map.of("truePeakDbtp", 0.5)));
            invalid.put("$.stems", rawMaster("p8", List.of(), null, null));
            invalid.put("$.durationFrames", rawMaster("p9", List.of(placement(tone, 0, 0.0, 0, 0, 0)), 1000, null));
            for (Map.Entry<String, Map<String, Object>> entry : invalid.entrySet()) {
                HttpResponse<String> response = send(base, "POST", MASTERS, JSON.writeValueAsString(entry.getValue()), OWNER, PERMISSIONS);
                assertThat(response.statusCode()).as(entry.getKey() + " " + response.body()).isEqualTo(422);
                Map<String, Object> failure = object(read(response.body()).get("error"));
                assertThat(object(failure.get("details"))).containsEntry("path", entry.getKey());
            }
            HttpResponse<String> pastEnd = send(base, "POST", MASTERS, masterBody("past", List.of(placement(tone, 0, 0.0, 30_000, 0, 0)), 48_000, -16.0, -1.0), OWNER, PERMISSIONS);
            assertThat(pastEnd.statusCode()).isEqualTo(422);
            assertThat(pastEnd.body()).contains("MASTER_STEM_PAST_END");
            HttpResponse<String> hugeStart = send(base, "POST", MASTERS, masterBody("huge", List.of(placement(tone, 0, 0.0, 2_900_000, 0, 0)), null, -16.0, -1.0), OWNER, PERMISSIONS);
            assertThat(hugeStart.statusCode()).isEqualTo(422);
            assertThat(hugeStart.body()).contains("MASTER_BUDGET_EXCEEDED");
            HttpResponse<String> fades = send(base, "POST", MASTERS, masterBody("fades", List.of(placement(tone, 0, 0.0, 0, 40_000, 40_000)), null, -16.0, -1.0), OWNER, PERMISSIONS);
            assertThat(fades.statusCode()).isEqualTo(422);
            assertThat(fades.body()).contains("$.stems[0].fadeOutFrames");
            HttpResponse<String> shortMaster = send(base, "POST", MASTERS, masterBody("short", List.of(placement(
                    stem(base, "tiny", tone(440.0, 100)), 0, 0.0, 0, 0, 0)), null, -16.0, -1.0), OWNER, PERMISSIONS);
            assertThat(shortMaster.statusCode()).isEqualTo(422);
            assertThat(shortMaster.body()).contains("MASTER_TOO_SHORT_TO_MEASURE");
        } finally {
            server.stop(0);
        }
    }

    @Test
    void uploadedStemsNeedAdmittedProcessingRightsOnEveryCallAndForgedMetadataBuysNothing() throws Exception {
        MediaRuntime runtime = runtime();
        HttpServer server = server(runtime);
        try {
            String base = base(server);
            MediaArtifact upload = upload(runtime, "guitar.wav", "audio/wav", MediaDevAudioWav.write(new MediaDevAudioWav.Pcm(48_000, 1, tonePcm(48_000, 196, 72_000))));
            int before = artifactCount(runtime);
            HttpResponse<String> missing = send(base, "POST", MASTERS, masterBody("up-1", List.of(placementOf(upload, 0, 0.0, 0, 0, 0)), null, -16.0, -1.0), OWNER, PERMISSIONS);
            assertThat(missing.statusCode()).as(missing.body()).isEqualTo(403);
            Map<String, Object> error = object(read(missing.body()).get("error"));
            assertThat(error).containsEntry("code", "RIGHTS_NOT_ADMITTED");
            assertThat(object(error.get("details"))).containsEntry("verdict", "DENIED").containsEntry("path", "$.stems[0].artifactId")
                    .containsEntry("artifactId", upload.artifactId());
            assertThat(artifactCount(runtime)).as("nothing mixed or registered without rights").isEqualTo(before);

            // forged generator metadata on an upload does not make it Media's own output: it is still an uploaded stem
            Map<String, Object> forgedSpec = new LinkedHashMap<>(Map.of("schema", MediaDevMasterSpec.STEM_SCHEMA, "kind", "TONE", "durationMs", 1500,
                    "channels", 1, "amplitudeDb", -6.0, "frequencyHz", 196.0, "attackMs", 5, "releaseMs", 20));
            MediaArtifact forged = upload(runtime, "forged.wav", "audio/wav", MediaDevAudioWav.write(new MediaDevAudioWav.Pcm(48_000, 1, tonePcm(48_000, 197, 72_000))),
                    Map.of("stemSchema", MediaDevMasterRuntime.SCHEMA_STEM, "generatorSpec", forgedSpec, "kind", MediaDevMasterRuntime.KIND_STEM));
            HttpResponse<String> forgedResponse = send(base, "POST", MASTERS, masterBody("forged-1", List.of(placementOf(forged, 0, 0.0, 0, 0, 0)), null, -16.0, -1.0), OWNER, PERMISSIONS);
            assertThat(forgedResponse.statusCode()).as(forgedResponse.body()).isEqualTo(403);

            admitted.add(upload.artifactId());
            Map<String, Object> own = stem(base, "own", tone(440.0, 1000));
            HttpResponse<String> mixed = send(base, "POST", MASTERS, masterBody("up-2", List.of(placementOf(upload, -3.0, 0.0, 0, 0, 0), placement(own, 0, 0.0, 0, 0, 0)), null, -16.0, -1.0), OWNER, PERMISSIONS);
            assertThat(mixed.statusCode()).as(mixed.body()).isEqualTo(201);
            Map<String, Object> view = read(mixed.body());
            Map<String, Object> report = object(view.get("report"));
            assertThat(object(report.get("rightsDecision"))).containsEntry("uploadedStems", 1).containsEntry("originalProceduralStems", 1)
                    .containsEntry("attestationIds", List.of("att-" + upload.artifactId())).containsEntry("legalClearanceClaimed", false);
            List<?> lineage = (List<?>) report.get("stems");
            assertThat(object(lineage.get(0))).containsEntry("origin", "UPLOADED_WITH_PROCESSING_RIGHTS").containsKey("rights");
            assertThat(object(lineage.get(1))).containsEntry("origin", "ORIGINAL_PROCEDURAL_SYNTHESIS");
            assertThat(((Number) object(report.get("measurement")).get("integratedLufs")).doubleValue()).isBetween(-16.25, -15.75);

            // rights are re-checked on a replay: revocation refuses even the stored master
            revoked.set(true);
            HttpResponse<String> replay = send(base, "POST", MASTERS, masterBody("up-2", List.of(placementOf(upload, -3.0, 0.0, 0, 0, 0), placement(own, 0, 0.0, 0, 0, 0)), null, -16.0, -1.0), OWNER, PERMISSIONS);
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(403);
            assertThat(replay.body()).contains("REVOKED");
            HttpResponse<String> fresh = send(base, "POST", MASTERS, masterBody("up-3", List.of(placementOf(upload, 0, 0.0, 0, 0, 0)), null, -16.0, -1.0), OWNER, PERMISSIONS);
            assertThat(fresh.statusCode()).isEqualTo(403);
            // procedural stems stay usable: they carry no third-party material
            HttpResponse<String> originalOnly = send(base, "POST", MASTERS, masterBody("up-4", List.of(placement(own, 0, 0.0, 0, 0, 0)), null, -16.0, -1.0), OWNER, PERMISSIONS);
            assertThat(originalOnly.statusCode()).as(originalOnly.body()).isEqualTo(201);
            revoked.set(false);
        } finally {
            server.stop(0);
        }
    }

    // ---------------------------------------------------------------------------------------------- helpers: requests

    private Map<String, Object> stem(String base, String id, Map<String, Object> spec) throws Exception {
        HttpResponse<String> response = send(base, "POST", STEMS, stemBody("stem-" + id, spec), OWNER, PERMISSIONS);
        assertThat(response.statusCode()).as(response.body()).isIn(200, 201);
        Map<String, Object> artifact = object(read(response.body()).get("artifact"));
        return new LinkedHashMap<>(Map.of("artifactId", artifact.get("artifactId"), "artifactVersionId", artifact.get("artifactVersionId")));
    }

    private static Map<String, Object> tone(double hz, int ms) {
        return new LinkedHashMap<>(Map.of("kind", "TONE", "durationMs", ms, "frequencyHz", hz));
    }

    private static String stemBody(String requestId, Map<String, Object> spec) throws Exception {
        return JSON.writeValueAsString(new LinkedHashMap<>(Map.of("requestId", requestId, "spec", spec)));
    }

    private static Map<String, Object> placement(Map<String, Object> stem, double gainDb, double pan, int start, int fadeIn, int fadeOut) {
        Map<String, Object> placement = new LinkedHashMap<>();
        placement.put("artifactId", stem.get("artifactId"));
        placement.put("artifactVersionId", stem.get("artifactVersionId"));
        placement.put("gainDb", gainDb);
        placement.put("pan", pan);
        placement.put("startFrame", start);
        placement.put("fadeInFrames", fadeIn);
        placement.put("fadeOutFrames", fadeOut);
        return placement;
    }

    private static Map<String, Object> placementOf(MediaArtifact artifact, double gainDb, double pan, int start, int fadeIn, int fadeOut) {
        return placement(Map.of("artifactId", artifact.artifactId(), "artifactVersionId", artifact.version().value()), gainDb, pan, start, fadeIn, fadeOut);
    }

    private static Map<String, Object> withPlacement(Map<String, Object> stem, String key, Object value) {
        Map<String, Object> placement = placement(stem, 0, 0.0, 0, 0, 0);
        placement.put(key, value);
        return placement;
    }

    private static Map<String, Object> rawMaster(String requestId, List<Map<String, Object>> stems, Integer durationFrames, Map<String, Object> target) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("stems", stems);
        if (durationFrames != null) body.put("durationFrames", durationFrames);
        if (target != null) body.put("target", target);
        return body;
    }

    private static String masterBody(String requestId, List<Map<String, Object>> stems, Integer durationFrames, double lufs, double peak) throws Exception {
        return JSON.writeValueAsString(rawMaster(requestId, stems, durationFrames, Map.of("integratedLufs", lufs, "truePeakDbtp", peak)));
    }

    // ---------------------------------------------------------------------------------------------- helpers: audio

    /** {integrated LUFS, true peak dBTP} from FFmpeg's EBU R128 filter with true-peak measurement. */
    private static double[] ebur128(Path file) throws Exception {
        Process process = new ProcessBuilder(ffmpeg.toString(), "-nostdin", "-nostats", "-hide_banner", "-i", file.toString(),
                "-af", "ebur128=peak=true", "-f", "null", "-").redirectErrorStream(true).start();
        String output = new String(process.getInputStream().readAllBytes());
        assertThat(process.waitFor(2, java.util.concurrent.TimeUnit.MINUTES)).isTrue();
        String summary = output.substring(output.lastIndexOf("Summary:"));
        Matcher integrated = Pattern.compile("I:\\s+(-?[0-9.]+) LUFS").matcher(summary);
        Matcher peak = Pattern.compile("True peak:\\s+Peak:\\s+(-?[0-9.]+) dBFS").matcher(summary);
        assertThat(integrated.find()).as(summary).isTrue();
        assertThat(peak.find()).as(summary).isTrue();
        return new double[] { Double.parseDouble(integrated.group(1)), Double.parseDouble(peak.group(1)) };
    }

    /** A stem as the test itself places it: raw interleaved PCM plus its placement. */
    private record Piece(short[] pcm, int channels, double gainDb, double pan, int start, int fadeIn, int fadeOut) { }

    /**
     * Re-mixes the stored stems with this test's own implementation of the documented placement (start sample, dB gain, balance
     * pan law, linear fades) and the reported pre-limiter gain, and returns the largest 16-bit difference from the stored master.
     * {@code shiftedIndex >= 0} shifts that one stem by {@code shift} samples, to show how sensitive the check is.
     */
    private static int remixError(short[] masterInterleaved, double preGainDb, List<Piece> pieces, int shiftedIndex, int shift) {
        int frames = masterInterleaved.length / 2;
        double[] left = new double[frames];
        double[] right = new double[frames];
        for (int p = 0; p < pieces.size(); p++) {
            Piece piece = pieces.get(p);
            double gain = Math.pow(10.0, piece.gainDb() / 20.0);
            double gl = gain * (piece.pan() > 0 ? 1.0 - piece.pan() : 1.0);
            double gr = gain * (piece.pan() < 0 ? 1.0 + piece.pan() : 1.0);
            int length = piece.pcm().length / piece.channels();
            int start = piece.start() + (p == shiftedIndex ? shift : 0);
            if (start < 0 || start + length > frames) return Integer.MAX_VALUE; // that shift would leave the master: not a valid probe
            for (int i = 0; i < length; i++) {
                double fade = 1.0;
                if (piece.fadeIn() > 0 && i < piece.fadeIn()) fade = (double) i / piece.fadeIn();
                if (piece.fadeOut() > 0 && length - 1 - i < piece.fadeOut()) fade = Math.min(fade, (double) (length - 1 - i) / piece.fadeOut());
                double a = piece.pcm()[i * piece.channels()] / 32768.0;
                double b = piece.channels() == 2 ? piece.pcm()[i * 2 + 1] / 32768.0 : a;
                left[start + i] += a * gl * fade;
                right[start + i] += b * gr * fade;
            }
        }
        double master = Math.pow(10.0, preGainDb / 20.0) * 32768.0;
        int worst = 0;
        for (int n = 0; n < frames; n++) {
            worst = Math.max(worst, Math.abs(masterInterleaved[2 * n] - (int) Math.max(-32767, Math.min(32767, Math.rint(left[n] * master)))));
            worst = Math.max(worst, Math.abs(masterInterleaved[2 * n + 1] - (int) Math.max(-32767, Math.min(32767, Math.rint(right[n] * master)))));
        }
        return worst;
    }

    private static void assertPlacementExact(short[] masterInterleaved, double preGainDb, List<Piece> pieces) {
        int exact = remixError(masterInterleaved, preGainDb, pieces, -1, 0);
        StringBuilder sensitivity = new StringBuilder();
        for (int p = 0; p < pieces.size(); p++) {
            int shifted = Math.min(remixError(masterInterleaved, preGainDb, pieces, p, 1), remixError(masterInterleaved, preGainDb, pieces, p, -1));
            sensitivity.append(" stem").append(p).append("+-1sample=").append(shifted).append("LSB");
            assertThat(shifted).as("moving stem " + p + " by one sample must be visible in the re-mix").isGreaterThan(exact + 8);
        }
        System.out.println("J17-PLACEMENT re-mix with the test's own placement math matches the master to " + exact + " LSB;" + sensitivity);
        assertThat(exact).as("every sample of the master equals the independent re-mix (+-1 LSB rounding)").isLessThanOrEqualTo(1);
    }

    private static short[] stemPcm(MediaRuntime runtime, Map<String, Object> stem) throws Exception {
        return channel(stemStereo(runtime, stem), 0);
    }

    private static MediaDevAudioWav.Pcm stemStereo(MediaRuntime runtime, Map<String, Object> stem) throws Exception {
        return MediaDevAudioWav.parse(content(runtime, (String) stem.get("artifactId")), true);
    }

    private static short[] channel(MediaDevAudioWav.Pcm pcm, int channel) {
        short[] all = pcm.raw();
        short[] out = new short[pcm.frames()];
        for (int i = 0; i < out.length; i++) out[i] = all[i * pcm.channels() + Math.min(channel, pcm.channels() - 1)];
        return out;
    }

    private static int[] toInts(short[] values) {
        int[] out = new int[values.length];
        for (int i = 0; i < values.length; i++) out[i] = values[i];
        return out;
    }

    private static short[] tonePcm(int rate, double hz, int frames) {
        short[] out = new short[frames];
        for (int i = 0; i < frames; i++) out[i] = (short) Math.round(12_000 * Math.sin(2 * Math.PI * hz * i / rate));
        return out;
    }

    private static short[] stereoTone(int frames) {
        short[] out = new short[frames * 2];
        for (int i = 0; i < frames; i++) {
            out[2 * i] = (short) Math.round(12_000 * Math.sin(2 * Math.PI * 220.0 * i / 48_000));
            out[2 * i + 1] = out[2 * i];
        }
        return out;
    }

    private static byte[] sixChannelWav() {
        int frames = 4800;
        ByteBuffer out = ByteBuffer.allocate(44 + frames * 12).order(ByteOrder.LITTLE_ENDIAN);
        out.putInt(0x46464952).putInt(36 + frames * 12).putInt(0x45564157);
        out.putInt(0x20746d66).putInt(16).putShort((short) 1).putShort((short) 6).putInt(48_000).putInt(48_000 * 12)
                .putShort((short) 12).putShort((short) 16);
        out.putInt(0x61746164).putInt(frames * 12);
        for (int i = 0; i < frames * 6; i++) out.putShort((short) (1000 * Math.sin(i * 0.05)));
        return out.array();
    }

    // ---------------------------------------------------------------------------------------------- host builders

    private HttpServer server(MediaRuntime runtime) throws Exception {
        MediaDevProjectTimelineRuntime projects = new MediaDevProjectTimelineRuntime(new InMemoryManagedStore());
        HttpServer server = MediaDevProjectRenderHttpTest.server(runtime, projects, null);
        server.removeContext("/");
        MediaDevMasterRuntime masters = new MediaDevMasterRuntime(runtime, ffmpeg, resolver,
                MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), MediaDevRequestLedger.inMemory());
        MediaHttpHandler handler = new MediaHttpHandler(runtime, null, null, projects).withDevMasters(masters);
        server.createContext("/", new MediaSecurityFilter(handler, "dev", Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true",
                "MEDIA_DEV_JWT_HMAC_SECRET", "test-only-dev-project-secret-at-least-32-bytes"),
                java.time.Clock.fixed(java.time.Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC)));
        return server;
    }

    private static MediaRuntime runtime() throws Exception {
        Path store = Files.createTempDirectory(root, "store-");
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "dev", 8093, 1_048_576, 131_072, 64L * 1024 * 1024, Duration.ofSeconds(2),
                        2, "", "", true, false, store, 0, MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT,
                        MediaRuntimeConfig.DEFAULT_DEV_RENDER_MAX_CONCURRENT_PER_TENANT),
                new LocalMediaRuntimeSupport.FileArtifactStore(store), new LocalMediaRuntimeSupport.JobStore(false),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                List.of(new MediaDevProjectRenderHttpTest.NoEffectProvider()),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    private static int artifactCount(MediaRuntime runtime) throws Exception {
        try (var files = Files.walk(Path.of(runtime.config().localStorageRoot().toString()))) {
            return (int) files.filter(Files::isRegularFile).count();
        }
    }

    private static MediaArtifact upload(MediaRuntime runtime, String name, String contentType, byte[] bytes) throws Exception {
        return upload(runtime, name, contentType, bytes, Map.of());
    }

    private static MediaArtifact upload(MediaRuntime runtime, String name, String contentType, byte[] bytes, Map<String, Object> metadata) throws Exception {
        String digest = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        var session = runtime.beginUpload(new UploadRequest(TENANT, OWNER, name, contentType, bytes.length, digest,
                "INTERNAL", Duration.ofMinutes(30), metadata), "fixture-" + digest);
        int chunk = runtime.config().maximumChunkBytes();
        int index = 0;
        for (int offset = 0; offset < bytes.length; offset += chunk, index++) {
            runtime.appendChunk(TENANT, OWNER, session.uploadId(), index,
                    Arrays.copyOfRange(bytes, offset, Math.min(bytes.length, offset + chunk)));
        }
        return runtime.completeUpload(TENANT, OWNER, session.uploadId());
    }

    private static byte[] content(MediaRuntime runtime, String artifactId) throws Exception {
        MediaArtifact artifact = runtime.artifact(TENANT, OWNER, artifactId).orElseThrow();
        var out = new java.io.ByteArrayOutputStream();
        runtime.copyArtifactContent(TENANT, OWNER, artifactId, artifact.version(), out, 64L << 20).orElseThrow();
        return out.toByteArray();
    }

    private static byte[] contentAs(MediaRuntime runtime, String principal, String artifactId) throws Exception {
        MediaArtifact artifact = runtime.artifact(TENANT, principal, artifactId).orElseThrow();
        var out = new java.io.ByteArrayOutputStream();
        runtime.copyArtifactContent(TENANT, principal, artifactId, artifact.version(), out, 64L << 20).orElseThrow();
        return out.toByteArray();
    }

    private static byte[] runBytes(String... command) throws Exception {
        Process process = new ProcessBuilder(command).redirectErrorStream(false).start();
        byte[] output = process.getInputStream().readAllBytes();
        assertThat(process.waitFor(60, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        assertThat(process.exitValue()).isZero();
        return output;
    }

    private static void deleteTree(Path path) {
        try (var walk = Files.walk(path)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        } catch (java.io.IOException ignored) { }
    }
}
