package com.ghatana.stt.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.governance.PolicyDecisionOutcome;
import com.ghatana.governance.PolicyDecisionRecord;
import com.ghatana.governance.PolicyEngine;
import com.ghatana.governance.PolicyEvaluationRequest;
import com.ghatana.governance.VerifiedPolicyContext;
import com.ghatana.security.identity.PrincipalIdentity;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * STT consumer of Shared PolicyEngine plus a separate Media source-rights authority.
 *
 * <p>This adapter is intentionally injectable and is not installed by the production server:
 * no Media policy identity/version or authoritative source-rights resolver is currently
 * configured there. A policy permit alone never admits provider work.</p>
 */
final class SharedPolicySttRequestAuthorization implements SttRequestAuthorization {
    private static final Duration MAX_TIMEOUT = Duration.ofSeconds(30);

    private final PolicyEngine policyEngine;
    private final MediaRightsSourceResolver rightsResolver;
    private final Duration timeout;

    SharedPolicySttRequestAuthorization(
            PolicyEngine policyEngine,
            MediaRightsSourceResolver rightsResolver,
            Duration timeout) {
        this.policyEngine = Objects.requireNonNull(policyEngine, "policyEngine");
        this.rightsResolver = Objects.requireNonNull(rightsResolver, "rightsResolver");
        this.timeout = requireTimeout(timeout);
    }

    @Override
    public Decision authorize(Request request) {
        Objects.requireNonNull(request, "request");
        long deadline = System.nanoTime() + timeout.toNanos();
        MediaRightsSourceResolver.Resolution source;
        try {
            CompletionStage<MediaRightsSourceResolver.Resolution> stage =
                    rightsResolver.resolve(new MediaRightsSourceResolver.Request(
                            request.identity(), request.operation(), request.resourceId()));
            if (stage == null) return Decision.UNAVAILABLE;
            source = await(stage, deadline);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return Decision.UNAVAILABLE;
        } catch (ExecutionException | TimeoutException | RuntimeException failure) {
            return Decision.UNAVAILABLE;
        }
        if (source == null) return Decision.UNAVAILABLE;
        if (source.status() != MediaRightsSourceResolver.Status.ADMITTED
                || !hasCurrentFacts(source.facts(), Instant.now())) {
            return mapSourceStatus(source.status());
        }

        PolicyDecisionRecord policyDecision;
        PolicyEvaluationRequest evaluation;
        try {
            evaluation = policyRequest(request, source.facts());
            CompletionStage<PolicyDecisionRecord> stage = policyEngine.evaluate(evaluation);
            if (stage == null) return Decision.UNAVAILABLE;
            policyDecision = await(stage, deadline);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return Decision.UNAVAILABLE;
        } catch (ExecutionException | TimeoutException | RuntimeException failure) {
            return Decision.UNAVAILABLE;
        }

        if (policyDecision == null || isExpired(policyDecision, Instant.now())) {
            return Decision.UNAVAILABLE;
        }
        if (policyDecision.outcome() == PolicyDecisionOutcome.DENY) return Decision.DENIED;
        if (policyDecision.outcome() != PolicyDecisionOutcome.ALLOW
                || !policyDecision.isAuthoritative()
                || !matchesVerifiedRequest(policyDecision, evaluation)) {
            return Decision.UNAVAILABLE;
        }

        MediaRightsSourceResolver.Resolution revalidated;
        try {
            CompletionStage<MediaRightsSourceResolver.Resolution> stage = rightsResolver.revalidate(
                    new MediaRightsSourceResolver.Request(
                            request.identity(), request.operation(), request.resourceId()), source.facts());
            if (stage == null) return Decision.UNAVAILABLE;
            revalidated = await(stage, deadline);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return Decision.UNAVAILABLE;
        } catch (ExecutionException | TimeoutException | RuntimeException failure) {
            return Decision.UNAVAILABLE;
        }

        // The same canonical facts must still be current after policy evaluation. Re-read the
        // authority immediately before returning ADMITTED; any replacement or expiry fails closed.
        if (revalidated == null || isExpired(policyDecision, Instant.now())) return Decision.UNAVAILABLE;
        if (revalidated.status() != MediaRightsSourceResolver.Status.ADMITTED) {
            return mapSourceStatus(revalidated.status());
        }
        if (!source.facts().equals(revalidated.facts()) || !hasCurrentFacts(revalidated.facts(), Instant.now())) {
            return Decision.UNAVAILABLE;
        }
        return Decision.ADMITTED;
    }

