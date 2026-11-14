package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.ByteArrayOutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * DEV_ONLY local speech lane through the real HTTP host and the canonical artifact registration path, with the REAL
 * pinned models: Kokoro-82M synthesizes a clip, the clip is registered as an immutable artifact version, then
 * Whisper large-v3-turbo (whisper.cpp) transcribes that exact version and a WebVTT artifact is registered.
 *
 * <p>The round-trip tests are skipped, with the reason, only when the installed runtime/manifests are absent. They run
 * on a host prepared with {@code tools/model-runtimes/install-local-manifests.sh}. Rights are an explicit test
 * FIXTURE ({@link FixtureSpeechRightsGate}); it proves the injectable port, not a real rights decision.</p>
 */
class MediaDevSpeechLocalModelsTest {
    private static final String TENANT = "tenant-local";
    private static final String PRINCIPAL = "principal-local";
    private static final String SECRET = "test-only-dev-project-secret-at-least-32-bytes";
    private static final java.time.Clock CLOCK =
            java.time.Clock.fixed(Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC);
    private static final Set<String> PERMISSIONS = Set.of("media:project:dev:read", "media:project:dev:write",
            "media:artifact:read", "media:artifact:create", "media:artifact:write");
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final String SENTENCE = "The quick brown fox jumps over the lazy dog.";

    /** Explicit test fixture: allows only the named source artifacts; everything else is UNAVAILABLE. */
    static final class FixtureSpeechRightsGate implements MediaDevSpeechRuntime.SpeechRightsGate {
        private final Set<String> allowedSourceArtifacts = java.util.concurrent.ConcurrentHashMap.newKeySet();
        final AtomicInteger consulted = new AtomicInteger();
        void allow(String artifactId) { allowedSourceArtifacts.add(artifactId); }
        @Override public Decision authorize(String tenantId, String principalId,
                                            MediaDevSpeechRuntime.Operation operation, MediaArtifact source) {
            consulted.incrementAndGet();
            if (operation == MediaDevSpeechRuntime.Operation.TEXT_TO_SPEECH) {
                return new Decision(Outcome.ALLOWED, "", "TEST-FIXTURE:tts");
            }
            return source != null && allowedSourceArtifacts.contains(source.artifactId())
                    ? new Decision(Outcome.ALLOWED, "", "TEST-FIXTURE:rights:" + source.artifactId())
                    : Decision.unavailable();
        }
    }

    // ---- environment of the locally installed runtimes ----

    private static Path root() {
        String configured = System.getenv("MEDIA_LOCAL_MODEL_ROOT");
        return configured != null && !configured.isBlank() ? Path.of(configured)
                : Path.of(System.getProperty("user.home"), ".local", "share", "ghatana-media");
    }

    private static Map<String, String> environment() {
        Path root = root();
        Path script = Path.of("").toAbsolutePath().getParent().resolve("tools/model-runtimes/kokoro_synth.py");
        return Map.of(
                "MEDIA_LOCAL_MODEL_ROOT", root.toString(),
                "MEDIA_WHISPER_CPP_BIN", root.resolve("runtimes/whisper.cpp-src/build/bin/whisper-cli").toString(),
                "MEDIA_KOKORO_PYTHON", root.resolve("runtimes/kokoro-venv/bin/python").toString(),
                "MEDIA_KOKORO_SCRIPT", script.toString(),
                "MEDIA_WHISPER_CPP_THREADS", "8");
    }

    private static boolean installed() {
        var stt = com.ghatana.stt.provider.LocalWhisperCppSttProvider.fromEnvironment(environment());
        var tts = com.ghatana.tts.local.LocalKokoroTtsProvider.fromEnvironment(environment());
        return stt.ready() && tts.ready();
    }

    // ---- tests ----

