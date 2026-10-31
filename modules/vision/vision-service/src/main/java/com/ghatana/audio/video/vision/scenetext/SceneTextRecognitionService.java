package com.ghatana.audio.video.vision.scenetext;

import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.Box;
import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.Cancellation;
import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.ParsedDocument;
import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.ProviderCatalog;
import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.ProviderEntry;
import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceV1.Provenance;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * Media Vision scene-text (VIS-09) consumer of Document Intelligence v1.
 *
 * <p>Media owns the lawful source check, frame identity/PTS, ROI crop digest and the
 * crop-to-frame coordinate transform. Document Intelligence owns provider selection
 * and OCR inference; there is no Media recognizer or fallback. Every failure returns a
 * typed rejection with zero recognized text.
 *
 * @doc.type class
 * @doc.purpose DI-only frame/ROI scene-text recognition with source authorization
 * @doc.layer product
 * @doc.pattern Service
 */
public final class SceneTextRecognitionService {

    private static final Pattern IDENTITY = Pattern.compile("[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}");
    private static final Pattern SHA256 = Pattern.compile("[a-f0-9]{64}");
    private static final int MAX_CROP_BYTES = 20 * 1024 * 1024;
    private static final int MAX_OBSERVATIONS = 5_000;

    private final Optional<DocumentIntelligenceV1> documentIntelligence;
    private final SourceAuthority sourceAuthority;
    private final Policy policy;
    private final SecureRandom random = new SecureRandom();
    private final Set<String> inFlight = ConcurrentHashMap.newKeySet();

    public SceneTextRecognitionService(Optional<DocumentIntelligenceV1> documentIntelligence,
                                       SourceAuthority sourceAuthority, Policy policy) {
        this.documentIntelligence = Objects.requireNonNull(documentIntelligence, "documentIntelligence");
        this.sourceAuthority = Objects.requireNonNull(sourceAuthority, "sourceAuthority");
        this.policy = Objects.requireNonNull(policy, "policy");
    }

    /** Trusted source-rights seam; caller-supplied consent strings are not an input. */
    @FunctionalInterface
    public interface SourceAuthority {
        Decision verify(SourceCheck check);
    }

    public record SourceCheck(String tenantId, String principalId, String purposeRef, String sourceArtifactId,
                              String sourceVersion, String frameId, String originalFrameSha256) { }

    public enum SourceStatus { ADMITTED, DENIED, NOT_ADMITTED, UNAVAILABLE }

    public record Decision(SourceStatus status, String sourceVersion, String originalFrameSha256, String decisionRef) {
        public static Decision of(SourceStatus status) {
            return new Decision(status, null, null, null);
        }
    }

    /** Owner-reviewed DI provider policy; worker limit names/units are explicit, never inferred. */
    public record Policy(String providerRef, String providerVersion, String modelRef, String modelVersion,
                         Set<String> acceptedMediaTypes, Set<String> acceptedLanguages, long timeoutMs,
                         Map<String, Integer> workerLimits) {
        public Policy {
            for (String value : List.of(providerRef, providerVersion, modelRef, modelVersion)) {
                if (value == null || value.isBlank()) throw new IllegalArgumentException("policy identity is required");
            }
            acceptedMediaTypes = Set.copyOf(acceptedMediaTypes);
            acceptedLanguages = Set.copyOf(acceptedLanguages);
            workerLimits = Map.copyOf(workerLimits);
            if (acceptedMediaTypes.isEmpty() || timeoutMs <= 0 || timeoutMs > 300_000) {
                throw new IllegalArgumentException("policy media types and bounded timeout are required");
            }
        }
    }

    /** Region of interest in source-frame pixels. */
    public record Roi(int x, int y, int width, int height) { }