    private static PolicyEvaluationRequest policyRequest(
            Request request, MediaRightsSourceResolver.SourceFacts source) {
        JwtServerInterceptor.VerifiedIdentity identity = request.identity();
        String correlationId = UUID.randomUUID().toString();
        PrincipalIdentity principal = new PrincipalIdentity(
                identity.tenantId(), identity.subject(), null, Set.of(), Instant.now());
        VerifiedPolicyContext verifiedContext = VerifiedPolicyContext.from(principal, correlationId);

        String actionClass = switch (request.operation()) {
            case TRANSCRIBE, STREAM_TRANSCRIBE -> "CALL_EXTERNAL";
            case READ_STATUS, LIST_MODELS, READ_SPEAKER_IDENTITY -> "READ";
            case LOAD_MODEL, UNLOAD_MODEL, ADAPT_MODEL, SUBMIT_CORRECTION,
                    CREATE_SPEAKER_IDENTITY, UPDATE_SPEAKER_IDENTITY -> "WRITE_REVERSIBLE";
        };
        String reversibility = switch (request.operation()) {
            case TRANSCRIBE, STREAM_TRANSCRIBE -> "IRREVERSIBLE";
            case READ_STATUS, LIST_MODELS, READ_SPEAKER_IDENTITY -> "REVERSIBLE";
            case LOAD_MODEL, UNLOAD_MODEL, ADAPT_MODEL, SUBMIT_CORRECTION,
                    CREATE_SPEAKER_IDENTITY, UPDATE_SPEAKER_IDENTITY -> "PARTIALLY_REVERSIBLE";
        };

        // Only canonical server-resolved source facts cross into policy evaluation. The caller's
        // resource key is lookup-only and does not select a policy ID/version or become authority.
        return PolicyEvaluationRequest.builder()
                .principalId(identity.subject())
                .tenantId(identity.tenantId())
                .actionClass(actionClass)
                .targetType("MEDIA_SOURCE_ARTIFACT")
                .targetId(source.canonicalArtifactId())
                .criticality("HIGH")
                .reversibility(reversibility)
                .attributes(Map.of(
                        "operation", request.operation().name(),
                        "sourceVersion", source.immutableVersion(),
                        "purpose", source.purpose(),
                        "rightsReference", source.rightsReference(),
                        "consentReference", source.consentReference(),
                        "consentExpiresAt", source.consentExpiresAt().toString(),
                        "revocationScope", source.revocationScope()))
                .correlationId(correlationId)
                .verifiedContext(verifiedContext)
                .build();
    }

    private static <T> T await(CompletionStage<T> stage, long deadline)
            throws InterruptedException, ExecutionException, TimeoutException {
        long remaining = deadline - System.nanoTime();
        if (remaining <= 0) throw new TimeoutException("STT authorization deadline elapsed");
        return stage.toCompletableFuture().get(remaining, TimeUnit.NANOSECONDS);
    }

    private static boolean isExpired(PolicyDecisionRecord decision, Instant now) {
        return decision.expiresAt() != null && !decision.expiresAt().isAfter(now);
    }

    private static boolean hasCurrentFacts(MediaRightsSourceResolver.SourceFacts facts, Instant now) {
        return facts != null && facts.consentExpiresAt().isAfter(now);
    }

    private static Decision mapSourceStatus(MediaRightsSourceResolver.Status status) {
        if (status == null) return Decision.UNAVAILABLE;
        return switch (status) {
            case DENIED -> Decision.DENIED;
            case REVOKED -> Decision.REVOKED;
            case ADMITTED, STALE, UNAVAILABLE -> Decision.UNAVAILABLE;
        };
    }

    private static boolean matchesVerifiedRequest(
            PolicyDecisionRecord decision, PolicyEvaluationRequest request) {
        var context = decision.context();
        return context != null
                && context.isTrusted()
                && context.principalId().equals(request.principalId())
                && context.tenantId().equals(request.tenantId())
                && Objects.equals(context.correlationId(), request.correlationId())
                && context.verifiedContext() != null
                && context.verifiedContext().principalId().equals(request.principalId())
                && context.verifiedContext().tenantId().equals(request.tenantId());
    }

    private static Duration requireTimeout(Duration timeout) {
        Objects.requireNonNull(timeout, "timeout");
        if (timeout.isZero() || timeout.isNegative() || timeout.compareTo(MAX_TIMEOUT) > 0) {
            throw new IllegalArgumentException("STT authorization timeout must be between zero and 30 seconds");
        }
        return timeout;
    }

    /** Separate server-side authority for source ownership, rights, purpose, and current revocation. */
    interface MediaRightsSourceResolver {
        enum Status { ADMITTED, DENIED, REVOKED, STALE, UNAVAILABLE }

        /** Facts returned only after resolving the caller key to a current source authority record. */
        record SourceFacts(
                String canonicalArtifactId,
                String immutableVersion,
                String purpose,
                String rightsReference,
                String consentReference,
                Instant consentExpiresAt,
                String revocationScope) {
            public SourceFacts {
                canonicalArtifactId = required(canonicalArtifactId, "canonicalArtifactId");
                immutableVersion = required(immutableVersion, "immutableVersion");
                purpose = required(purpose, "purpose");
                rightsReference = required(rightsReference, "rightsReference");
                consentReference = required(consentReference, "consentReference");
                Objects.requireNonNull(consentExpiresAt, "consentExpiresAt");
                revocationScope = required(revocationScope, "revocationScope");
            }

            private static String required(String value, String field) {
                Objects.requireNonNull(value, field);
                if (value.isBlank() || value.length() > 256 || value.chars().anyMatch(Character::isISOControl)) {
                    throw new IllegalArgumentException(field + " must be bounded and nonblank");
                }
                return value;
            }
        }

        record Resolution(Status status, SourceFacts facts) {
            public Resolution {
                Objects.requireNonNull(status, "status");
                if ((status == Status.ADMITTED) != (facts != null)) {
                    throw new IllegalArgumentException("ADMITTED requires current source facts only");
                }
            }
        }

        record Request(
                JwtServerInterceptor.VerifiedIdentity identity,
                Operation operation,
                String resourceId) {
            public Request {
                Objects.requireNonNull(identity, "identity");
                Objects.requireNonNull(operation, "operation");
            }
        }

        CompletionStage<Resolution> resolve(Request request);

        /** Revalidates the exact same source facts after policy evaluation and before admission. */
        CompletionStage<Resolution> revalidate(Request request, SourceFacts expectedFacts);
    }
}
