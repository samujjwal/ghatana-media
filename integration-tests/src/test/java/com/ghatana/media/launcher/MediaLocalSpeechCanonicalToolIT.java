package com.ghatana.media.launcher;

import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.agent.framework.tools.ToolExecutionStatus;
import com.ghatana.agent.framework.tools.ToolTransport;
import com.ghatana.audio.video.tools.AudioVideoToolHandlerFactory;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.ClaimResult;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.InvocationLedger;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.LogicalAction;
import com.ghatana.audio.video.tools.MediaToolJobBridge;
import com.ghatana.audio.video.tools.RuntimeMediaJobSubmissionPort;
import com.ghatana.governance.PolicyDecisionOutcome;
import com.ghatana.governance.PolicyDecisionRecord;
import com.ghatana.governance.PolicyEngine;
import com.ghatana.governance.PolicyEvaluationContext;
import com.ghatana.governance.PolicyReasonCode;
import com.ghatana.media.provider.aws.PostgresqlMediaConsentAuthority;
import com.ghatana.media.provider.aws.PostgresqlMediaJobStore;
import com.ghatana.media.provider.aws.PostgresqlMediaSourceAuthorizationAuthority;
import com.ghatana.media.provider.aws.PostgresqlMediaSourceRightsAdministration;
import com.ghatana.media.provider.aws.PostgresqlMediaStreamSessionStore;
import com.ghatana.media.provider.aws.PostgresqlMediaTranscriptStore;
import com.ghatana.media.provider.aws.TestAwsStateInstall;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaSourceRightsAdministration;
import com.ghatana.stt.local.PcmWav;
import com.ghatana.stt.provider.LocalWhisperCppSttProvider;
import com.ghatana.tools.testing.EventloopTestBase;
import com.ghatana.tts.local.LocalKokoroTtsProvider;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Canonical durable path for the local speech models, driven the way an agent drives it: the
 * {@code av.speech-to-text} / {@code av.text-to-speech} tool handlers -> MediaToolJobBridge ->
 * RuntimeMediaJobSubmissionPort -> MediaRuntime job admission, provider attempt, fenced commit -> PostgreSQL job and
 * transcript stores, with the REAL pinned Whisper large-v3-turbo (whisper.cpp) and Kokoro-82M runtimes.
 *
 * <p>Rights and policy are explicit TEST FIXTURES (an ALLOW policy engine and a registered source-rights record);
 * they prove the canonical rights path accepts a registered source, not that any real rights decision exists. Skipped
 * with a reason only when Docker or the installed runtimes are absent.</p>
 */
@Tag("integration")
@Testcontainers(disabledWithoutDocker = true)
class MediaLocalSpeechCanonicalToolIT extends EventloopTestBase {
    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"));

    private static final String TENANT = "tenant-a";
    private static final String PRINCIPAL = "principal-a";
    private static final String SENTENCE = "The quick brown fox jumps over the lazy dog.";
    private static com.sun.net.httpserver.HttpsServer s3Stub;
    private static Path keystore;
    private static String stubUrl;
    private static final Map<String, String> previousTls = new HashMap<>();