    public record FrameRequest(String operationId, String tenantId, String principalId, String purposeRef,
                               String sourceArtifactId, String sourceVersion, String frameId, long ptsUs,
                               int frameWidth, int frameHeight, Roi roi, String mediaType, byte[] croppedBytes,
                               String originalFrameSha256, String croppedFrameSha256, Optional<String> languageHint) {
        public FrameRequest {
            croppedBytes = croppedBytes == null ? null : croppedBytes.clone();
            languageHint = languageHint == null ? Optional.empty() : languageHint;
        }

        @Override
        public byte[] croppedBytes() {
            return croppedBytes == null ? null : croppedBytes.clone();
        }
    }

    public record Observation(String text, double confidence, Box cropBox, Box frameBox, String blockId,
                              String lineId, int wireOrdinal, Optional<String> languageTag) { }

    public enum Code {
        INVALID_REQUEST, DUPLICATE_IN_FLIGHT, SOURCE_DIGEST_MISMATCH, SOURCE_DENIED, SOURCE_UNAVAILABLE,
        SOURCE_VERSION_MISMATCH, MEDIA_TYPE_NOT_ADMITTED, LANGUAGE_NOT_ADMITTED, DI_NOT_CONFIGURED, DI_UNAVAILABLE,
        CLIENT_PROTOCOL_MISMATCH, WORKER_VERSION_NOT_ADMITTED, PROVIDER_NOT_ADMITTED, PROVIDER_VERSION_MISMATCH,
        MODEL_IDENTITY_MISSING, MODEL_VERSION_MISMATCH, RESPONSE_INVALID, PAGE_SCOPE_UNSUPPORTED,
        RESULT_CONFIDENCE_MISSING, PROVIDER_FAILED, CANCELLED
    }

    public sealed interface Outcome permits Recognized, Rejected { }

    /** Recognized text bound to the exact source/frame/PTS and rights decision; DI did not observe these Media fields. */
    public record Recognized(String operationId, String tenantId, String sourceArtifactId, String sourceVersion,
                             String frameId, long ptsUs, String rightsDecisionRef, Provenance provenance,
                             List<Observation> observations) implements Outcome {
        public Recognized {
            observations = List.copyOf(observations);
        }
    }

    public record Rejected(Code code, boolean retryable, Optional<String> workerCode) implements Outcome {
        static Rejected of(Code code) {
            return new Rejected(code, code == Code.DI_UNAVAILABLE || code == Code.SOURCE_UNAVAILABLE, Optional.empty());
        }
    }

    public Outcome recognize(FrameRequest request, Cancellation cancellation) {
        Objects.requireNonNull(cancellation, "cancellation");
        if (!valid(request)) return Rejected.of(Code.INVALID_REQUEST);
        byte[] crop = request.croppedBytes();
        if (!sha256(crop).equals(request.croppedFrameSha256())) return Rejected.of(Code.SOURCE_DIGEST_MISMATCH);
        if (!policy.acceptedMediaTypes().contains(request.mediaType())) return Rejected.of(Code.MEDIA_TYPE_NOT_ADMITTED);
        if (request.languageHint().isPresent() && !policy.acceptedLanguages().contains(request.languageHint().get())) {
            return Rejected.of(Code.LANGUAGE_NOT_ADMITTED);
        }
        if (!inFlight.add(request.tenantId() + '\u0000' + request.operationId())) return Rejected.of(Code.DUPLICATE_IN_FLIGHT);
        try {
            return recognizeAdmitted(request, crop, cancellation);
        } finally {
            inFlight.remove(request.tenantId() + '\u0000' + request.operationId());
        }
    }