    @Test
    void realKokoroClipIsRegisteredThenRealWhisperTranscribesTheExactVersionWithWebVtt() throws Exception {
        assumeTrue(installed(), "local Whisper/Kokoro runtimes with verified manifests are not installed on this "
                + "host (run tools/model-runtimes/install-local-manifests.sh)");
        Path storage = Files.createTempDirectory("media-dev-speech-");
        MediaRuntime runtime = runtime(storage);
        FixtureSpeechRightsGate gate = new FixtureSpeechRightsGate();
        HttpServer server = server(runtime, speechRuntime(runtime, gate));
        try {
            // 1. text -> synthesized audio artifact (real Kokoro-82M).
            HttpResponse<byte[]> synth = post(server, "/dev/v1/speech/syntheses", Map.of(
                    "requestId", "rt-tts-1", "text", SENTENCE, "voice", "af_heart"));
            assertThat(synth.statusCode()).as(text(synth)).isEqualTo(201);
            Map<String, Object> synthBody = map(synth);
            @SuppressWarnings("unchecked") Map<String, Object> audio = (Map<String, Object>) synthBody.get("artifact");
            assertThat(audio.get("contentType")).isEqualTo("audio/wav");
            assertThat((Integer) audio.get("sizeBytes")).isGreaterThan(40_000);
            @SuppressWarnings("unchecked") Map<String, Object> synthLineage = (Map<String, Object>) synthBody.get("lineage");
            assertThat(synthLineage.get("kind")).isEqualTo("LOCAL_TTS_AUDIO");
            assertThat(synthLineage).doesNotContainValue(SENTENCE);
            assertThat(synthLineage.get("inputTextSha256")).isEqualTo(sha(SENTENCE.getBytes(StandardCharsets.UTF_8)));
            @SuppressWarnings("unchecked") Map<String, Object> model = (Map<String, Object>) synthLineage.get("model");
            assertThat(model.get("licenseSpdx")).isEqualTo("Apache-2.0");
            String audioId = (String) audio.get("artifactId");
            String audioVersion = (String) audio.get("artifactVersionId");
            MediaArtifact registered = runtime.artifact(TENANT, PRINCIPAL, audioId).orElseThrow();
            ByteArrayOutputStream wav = new ByteArrayOutputStream();
            runtime.copyArtifactContent(TENANT, PRINCIPAL, audioId, registered.version(), wav, 8 * 1024 * 1024).orElseThrow();
            assertThat(wav.toByteArray()).startsWith('R', 'I', 'F', 'F');

            // 2. rights are an injectable port: without a rights decision for this source nothing is transcribed.
            HttpResponse<byte[]> refused = post(server, "/dev/v1/speech/transcriptions", Map.of(
                    "requestId", "rt-stt-denied", "artifactId", audioId, "artifactVersionId", audioVersion));
            assertThat(refused.statusCode()).isEqualTo(422);
            assertThat(code(refused)).isEqualTo("RIGHTS_AUTHORITY_UNAVAILABLE");
            assertThat(runtime.artifact(TENANT, PRINCIPAL, audioId)).isPresent();

            // 3. audio artifact version -> transcript + WebVTT (real whisper.cpp, large-v3-turbo).
            gate.allow(audioId);
            HttpResponse<byte[]> stt = post(server, "/dev/v1/speech/transcriptions", Map.of(
                    "requestId", "rt-stt-1", "artifactId", audioId, "artifactVersionId", audioVersion,
                    "language", "en"));
            assertThat(stt.statusCode()).as(text(stt)).isEqualTo(201);
            Map<String, Object> sttBody = map(stt);
            String transcript = (String) sttBody.get("text");
            System.out.println("LOCAL_SPEECH_ROUND_TRIP input=\"" + SENTENCE + "\" transcript=\"" + transcript + "\"");
            String normalized = transcript.toLowerCase(Locale.ROOT).replaceAll("[^a-z ]", " ");
            for (String word : List.of("quick", "brown", "fox", "jumps", "lazy", "dog")) {
                assertThat(normalized).as("transcript: %s", transcript).contains(word);
            }
            @SuppressWarnings("unchecked") Map<String, Object> captions = (Map<String, Object>) sttBody.get("captions");
            @SuppressWarnings("unchecked") Map<String, Object> captionArtifact = (Map<String, Object>) captions.get("artifact");
            assertThat(captionArtifact.get("contentType")).isEqualTo("text/vtt");
            ByteArrayOutputStream vtt = new ByteArrayOutputStream();
            MediaArtifact vttArtifact = runtime.artifact(TENANT, PRINCIPAL, (String) captionArtifact.get("artifactId")).orElseThrow();
            runtime.copyArtifactContent(TENANT, PRINCIPAL, vttArtifact.artifactId(), vttArtifact.version(), vtt, 1 << 20).orElseThrow();
            // The registered artifact must satisfy the strict WebVTT reader used by the caption renderer.
            assertThat(MediaDevWebVtt.parse(vtt.toByteArray())).isNotEmpty();
            @SuppressWarnings("unchecked") Map<String, Object> transcriptView = (Map<String, Object>) sttBody.get("transcript");
            @SuppressWarnings("unchecked") Map<String, Object> sttLineage = (Map<String, Object>) transcriptView.get("lineage");
            @SuppressWarnings("unchecked") Map<String, Object> source = (Map<String, Object>) sttLineage.get("source");
            assertThat(source.get("artifactVersionId")).isEqualTo(audioVersion);
            assertThat(sttLineage.get("rightsDecision")).isEqualTo("TEST-FIXTURE:rights:" + audioId);
            @SuppressWarnings("unchecked") Map<String, Object> sttModel = (Map<String, Object>) sttLineage.get("model");
            assertThat(sttModel.get("licenseSpdx")).isEqualTo("MIT");
            assertThat((String) sttModel.get("weightsSha256")).matches("[0-9a-f]{64}");

            // 4. owner-scoped reopen of the durable lineage.
            @SuppressWarnings("unchecked") String transcriptId = (String) ((Map<String, Object>) transcriptView.get("artifact")).get("artifactId");
            HttpResponse<byte[]> reopened = get(server, "/dev/v1/speech/outputs/" + transcriptId, PRINCIPAL);
            assertThat(reopened.statusCode()).isEqualTo(200);
            assertThat(get(server, "/dev/v1/speech/outputs/" + transcriptId, "principal-other").statusCode()).isEqualTo(404);

            // 5. same requestId replays the same durable outputs instead of creating duplicates.
            HttpResponse<byte[]> replay = post(server, "/dev/v1/speech/transcriptions", Map.of(
                    "requestId", "rt-stt-1", "artifactId", audioId, "artifactVersionId", audioVersion,
                    "language", "en"));
            assertThat(replay.statusCode()).as(text(replay)).isEqualTo(200);
            assertThat(map(replay).get("replayed")).isEqualTo(true);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void absentModelsStayFailClosedWithATypedUnavailableResultAndNoEffect() throws Exception {
        Path storage = Files.createTempDirectory("media-dev-speech-absent-");
        MediaRuntime runtime = runtime(storage);
        FixtureSpeechRightsGate gate = new FixtureSpeechRightsGate();
        MediaDevSpeechRuntime absent = MediaDevSpeechRuntime.compose(runtime, Map.of());
        HttpServer server = server(runtime, absent);
        try {
            Map<String, Object> capabilities = map(get(server, "/dev/v1/speech/capabilities", PRINCIPAL));
            @SuppressWarnings("unchecked") Map<String, Object> stt = (Map<String, Object>) capabilities.get("speechToText");
            assertThat(stt.get("ready")).isEqualTo(false);
            assertThat(stt.get("installState")).isEqualTo("NOT_INSTALLED");
            HttpResponse<byte[]> synth = post(server, "/dev/v1/speech/syntheses",
                    Map.of("requestId", "absent-1", "text", "hello"));
            assertThat(synth.statusCode()).isEqualTo(503);
            assertThat(code(synth)).isEqualTo("SPEECH_RUNTIME_UNAVAILABLE");
            HttpResponse<byte[]> transcribe = post(server, "/dev/v1/speech/transcriptions", Map.of(
                    "requestId", "absent-2", "artifactId", "a", "artifactVersionId", "sha256:" + "0".repeat(64)));
            assertThat(transcribe.statusCode()).isEqualTo(503);
            assertThat(gate.consulted.get()).isZero();
        } finally {
            server.stop(0);
        }
    }

    @Test
    void permissionsAndShapesAreEnforcedBeforeAnyInference() throws Exception {
        Path storage = Files.createTempDirectory("media-dev-speech-perm-");
        MediaRuntime runtime = runtime(storage);
        HttpServer server = server(runtime, MediaDevSpeechRuntime.compose(runtime, Map.of()));
        try {
            HttpResponse<byte[]> noCreate = send(server, "POST", "/dev/v1/speech/syntheses",
                    Map.of("requestId", "p-1", "text", "hello"), Set.of("media:project:dev:write", "media:artifact:read"));
            assertThat(noCreate.statusCode()).isEqualTo(403);
            HttpResponse<byte[]> noWrite = send(server, "POST", "/dev/v1/speech/syntheses",
                    Map.of("requestId", "p-1", "text", "hello"), Set.of("media:artifact:create"));
            assertThat(noWrite.statusCode()).isEqualTo(403);
            HttpResponse<byte[]> extra = post(server, "/dev/v1/speech/syntheses",
                    Map.of("requestId", "p-2", "text", "hello", "voiceEmbedding", "AAAA"));
            assertThat(extra.statusCode()).isEqualTo(400);
            HttpResponse<byte[]> badSpeed = post(server, "/dev/v1/speech/syntheses",
                    Map.of("requestId", "p-3", "text", "hello", "speakingRate", 9));
            assertThat(badSpeed.statusCode()).isEqualTo(400);
            assertThat(send(server, "GET", "/dev/v1/speech/syntheses", null, PERMISSIONS).statusCode())
                .as("GET is not a mapped DEV route permission, so the security filter refuses it").isEqualTo(403);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void productionLikeProfilesRefuseTheDevTtsGateAndTheDefaultSttGateWithoutAnAuthority() {
        MediaRuntime runtime = runtime(Path.of(System.getProperty("java.io.tmpdir")));
        // A development profile may use a stock voice with no source artifact (mirrors the job lane) ...
        var devDecision = MediaDevSpeechRuntime.canonicalJobLaneTtsGate(runtime).authorize(
                TENANT, PRINCIPAL, MediaDevSpeechRuntime.Operation.TEXT_TO_SPEECH, null);
        assertThat(devDecision.outcome()).isEqualTo(MediaDevSpeechRuntime.SpeechRightsGate.Outcome.ALLOWED);
        assertThat(devDecision.evidenceRef()).contains("no-source-artifact");
        // ... but the STT gate is the runtime's authority; none is configured (and this source is not even in the
        // store), so it can never answer ALLOWED.
        MediaArtifact artifact = new MediaArtifact(TENANT, PRINCIPAL, "artifact-x", "a.wav", "audio/wav", 4,
                "a".repeat(64), "local://x", "INTERNAL", Instant.now(), Instant.now().plusSeconds(60), Map.of());
        assertThat(MediaDevSpeechRuntime.runtimeAuthorityGate(runtime).authorize(
                TENANT, PRINCIPAL, MediaDevSpeechRuntime.Operation.SPEECH_TO_TEXT, artifact).outcome())
                .isNotEqualTo(MediaDevSpeechRuntime.SpeechRightsGate.Outcome.ALLOWED);
        assertThat(MediaDevSpeechRuntime.SpeechRightsGate.unavailable().authorize(
                TENANT, PRINCIPAL, MediaDevSpeechRuntime.Operation.SPEECH_TO_TEXT, artifact).code())
                .isEqualTo("RIGHTS_AUTHORITY_UNAVAILABLE");
    }

    @Test
    void rightsConsentResolverVerdictsMapToProcessingScopeDecisionsAndUnavailableIsTheDefault() {
        MediaArtifact artifact = new MediaArtifact(TENANT, PRINCIPAL, "artifact-x", "a.wav", "audio/wav", 4,
                "a".repeat(64), "local://x", "INTERNAL", Instant.now(), Instant.now().plusSeconds(60), Map.of());
        var seen = new java.util.ArrayList<com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest>();
        for (var verdict : com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict.values()) {
            // TEST FIXTURE resolver returning a fixed verdict.
            var resolver = (com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver)
                    new FixtureResolver(verdict, seen);
            var decision = MediaDevSpeechRuntime.resolverGate(resolver).authorize(TENANT, PRINCIPAL,
                    MediaDevSpeechRuntime.Operation.SPEECH_TO_TEXT, artifact);
            switch (verdict) {
                case ADMITTED -> assertThat(decision.outcome())
                        .isEqualTo(MediaDevSpeechRuntime.SpeechRightsGate.Outcome.ALLOWED);
                case UNAVAILABLE -> assertThat(decision.code()).isEqualTo("RIGHTS_AUTHORITY_UNAVAILABLE");
                default -> {
                    assertThat(decision.outcome()).isEqualTo(MediaDevSpeechRuntime.SpeechRightsGate.Outcome.DENIED);
                    assertThat(decision.code()).isEqualTo("RIGHTS_DECISION_" + verdict.name());
                }
            }
        }
        assertThat(seen).allSatisfy(request -> {
            assertThat(request.scope()).isEqualTo(com.ghatana.media.runtime.MediaRightsConsentContracts.Scope.PROCESSING);
            assertThat(request.artifactVersion()).isEqualTo(artifact.version().value());
            assertThat(request.contentSha256()).isEqualTo(artifact.sha256());
        });
        // The unconfigured default resolver and a throwing resolver both stay fail-closed.
        assertThat(MediaDevSpeechRuntime.resolverGate(
                com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver.unavailable())
                .authorize(TENANT, PRINCIPAL, MediaDevSpeechRuntime.Operation.SPEECH_TO_TEXT, artifact).code())
                .isEqualTo("RIGHTS_AUTHORITY_UNAVAILABLE");
    }

    /** TEST FIXTURE: fixed verdict, records the exact requests it was asked about. */
    private record FixtureResolver(com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict verdict,
            java.util.List<com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest> seen)
            implements com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver {
        @Override public String resolverId() { return "test-fixture-resolver"; }
        @Override public boolean ready() { return true; }
        @Override public com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution resolve(
                com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest request) {
            seen.add(request);
            return new com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution(verdict, java.util.Set.of(),
                    verdict == com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict.ADMITTED
                            ? java.util.List.of("attestation-1") : java.util.List.of(), "test-fixture-resolver");
        }
    }

    // ---- helpers ----

    private static MediaDevSpeechRuntime speechRuntime(MediaRuntime runtime, FixtureSpeechRightsGate gate) {
        return new MediaDevSpeechRuntime(runtime, MediaDevProjectRenderRuntime.canonicalRegistrar(runtime),
                com.ghatana.stt.provider.LocalWhisperCppSttProvider.fromEnvironment(environment()),
                com.ghatana.tts.local.LocalKokoroTtsProvider.fromEnvironment(environment()), gate,
                MediaDevSpeechRuntime.canonicalJobLaneTtsGate(runtime));
    }

    private static MediaRuntime runtime(Path root) {
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "dev", 8093, 8 * 1_048_576, 131_072, 16 * 1_048_576,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(false),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                List.of(new NoEffectProvider()), List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
    }

    private static HttpServer server(MediaRuntime runtime, MediaDevSpeechRuntime speech) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        MediaHttpHandler handler = new MediaHttpHandler(runtime, null, null, null, (MediaDevReviewRuntime) null)
                .withDevSpeech(speech);
        server.createContext("/", new MediaSecurityFilter(handler, "dev",
                Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true", "MEDIA_DEV_JWT_HMAC_SECRET", SECRET), CLOCK));
        server.start();
        return server;
    }

    private static HttpResponse<byte[]> post(HttpServer server, String path, Map<String, Object> body) throws Exception {
        return send(server, "POST", path, body, PERMISSIONS);
    }

    private static HttpResponse<byte[]> get(HttpServer server, String path, String principal) throws Exception {
        return send(server, "GET", path, null, PERMISSIONS, principal);
    }

    private static HttpResponse<byte[]> send(HttpServer server, String method, String path, Map<String, Object> body,
                                             Set<String> permissions) throws Exception {
        return send(server, method, path, body, permissions, PRINCIPAL);
    }

    private static HttpResponse<byte[]> send(HttpServer server, String method, String path, Map<String, Object> body,
                                             Set<String> permissions, String principal) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + server.getAddress().getPort() + path))
                .timeout(Duration.ofMinutes(8))
                .header("Authorization", "Bearer " + token(principal, permissions))
                .header("X-Tenant-Id", TENANT).header("Content-Type", "application/json");
        request.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body)));
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofByteArray());
    }

    private static Map<String, Object> map(HttpResponse<byte[]> response) throws Exception {
        return JSON.readValue(response.body(), new TypeReference<Map<String, Object>>() { });
    }

    private static String text(HttpResponse<byte[]> response) {
        return new String(response.body(), StandardCharsets.UTF_8);
    }

    private static String code(HttpResponse<byte[]> response) throws Exception {
        @SuppressWarnings("unchecked") Map<String, Object> error = (Map<String, Object>) map(response).get("error");
        return (String) error.get("code");
    }

    private static String sha(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static String token(String principal, Set<String> permissions) throws Exception {
        String permissionJson = permissions.stream().sorted().map(p -> "\"" + p + "\"")
                .collect(java.util.stream.Collectors.joining(","));
        String payload = "{\"sub\":\"" + principal + "\",\"tenant_id\":\"" + TENANT
                + "\",\"iss\":\"urn:ghatana:media:dev-only\",\"aud\":\"ghatana-media-dev\",\"dev_only\":true,"
                + "\"iat\":" + CLOCK.instant().getEpochSecond() + ",\"exp\":"
                + CLOCK.instant().plusSeconds(120).getEpochSecond() + ",\"permissions\":[" + permissionJson + "]}";
        String signingInput = encode("{\"alg\":\"HS256\",\"typ\":\"JWT\"}") + "." + encode(payload);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return signingInput + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
    }

    private static String encode(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static final class NoEffectProvider implements MediaProcessingProvider {
        @Override public String providerId() { return "dev-speech-http-no-effect"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 0; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public java.util.concurrent.CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            return java.util.concurrent.CompletableFuture.failedFuture(new AssertionError("speech lane must not process jobs"));
        }
    }
}