    @org.junit.jupiter.api.BeforeAll
    static void startS3Stub() throws Exception {
        keystore = Files.createTempFile("media-speech-s3-", ".p12");
        Files.delete(keystore);
        new ProcessBuilder("keytool", "-genkeypair", "-alias", "s3stub", "-keyalg", "RSA", "-keysize", "2048",
                "-validity", "1", "-keystore", keystore.toString(), "-storetype", "PKCS12", "-storepass", "changeit",
                "-keypass", "changeit", "-dname", "CN=localhost", "-ext", "SAN=dns:localhost,ip:127.0.0.1")
                .inheritIO().start().waitFor();
        javax.net.ssl.KeyManagerFactory keyManagers = javax.net.ssl.KeyManagerFactory
                .getInstance(javax.net.ssl.KeyManagerFactory.getDefaultAlgorithm());
        var store = java.security.KeyStore.getInstance(keystore.toFile(), "changeit".toCharArray());
        keyManagers.init(store, "changeit".toCharArray());
        javax.net.ssl.SSLContext tls = javax.net.ssl.SSLContext.getInstance("TLS");
        tls.init(keyManagers.getKeyManagers(), null, null);
        for (String prop : new String[]{"javax.net.ssl.trustStore", "javax.net.ssl.trustStorePassword",
                "javax.net.ssl.trustStoreType"}) {
            previousTls.put(prop, System.getProperty(prop));
        }
        System.setProperty("javax.net.ssl.trustStore", keystore.toString());
        System.setProperty("javax.net.ssl.trustStorePassword", "changeit");
        System.setProperty("javax.net.ssl.trustStoreType", "PKCS12");
        s3Stub = com.sun.net.httpserver.HttpsServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        s3Stub.setHttpsConfigurator(new com.sun.net.httpserver.HttpsConfigurator(tls));
        s3Stub.createContext("/", exchange -> {
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        s3Stub.start();
        stubUrl = "https://127.0.0.1:" + s3Stub.getAddress().getPort();
    }

    @org.junit.jupiter.api.AfterAll
    static void stopS3Stub() throws Exception {
        if (s3Stub != null) s3Stub.stop(0);
        previousTls.forEach((key, value) -> {
            if (value == null) System.clearProperty(key);
            else System.setProperty(key, value);
        });
        if (keystore != null) Files.deleteIfExists(keystore);
    }

    private static Map<String, String> speechEnvironment() {
        String configured = System.getenv("MEDIA_LOCAL_MODEL_ROOT");
        Path root = configured != null && !configured.isBlank() ? Path.of(configured)
                : Path.of(System.getProperty("user.home"), ".local", "share", "ghatana-media");
        Path script = Path.of("").toAbsolutePath().getParent().resolve("tools/model-runtimes/kokoro_synth.py");
        return Map.of("MEDIA_LOCAL_MODEL_ROOT", root.toString(),
                "MEDIA_WHISPER_CPP_BIN", root.resolve("runtimes/whisper.cpp-src/build/bin/whisper-cli").toString(),
                "MEDIA_KOKORO_PYTHON", root.resolve("runtimes/kokoro-venv/bin/python").toString(),
                "MEDIA_KOKORO_SCRIPT", script.toString(), "MEDIA_WHISPER_CPP_THREADS", "8");
    }

    @Test
    void agentSpeechToolsRunRealLocalModelsThroughTheCanonicalJobAndTranscriptStores() throws Exception {
        LocalWhisperCppSttProvider stt = LocalWhisperCppSttProvider.fromEnvironment(speechEnvironment());
        LocalKokoroTtsProvider tts = LocalKokoroTtsProvider.fromEnvironment(speechEnvironment());
        assumeTrue(stt.ready() && tts.ready(), "local Whisper/Kokoro runtimes with verified manifests are not "
                + "installed on this host (run tools/model-runtimes/install-local-manifests.sh)");

        // A real 16 kHz mono clip, produced by the real Kokoro model.
        var synthesis = tts.synthesizer().synthesize(SENTENCE, "af_heart", 1.0, Duration.ofMinutes(3),
                () -> false);
        PcmWav.Pcm pcm16k = PcmWav.resample(PcmWav.decode(synthesis.wav()), 16_000);
        byte[] wav = PcmWav.encode(pcm16k);
        String wavSha = sha(wav);

        try (AutoCloseable installed = TestAwsStateInstall.install(environment());
             var artifactStore = new LocalMediaRuntimeSupport.FileArtifactStore(
                     Files.createTempDirectory("media-speech-artifacts"));
             var jobStore = new PostgresqlMediaJobStore();
             var streamStore = new PostgresqlMediaStreamSessionStore();
             var consentAuthority = new PostgresqlMediaConsentAuthority();
             var authority = new PostgresqlMediaSourceAuthorizationAuthority(new AllowPolicy());
             var transcriptStore = new PostgresqlMediaTranscriptStore();
             var administration = new PostgresqlMediaSourceRightsAdministration();
             var runtime = new MediaRuntime(
                     new MediaRuntimeConfig(true, "test", 8094, 8 * 1024 * 1024, 4 * 1024 * 1024,
                             64L * 1024 * 1024, Duration.ofMinutes(5), 4, "", "", false, false,
                             Files.createTempDirectory("media-speech-root")),
                     artifactStore, jobStore, streamStore, consentAuthority,
                     MediaSemanticRedactionRuntime.disabled(Duration.ofSeconds(2)),
                     MediaLifecyclePublisher.disabled(), List.of(stt, tts),
                     List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()), List.of(), authority,
                     transcriptStore, Clock.systemUTC())) {

            MediaArtifact source = upload(runtime, wav, wavSha, pcm16k.samples().length, "speech-upload-1");
            seedArtifactRow(source, pcm16k.samples().length);
            MediaArtifact unregistered = upload(runtime, wav, wavSha, pcm16k.samples().length, "speech-upload-2");
            assertThat(unregistered.artifactId()).isNotEqualTo(source.artifactId());

            // Rights fixture: only `source` has a registered, current, source-owner rights record.
            MediaSourceRightsAdministration.SourceRecord record = administration.register(
                    new MediaSourceRightsAdministration.RegisterRequest(TENANT, PRINCIPAL, source.artifactId(),
                            source.version().value(), wavSha, PRINCIPAL,
                            MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                            MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                            "", Set.of("speech_to_text", "caption_version_write"), Set.of("transcription"),
                            Set.of("local"), Set.of(ProviderDataRetention.NONE), "fixture-clock-evidence",
                            "provenance://fixture/speech", Instant.now().plusSeconds(3600), "correlation-speech"),
                    new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(TENANT, PRINCIPAL, Instant.now()));
            assertThat(record.revoked()).isFalse();

            var profile = stt.speechToTextProfile().orElseThrow();
            var bridge = new MediaToolJobBridge(new RuntimeMediaJobSubmissionPort(runtime), "test",
                    new MediaToolJobBridge.SpeechProfilePin(profile.profileId(), profile.profileVersion(),
                            profile.configurationDigest()), Duration.ofMinutes(5),
                    Map.of(com.ghatana.media.runtime.MediaRuntimeContracts.JobType.SPEECH_TO_TEXT, governance()));
            var factory = new AudioVideoToolHandlerFactory(new MediaToolExecutionBinder(new MemoryLedger(),
                    bridge.readback(), (p, id) -> p.tenantId().equals(id.tenantId())
                            && p.principalId().equals(id.callerAgentId())), bridge);
            var caller = new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(TENANT, PRINCIPAL, Instant.now());

            // ---- speech-to-text tool: real whisper.cpp, canonical admission, fenced commit, transcript store ----
            ToolExecutionResult stto = runTool(factory, caller, "av.speech-to-text", Map.of(
                    "audioSource", Map.of("mediaArtifactId", source.artifactId()), "languageCode", "en-US",
                    "sourceArtifactVersion", source.version().value()));
            assertThat(stto.status()).as("STT tool result: %s / %s", stto.status(), stto.failure())
                    .isEqualTo(ToolExecutionStatus.SUCCESS);
            @SuppressWarnings("unchecked") Map<String, Object> sttOut = (Map<String, Object>) stto.output();
            assertThat(sttOut).containsEntry("status", "COMPLETED").containsEntry("jobType", "SPEECH_TO_TEXT");
            String jobId = (String) sttOut.get("jobId");
            var binding = transcriptStore.readAttemptBinding(TENANT, PRINCIPAL, "transcript:" + jobId, 1);
            var transcript = transcriptStore.revisionByVersionRef(TENANT, PRINCIPAL,
                    binding.transcriptVersionRef()).orElseThrow();
            assertThat(transcript.admissionStatus()).isEqualTo("ADMITTED");
            String text = transcript.draft().text();
            System.out.println("LOCAL_SPEECH_CANONICAL_STT input=\"" + SENTENCE + "\" transcript=\"" + text + "\"");
            String normalized = text.toLowerCase(Locale.ROOT).replaceAll("[^a-z ]", " ");
            for (String word : List.of("quick", "brown", "fox", "jumps", "lazy", "dog")) {
                assertThat(normalized).as("durable transcript: %s", text).contains(word);
            }
            // The declared 1 tick/second clock cannot map 16 kHz sample extents exactly, so (as for the ONNX provider)
            // the provider makes no timing claim; the production-like transcript store admits no segment projection.
            assertThat(transcript.draft().segments()).isEmpty();

            // ---- STT rights gate stays closed for a source with no registered rights ----
            ToolExecutionResult denied = runTool(factory, caller, "av.speech-to-text", Map.of(
                    "audioSource", Map.of("mediaArtifactId", unregistered.artifactId()), "languageCode", "en-US",
                    "sourceArtifactVersion", unregistered.version().value()));
            assertThat(denied.status()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(denied.failure().code()).isEqualTo("MEDIA_NOT_ADMITTED");

            // ---- text-to-speech tool: real Kokoro through the same canonical job path ----
            ToolExecutionResult ttso = runTool(factory, caller, "av.text-to-speech", Map.of(
                    "text", "Local speech, on this machine.", "voiceId", "af_heart", "audioEncoding", "LINEAR16",
                    "sourceArtifactId", source.artifactId(), "sourceArtifactVersion", source.version().value()));
            assertThat(ttso.status()).as("TTS tool result: %s / %s", ttso.status(), ttso.failure())
                    .isEqualTo(ToolExecutionStatus.SUCCESS);
            @SuppressWarnings("unchecked") Map<String, Object> ttsOut = (Map<String, Object>) ttso.output();
            @SuppressWarnings("unchecked") Map<String, Object> ttsResult = (Map<String, Object>) ttsOut.get("result");
            // The durable job result carries the synthesis receipt; inline audio bytes are not persisted in the job
            // row, so the audio itself is delivered by the artifact-registering DEV lane.
            assertThat((String) ttsResult.get("audioSha256")).matches("[0-9a-f]{64}");
            assertThat(ttsResult).containsEntry("sampleRate", 24_000).containsEntry("audioContentType", "audio/wav");
            assertThat(((Number) ttsResult.get("sizeBytes")).intValue()).isGreaterThan(20_000);
            assertThat(ttsResult).containsEntry("voiceCloning", "NOT_SUPPORTED").containsEntry("voice", "af_heart");

            // ---- an encoding the local profile cannot honour fails the job instead of pretending ----
            ToolExecutionResult mp3 = runTool(factory, caller, "av.text-to-speech", Map.of(
                    "text", "Encoding check.", "voiceId", "af_heart", "audioEncoding", "MP3",
                    "sourceArtifactId", source.artifactId(), "sourceArtifactVersion", source.version().value()));
            assertThat(mp3.status()).as("an unsupported encoding must never report success").isNotEqualTo(ToolExecutionStatus.SUCCESS);
        }
    }

    // ---- helpers ----

    private ToolExecutionResult runTool(AudioVideoToolHandlerFactory factory,
                                        MediaSourceAuthorizationContracts.AuthenticatedPrincipal caller,
                                        String toolId, Map<String, Object> input) {
        ToolExecutionEnvelope envelope = ToolExecutionEnvelope.of(toolId, "1.0.0", PRINCIPAL, null, TENANT,
                ToolActionClass.CALL_EXTERNAL, "1.0", input);
        ToolContract contract = new ToolContract(toolId, "1.0.0", "test", "test", envelope.actionClass(), false, true,
                Map.of(), Map.of(), Set.of(), ToolTransport.IN_PROCESS, null, Map.of());
        return runPromise(() -> factory.createAuthenticated(toolId).handle(envelope, contract, caller),
                Duration.ofMinutes(6));
    }

    private static final class MemoryLedger implements InvocationLedger {
        private final Map<String, LogicalAction> actions = new HashMap<>();
        @Override public synchronized Optional<LogicalAction> find(String id) { return Optional.ofNullable(actions.get(id)); }
        @Override public synchronized void record(LogicalAction action) { actions.put(action.invocationId(), action); }
        @Override public synchronized ClaimResult claim(LogicalAction fence) {
            return actions.putIfAbsent(fence.invocationId(), fence) == null ? ClaimResult.CLAIMED
                    : ClaimResult.ALREADY_CLAIMED;
        }
        @Override public synchronized boolean complete(LogicalAction terminal) {
            actions.put(terminal.invocationId(), terminal);
            return true;
        }
    }

    /** Host-owned purpose for the speech-to-text tool; the rights fixture below allows exactly this purpose. */
    private static com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext governance() {
        return new com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext("", "transcription",
                com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification.CONFIDENTIAL, "local",
                Set.of("local"), false, "short-lived-media", false, false, "",
                com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity.NONE,
                com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk.ASSISTIVE);
    }

    private static String sha(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static MediaArtifact upload(MediaRuntime runtime, byte[] wav, String wavSha, int samples, String key)
            throws Exception {
        var upload = runtime.beginUpload(new UploadRequest(TENANT, PRINCIPAL, "speech.wav", "audio/wav", wav.length,
                wavSha, "CONFIDENTIAL", Duration.ofMinutes(30), Map.of("sourceClockId", "fixture-clock",
                "sourceClockMappingEvidenceRef", "fixture-clock-evidence", "sourceClockTicksPerSecond", 1,
                "sourceDurationTicks", samples)), key);
        runtime.appendChunk(TENANT, PRINCIPAL, upload.uploadId(), 0, wav);
        return runtime.completeUpload(TENANT, PRINCIPAL, upload.uploadId());
    }

    /** Mirrors the artifact store's durable admission record for the fixture upload (as the existing STT IT does). */
    private static void seedArtifactRow(MediaArtifact artifact, int samples) throws Exception {
        try (var connection = java.sql.DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var statement = connection.prepareStatement(
                     "INSERT INTO media_artifacts (tenant_id,artifact_id,principal_id,file_name,"
                             + "content_type,size_bytes,sha256,object_reference,classification,"
                             + "created_at,expires_at,metadata_json,scan_status,"
                             + "scan_policy_version,scanner_id,scanned_at) "
                             + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'CLEAN',?,?,?) ON CONFLICT DO NOTHING")) {
            statement.setString(1, artifact.tenantId());
            statement.setString(2, artifact.artifactId());
            statement.setString(3, artifact.principalId());
            statement.setString(4, artifact.fileName());
            statement.setString(5, artifact.contentType());
            statement.setLong(6, artifact.sizeBytes());
            statement.setString(7, artifact.sha256());
            statement.setString(8, artifact.objectReference());
            statement.setString(9, artifact.classification());
            statement.setLong(10, artifact.createdAt().toEpochMilli());
            statement.setLong(11, artifact.expiresAt().toEpochMilli());
            statement.setString(12, "{\"sourceClockId\":\"fixture-clock\","
                    + "\"sourceClockMappingEvidenceRef\":\"fixture-clock-evidence\","
                    + "\"sourceClockTicksPerSecond\":1,\"sourceDurationTicks\":" + samples + "}");
            statement.setString(13, "fixture-scan-policy/v1");
            statement.setString(14, "fixture-scanner/v1");
            statement.setLong(15, Instant.now().toEpochMilli());
            statement.executeUpdate();
        }
    }

    private static Map<String, String> environment() {
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENABLED", "true");
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "integration");
        env.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_E2E_DB_PASSWORD");
        env.put("MEDIA_E2E_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        env.put("MEDIA_S3_BUCKET", "media-e2e-speech");
        env.put("MEDIA_S3_REGION", "us-east-1");
        env.put("MEDIA_S3_ENDPOINT", stubUrl);
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_E2E_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_E2E_SECRET");
        env.put("MEDIA_E2E_ACCESS", "e2e-access");
        env.put("MEDIA_E2E_SECRET", "e2e-secret");
        return env;
    }

    /** TEST FIXTURE: deterministic ALLOW decision for the source-rights authority under test. */
    private static final class AllowPolicy implements PolicyEngine {
        @Override public CompletionStage<PolicyDecisionRecord> evaluate(
                com.ghatana.governance.PolicyEvaluationRequest request) {
            PolicyEvaluationContext context = new PolicyEvaluationContext(
                    request.principalId(), request.tenantId(), request.actionClass(),
                    request.targetType(), request.targetId(), request.toolId(),
                    request.criticality(), request.reversibility(), request.attributes(),
                    Instant.now(), request.correlationId(), request.verifiedContext());
            return CompletableFuture.completedFuture(new PolicyDecisionRecord(
                    "policy-decision-e2e", PolicyDecisionOutcome.ALLOW,
                    List.of("policy-v1:rule-allow-media"), List.of("rule-allow-media"),
                    List.of("e2e policy evaluation"), context, Instant.now(), null,
                    "policy-v1", List.of(PolicyReasonCode.POLICY_ALLOWED)));
        }
        @Override public CompletionStage<Boolean> policyExists(String policyId) {
            return CompletableFuture.completedFuture("policy-v1".equals(policyId));
        }
        @Override public CompletionStage<Boolean> policyExists(String policyId, String version) { return policyExists(policyId); }
        @Override public boolean isOpen() { return true; }
        @Override public void close() { }
        @Override public com.ghatana.governance.PolicyEngineLifecycle.State lifecycleState() {
            return com.ghatana.governance.PolicyEngineLifecycle.State.OPEN;
        }
        @Override public long inFlightEvaluations() { return 0; }
        @Override public com.ghatana.governance.PolicyEngineLifecycle.Result drain(Duration timeout) {
            return new com.ghatana.governance.PolicyEngineLifecycle.Result(
                    com.ghatana.governance.PolicyEngineLifecycle.State.DRAINED, 0);
        }
        @Override public com.ghatana.governance.PolicyEngineLifecycle.Result close(Duration timeout) {
            return new com.ghatana.governance.PolicyEngineLifecycle.Result(
                    com.ghatana.governance.PolicyEngineLifecycle.State.CLOSED, 0);
        }
    }
}
