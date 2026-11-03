package com.ghatana.stt.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.HumanConsentDisposition;
import com.ghatana.media.runtime.MediaSourceRightsAdministration;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/**
 * Production Media source-rights resolver for the STT gRPC authorization boundary.
 *
 * <p>The caller's {@code resourceId} is a lookup key only: it is resolved against the
 * registered Media source-rights records for the verified tenant, and the returned facts
 * always describe the canonical record — never caller-supplied fields. Admission requires
 * the interceptor-verified subject to equal the record's registered principal (the
 * source-owning identity), the operation to be inside the record's registered operation
 * scope, and the record to be current and unrevoked. Revalidation performs an identical
 * fresh read so a revocation, expiry or replaced registration cannot ride on a stale
 * resolution. Any read failure or ambiguous multi-version registration fails closed.</p>
 */
final class MediaRuntimeSttRightsSourceResolver
        implements SharedPolicySttRequestAuthorization.MediaRightsSourceResolver {
    /** Consent reference reported for source kinds with no human-consent decision. */
    private static final String NO_HUMAN_CONSENT_REFERENCE = "not-applicable:no-human-consent-decision";

    private final MediaSourceRightsAdministration administration;
    private final Clock clock;

    MediaRuntimeSttRightsSourceResolver(
            MediaSourceRightsAdministration administration, Clock clock) {
        this.administration = Objects.requireNonNull(administration, "administration");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    @Override
    public CompletionStage<Resolution> resolve(Request request) {
        Objects.requireNonNull(request, "request");
        return CompletableFuture.completedFuture(resolveNow(request));
    }

    @Override
    public CompletionStage<Resolution> revalidate(Request request, SourceFacts expectedFacts) {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(expectedFacts, "expectedFacts");
        // Revalidate performs the same fresh authoritative read; the caller rejects any
        // change in the returned facts, so revocation between resolve and admit fails closed.
        return CompletableFuture.completedFuture(resolveNow(request));
    }

    private Resolution resolveNow(Request request) {
        JwtServerInterceptor.VerifiedIdentity identity = request.identity();
        String tenantId = identity.tenantId();
        String subject = identity.subject();
        String resourceId = request.resourceId();
        if (tenantId == null || tenantId.isBlank()
                || subject == null || subject.isBlank()
                || resourceId == null || resourceId.isBlank()) {
            return new Resolution(Status.UNAVAILABLE, null);
        }
        if (request.operation() == SttRequestAuthorization.Operation.TRANSCRIBE
                && request.sourceSha256() == null) {
            return new Resolution(Status.UNAVAILABLE, null);
        }
        List<MediaSourceRightsAdministration.SourceRecord> records;
        try {
            if (!administration.ready()) return new Resolution(Status.UNAVAILABLE, null);
            records = administration.currentRecords(tenantId, resourceId);
        } catch (RuntimeException unavailable) {
            return new Resolution(Status.UNAVAILABLE, null);
        }
        if (records == null || records.isEmpty()) {
            // No registered source-rights record can authorize work on this artifact.
            return new Resolution(Status.DENIED, null);
        }

        Instant now = clock.instant();
        List<MediaSourceRightsAdministration.SourceRecord> current = new ArrayList<>();
        MediaSourceRightsAdministration.SourceRecord newest = null;
        for (MediaSourceRightsAdministration.SourceRecord record : records) {
            if (newest == null || record.registeredAt().isAfter(newest.registeredAt())) {
                newest = record;
            }
            if (!record.revoked() && !record.expiredAt(now)) {
                current.add(record);
            }
        }
        if (current.isEmpty()) {
            // The newest registration state carries the truthful non-current status.
            return new Resolution(newest.revoked() ? Status.REVOKED : Status.STALE, null);
        }
        if (current.size() > 1) {
            // Multiple live immutable-version registrations for one caller key are ambiguous;
            // refusing is the fail-closed outcome rather than silently picking one.
            return new Resolution(Status.UNAVAILABLE, null);
        }
        MediaSourceRightsAdministration.SourceRecord record = current.get(0);
        // Do not let a malformed authority projection turn an omitted human-consent
        // decision into the nonhuman sentinel. RegisterRequest validates this shape,
        // but persisted/plugin-provided current records are an independent trust boundary.
        if (!hasValidConsentShape(record)) {
            return new Resolution(Status.UNAVAILABLE, null);
        }
        if (!record.principalId().equals(subject)
                || !record.allowedOperations().contains(operationToken(request.operation()))) {
            return new Resolution(Status.DENIED, null);
        }
        String requiredPurpose = requiredPurpose(request.operation());
        if (requiredPurpose != null && !record.allowedPurposes().contains(requiredPurpose)) {
            return new Resolution(Status.DENIED, null);
        }
        if (request.operation() == SttRequestAuthorization.Operation.TRANSCRIBE) {
            if (!hasValidContentBinding(record)) return new Resolution(Status.UNAVAILABLE, null);
            if (!constantTimeDigestEquals(request.sourceSha256(), record.sourceSha256())) {
                return new Resolution(Status.DENIED, null);
            }
        }
        return new Resolution(Status.ADMITTED, new SourceFacts(
                record.artifactId(),
                record.sourceVersion(),
                purposes(record),
                record.provenanceRef(),
                record.consentDecisionId().isBlank()
                        ? NO_HUMAN_CONSENT_REFERENCE
                        : record.consentDecisionId(),
                record.expiresAt(),
                "epoch:" + record.revocationEpoch()));
    }

    private static boolean hasValidContentBinding(MediaSourceRightsAdministration.SourceRecord record) {
        return record.sourceSha256().matches("(?i)[0-9a-f]{64}")
                && record.sourceVersion().equalsIgnoreCase("sha256:" + record.sourceSha256());
    }

    /** Compare fixed-size digest bytes without an early-exit string comparison. */
    private static boolean constantTimeDigestEquals(String requestDigest, String sourceDigest) {
        try {
            return java.security.MessageDigest.isEqual(
                    java.util.HexFormat.of().parseHex(requestDigest),
                    java.util.HexFormat.of().parseHex(sourceDigest));
        } catch (IllegalArgumentException malformedDigest) {
            return false;
        }
    }

    private static boolean hasValidConsentShape(
            MediaSourceRightsAdministration.SourceRecord record) {
        return switch (record.sourceKind()) {
            case ORIGINAL_NONHUMAN -> record.humanConsentDisposition()
                    == HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT
                    && record.consentDecisionId().isBlank();
            case HUMAN_RECORDING, THIRD_PARTY -> record.humanConsentDisposition()
                    == HumanConsentDisposition.REQUIRED
                    && !record.consentDecisionId().isBlank();
            case UNKNOWN -> false;
        };
    }

    /** Maps the STT operation to the canonical registered operation scope token. */
    private static String operationToken(SttRequestAuthorization.Operation operation) {
        return switch (operation) {
            case TRANSCRIBE, STREAM_TRANSCRIBE -> "speech_to_text";
            case LOAD_MODEL, UNLOAD_MODEL, ADAPT_MODEL, SUBMIT_CORRECTION,
                    CREATE_SPEAKER_IDENTITY, READ_SPEAKER_IDENTITY, UPDATE_SPEAKER_IDENTITY,
                    READ_STATUS, LIST_MODELS -> operation.name().toLowerCase(Locale.ROOT);
        };
    }

    /**
     * Conservative development-lane default while PDP-1's transcription purpose binding is unresolved.
     * The source leaves {@code context.consent purpose} unset and the operation proposal-only, so
     * {@code transcription} is not asserted as a canonical purpose taxonomy or evaluation grant.
     */
    private static String requiredPurpose(SttRequestAuthorization.Operation operation) {
        return switch (operation) {
            case TRANSCRIBE, STREAM_TRANSCRIBE -> "transcription";
            default -> null;
        };
    }

    /** Stable single-purpose projection of the record's registered purpose set. */
    private static String purposes(MediaSourceRightsAdministration.SourceRecord record) {
        return record.allowedPurposes().stream().sorted().reduce((a, b) -> a + "," + b).orElse("unknown");
    }
}