    private Outcome recognizeAdmitted(FrameRequest request, byte[] crop, Cancellation cancellation) {
        if (cancellation.isCancelled()) return Rejected.of(Code.CANCELLED);
        Decision decision = sourceAuthority.verify(new SourceCheck(request.tenantId(), request.principalId(),
                request.purposeRef(), request.sourceArtifactId(), request.sourceVersion(), request.frameId(),
                request.originalFrameSha256()));
        if (decision == null || decision.status() == SourceStatus.DENIED || decision.status() == SourceStatus.NOT_ADMITTED) {
            return Rejected.of(Code.SOURCE_DENIED);
        }
        if (decision.status() != SourceStatus.ADMITTED) return Rejected.of(Code.SOURCE_UNAVAILABLE);
        if (!request.sourceVersion().equals(decision.sourceVersion())) return Rejected.of(Code.SOURCE_VERSION_MISMATCH);
        if (!request.originalFrameSha256().equals(decision.originalFrameSha256())) return Rejected.of(Code.SOURCE_DIGEST_MISMATCH);
        if (decision.decisionRef() == null || !IDENTITY.matcher(decision.decisionRef()).matches()) return Rejected.of(Code.SOURCE_DENIED);
        if (documentIntelligence.isEmpty()) return Rejected.of(Code.DI_NOT_CONFIGURED);
        DocumentIntelligenceV1 di = documentIntelligence.get();
        String generation = HexFormat.of().formatHex(randomBytes());
        try {
            ProviderCatalog catalog = di.providers(cancellation);
            Code catalogProblem = checkCatalog(catalog, request);
            if (catalogProblem != null) return Rejected.of(catalogProblem);
            ParsedDocument parsed = di.parse(new DocumentIntelligenceV1.ParseRequest(request.operationId(), generation,
                    policy.providerRef(), request.mediaType(), request.languageHint(), policy.timeoutMs(),
                    policy.workerLimits(), crop), cancellation);
            if (cancellation.isCancelled()) {
                di.cancel(request.operationId(), generation);
                return Rejected.of(Code.CANCELLED);
            }
            return map(request, decision, parsed);
        } catch (DocumentIntelligenceException failure) {
            return switch (failure.kind()) {
                case CANCELLED -> Rejected.of(Code.CANCELLED);
                case UNAVAILABLE, TIMEOUT -> Rejected.of(Code.DI_UNAVAILABLE);
                case WORKER_ERROR -> new Rejected(Code.PROVIDER_FAILED, failure.retryable(), failure.workerCode());
                case INVALID_RESPONSE -> Rejected.of(Code.RESPONSE_INVALID);
                case SOURCE_TOO_LARGE -> Rejected.of(Code.INVALID_REQUEST);
            };
        }
    }

    private Code checkCatalog(ProviderCatalog catalog, FrameRequest request) {
        if (catalog == null || !DocumentIntelligenceV1.PROTOCOL_VERSION.equals(catalog.protocolVersion())) {
            return Code.CLIENT_PROTOCOL_MISMATCH;
        }
        if (!DocumentIntelligenceV1.WORKER_CAPABILITY_VERSION.equals(catalog.workerCapabilityVersion())) {
            return Code.WORKER_VERSION_NOT_ADMITTED;
        }
        Optional<ProviderEntry> provider = catalog.providers().stream()
                .filter(entry -> entry.providerRef().equals(policy.providerRef())).findFirst();
        if (provider.isEmpty() || !"ACCEPTED".equals(provider.get().promotionStatus())
                || !provider.get().loaded() || !provider.get().ready()) {
            return Code.PROVIDER_NOT_ADMITTED;
        }
        ProviderEntry entry = provider.get();
        if (!entry.providerVersion().equals(policy.providerVersion())) return Code.PROVIDER_VERSION_MISMATCH;
        if (entry.modelRef().isEmpty() || entry.modelVersion().isEmpty()) return Code.MODEL_IDENTITY_MISSING;
        if (!entry.modelRef().get().equals(policy.modelRef()) || !entry.modelVersion().get().equals(policy.modelVersion())) {
            return Code.MODEL_VERSION_MISMATCH;
        }
        if (!entry.mediaTypes().contains(request.mediaType())) return Code.MEDIA_TYPE_NOT_ADMITTED;
        if (request.languageHint().isPresent() && !entry.supportedLanguages().contains(request.languageHint().get())) {
            return Code.LANGUAGE_NOT_ADMITTED;
        }
        return null;
    }

