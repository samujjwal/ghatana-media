package com.ghatana.audio.video.vision.scenetext;

import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.Cancellation;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Code;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Decision;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.FrameRequest;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Outcome;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Policy;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Recognized;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Rejected;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.Roi;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.SourceAuthority;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.SourceCheck;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.SourceStatus;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * DI v1 protocol-fixture tests. The local HTTP server is a wire fixture, NOT a
 * qualified Document Intelligence worker or real OCR result (VIS-09 stays open).
 */
class SceneTextRecognitionServiceTest {

    private static final byte[] CROP = {(byte) 0x89, 'P', 'N', 'G', 1, 2, 3};
    private static final String ORIGINAL_SHA = "a".repeat(64);
    private static final Policy POLICY = new Policy("di.ocr.en", "2.4.1", "model.scene-text.en", "2026.09.2",
            Set.of("image/png"), Set.of("en"), 3_000, Map.of("maxPages", 1, "maxRegions", 50));

    private HttpServer server;
    private final List<String> calls = new CopyOnWriteArrayList<>();
    private final AtomicReference<byte[]> parseBody = new AtomicReference<>();
    private final AtomicReference<String> parseGenerationHeader = new AtomicReference<>();
    private final AtomicReference<String> cancelGenerationHeader = new AtomicReference<>();
    private volatile String catalogJson = catalog("ACCEPTED", "2.4.1", "2026.09.2");
    private volatile String parseJson = parsed("op-1", "di.ocr.en", "2026.09.2", ",\"confidence\":0.9");
    private volatile int parseStatus = 200;
    private volatile CountDownLatch parseGate = null;
    private final CountDownLatch parseEntered = new CountDownLatch(1);

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/providers", exchange -> respond(exchange, 200, catalogJson, "providers"));
        server.createContext("/v1/parse", exchange -> {
            parseGenerationHeader.set(exchange.getRequestHeaders().getFirst("x-operation-generation"));
            parseBody.set(exchange.getRequestBody().readAllBytes());
            parseEntered.countDown();
            if (parseGate != null) {
                try {
                    parseGate.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            respond(exchange, parseStatus, parseJson, "parse");
        });
        server.createContext("/v1/operations/", exchange -> {
            cancelGenerationHeader.set(exchange.getRequestHeaders().getFirst("x-operation-generation"));
            respond(exchange, 204, null, "cancel:" + exchange.getRequestMethod() + ":" + exchange.getRequestURI().getPath());
        });
        server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
        server.start();
    }

    @AfterEach
    void stop() {
        if (parseGate != null) parseGate.countDown();
        server.stop(0);
    }

    @Test
    void recognizesThroughDiAndMapsCropBoxesToSourceFrameWithIdentity() {
        Outcome outcome = service(admitted()).recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none());

        assertThat(outcome).isInstanceOf(Recognized.class);
        Recognized recognized = (Recognized) outcome;
        assertThat(recognized.tenantId()).isEqualTo("tenant-1");
        assertThat(recognized.sourceVersion()).isEqualTo("v3");
        assertThat(recognized.frameId()).isEqualTo("frame-7");
        assertThat(recognized.ptsUs()).isEqualTo(4_000_000L);
        assertThat(recognized.rightsDecisionRef()).isEqualTo("decision-1");
        assertThat(recognized.provenance().modelVersion()).contains("2026.09.2");
        assertThat(recognized.observations()).singleElement().satisfies(observation -> {
            assertThat(observation.text()).isEqualTo("EXIT");
            assertThat(observation.confidence()).isEqualTo(0.9);
            // ROI (400,200,800x400) in a 1600x800 frame; crop box (0.5,0.5,0.25,0.25).
            assertThat(observation.frameBox().x()).isEqualTo(0.5);
            assertThat(observation.frameBox().y()).isEqualTo(0.5);
            assertThat(observation.frameBox().width()).isEqualTo(0.125);
            assertThat(observation.frameBox().height()).isEqualTo(0.125);
            assertThat(observation.wireOrdinal()).isZero();
        });
        assertThat(calls).containsExactly("providers", "parse");
        String body = new String(parseBody.get(), StandardCharsets.ISO_8859_1);
        assertThat(body).contains("\"operationId\":\"op-1\"", "\"providerRef\":\"di.ocr.en\"", "\"mediaType\":\"image/png\"",
                "\"operationGeneration\":\"" + parseGenerationHeader.get() + "\"", "name=\"file\"");
        assertThat(body).contains(new String(CROP, StandardCharsets.ISO_8859_1));
        assertThat(parseGenerationHeader.get()).matches("[0-9a-f]{32}");
    }

