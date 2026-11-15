package com.ghatana.media.integration;

import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.agent.framework.tools.ToolExecutionStatus;
import com.ghatana.audio.video.tools.AudioVideoToolHandlerFactory;
import com.ghatana.audio.video.tools.FileInvocationLedger;
import com.ghatana.audio.video.tools.FileMediaDelegationGrantStore;
import com.ghatana.audio.video.tools.MediaDelegationGrant;
import com.ghatana.audio.video.tools.MediaLauncherDelegate;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder;
import com.ghatana.audio.video.tools.MediaToolJobBridge;
import com.ghatana.media.integration.MediaDevLiveFixtures.StoredArtifact;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import com.ghatana.tools.testing.EventloopTestBase;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import tools.jackson.databind.JsonNode;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static com.ghatana.media.integration.MediaDevAgentDelegationSupport.*;
import static com.ghatana.media.integration.MediaDevLiveFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-25: the four Media agent tools delegate, as the calling USER and under a scoped revocable grant, to REAL launcher
 * operations over HTTP (real PostgreSQL + S3, real CPU models, real FFmpeg): speech-to-text to Whisper, text-to-speech
 * to Kokoro, vision analysis to Florence-2, multimodal (vision-only) observation to the Florence-2 video tracker. For
 * each tool: a positive call whose exact effect is read back from the launcher's own state, a duplicate invocation with
 * no second effect, wrong-tenant denials, an out-of-scope denial, a killed-host ambiguous retry that reconciles to the
 * single real outcome without re-dispatching, revoked consent (the launcher's rights gate) and a revoked grant.
 *
 * <p>The attestations are TEST statements made through the real /dev/v1/rights routes by a synthetic test principal;
 * they prove the code path, not any real person's rights or consent.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
class MediaDevAgentDelegationIT extends EventloopTestBase {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private static final String AGENT = "agent-j25-media";

    private int port;
    private String tenant;
    private String owner;
    private String otherTenant;
    private String otherOwner;
    private String bucket;
    private Path ledgerDir;
    private Path grantDir;
    private FileInvocationLedger ledger;
    private FileMediaDelegationGrantStore grants;
    private AudioVideoToolHandlerFactory factory;

    @Test
    void fourToolsDelegateToTheRealLauncherUnderRevocableGrants() throws Exception {
        Path home = Path.of(System.getProperty("user.home"));
        Path root = home.resolve(".local/share/ghatana-media");
        Path models = root.resolve("models");
        Path whisper = root.resolve("runtimes/whisper.cpp-src/build-vulkan/bin/whisper-cli");
        Path kokoroPython = root.resolve("runtimes/kokoro-venv/bin/python");
        Path visionPython = root.resolve("runtimes/vision-venv/bin/python");
        Path kokoroScript = locate("tools/model-runtimes/kokoro_synth.py");
        Path sidecarScript = locate("tools/model-runtimes/vision/vision_sidecar.py");
        String ffmpegEnv = System.getenv("MEDIA_DEV_RENDER_FFMPEG");
        String ffprobeEnv = System.getenv("MEDIA_DEV_RENDER_FFPROBE");
        assumeTrue(Files.isExecutable(whisper) && Files.isExecutable(kokoroPython) && Files.isExecutable(visionPython)
                        && kokoroScript != null && sidecarScript != null && ffmpegEnv != null && ffprobeEnv != null
                        && Files.isRegularFile(models.resolve("florence-2-large/ghatana-model-manifest.json"))
                        && Files.isRegularFile(models.resolve("whisper-large-v3-turbo/manifest.json")),
                "local CPU Whisper/Kokoro/Florence runtimes, manifests and FFmpeg are not installed on this host");
        Path ffmpeg = Path.of(ffmpegEnv);
        Path ffprobe = Path.of(ffprobeEnv);
        Path digestCache = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_MODEL_DIGEST_CACHE",
                Path.of(System.getProperty("java.io.tmpdir"), "ghatana-media-vision-model-digests.json").toString()));

        String run = UUID.randomUUID().toString().replace("-", "").substring(0, 16);
        tenant = "tenant-j25-" + run;
        owner = "user-j25-owner-" + run;
        otherTenant = "tenant-j25-other-" + run;
        otherOwner = "user-j25-other-" + run;
        bucket = "media-j25-" + run;
        String schema = "media_dev_j25_" + run;
        try (var socket = new java.net.ServerSocket(0)) { port = socket.getLocalPort(); }
        int sidecarPort;
        try (var socket = new java.net.ServerSocket(0)) { sidecarPort = socket.getLocalPort(); }
        byte[] tokenBytes = new byte[24];
        new SecureRandom().nextBytes(tokenBytes);
        String sidecarToken = HexFormat.of().formatHex(tokenBytes);
        Path services = Files.createTempDirectory("media-j25-services-");
        Path work = Files.createTempDirectory("media-j25-work-");
        Path log = Files.createTempFile("media-j25-process-", ".log");
        ledgerDir = Files.createTempDirectory("media-j25-ledger-").resolve("ledger");
        grantDir = Files.createTempDirectory("media-j25-grants-").resolve("grants");
        Process sidecar = null;
        Process launcher = null;
        boolean passed = false;
        try {
            try (var s3 = s3(LOCALSTACK)) { s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()); }
            sidecar = startSidecar(visionPython, sidecarScript, models, home, sidecarPort, sidecarToken, digestCache);
            awaitSidecar(sidecar, sidecarPort, sidecarToken);
            installDescriptors(services);
            String childClasspath = System.getProperty("media.child.classpath", "");
            assertThat(childClasspath).as("Gradle-resolved child runtime classpath").isNotBlank();
            Map<String, String> environment = new HashMap<>(environment(POSTGRES, LOCALSTACK, bucket, port, schema));
            environment.put("MEDIA_RIGHTS_DEV_ENABLED", "true");
            environment.put("MEDIA_LOCAL_MODEL_ROOT", root.toString());
            environment.put("MEDIA_WHISPER_CPP_BIN", whisper.toString());
            environment.put("MEDIA_WHISPER_CPP_THREADS", "8");
            environment.put("MEDIA_KOKORO_PYTHON", kokoroPython.toString());
            environment.put("MEDIA_KOKORO_SCRIPT", kokoroScript.toString());
            environment.put("MEDIA_LOCAL_VISION_MODELS_ROOT", models.toString());
            environment.put("MEDIA_LOCAL_VISION_SIDECAR_URL", "http://127.0.0.1:" + sidecarPort);
            environment.put("MEDIA_LOCAL_VISION_SIDECAR_TOKEN", sidecarToken);
            environment.put("MEDIA_LOCAL_VISION_TIMEOUT_SECONDS", "600");
            environment.put("MEDIA_LOCAL_MODEL_DIGEST_CACHE", digestCache.toString());
            environment.put("MEDIA_DEV_RENDER_FFMPEG", ffmpeg.toString());
            environment.put("MEDIA_DEV_RENDER_FFPROBE", ffprobe.toString());
            environment.put("CUDA_VISIBLE_DEVICES", "");
            launcher = startLauncher(services + java.io.File.pathSeparator + childClasspath, environment, log);
            awaitReadyPatiently(launcher, port);

            // ---- the USER's own direct work: real inputs, registered over the launcher's own routes ----
            String userToken = issueDevToken(tenant, owner);
            JsonNode capabilities = get(port, tenant, userToken, "/dev/v1/speech/capabilities", 200);
            assertThat(capabilities.path("speechToText").path("ready").asBoolean()).isTrue();
            assertThat(capabilities.path("textToSpeech").path("ready").asBoolean()).isTrue();
            JsonNode clip = post(port, tenant, userToken, "/dev/v1/speech/syntheses",
                    Map.of("requestId", "j25-user-clip-" + run, "text", TTS_TEXT, "voice", "af_heart"), 201);
            String clipId = clip.path("artifact").path("artifactId").asString();
            String clipVersion = clip.path("artifact").path("artifactVersionId").asString();
            byte[] video = TrackingVideoFixture.generate(ffmpeg, work, false);
            String videoId = upload(port, tenant, owner, userToken, run + "-video", "motion.mp4", "video/mp4", video);
            String videoVersion = "sha256:" + sha256(video);
            // A second clip with different words: re-transcribing byte-identical audio yields byte-identical transcript
            // bytes, which the DEV speech lane's artifact registration refuses (reported as a known limit).
            JsonNode clip2 = post(port, tenant, userToken, "/dev/v1/speech/syntheses",
                    Map.of("requestId", "j25-user-clip2-" + run, "text", "Pack my box with five dozen liquor jugs.",
                            "voice", "af_heart"), 201);
            String clip2Id = clip2.path("artifact").path("artifactId").asString();
            String clip2Version = clip2.path("artifact").path("artifactVersionId").asString();
            String clipAttestation = attest(userToken, clipId, clipVersion);
            String clip2Attestation = attest(userToken, clip2Id, clip2Version);
            String videoAttestation = attest(userToken, videoId, videoVersion);
            // a second tenant with its own user and its own synthetic clip
            String otherToken = issueDevToken(otherTenant, otherOwner);

            // ---- the agent-tool host: durable ledger, grant store, delegate, binder ----
            ledger = ledger(ledgerDir);
            grants = new FileMediaDelegationGrantStore(grantDir);
            MediaLauncherDelegate delegate = delegate(URI.create("http://127.0.0.1:" + port), grants,
                    (grant, principal) -> {
                        try { return issueDevToken(grant.tenantId(), grant.principalId()); }
                        catch (Exception failure) { throw new IOException(failure); }
                    });
            factory = factory(binder(ledger, delegate), delegate);
            Instant now = Instant.now();
            grant("grant-stt-" + run, tenant, owner, STT, "speech.transcribe", Set.of(clipId, clip2Id), now);
            grant("grant-tts-" + run, tenant, owner, TTS, "speech.synthesize", Set.of(), now);
            grant("grant-vis-" + run, tenant, owner, VISION, "vision.analyze", Set.of(videoId), now);
            grant("grant-mm-" + run, tenant, owner, MULTIMODAL, "vision.track", Set.of(videoId), now);

            int artifactsBefore = artifactCount();

            // =============== TEXT-TO-SPEECH ===============
            ToolExecutionResult tts = call(TTS, "inv-tts-1-" + run, tenant, owner, null, null);
            assertThat(tts.status()).as(String.valueOf(tts.failure())).isEqualTo(ToolExecutionStatus.SUCCESS);
            String ttsId = (String) out(tts).get("mediaArtifactId");
            assertThat(artifactCount()).as("one synthesized audio artifact").isEqualTo(artifactsBefore + 1);
            StoredArtifact ttsRow = storedArtifact(POSTGRES, tenant, owner, ttsId);
            assertThat(ttsRow.contentType()).isEqualTo("audio/wav");
            byte[] ttsBytes = s3Bytes(LOCALSTACK, bucket, ttsRow);
            assertThat(sha256(ttsBytes)).isEqualTo(ttsRow.sha256()).isEqualTo(out(tts).get("sha256"));
            try (var stream = javax.sound.sampled.AudioSystem.getAudioInputStream(
                    new java.io.ByteArrayInputStream(ttsBytes))) {
                assertThat(stream.getFrameLength() / stream.getFormat().getFrameRate()).isGreaterThan(1.5f);
            }
            // no provider bypass: owned by the delegating USER, requestId derived from the invocation, launcher ledger row
            assertThat(out(tts).get("requestId")).isEqualTo(MediaToolJobBridge.requestIdFor("inv-tts-1-" + run));
            assertOutcome(userToken, tenant, "speech.synthesize", "inv-tts-1-" + run, "COMPLETED", 1);
            assertOutcome(otherToken, otherTenant, "speech.synthesize", "inv-tts-1-" + run, "ABSENT", 0);
            duplicateIsSingleEffect(TTS, "inv-tts-1-" + run, tenant, owner, null, null, tts);
            wrongTenantDenied(TTS, run, null, null, Set.of());
            ambiguousAfterResponse(TTS, "inv-tts-amb-" + run, null, null, "speech.synthesize", 1, run);
            midFlightKillReconciles(run);

            // =============== SPEECH-TO-TEXT ===============
            int beforeStt = artifactCount();
            ToolExecutionResult stt = call(STT, "inv-stt-1-" + run, tenant, owner, clipId, clipVersion);
            assertThat(stt.status()).as(String.valueOf(stt.failure())).isEqualTo(ToolExecutionStatus.SUCCESS);
            String text = ((String) out(stt).get("transcript")).toLowerCase(Locale.ROOT).replaceAll("[^a-z ]", " ");
            for (String word : List.of("quick", "brown", "fox", "jumps", "lazy", "dog")) {
                assertThat(text).as(String.valueOf(out(stt).get("transcript"))).contains(word);
            }
            assertThat(artifactCount()).as("transcript + captions").isEqualTo(beforeStt + 2);
            String transcriptId = (String) out(stt).get("transcriptArtifactId");
            StoredArtifact transcriptRow = storedArtifact(POSTGRES, tenant, owner, transcriptId);
            assertThat(JSON.readTree(new String(s3Bytes(LOCALSTACK, bucket, transcriptRow), StandardCharsets.UTF_8))
                    .path("text").asString()).isEqualTo(out(stt).get("transcript"));
            assertThat(get(port, tenant, userToken, "/dev/v1/speech/outputs/" + transcriptId, 200)
                    .path("lineage").path("requestId").asString())
                    .isEqualTo(MediaToolJobBridge.requestIdFor("inv-stt-1-" + run));
            assertOutcome(userToken, tenant, "speech.transcribe", "inv-stt-1-" + run, "COMPLETED", 2);
            duplicateIsSingleEffect(STT, "inv-stt-1-" + run, tenant, owner, clipId, clipVersion, stt);
            wrongTenantDenied(STT, run, clipId, clipVersion, Set.of(clipId));
            outOfScopeDenied(STT, run, videoId, videoVersion);
            ambiguousAfterResponse(STT, "inv-stt-amb-" + run, clip2Id, clip2Version, "speech.transcribe", 2, run);

            // =============== VISION ANALYSIS ===============
            int beforeVision = artifactCount();
            ToolExecutionResult vision = call(VISION, "inv-vis-1-" + run, tenant, owner, videoId, videoVersion);
            assertThat(vision.status()).as(String.valueOf(vision.failure())).isEqualTo(ToolExecutionStatus.SUCCESS);
            assertThat(artifactCount()).isEqualTo(beforeVision + 1);
            StoredArtifact visionRow = storedArtifact(POSTGRES, tenant, owner,
                    (String) out(vision).get("resultArtifactId"));
            byte[] visionBytes = s3Bytes(LOCALSTACK, bucket, visionRow);
            assertThat(sha256(visionBytes)).isEqualTo(visionRow.sha256()).isEqualTo(out(vision).get("resultSha256"));
            JsonNode analysis = JSON.readTree(new String(visionBytes, StandardCharsets.UTF_8));
            assertThat(analysis.path("kind").asString()).isEqualTo("LOCAL_VISION_ANALYSIS");
            assertThat(analysis.path("requestId").asString()).isEqualTo(MediaToolJobBridge.requestIdFor("inv-vis-1-" + run));
            assertThat(analysis.path("source").path("sha256").asString()).isEqualTo(sha256(video));
            assertThat(analysis.path("inference").path("model").path("id").asString()).contains("Florence-2");
            assertOutcome(userToken, tenant, "vision.analyze", "inv-vis-1-" + run, "COMPLETED", 1);
            duplicateIsSingleEffect(VISION, "inv-vis-1-" + run, tenant, owner, videoId, videoVersion, vision);
            wrongTenantDenied(VISION, run, videoId, videoVersion, Set.of(videoId));
            outOfScopeDenied(VISION, run, clipId, clipVersion);
            ambiguousAfterResponse(VISION, "inv-vis-amb-" + run, videoId, videoVersion, "vision.analyze", 1, run);

            // =============== MULTIMODAL (vision-only observation of the video) ===============
            int beforeMm = artifactCount();
            ToolExecutionResult mm = call(MULTIMODAL, "inv-mm-1-" + run, tenant, owner, videoId, videoVersion);
            assertThat(mm.status()).as(String.valueOf(mm.failure())).isEqualTo(ToolExecutionStatus.SUCCESS);
            assertThat(artifactCount()).isEqualTo(beforeMm + 1);
            StoredArtifact mmRow = storedArtifact(POSTGRES, tenant, owner, (String) out(mm).get("resultArtifactId"));
            JsonNode tracks = JSON.readTree(new String(s3Bytes(LOCALSTACK, bucket, mmRow), StandardCharsets.UTF_8));
            assertThat(tracks.path("frames").size()).isEqualTo(2);
            assertThat(tracks.path("model").path("id").asString()).contains("Florence-2");
            assertThat(out(mm).get("samplingRateMsHonored")).isEqualTo(false);
            assertOutcome(userToken, tenant, "vision.track", "inv-mm-1-" + run, "COMPLETED", 1);
            duplicateIsSingleEffect(MULTIMODAL, "inv-mm-1-" + run, tenant, owner, videoId, videoVersion, mm);
            wrongTenantDenied(MULTIMODAL, run, videoId, videoVersion, Set.of(videoId));
            outOfScopeDenied(MULTIMODAL, run, clipId, clipVersion);
            ambiguousAfterResponse(MULTIMODAL, "inv-mm-amb-" + run, videoId, videoVersion, "vision.track", 1, run);

            // Anything outside the grant stays a typed NOT_ADMITTED refusal (cross-modal transcription, diarization).
            ToolExecutionResult fusion = runPromise(() -> factory.createAuthenticated(MULTIMODAL).handle(
                    withInput(envelope(MULTIMODAL, "inv-mm-fusion-" + run, tenant, AGENT, videoId, videoVersion),
                            Map.of("mediaArtifactId", videoId, "sourceArtifactVersion", videoVersion)),
                    contract(envelope(MULTIMODAL, "x", tenant, AGENT, videoId, videoVersion)), principal(tenant, owner)));
            assertThat(fusion.status()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(fusion.failure().code()).isEqualTo("MULTIMODAL_TRANSCRIPTION_NOT_ADMITTED");
            ToolExecutionResult diarization = runPromise(() -> factory.createAuthenticated(STT).handle(
                    withInput(envelope(STT, "inv-stt-dia-" + run, tenant, AGENT, clipId, clipVersion),
                            Map.of("audioSource", Map.of("mediaArtifactId", clipId), "enableDiarization", true,
                                    "sourceArtifactVersion", clipVersion)),
                    contract(envelope(STT, "x", tenant, AGENT, clipId, clipVersion)), principal(tenant, owner)));
            assertThat(diarization.failure().code()).isEqualTo("STT_DIARIZATION_NOT_ADMITTED");
            assertThat(artifactCount()).as("refusals have no effect").isEqualTo(beforeMm + 1 + 1);

            // =============== REVOKED CONSENT (the launcher's rights gate) ===============
            int beforeConsent = artifactCount();
            revokeAttestation(userToken, clipAttestation);
            revokeAttestation(userToken, clip2Attestation);
            ToolExecutionResult sttRevoked = call(STT, "inv-stt-consent-" + run, tenant, owner, clipId, clipVersion);
            assertThat(sttRevoked.status()).isEqualTo(ToolExecutionStatus.DENIED);
            assertThat(sttRevoked.failure().code()).startsWith("MEDIA_RIGHTS_");
            revokeAttestation(userToken, videoAttestation);
            ToolExecutionResult visionRevoked = call(VISION, "inv-vis-consent-" + run, tenant, owner, videoId, videoVersion);
            assertThat(visionRevoked.status()).isEqualTo(ToolExecutionStatus.DENIED);
            assertThat(visionRevoked.failure().code()).startsWith("MEDIA_RIGHTS_");
            ToolExecutionResult mmRevoked = call(MULTIMODAL, "inv-mm-consent-" + run, tenant, owner, videoId, videoVersion);
            assertThat(mmRevoked.status()).isEqualTo(ToolExecutionStatus.DENIED);
            assertThat(mmRevoked.failure().code()).startsWith("MEDIA_RIGHTS_");
            assertThat(artifactCount()).as("consent revoked: no effect").isEqualTo(beforeConsent);

            // =============== REVOKED GRANT ===============
            for (String[] toolGrant : new String[][]{{STT, "grant-stt-"}, {TTS, "grant-tts-"}, {VISION, "grant-vis-"},
                    {MULTIMODAL, "grant-mm-"}}) {
                assertThat(grants.revoke(toolGrant[1] + run, Instant.now())).isTrue();
                boolean source = !TTS.equals(toolGrant[0]);
                String id = STT.equals(toolGrant[0]) ? clipId : videoId;
                String version = STT.equals(toolGrant[0]) ? clipVersion : videoVersion;
                // a revoked grant is refused before any claim or dispatch (typed, and nothing is recorded)
                assertThatThrownBy(() -> call(toolGrant[0], "inv-grantrevoked-" + toolGrant[0] + run, tenant, owner,
                        source ? id : null, source ? version : null))
                        .isInstanceOf(MediaToolExecutionBinder.InvocationReplayDeniedException.class);
                assertThat(ledger.find("inv-grantrevoked-" + toolGrant[0] + run)).isEmpty();
            }
            // a recorded result can no longer be replayed once the grant is revoked
            assertThatThrownBy(() -> call(TTS, "inv-tts-1-" + run, tenant, owner, null, null))
                    .isInstanceOf(MediaToolExecutionBinder.InvocationReplayDeniedException.class);
            assertThat(artifactCount()).as("revoked grant: no effect").isEqualTo(beforeConsent);
            passed = true;
            System.out.println("J25_IT_PASSED run=" + run);
        } finally {
            if (launcher != null) stopLauncher(launcher);
            if (sidecar != null) { sidecar.destroy(); sidecar.waitFor(15, TimeUnit.SECONDS); sidecar.destroyForcibly(); }
            dropSchema(POSTGRES, schema);
            deleteBucket(LOCALSTACK, bucket);
            deleteTree(services);
            deleteTree(work);
            deleteTree(ledgerDir == null ? null : ledgerDir.getParent());
            deleteTree(grantDir == null ? null : grantDir.getParent());
            if (passed) Files.deleteIfExists(log); else System.out.println("J25_LAUNCHER_LOG " + log);
        }
    }

    // -------------------------------------------------------------------- scenarios

    private void duplicateIsSingleEffect(String toolId, String invocationId, String tenantId, String principalId,
            String artifactId, String version, ToolExecutionResult first) throws Exception {
        int before = artifactCount();
        ToolExecutionResult again = call(toolId, invocationId, tenantId, principalId, artifactId, version);
        assertThat(again.status()).isEqualTo(ToolExecutionStatus.SUCCESS);
        assertThat(norm(again.output())).as("duplicate returns the first recorded result").isEqualTo(norm(first.output()));
        // a freshly started host over the same durable ledger answers the same way
        FileInvocationLedger restartedLedger = ledger(ledgerDir);
        MediaLauncherDelegate delegate = delegate(URI.create("http://127.0.0.1:" + port), grants,
                (grant, principal) -> { throw new IOException("a replay must not need a credential"); });
        AudioVideoToolHandlerFactory restarted = factory(binder(restartedLedger, delegate), delegate);
        ToolExecutionEnvelope envelope = envelope(toolId, invocationId, tenantId, AGENT, artifactId, version);
        ToolExecutionResult replayed = runPromise(() -> restarted.createAuthenticated(toolId)
                .handle(envelope, contract(envelope), principal(tenantId, principalId)), Duration.ofMinutes(15));
        assertThat(norm(replayed.output())).isEqualTo(norm(first.output()));
        assertThat(artifactCount()).as("duplicate invocation: no second effect").isEqualTo(before);
    }

    private void wrongTenantDenied(String toolId, String run, String artifactId, String version, Set<String> foreignSources)
            throws Exception {
        int before = artifactCount();
        // (a) a principal authenticated in another tenant cannot execute an envelope bound to this tenant
        ToolExecutionEnvelope envelope = envelope(toolId, "inv-wt-a-" + toolId + run, tenant, AGENT, artifactId, version);
        assertThatThrownBy(() -> runPromise(() -> factory.createAuthenticated(toolId).handle(envelope,
                contract(envelope), principal(otherTenant, otherOwner)), Duration.ofMinutes(15)))
                .isInstanceOf(MediaToolExecutionBinder.InvocationReplayDeniedException.class);
        // (b) the other tenant's user has no grant of their own: refused before any claim, so not even recorded
        assertThatThrownBy(() -> callAs(toolId, "inv-wt-b-" + toolId + run, otherTenant, otherOwner, artifactId, version))
                .isInstanceOf(MediaToolExecutionBinder.InvocationReplayDeniedException.class);
        assertThat(ledger.find("inv-wt-b-" + toolId + run)).isEmpty();
        // (c) a grant in the other tenant that names this tenant's artifact: the LAUNCHER's tenant isolation refuses it
        if (artifactId != null) {
            grant("grant-foreign-" + toolId + run, otherTenant, otherOwner, toolId, operationOf(toolId), foreignSources,
                    Instant.now());
            ToolExecutionResult foreign = callAs(toolId, "inv-wt-c-" + toolId + run, otherTenant, otherOwner, artifactId,
                    version);
            assertThat(foreign.status()).isEqualTo(ToolExecutionStatus.DENIED);
            assertThat(foreign.failure().code()).isEqualTo("MEDIA_SOURCE_VERSION_NOT_FOUND");
        }
        assertThat(artifactCount()).as("wrong tenant: no effect").isEqualTo(before);
    }

    private void outOfScopeDenied(String toolId, String run, String otherArtifactId, String otherVersion) throws Exception {
        int before = artifactCount();
        ToolExecutionResult denied = call(toolId, "inv-scope-" + toolId + run, tenant, owner, otherArtifactId, otherVersion);
        assertThat(denied.status()).isEqualTo(ToolExecutionStatus.DENIED);
        assertThat(denied.failure().code()).isEqualTo(MediaLauncherDelegate.SOURCE_NOT_GRANTED);
        assertThat(artifactCount()).isEqualTo(before);
    }

    /**
     * A real child agent-tool host dispatches, receives the launcher's answer and is killed before it can record the
     * result. The invocation stays UNKNOWN-fenced; a retry reconciles to the launcher's single real outcome.
     */
    private void ambiguousAfterResponse(String toolId, String invocationId, String artifactId, String version,
            String lane, int expectedArtifacts, String run) throws Exception {
        int before = artifactCount();
        Process child = startWorker(toolId, invocationId, artifactId, version, "on-complete");
        String output = new String(child.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(child.waitFor(900, TimeUnit.SECONDS)).isTrue();
        assertThat(child.exitValue()).as(output).isEqualTo(137);
        assertThat(output).contains("WORKER_KILLED_BEFORE_RECORDING_RESULT");
        assertThat(ledger.find(invocationId)).hasValueSatisfying(found ->
                assertThat(found.outcome()).isEqualTo(MediaToolExecutionBinder.LogicalOutcome.OUTCOME_UNKNOWN));
        assertThat(artifactCount()).as("the launcher did the work exactly once").isEqualTo(before + expectedArtifacts);
        assertOutcome(issueToken(tenant, owner), tenant, lane, invocationId, "COMPLETED", -1);

        ToolExecutionResult reconciled = call(toolId, invocationId, tenant, owner, artifactId, version);
        assertThat(reconciled.status()).as(String.valueOf(reconciled.failure())).isEqualTo(ToolExecutionStatus.SUCCESS);
        assertThat(out(reconciled).get("replayed")).isEqualTo(true);
        assertThat(out(reconciled).get("requestId")).isEqualTo(MediaToolJobBridge.requestIdFor(invocationId));
        assertThat(artifactCount()).as("reconciliation never dispatches again").isEqualTo(before + expectedArtifacts);
        assertThat(ledger.find(invocationId)).hasValueSatisfying(found ->
                assertThat(found.outcome()).isEqualTo(MediaToolExecutionBinder.LogicalOutcome.SUCCESS));
        ToolExecutionResult recorded = call(toolId, invocationId, tenant, owner, artifactId, version);
        assertThat(norm(recorded.output())).isEqualTo(norm(reconciled.output()));
        assertThat(artifactCount()).isEqualTo(before + expectedArtifacts);
    }

    /** Killed while the launcher is still synthesizing: stays unknown while in flight, then reconciles to one effect. */
    private void midFlightKillReconciles(String run) throws Exception {
        String invocationId = "inv-tts-midflight-" + run;
        int before = artifactCount();
        Process child = startWorker(TTS, invocationId, null, null, "after-ms:600");
        String output = new String(child.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(child.waitFor(300, TimeUnit.SECONDS)).isTrue();
        assertThat(child.exitValue()).as(output).isEqualTo(137);
        assertThat(output).contains("WORKER_KILLED_MID_FLIGHT");
        // While the launcher's request is still in flight (or not yet visible) the retry must NOT send new work.
        boolean inFlight = false;
        String token = issueToken(tenant, owner);
        for (int attempt = 0; attempt < 40 && !inFlight; attempt++) {
            String state = outcomeState(token, tenant, "speech.synthesize", invocationId);
            if ("COMPLETED".equals(state)) break;
            if ("IN_PROGRESS".equals(state)) inFlight = true;
            else Thread.sleep(100);
        }
        if (inFlight) {
            assertThatThrownBy(() -> call(TTS, invocationId, tenant, owner, null, null))
                    .isInstanceOf(MediaToolExecutionBinder.OutcomeUnknownException.class);
            assertThat(artifactCount()).as("no second dispatch while in flight").isLessThanOrEqualTo(before + 1);
        }
        long deadline = System.nanoTime() + Duration.ofMinutes(3).toNanos();
        while (!"COMPLETED".equals(outcomeState(token, tenant, "speech.synthesize", invocationId))) {
            assertThat(System.nanoTime()).as("launcher finished the orphaned request").isLessThan(deadline);
            Thread.sleep(250);
        }
        ToolExecutionResult reconciled = call(TTS, invocationId, tenant, owner, null, null);
        assertThat(reconciled.status()).as(String.valueOf(reconciled.failure())).isEqualTo(ToolExecutionStatus.SUCCESS);
        assertThat(artifactCount()).as("exactly one effect").isEqualTo(before + 1);
        System.out.println("J25_MIDFLIGHT inFlightObserved=" + inFlight);
    }

    // -------------------------------------------------------------------- helpers

    private static String operationOf(String toolId) {
        return switch (toolId) {
            case STT -> "speech.transcribe";
            case TTS -> "speech.synthesize";
            case VISION -> "vision.analyze";
            default -> "vision.track";
        };
    }

    private void grant(String grantId, String tenantId, String principalId, String toolId, String operation,
            Set<String> sources, Instant now) {
        grants.issue(new MediaDelegationGrant(grantId, tenantId, principalId, AGENT, toolId, Set.of(operation), sources,
                now.minusSeconds(5), now.plus(Duration.ofHours(2)), null));
    }

    private static AuthenticatedPrincipal principal(String tenantId, String principalId) {
        return new AuthenticatedPrincipal(tenantId, principalId, Instant.now());
    }

    private ToolExecutionResult call(String toolId, String invocationId, String tenantId, String principalId,
            String artifactId, String version) {
        return callAs(toolId, invocationId, tenantId, principalId, artifactId, version);
    }

    private ToolExecutionResult callAs(String toolId, String invocationId, String tenantId, String principalId,
            String artifactId, String version) {
        ToolExecutionEnvelope envelope = envelope(toolId, invocationId, tenantId, AGENT, artifactId, version);
        return runPromise(() -> factory.createAuthenticated(toolId).handle(envelope, contract(envelope),
                principal(tenantId, principalId)), Duration.ofMinutes(15));
    }

    private static ToolExecutionEnvelope withInput(ToolExecutionEnvelope base, Map<String, Object> input) {
        return new ToolExecutionEnvelope(base.invocationId(), base.toolId(), base.toolVersion(), base.callerAgentId(),
                base.callerReleaseId(), base.tenantId(), base.actionClass(), base.requestSchemaVersion(), input,
                base.requestedAt());
    }

    private Process startWorker(String toolId, String invocationId, String artifactId, String version, String mode)
            throws Exception {
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        ProcessBuilder builder = new ProcessBuilder(java, "-cp", System.getProperty("media.child.classpath"),
                MediaDevAgentDelegationWorker.class.getName(), "http://127.0.0.1:" + port, tenant, owner, AGENT,
                ledgerDir.toString(), grantDir.toString(), toolId, invocationId, String.valueOf(artifactId),
                String.valueOf(version), issueToken(tenant, owner), mode);
        builder.redirectErrorStream(true);
        return builder.start();
    }

    private static String issueToken(String tenantId, String principalId) throws Exception {
        return issueDevToken(tenantId, principalId);
    }

    private String attest(String token, String artifactId, String version) throws Exception {
        HttpResponse<String> attested = send(port, tenant, token, "POST", "/dev/v1/rights/attestations",
                JSON.writeValueAsString(Map.of("artifactId", artifactId, "artifactVersionId", version,
                        "statementKind", "MEDIA_RIGHTS", "scopes", List.of("PROCESSING"),
                        "basis", "TEST: synthetic input generated by the J-25 integration test; no real person or rights")));
        assertThat(attested.statusCode()).as(attested.body()).isEqualTo(201);
        return JSON.readTree(attested.body()).path("attestationId").asString();
    }

    private void revokeAttestation(String token, String attestationId) throws Exception {
        HttpResponse<String> revoked = send(port, tenant, token, "POST",
                "/dev/v1/rights/attestations/" + attestationId + "/revoke",
                JSON.writeValueAsString(Map.of("reason", "TEST: consent revoked to prove the delegated call is denied")));
        assertThat(revoked.statusCode()).as(revoked.body()).isEqualTo(200);
    }

    private String outcomeState(String token, String tenantId, String lane, String invocationId) throws Exception {
        String requestId = MediaToolJobBridge.requestIdFor(invocationId);
        return get(port, tenantId, token, "/dev/v1/request-outcomes/" + lane + "/" + requestId, 200)
                .path("state").asString();
    }

    private void assertOutcome(String token, String tenantId, String lane, String invocationId, String state,
            int outputs) throws Exception {
        String requestId = MediaToolJobBridge.requestIdFor(invocationId);
        JsonNode outcome = get(port, tenantId, token, "/dev/v1/request-outcomes/" + lane + "/" + requestId, 200);
        assertThat(outcome.path("state").asString()).isEqualTo(state);
        if (outputs >= 0) assertThat(outcome.path("outputs").size()).isEqualTo(outputs);
    }

    private int artifactCount() throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword());
                var statement = connection.createStatement();
                var rows = statement.executeQuery("SELECT count(*) FROM media_artifacts")) {
            rows.next();
            return rows.getInt(1);
        }
    }

    /** Order- and numeric-type-insensitive view of a tool output (the ledger round-trips it through JSON). */
    private static Map<String, String> norm(Object output) {
        Map<String, String> view = new java.util.TreeMap<>();
        for (Map.Entry<?, ?> entry : ((Map<?, ?>) output).entrySet()) {
            Object value = entry.getValue();
            view.put(String.valueOf(entry.getKey()), value instanceof Number number
                    ? new java.math.BigDecimal(number.toString()).stripTrailingZeros().toPlainString()
                    : String.valueOf(value));
        }
        return view;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> out(ToolExecutionResult result) {
        return (Map<String, Object>) result.output();
    }

    private static Path locate(String relative) {
        for (Path dir = Path.of("").toAbsolutePath(); dir != null; dir = dir.getParent()) {
            Path candidate = dir.resolve(relative);
            if (Files.isRegularFile(candidate)) return candidate;
        }
        return null;
    }

    private static Process startSidecar(Path python, Path script, Path models, Path home, int port, String token,
            Path digestCache) throws Exception {
        ProcessBuilder builder = new ProcessBuilder(python.toString(), "-I", script.toString(), "--port",
                Integer.toString(port), "--models-root", models.toString(), "--device", "cpu");
        builder.redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD);
        builder.environment().clear();
        builder.environment().putAll(Map.of("GHATANA_VISION_SIDECAR_TOKEN", token, "HOME", home.toString(),
                "PATH", "/usr/bin:/bin", "HF_HUB_OFFLINE", "1", "TRANSFORMERS_OFFLINE", "1",
                "CUDA_VISIBLE_DEVICES", "", "MEDIA_LOCAL_MODEL_DIGEST_CACHE", digestCache.toString()));
        return builder.start();
    }

    private static void awaitSidecar(Process process, int port, String token) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(180).toNanos();
        while (System.nanoTime() < deadline) {
            if (!process.isAlive()) throw new AssertionError("vision sidecar exited: " + process.exitValue());
            try {
                HttpResponse<String> response = HttpClient.newHttpClient().send(
                        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/v1/health"))
                                .header("Authorization", "Bearer " + token).GET().build(),
                        HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() == 200) return;
            } catch (IOException ignored) { }
            Thread.sleep(250);
        }
        throw new AssertionError("vision sidecar did not become healthy");
    }

    private static void awaitReadyPatiently(Process process, int port) throws Exception {
        long deadline = System.nanoTime() + Duration.ofMinutes(20).toNanos();
        while (System.nanoTime() < deadline) {
            if (!process.isAlive()) throw new AssertionError("MediaLauncher exited: " + process.exitValue());
            try {
                HttpResponse<String> response = HttpClient.newHttpClient().send(
                        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/health/ready")).GET().build(),
                        HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() == 200) return;
            } catch (IOException ignored) { }
            Thread.sleep(500);
        }
        throw new AssertionError("MediaLauncher did not become ready within 20 minutes");
    }
}
