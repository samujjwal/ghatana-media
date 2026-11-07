package com.ghatana.audio.video.vision.scenetext;

import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.Cancellation;
import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1;
import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.Box;
import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.Block;
import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.Line;
import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.Page;
import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.ParsedDocument;
import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.ParseRequest;
import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.Provenance;
import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.ProviderCatalog;
import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.ProviderEntry;
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
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.OperationIdentityRequest;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.OperationIdentityReservation;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.DiOperationIdentity;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.ReservationDecision;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.ReservationStatus;
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
import java.util.concurrent.atomic.AtomicInteger;
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
    private final AtomicReference<String> diOperationId = new AtomicReference<>();
    private final AtomicReference<String> cancelOperationId = new AtomicReference<>();
    private final AtomicReference<String> parseGenerationHeader = new AtomicReference<>();
    private final AtomicReference<String> cancelGenerationHeader = new AtomicReference<>();
    private final List<String> diOperationIds = new CopyOnWriteArrayList<>();
    private final List<String> diGenerations = new CopyOnWriteArrayList<>();
    private volatile String catalogJson = catalog("ACCEPTED", "2.4.1", "2026.09.2");
    private volatile String parseJson = parsed("op-1", "di.ocr.en", "2026.09.2", ",\"confidence\":0.9");
    private volatile int parseStatus = 200;
    private volatile CountDownLatch parseGate = null;
    private volatile boolean cancelAck = true;
    private volatile boolean dropCancelAck;
    private final CountDownLatch parseEntered = new CountDownLatch(1);

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/providers", exchange -> respond(exchange, 200, catalogJson, "providers"));
        server.createContext("/v1/parse", exchange -> {
            parseGenerationHeader.set(exchange.getRequestHeaders().getFirst("x-operation-generation"));
            byte[] body = exchange.getRequestBody().readAllBytes();
            parseBody.set(body);
            diOperationId.set(multipartOperationId(new String(body, StandardCharsets.ISO_8859_1)));
            diOperationIds.add(diOperationId.get());
            diGenerations.add(parseGenerationHeader.get());
            parseEntered.countDown();
            if (parseGate != null) {
                try {
                    parseGate.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            String response = parseJson.replace("\"operationId\":\"op-1\"",
                    "\"operationId\":\"" + diOperationId.get() + "\"");
            respond(exchange, parseStatus, response, "parse");
        });
        server.createContext("/v1/operations/", exchange -> {
            cancelGenerationHeader.set(exchange.getRequestHeaders().getFirst("x-operation-generation"));
            cancelOperationId.set(exchange.getRequestURI().getPath().substring("/v1/operations/".length()));
            String call = "cancel:" + exchange.getRequestMethod() + ":" + exchange.getRequestURI().getPath();
            if (dropCancelAck) {
                calls.add(call);
                exchange.close();
            } else {
                String ack = "{\"protocolVersion\":\"document-intelligence.v1\",\"operationId\":\""
                        + cancelOperationId.get() + "\",\"operationGeneration\":\""
                        + cancelGenerationHeader.get() + "\",\"cancelled\":" + cancelAck + "}";
                respond(exchange, 200, ack, call);
            }
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
        assertThat(body).contains("\"operationId\":\"" + diOperationId.get() + "\"", "\"providerRef\":\"di.ocr.en\"", "\"mediaType\":\"image/png\"",
                "\"operationGeneration\":\"" + parseGenerationHeader.get() + "\"", "name=\"file\"");
        assertThat(diOperationId.get()).matches("media-scene-text-[0-9a-f]{64}").isNotEqualTo("op-1");
        assertThat(recognized.operationId()).isEqualTo("op-1");
        assertThat(body).contains(new String(CROP, StandardCharsets.ISO_8859_1));
        assertThat(parseGenerationHeader.get()).matches("[0-9a-f]{32}");
    }

    @Test
    void sourceRightsRevokedAfterCatalogPreventDiParse() {
        AtomicInteger checks = new AtomicInteger();
        SourceAuthority revokedAfterCatalog = check -> checks.incrementAndGet() == 1
                ? new Decision(SourceStatus.ADMITTED, check.sourceVersion(), ORIGINAL_SHA, "decision-1")
                : Decision.of(SourceStatus.DENIED);

        Outcome outcome = service(revokedAfterCatalog).recognize(
                request("tenant-1", ORIGINAL_SHA), Cancellation.none());

        assertRejected(outcome, Code.SOURCE_DENIED);
        assertThat(checks).hasValue(2);
        assertThat(calls).containsExactly("providers");
        assertThat(parseEntered.getCount()).isEqualTo(1);
    }

    @Test
    void missingExternalConsentRevalidatorPreventsDiParse() {
        AtomicInteger checks = new AtomicInteger();
        SourceAuthority noExternalConsentRevalidator = check -> checks.incrementAndGet() == 1
                ? new Decision(SourceStatus.ADMITTED, check.sourceVersion(), ORIGINAL_SHA, "decision-1")
                : Decision.of(SourceStatus.NOT_ADMITTED);

        Outcome outcome = service(noExternalConsentRevalidator).recognize(
                request("tenant-1", ORIGINAL_SHA), Cancellation.none());

        assertRejected(outcome, Code.SOURCE_DENIED);
        assertThat(checks).hasValue(2);
        assertThat(calls).containsExactly("providers");
        assertThat(parseEntered.getCount()).isEqualTo(1);
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
        SceneTextRecognitionService service = new SceneTextRecognitionService(
                Optional.empty(), admitted(), POLICY, Optional.of(trustedResolver()));
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
    void consumerRevalidatesGeometryAndConfidenceFromItsClientPort() {
        DocumentIntelligenceV1 clientWithOutOfCropLine = directClient(
                new Box(0.9, 0.5, 0.2, 0.25), Optional.of(0.9));
        DocumentIntelligenceV1 clientWithNonFiniteConfidence = directClient(
                new Box(0.5, 0.5, 0.25, 0.25), Optional.of(Double.NaN));

        assertRejected(serviceWithClient(clientWithOutOfCropLine)
                .recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()), Code.RESPONSE_INVALID);
        assertRejected(serviceWithClient(clientWithNonFiniteConfidence)
                .recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()), Code.RESPONSE_INVALID);
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
        assertThat(cancelOperationId.get()).isEqualTo(diOperationId.get());
        assertThat(cancelOperationId.get()).isNotEqualTo("op-1");
        assertThat(calls).contains("cancel:DELETE:/v1/operations/" + diOperationId.get());
    }

    @Test
    void cancellationBeforeStartMakesNoDiCall() {
        Cancellation cancellation = new Cancellation();
        cancellation.cancel();
        assertRejected(service(admitted()).recognize(request("tenant-1", ORIGINAL_SHA), cancellation), Code.CANCELLED);
        assertThat(calls).isEmpty();
    }

    @Test
    void identicalInputReusesStableDiIdentityAndDifferentTenantDoesNot() {
        SceneTextRecognitionService service = service(admitted(), POLICY, new MapReservation());
        assertThat(service.recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()))
                .isInstanceOf(Recognized.class);
        assertThat(service.recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()))
                .isInstanceOf(Recognized.class);
        assertThat(service.recognize(request("tenant-2", ORIGINAL_SHA), Cancellation.none()))
                .isInstanceOf(Recognized.class);

        assertThat(diOperationIds).hasSize(3);
        assertThat(diOperationIds.get(0)).isEqualTo(diOperationIds.get(1));
        assertThat(diGenerations.get(0)).isEqualTo(diGenerations.get(1)).matches("[0-9a-f]{32}");
        assertThat(diOperationIds.get(2)).isNotEqualTo(diOperationIds.get(0));
        assertThat(diGenerations.get(2)).isNotEqualTo(diGenerations.get(0));
        assertThat(diOperationIds).noneMatch(id -> id.contains("tenant-"));
    }

    @Test
    void renewedDecisionReferenceDoesNotBreakExactReplayAndLatestReferenceIsReturned() {
        AtomicInteger decisionRefs = new AtomicInteger();
        SourceAuthority renewedDecision = check -> new Decision(SourceStatus.ADMITTED, check.sourceVersion(),
                ORIGINAL_SHA, "decision-" + decisionRefs.incrementAndGet());
        SceneTextRecognitionService service = service(renewedDecision, POLICY, new MapReservation());

        Recognized first = (Recognized) service.recognize(
                request("tenant-1", ORIGINAL_SHA), Cancellation.none());
        Recognized replay = (Recognized) service.recognize(
                request("tenant-1", ORIGINAL_SHA), Cancellation.none());

        assertThat(first.rightsDecisionRef()).isEqualTo("decision-3");
        assertThat(replay.rightsDecisionRef()).isEqualTo("decision-6");
        assertThat(decisionRefs).hasValue(6);
        assertThat(diOperationIds).hasSize(2);
        assertThat(diOperationIds.get(0)).isEqualTo(diOperationIds.get(1));
        assertThat(diGenerations).hasSize(2);
        assertThat(diGenerations.get(0)).isEqualTo(diGenerations.get(1));
    }

    @Test
    void sourceRightsAreRecheckedAfterDurableReservationBeforeDiParse() {
        AtomicInteger checks = new AtomicInteger();
        SourceAuthority revokedDuringReservation = check -> checks.incrementAndGet() <= 2
                ? new Decision(SourceStatus.ADMITTED, check.sourceVersion(), ORIGINAL_SHA, "decision-" + checks.get())
                : Decision.of(SourceStatus.DENIED);
        OperationIdentityReservation reservation = new MapReservation();
        SceneTextRecognitionService service = service(revokedDuringReservation, POLICY, reservation);

        Outcome outcome = service.recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none());

        assertRejected(outcome, Code.SOURCE_DENIED);
        assertThat(checks).hasValue(3);
        assertThat(calls).containsExactly("providers");
        assertThat(parseEntered.getCount()).isEqualTo(1);
    }

    @Test
    void unavailableOperationReservationFailsClosedBeforeDiParse() {
        SceneTextRecognitionService service = service(admitted(), POLICY,
                ignored -> ReservationDecision.of(ReservationStatus.UNAVAILABLE));

        assertRejected(service.recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()),
                Code.OPERATION_IDENTITY_NOT_ADMITTED);
        assertThat(calls).containsExactly("providers");
        assertThat(parseEntered.getCount()).isEqualTo(1);
    }

    @Test
    void changedRequestUnderSameMediaOperationIdConflictsBeforeSecondParse() {
        SceneTextRecognitionService service = service(admitted(), POLICY, new MapReservation());
        assertThat(service.recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()))
                .isInstanceOf(Recognized.class);
        FrameRequest base = request("tenant-1", ORIGINAL_SHA);
        FrameRequest changed = new FrameRequest(base.operationId(), base.tenantId(), base.principalId(), "different-purpose",
                base.sourceArtifactId(), base.sourceVersion(), base.frameId(), base.ptsUs(), base.frameWidth(), base.frameHeight(),
                base.roi(), base.mediaType(), base.croppedBytes(), base.originalFrameSha256(), base.croppedFrameSha256(), base.languageHint());

        assertRejected(service.recognize(changed, Cancellation.none()), Code.OPERATION_IDENTITY_CONFLICT);
        assertThat(calls.stream().filter("parse"::equals)).hasSize(1);
        assertThat(diOperationIds).hasSize(1);
    }

    @Test
    void missingOperationReservationFailsClosedBeforeDiParse() {
        SceneTextRecognitionService service = new SceneTextRecognitionService(
                Optional.of(httpClient()), admitted(), POLICY, Optional.of(trustedResolver()));

        assertRejected(service.recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()),
                Code.OPERATION_IDENTITY_NOT_ADMITTED);
        assertThat(calls).containsExactly("providers");
        assertThat(parseEntered.getCount()).isEqualTo(1);
    }

    @Test
    void timeoutWithConfirmedCancelReturnsDeadlineExceeded() {
        parseGate = new CountDownLatch(1);
        Outcome outcome = service(admitted(), policyWithTimeout(150))
                .recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none());
        parseGate.countDown();
        assertRejected(outcome, Code.DEADLINE_EXCEEDED);
        assertThat(cancelOperationId.get()).isEqualTo(diOperationId.get());
        assertThat(cancelGenerationHeader.get()).isEqualTo(parseGenerationHeader.get());
    }

    @Test
    void timeoutWithLostCancelAckReturnsNonretryableUnknownOutcome() {
        parseGate = new CountDownLatch(1);
        dropCancelAck = true;
        Outcome outcome = service(admitted(), policyWithTimeout(150))
                .recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none());
        parseGate.countDown();
        assertRejected(outcome, Code.UNKNOWN_OUTCOME);
        assertThat(((Rejected) outcome).retryable()).isFalse();
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

    @Test
    void callerCropBytesNeverReachDiOnlyResolverPixelsDo() {
        FrameRequest forged = new FrameRequest("op-1", "tenant-1", "principal-1", "caption", "artifact-1",
                "v3", "frame-7", 4_000_000L, 1600, 800, new Roi(400, 200, 800, 400), "image/png",
                new byte[] {0x55, 0x55}, ORIGINAL_SHA, sha(new byte[] {0x55, 0x55}), Optional.of("en"));
        Outcome outcome = service(admitted()).recognize(forged, Cancellation.none());
        assertThat(outcome).isInstanceOf(Recognized.class);
        String body = new String(parseBody.get(), StandardCharsets.ISO_8859_1);
        assertThat(body).contains(new String(CROP, StandardCharsets.ISO_8859_1));
        assertThat(body).doesNotContain(new String(new byte[] {0x55, 0x55}, StandardCharsets.ISO_8859_1));
    }

    @Test
    void absentCropDeclarationStillRecognizesThroughResolver() {
        FrameRequest noCrop = new FrameRequest("op-1", "tenant-1", "principal-1", "caption", "artifact-1",
                "v3", "frame-7", 4_000_000L, 1600, 800, new Roi(400, 200, 800, 400), "image/png",
                null, ORIGINAL_SHA, null, Optional.of("en"));
        assertThat(service(admitted()).recognize(noCrop, Cancellation.none())).isInstanceOf(Recognized.class);
    }

    @Test
    void resolverClaimingForeignFrameDigestIsRejectedBeforeDi() {
        SceneTextRecognitionService service = new SceneTextRecognitionService(
                Optional.of(httpClient()), admitted(), POLICY,
                Optional.of(request -> new SceneTextRecognitionService.ResolvedCrop(
                        CROP, "image/png", "b".repeat(64), 4_000_000L, 1600, 800)));
        assertRejected(service.recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()),
                Code.SOURCE_FRAME_MISMATCH);
        assertThat(calls).doesNotContain("parse");
    }

    @Test
    void resolverFrameIdentityMismatchIsRejectedBeforeDi() {
        SceneTextRecognitionService service = new SceneTextRecognitionService(
                Optional.of(httpClient()), admitted(), POLICY,
                Optional.of(request -> new SceneTextRecognitionService.ResolvedCrop(
                        CROP, "image/png", ORIGINAL_SHA, 9_999_999L, request.frameWidth(), request.frameHeight())));
        assertRejected(service.recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()),
                Code.SOURCE_FRAME_MISMATCH);
        assertThat(calls).doesNotContain("parse");
    }

    @Test
    void refusedAndAbsentResolverFailClosedWithoutDi() {
        SceneTextRecognitionService denied = new SceneTextRecognitionService(
                Optional.of(httpClient()), admitted(), POLICY,
                Optional.of(request -> new SceneTextRecognitionService.CropRefused(
                        SceneTextRecognitionService.SourceStatus.NOT_ADMITTED)));
        assertRejected(denied.recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()), Code.SOURCE_DENIED);
        SceneTextRecognitionService noResolver = new SceneTextRecognitionService(
                Optional.of(httpClient()), admitted(), POLICY);
        assertRejected(noResolver.recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none()),
                Code.CROP_RESOLVER_NOT_CONFIGURED);
        assertThat(calls).doesNotContain("parse");
    }

    private DocumentIntelligenceHttpClient httpClient() {
        return new DocumentIntelligenceHttpClient(
                URI.create("http://127.0.0.1:" + server.getAddress().getPort()),
                HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build(), Duration.ofSeconds(3), 1024 * 1024,
                DocumentIntelligenceHttpClient.EndpointPolicy.loopback("127.0.0.1"), 4);
    }

    private Outcome recognize() {
        return service(admitted()).recognize(request("tenant-1", ORIGINAL_SHA), Cancellation.none());
    }

    private SceneTextRecognitionService service(SourceAuthority authority) {
        return service(authority, POLICY);
    }

    private SceneTextRecognitionService service(SourceAuthority authority, Policy policy) {
        return service(authority, policy, new MapReservation());
    }

    private SceneTextRecognitionService service(SourceAuthority authority, Policy policy,
                                                OperationIdentityReservation reservation) {
        DocumentIntelligenceHttpClient client = new DocumentIntelligenceHttpClient(
                URI.create("http://127.0.0.1:" + server.getAddress().getPort()),
                HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build(), Duration.ofSeconds(3), 1024 * 1024,
                DocumentIntelligenceHttpClient.EndpointPolicy.loopback("127.0.0.1"), 4);
        return new SceneTextRecognitionService(Optional.of(client), authority, policy,
                Optional.of(trustedResolver()), Optional.of(reservation));
    }

    private static SceneTextRecognitionService serviceWithClient(DocumentIntelligenceV1 client) {
        OperationIdentityReservation reservation = request -> ReservationDecision.reserved(
                new DiOperationIdentity(request.candidateDiOperationId(), request.candidateGeneration()));
        return new SceneTextRecognitionService(Optional.of(client), admitted(), POLICY,
                Optional.of(trustedResolver()), Optional.of(reservation));
    }

    private static DocumentIntelligenceV1 directClient(Box lineRegion, Optional<Double> confidence) {
        return new DocumentIntelligenceV1() {
            @Override public ProviderCatalog providers(Cancellation cancellation) {
                return new ProviderCatalog(DocumentIntelligenceV1.PROTOCOL_VERSION,
                        DocumentIntelligenceV1.WORKER_CAPABILITY_VERSION, List.of(
                        new ProviderEntry(POLICY.providerRef(), POLICY.providerVersion(),
                                Optional.of(POLICY.modelRef()), Optional.of(POLICY.modelVersion()),
                                List.of("image/png"), List.of("en"), "ACCEPTED", true, true)));
            }

            @Override public ParsedDocument parse(ParseRequest request, Cancellation cancellation) {
                Provenance provenance = new Provenance(POLICY.providerRef(), POLICY.providerVersion(),
                        Optional.of(POLICY.modelRef()), Optional.of(POLICY.modelVersion()));
                Line line = new Line("line-1", "EXIT", lineRegion, confidence, Optional.empty());
                Block block = new Block("block-1", "text", new Box(0.5, 0.5, 0.25, 0.25), List.of(line));
                return new ParsedDocument(DocumentIntelligenceV1.PROTOCOL_VERSION,
                        request.operationId(), POLICY.providerRef(), provenance,
                        List.of(new Page(1, List.of(block), 0)));
            }

            @Override public boolean cancel(String operationId, String operationGeneration) { return false; }
        };
    }

    private static Policy policyWithTimeout(long timeoutMs) {
        return new Policy(POLICY.providerRef(), POLICY.providerVersion(), POLICY.modelRef(), POLICY.modelVersion(),
                POLICY.acceptedMediaTypes(), POLICY.acceptedLanguages(), timeoutMs, POLICY.workerLimits());
    }

    /** Trusted-resolver fixture: re-derives CROP for the admitted frame identity. */
    private static SceneTextRecognitionService.FrameCropResolver trustedResolver() {
        return request -> new SceneTextRecognitionService.ResolvedCrop(
                CROP, "image/png", ORIGINAL_SHA, request.ptsUs(), request.frameWidth(), request.frameHeight());
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

    private static String multipartOperationId(String body) {
        String key = "\"operationId\":\"";
        int start = body.indexOf(key);
        if (start < 0) throw new AssertionError("DI request metadata has no operation ID");
        start += key.length();
        int end = body.indexOf('"', start);
        if (end < 0) throw new AssertionError("DI request operation ID is unterminated");
        return body.substring(start, end);
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

    /** Test-only atomic reservation fake; production deliberately has no local store. */
    private static final class MapReservation implements OperationIdentityReservation {
        private final java.util.concurrent.ConcurrentMap<String, BoundIdentity> bindings = new java.util.concurrent.ConcurrentHashMap<>();

        @Override
        public ReservationDecision reserve(OperationIdentityRequest request) {
            String key = request.tenantId() + '\u0000' + request.principalId() + '\u0000' + request.mediaOperationId();
            BoundIdentity proposed = new BoundIdentity(request.requestFingerprint(),
                    new DiOperationIdentity(request.candidateDiOperationId(), request.candidateGeneration()));
            java.util.concurrent.atomic.AtomicReference<BoundIdentity> selected = new java.util.concurrent.atomic.AtomicReference<>();
            java.util.concurrent.atomic.AtomicBoolean conflict = new java.util.concurrent.atomic.AtomicBoolean();
            bindings.compute(key, (ignored, existing) -> {
                if (existing == null) {
                    selected.set(proposed);
                    return proposed;
                }
                if (!existing.fingerprint().equals(request.requestFingerprint())) {
                    conflict.set(true);
                    return existing;
                }
                selected.set(existing);
                return existing;
            });
            if (conflict.get()) return ReservationDecision.of(ReservationStatus.CONFLICT);
            return ReservationDecision.reserved(selected.get().identity());
        }
    }

    private record BoundIdentity(String fingerprint, DiOperationIdentity identity) { }
}