    @Test
    void modifiedCropIsRejectedBeforeSourceAuthorityOrDi() {
        CountingAuthority authority = new CountingAuthority(admitted());
        FrameRequest tampered = withCrop(request("tenant-1", ORIGINAL_SHA), new byte[] {9, 9, 9});
        assertRejected(service(authority).recognize(tampered, Cancellation.none()), Code.SOURCE_DIGEST_MISMATCH);
        assertThat(authority.calls).isZero();
        assertThat(calls).isEmpty();
    }

    @Test
    void foreignTenantIsDeniedBeforeAnyDiCall() {
        SourceAuthority tenantScoped = check -> "tenant-owner".equals(check.tenantId())
                ? new Decision(SourceStatus.ADMITTED, "v3", ORIGINAL_SHA, "decision-1") : Decision.of(SourceStatus.DENIED);
        assertRejected(service(tenantScoped).recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()), Code.SOURCE_DENIED);
        assertThat(calls).isEmpty();
    }

    @Test
    void staleSourceVersionAndOriginalDigestAreRejectedBeforeDi() {
        assertRejected(service(check -> new Decision(SourceStatus.ADMITTED, "v2", ORIGINAL_SHA, "decision-1"))
                .recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()), Code.SOURCE_VERSION_MISMATCH);
        assertRejected(service(check -> new Decision(SourceStatus.ADMITTED, "v3", "b".repeat(64), "decision-1"))
                .recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()), Code.SOURCE_DIGEST_MISMATCH);
        assertRejected(service(check -> Decision.of(SourceStatus.UNAVAILABLE))
                .recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()), Code.SOURCE_UNAVAILABLE);
        assertThat(calls).isEmpty();
    }

    @Test
    void absentDiIsNotAdmittedWithoutAnyMediaFallback() {
        SceneTextRecognitionService service = new SceneTextRecognitionService(Optional.empty(), admitted(), POLICY);
        assertRejected(service.recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()), Code.DI_NOT_CONFIGURED);
    }

    @Test
    void diOutageIsRetryableUnavailableWithZeroText() {
        server.stop(0);
        Outcome outcome = service(admitted()).recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none());
        assertRejected(outcome, Code.DI_UNAVAILABLE);
        assertThat(((Rejected) outcome).retryable()).isTrue();
    }

    @Test
    void unpromotedOrMismatchedProviderNeverReachesParse() {
        catalogJson = catalog("UNPROMOTED", "2.4.1", "2026.09.2");
        assertRejected(service(admitted()).recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()), Code.PROVIDER_NOT_ADMITTED);
        catalogJson = catalog("ACCEPTED", "9.9.9", "2026.09.2");
        assertRejected(service(admitted()).recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()), Code.PROVIDER_VERSION_MISMATCH);
        catalogJson = catalog("ACCEPTED", "2.4.1", "2025.01.0");
        assertRejected(service(admitted()).recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()), Code.MODEL_VERSION_MISMATCH);
        catalogJson = catalogJson.replace("document-intelligence-worker.v1", "document-intelligence-worker.v9");
        assertRejected(service(admitted()).recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()), Code.WORKER_VERSION_NOT_ADMITTED);
        assertThat(calls).doesNotContain("parse");
    }

    @Test
    void forgedOrUnsupportedResponsesYieldNoText() {
        parseJson = parsed("op-forged", "di.ocr.en", "2026.09.2", ",\"confidence\":0.9");
        assertRejected(recognize(), Code.RESPONSE_INVALID);
        parseJson = parsed("op-1", "di.ocr.en", "2025.01.0", ",\"confidence\":0.9");
        assertRejected(recognize(), Code.MODEL_VERSION_MISMATCH);
        parseJson = parsed("op-1", "di.ocr.en", "2026.09.2", "");
        assertRejected(recognize(), Code.RESULT_CONFIDENCE_MISSING);
        parseJson = parsed("op-1", "di.ocr.en", "2026.09.2", ",\"confidence\":0.9,\"readingOrder\":0");
        assertRejected(recognize(), Code.RESPONSE_INVALID);
        parseJson = parsed("op-1", "di.ocr.en", "2026.09.2", ",\"confidence\":0.9").replace("\"width\":0.25", "\"width\":0.75");
        assertRejected(recognize(), Code.RESPONSE_INVALID);
        parseJson = parsed("op-1", "di.ocr.en", "2026.09.2", ",\"confidence\":0.9").replace("\"pageNumber\":1", "\"pageNumber\":2");
        assertRejected(recognize(), Code.PAGE_SCOPE_UNSUPPORTED);
        parseJson = "{not json";
        assertRejected(recognize(), Code.RESPONSE_INVALID);
    }

    @Test
    void workerErrorEnvelopeIsSanitizedAndMalformedErrorIsInvalid() {
        parseStatus = 503;
        parseJson = "{\"protocolVersion\":\"document-intelligence.v1\",\"operationId\":\"op-1\",\"code\":\"PROVIDER_FAILED\",\"retryable\":true,\"providerRef\":\"di.ocr.en\"}";
        Outcome outcome = recognize();
        assertRejected(outcome, Code.PROVIDER_FAILED);
        assertThat(((Rejected) outcome).workerCode()).contains("PROVIDER_FAILED");
        assertThat(((Rejected) outcome).retryable()).isTrue();
        parseJson = "{\"raw\":\"stack trace /secret/path\"}";
        assertRejected(recognize(), Code.RESPONSE_INVALID);
    }

    @Test
    void cancellationDuringParseDiscardsResultAndSendsGenerationFencedDelete() throws Exception {
        parseGate = new CountDownLatch(1);
        Cancellation cancellation = new Cancellation();
        CompletableFuture<Outcome> pending = CompletableFuture.supplyAsync(
                () -> service(admitted()).recognize(request("tenant-1", ORIGINAL_SHA), cancellation));
        assertThat(parseEntered.await(5, TimeUnit.SECONDS)).isTrue();
        cancellation.cancel();
        assertRejected(pending.get(5, TimeUnit.SECONDS), Code.CANCELLED);
        for (int i = 0; i < 50 && cancelGenerationHeader.get() == null; i++) Thread.sleep(20);
        assertThat(cancelGenerationHeader.get()).isEqualTo(parseGenerationHeader.get());
        assertThat(calls).contains("cancel:DELETE:/v1/operations/op-1");
    }

    @Test
    void cancellationBeforeStartMakesNoDiCall() {
        Cancellation cancellation = new Cancellation();
        cancellation.cancel();
        assertRejected(service(admitted()).recognize(request("tenant-1", ORIGINAL_SHA), cancellation), Code.CANCELLED);
        assertThat(calls).isEmpty();
    }

    @Test
    void concurrentDuplicateOperationIsRejectedWithoutSecondEffect() throws Exception {
        parseGate = new CountDownLatch(1);
        SceneTextRecognitionService service = service(admitted());
        CompletableFuture<Outcome> first = CompletableFuture.supplyAsync(
                () -> service.recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()));
        assertThat(parseEntered.await(5, TimeUnit.SECONDS)).isTrue();
        assertRejected(service.recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()), Code.DUPLICATE_IN_FLIGHT);
        parseGate.countDown();
        assertThat(first.get(5, TimeUnit.SECONDS)).isInstanceOf(Recognized.class);
        assertThat(calls.stream().filter("parse"::equals)).hasSize(1);
    }

    @Test
    void invalidGeometryMediaTypeAndLanguageAreRejectedLocally() {
        FrameRequest base = request("tenant-1", ORIGINAL_SHA);
        FrameRequest outside = new FrameRequest(base.operationId(), base.tenantId(), base.principalId(), base.purposeRef(),
                base.sourceArtifactId(), base.sourceVersion(), base.frameId(), base.ptsUs(), 1600, 800,
                new Roi(1000, 200, 800, 400), base.mediaType(), CROP, ORIGINAL_SHA, sha(CROP), base.languageHint());
        assertRejected(service(admitted()).recognize(outside, Cancellation.none()), Code.INVALID_REQUEST);
        FrameRequest jpeg = new FrameRequest(base.operationId(), base.tenantId(), base.principalId(), base.purposeRef(),
                base.sourceArtifactId(), base.sourceVersion(), base.frameId(), base.ptsUs(), 1600, 800, base.roi(),
                "image/jpeg", CROP, ORIGINAL_SHA, sha(CROP), base.languageHint());
        assertRejected(service(admitted()).recognize(jpeg, Cancellation.none()), Code.MEDIA_TYPE_NOT_ADMITTED);
        FrameRequest hindi = new FrameRequest(base.operationId(), base.tenantId(), base.principalId(), base.purposeRef(),
                base.sourceArtifactId(), base.sourceVersion(), base.frameId(), base.ptsUs(), 1600, 800, base.roi(),
                base.mediaType(), CROP, ORIGINAL_SHA, sha(CROP), Optional.of("hi"));
        assertRejected(service(admitted()).recognize(hindi, Cancellation.none()), Code.LANGUAGE_NOT_ADMITTED);
        assertThat(calls).isEmpty();
    }

    private Outcome recognize() {
        return service(admitted()).recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none());
    }

    private SceneTextRecognitionService service(SourceAuthority authority) {
        DocumentIntelligenceHttpClient client = new DocumentIntelligenceHttpClient(
                URI.create("http://127.0.0.1:" + server.getAddress().getPort()),
                HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build(), Duration.ofSeconds(3), 1024 * 1024);
        return new SceneTextRecognitionService(Optional.of(client), authority, POLICY);
    }

    private static SourceAuthority admitted() {
        return check -> new Decision(SourceStatus.ADMITTED, check.sourceVersion(), ORIGINAL_SHA, "decision-1");
    }

    private static FrameRequest request(String tenantId, String originalSha) {
        return new FrameRequest("op-1", tenantId, "principal-1", "caption", "artifact-1", "v3", "frame-7", 4_000_000L,
                1600, 800, new Roi(400, 200, 800, 400), "image/png", CROP, originalSha, sha(CROP), Optional.of("en"));
    }

    private static FrameRequest withCrop(FrameRequest base, byte[] crop) {
        return new FrameRequest(base.operationId(), base.tenantId(), base.principalId(), base.purposeRef(),
                base.sourceArtifactId(), base.sourceVersion(), base.frameId(), base.ptsUs(), base.frameWidth(),
                base.frameHeight(), base.roi(), base.mediaType(), crop, base.originalFrameSha256(),
                base.croppedFrameSha256(), base.languageHint());
    }

    private static void assertRejected(Outcome outcome, Code code) {
        assertThat(outcome).isInstanceOf(Rejected.class);
        assertThat(((Rejected) outcome).code()).isEqualTo(code);
    }

    private void respond(HttpExchange exchange, int status, String body, String call) throws IOException {
        calls.add(call);
        byte[] bytes = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("content-type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length == 0 ? -1 : bytes.length);
        if (bytes.length > 0) exchange.getResponseBody().write(bytes);
        exchange.close();
    }

    private static String catalog(String promotion, String providerVersion, String modelVersion) {
        return "{\"protocolVersion\":\"document-intelligence.v1\",\"workerCapabilityVersion\":\"document-intelligence-worker.v1\","
                + "\"providers\":[{\"providerRef\":\"di.ocr.en\",\"providerVersion\":\"" + providerVersion + "\","
                + "\"modelRef\":\"model.scene-text.en\",\"modelVersion\":\"" + modelVersion + "\","
                + "\"mediaTypes\":[\"image/png\"],\"supportedLanguages\":[\"en\"],\"promotionStatus\":\"" + promotion + "\","
                + "\"loaded\":true,\"ready\":true}]}";
    }

    private static String parsed(String operationId, String providerRef, String modelVersion, String lineExtras) {
        return "{\"protocolVersion\":\"document-intelligence.v1\",\"operationId\":\"" + operationId + "\",\"providerRef\":\"" + providerRef + "\","
                + "\"providerProvenance\":{\"providerRef\":\"" + providerRef + "\",\"providerVersion\":\"2.4.1\","
                + "\"modelRef\":\"model.scene-text.en\",\"modelVersion\":\"" + modelVersion + "\"},\"quality\":{},"
                + "\"pages\":[{\"pageNumber\":1,\"tables\":[],\"blocks\":[{\"blockId\":\"block-1\",\"kind\":\"text\","
                + "\"boundingRegion\":{\"x\":0.5,\"y\":0.5,\"width\":0.25,\"height\":0.25},\"lines\":[{\"lineId\":\"line-1\","
                + "\"text\":\"EXIT\",\"boundingRegion\":{\"x\":0.5,\"y\":0.5,\"width\":0.25,\"height\":0.25}" + lineExtras + "}]}]}]}";
    }

    private static String sha(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static final class CountingAuthority implements SourceAuthority {
        private final SourceAuthority delegate;
        private int calls;

        CountingAuthority(SourceAuthority delegate) {
            this.delegate = delegate;
        }

        @Override
        public Decision verify(SourceCheck check) {
            calls++;
            return delegate.verify(check);
        }
    }
}