    private Outcome map(FrameRequest request, Decision decision, ParsedDocument parsed) {
        if (!parsed.operationId().equals(request.operationId()) || !parsed.providerRef().equals(policy.providerRef())
                || !DocumentIntelligenceV1.PROTOCOL_VERSION.equals(parsed.protocolVersion())) {
            return Rejected.of(Code.RESPONSE_INVALID);
        }
        Provenance provenance = parsed.providerProvenance();
        if (!provenance.providerRef().equals(policy.providerRef()) || !provenance.providerVersion().equals(policy.providerVersion())) {
            return Rejected.of(Code.PROVIDER_VERSION_MISMATCH);
        }
        if (provenance.modelRef().isEmpty() || provenance.modelVersion().isEmpty()) return Rejected.of(Code.MODEL_IDENTITY_MISSING);
        if (!provenance.modelRef().get().equals(policy.modelRef()) || !provenance.modelVersion().get().equals(policy.modelVersion())) {
            return Rejected.of(Code.MODEL_VERSION_MISMATCH);
        }
        if (parsed.pages().size() != 1 || parsed.pages().get(0).pageNumber() != 1 || parsed.pages().get(0).tableCount() != 0) {
            return Rejected.of(Code.PAGE_SCOPE_UNSUPPORTED);
        }
        List<Observation> observations = new ArrayList<>();
        int ordinal = 0;
        for (DocumentIntelligenceV1.Block block : parsed.pages().get(0).blocks()) {
            for (DocumentIntelligenceV1.Line line : block.lines()) {
                if (line.confidence().isEmpty()) return Rejected.of(Code.RESULT_CONFIDENCE_MISSING);
                if (++ordinal > MAX_OBSERVATIONS) return Rejected.of(Code.RESPONSE_INVALID);
                observations.add(new Observation(line.text(), line.confidence().get(), line.boundingRegion(),
                        toFrame(line.boundingRegion(), request), block.blockId(), line.lineId(), ordinal - 1, line.languageTag()));
            }
        }
        return new Recognized(request.operationId(), request.tenantId(), request.sourceArtifactId(), request.sourceVersion(),
                request.frameId(), request.ptsUs(), decision.decisionRef(), provenance, observations);
    }

    /** Maps a DI box normalized to the submitted crop into a box normalized to the full source frame. */
    static Box toFrame(Box crop, FrameRequest request) {
        Roi roi = request.roi();
        double frameWidth = request.frameWidth();
        double frameHeight = request.frameHeight();
        return new Box((roi.x() + crop.x() * roi.width()) / frameWidth, (roi.y() + crop.y() * roi.height()) / frameHeight,
                crop.width() * roi.width() / frameWidth, crop.height() * roi.height() / frameHeight);
    }

    private static boolean valid(FrameRequest request) {
        if (request == null) return false;
        for (String value : new String[] {request.operationId(), request.tenantId(), request.principalId(), request.purposeRef(),
                request.sourceArtifactId(), request.sourceVersion(), request.frameId()}) {
            if (value == null || !IDENTITY.matcher(value).matches()) return false;
        }
        Roi roi = request.roi();
        byte[] crop = request.croppedBytes();
        return request.ptsUs() >= 0 && request.frameWidth() > 0 && request.frameHeight() > 0 && roi != null
                && roi.x() >= 0 && roi.y() >= 0 && roi.width() > 0 && roi.height() > 0
                && (long) roi.x() + roi.width() <= request.frameWidth() && (long) roi.y() + roi.height() <= request.frameHeight()
                && request.mediaType() != null && crop != null && crop.length > 0 && crop.length <= MAX_CROP_BYTES
                && request.originalFrameSha256() != null && SHA256.matcher(request.originalFrameSha256()).matches()
                && request.croppedFrameSha256() != null && SHA256.matcher(request.croppedFrameSha256()).matches()
                && request.languageHint().map(hint -> IDENTITY.matcher(hint).matches()).orElse(true);
    }

    private byte[] randomBytes() {
        byte[] bytes = new byte[16];
        random.nextBytes(bytes);
        return bytes;
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
