package com.ghatana.stt.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.governance.PolicyDecisionOutcome;
import com.ghatana.governance.PolicyDecisionRecord;
import com.ghatana.governance.PolicyEngine;
import com.ghatana.governance.PolicyEvaluationContext;
import com.ghatana.governance.PolicyEvaluationRequest;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.stt.api.TranscriptionOptions;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.security.identity.PrincipalIdentity;
import com.ghatana.stt.core.grpc.proto.TranscribeRequest;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;
import com.ghatana.stt.testutil.VerifiedJwtContext;
import com.google.protobuf.ByteString;
import io.grpc.Context;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class SharedPolicySttRequestAuthorizationTest {
    private static final JwtServerInterceptor.VerifiedIdentity IDENTITY =
            new JwtServerInterceptor.VerifiedIdentity(
                    "00000000-0000-0000-0000-000000000001", "tenant-verified");
    private static final String CALLER_RESOURCE_KEY = "caller-resource-key";
    private static final SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.SourceFacts SOURCE_FACTS =
            new SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.SourceFacts(
                    "fixture-canonical-artifact", "fixture-immutable-version", "fixture-purpose",
                    "fixture-rights-reference", "fixture-consent-reference",
                    Instant.now().plusSeconds(300), "fixture-revocation-scope");

    @Test
    void policyRequestUsesVerifiedIdentityAndServerResolvedFactsWithoutPolicyPin() {
        PolicyEngine engine = mock(PolicyEngine.class);
        when(engine.evaluate(any())).thenAnswer(invocation -> CompletableFuture.completedFuture(
                decision(PolicyDecisionOutcome.ALLOW, true, null, invocation.getArgument(0))));
        AtomicInteger rightsCalls = new AtomicInteger();
        AtomicInteger revalidationCalls = new AtomicInteger();
        var resolver = rightsResolver(
                admitted(SOURCE_FACTS),
                request -> {
                    revalidationCalls.incrementAndGet();
                    return admitted(SOURCE_FACTS);
                },
                rightsCalls);
        var authorization = new SharedPolicySttRequestAuthorization(engine, resolver, Duration.ofSeconds(2));

        assertThat(authorization.authorize(request())).isEqualTo(SttRequestAuthorization.Decision.ADMITTED);
        org.mockito.ArgumentCaptor<PolicyEvaluationRequest> policyRequest =
                org.mockito.ArgumentCaptor.forClass(PolicyEvaluationRequest.class);
        verify(engine).evaluate(policyRequest.capture());
        PolicyEvaluationRequest evaluated = policyRequest.getValue();
        assertThat(evaluated.principalId()).isEqualTo(IDENTITY.subject());
        assertThat(evaluated.tenantId()).isEqualTo(IDENTITY.tenantId());
        assertThat(evaluated.verifiedContext()).isNotNull();
        assertThat(evaluated.verifiedContext().principalId()).isEqualTo(IDENTITY.subject());
        assertThat(evaluated.verifiedContext().tenantId()).isEqualTo(IDENTITY.tenantId());
        assertThat(evaluated.targetId()).isEqualTo(SOURCE_FACTS.canonicalArtifactId());
        assertThat(evaluated.targetId()).isNotEqualTo(CALLER_RESOURCE_KEY);
        assertThat(evaluated.attributes())
                .containsEntry("operation", "TRANSCRIBE")
                .containsEntry("sourceVersion", SOURCE_FACTS.immutableVersion())
                .containsEntry("purpose", SOURCE_FACTS.purpose())
                .containsEntry("rightsReference", SOURCE_FACTS.rightsReference())
                .containsEntry("consentReference", SOURCE_FACTS.consentReference())
                .containsEntry("consentExpiresAt", SOURCE_FACTS.consentExpiresAt().toString())
                .containsEntry("revocationScope", SOURCE_FACTS.revocationScope());
        assertThat(evaluated.policyId()).isNull();
        assertThat(evaluated.policyVersion()).isNull();
        assertThat(rightsCalls).hasValue(2);
        assertThat(revalidationCalls).hasValue(1);
    }

    @Test
    void anythingShortOfCurrentPolicyAndUnchangedRightsStopsBeforeProvider() throws Exception {
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        SttEngine provider = mock(SttEngine.class);
        when(library.getSttEngine()).thenReturn(provider);
        when(provider.transcribe(any(AudioData.class), any(TranscriptionOptions.class))).thenReturn(
                new TranscriptionResult("fixture transcript", 0.9, List.of(), List.of(),
                        Duration.ofMillis(1), "en", "fixture-model"));

        assertRejectedBeforeProvider(library, authorization(
                request -> CompletableFuture.completedFuture(
                        decision(PolicyDecisionOutcome.DENY, false, null, request)),
                rightsResolver(admitted(SOURCE_FACTS), ignored -> admitted(SOURCE_FACTS))));
        assertRejectedBeforeProvider(library, authorization(
                request -> CompletableFuture.failedFuture(new IllegalStateException("policy unavailable")),
                rightsResolver(admitted(SOURCE_FACTS), ignored -> admitted(SOURCE_FACTS))));
        assertRejectedBeforeProvider(library, authorization(
                ignored -> new CompletableFuture<>(),
                rightsResolver(admitted(SOURCE_FACTS), ignored -> admitted(SOURCE_FACTS))));
        assertRejectedBeforeProvider(library, authorization(
                request -> CompletableFuture.completedFuture(
                        decision(PolicyDecisionOutcome.ALLOW, false, null, request)),
                rightsResolver(admitted(SOURCE_FACTS), ignored -> admitted(SOURCE_FACTS))));
        assertRejectedBeforeProvider(library, authorization(
                request -> CompletableFuture.completedFuture(decision(
                        PolicyDecisionOutcome.ALLOW, true, Instant.now().minusMillis(1), request)),
                rightsResolver(admitted(SOURCE_FACTS), ignored -> admitted(SOURCE_FACTS))));

        for (var status : List.of(
                SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.Status.DENIED,
                SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.Status.REVOKED,
                SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.Status.STALE,
                SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.Status.UNAVAILABLE)) {
            assertRejectedBeforeProvider(library, authorization(
                    request -> CompletableFuture.completedFuture(
                            decision(PolicyDecisionOutcome.ALLOW, true, null, request)),
                    rightsResolver(CompletableFuture.completedFuture(resolution(status, null)),
                            ignored -> admitted(SOURCE_FACTS))));
        }
        assertRejectedBeforeProvider(library, authorization(
                request -> CompletableFuture.completedFuture(
                        decision(PolicyDecisionOutcome.ALLOW, true, null, request)),
                rightsResolver(admitted(SOURCE_FACTS), ignored -> CompletableFuture.completedFuture(resolution(
                        SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.Status.STALE, null)))));
        assertRejectedBeforeProvider(library, authorization(
                request -> CompletableFuture.completedFuture(
                        decision(PolicyDecisionOutcome.ALLOW, true, null, request)),
                rightsResolver(admitted(SOURCE_FACTS), ignored -> admitted(changedFacts()))));
        assertRejectedBeforeProvider(library, authorization(
                request -> CompletableFuture.completedFuture(
                        decision(PolicyDecisionOutcome.ALLOW, true, null, request)),
                rightsResolver(admitted(SOURCE_FACTS), ignored ->
                        CompletableFuture.failedFuture(new IllegalStateException("rights unavailable")))));
        assertRejectedBeforeProvider(library, authorization(
                request -> CompletableFuture.completedFuture(
                        decision(PolicyDecisionOutcome.ALLOW, true, null, request)),
                rightsResolver(admitted(SOURCE_FACTS), ignored -> new CompletableFuture<>())));

        // Only an authoritative policy permit over server facts plus matching final revalidation
        // reaches the provider.
        SttRequestAuthorization admitted = authorization(
                request -> CompletableFuture.completedFuture(
                        decision(PolicyDecisionOutcome.ALLOW, true, null, request)),
                rightsResolver(admitted(SOURCE_FACTS), ignored -> admitted(SOURCE_FACTS)));
        SttGrpcService service = new SttGrpcService(library, new SimpleMeterRegistry(), admitted);
        CapturingObserver observer = new CapturingObserver();
        Context previous = VerifiedJwtContext.create(IDENTITY.tenantId(), IDENTITY.subject()).attach();
        try {
            service.transcribe(transcribeRequest(), observer);
        } finally {
            Context.current().detach(previous);
        }
        assertThat(observer.error).isNull();
        assertThat(observer.value.getText()).isEqualTo("fixture transcript");
        verify(library).getSttEngine();
        verify(provider).transcribe(any(AudioData.class), any(TranscriptionOptions.class));
    }

    private static void assertRejectedBeforeProvider(
            AudioVideoLibrary library, SttRequestAuthorization authorization) {
        SttGrpcService service = new SttGrpcService(library, new SimpleMeterRegistry(), authorization);
        CapturingObserver observer = new CapturingObserver();
        Context previous = VerifiedJwtContext.create(IDENTITY.tenantId(), IDENTITY.subject()).attach();
        try {
            service.transcribe(transcribeRequest(), observer);
        } finally {
            Context.current().detach(previous);
        }
        assertThat(observer.error).isNotNull();
        verify(library, never()).getSttEngine();
        verifyNoInteractions(library);
    }

    private static SttRequestAuthorization authorization(
            PolicyEvaluator evaluator,
            SharedPolicySttRequestAuthorization.MediaRightsSourceResolver resolver) {
        PolicyEngine engine = mock(PolicyEngine.class);
        when(engine.evaluate(any())).thenAnswer(invocation ->
                evaluator.evaluate(invocation.getArgument(0)));
        return new SharedPolicySttRequestAuthorization(engine, resolver, Duration.ofMillis(20));
    }

    private static SharedPolicySttRequestAuthorization.MediaRightsSourceResolver rightsResolver(
            CompletionStage<SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.Resolution> initial,
            Revalidation revalidation) {
        return new SharedPolicySttRequestAuthorization.MediaRightsSourceResolver() {
            @Override
            public CompletionStage<Resolution> resolve(Request request) {
                assertThat(request.identity().subject()).isEqualTo(IDENTITY.subject());
                assertThat(request.identity().tenantId()).isEqualTo(IDENTITY.tenantId());
                assertThat(request.resourceId()).isEqualTo(CALLER_RESOURCE_KEY);
                return initial;
            }

            @Override
            public CompletionStage<Resolution> revalidate(Request request, SourceFacts expectedFacts) {
                assertThat(expectedFacts).isEqualTo(SOURCE_FACTS);
                return revalidation.revalidate(expectedFacts);
            }
        };
    }

    private static SharedPolicySttRequestAuthorization.MediaRightsSourceResolver rightsResolver(
            CompletionStage<SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.Resolution> initial,
            Revalidation revalidation,
            AtomicInteger calls) {
        return new SharedPolicySttRequestAuthorization.MediaRightsSourceResolver() {
            @Override public CompletionStage<Resolution> resolve(Request request) {
                calls.incrementAndGet();
                assertThat(request.resourceId()).isEqualTo(CALLER_RESOURCE_KEY);
                return initial;
            }
            @Override public CompletionStage<Resolution> revalidate(Request request, SourceFacts expectedFacts) {
                calls.incrementAndGet();
                return revalidation.revalidate(expectedFacts);
            }
        };
    }

    private static CompletionStage<SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.Resolution>
            admitted(SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.SourceFacts facts) {
        return CompletableFuture.completedFuture(resolution(
                SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.Status.ADMITTED, facts));
    }

    private static SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.Resolution resolution(
            SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.Status status,
            SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.SourceFacts facts) {
        return new SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.Resolution(status, facts);
    }

    private static PolicyDecisionRecord decision(
            PolicyDecisionOutcome outcome,
            boolean authoritative,
            Instant expiresAt,
            PolicyEvaluationRequest request) {
        PolicyDecisionRecord decision = mock(PolicyDecisionRecord.class);
        when(decision.outcome()).thenReturn(outcome);
        when(decision.isAuthoritative()).thenReturn(authoritative);
        when(decision.expiresAt()).thenReturn(expiresAt);
        when(decision.context()).thenReturn(context(request));
        return decision;
    }

    private static PolicyEvaluationContext context(PolicyEvaluationRequest request) {
        PrincipalIdentity identity = new PrincipalIdentity(
                request.tenantId(), request.principalId(), null, Set.of(), Instant.now());
        return new PolicyEvaluationContext(
                request.principalId(), request.tenantId(), request.actionClass(), request.targetType(),
                request.targetId(), request.toolId(), request.criticality(), request.reversibility(),
                Map.of(), Instant.now(), request.correlationId(),
                com.ghatana.governance.VerifiedPolicyContext.from(identity, request.correlationId()));
    }

    private static SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.SourceFacts changedFacts() {
        return new SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.SourceFacts(
                SOURCE_FACTS.canonicalArtifactId(), "fixture-replaced-version", SOURCE_FACTS.purpose(),
                SOURCE_FACTS.rightsReference(), SOURCE_FACTS.consentReference(),
                Instant.now().plusSeconds(300), SOURCE_FACTS.revocationScope());
    }

    private static SttRequestAuthorization.Request request() {
        return new SttRequestAuthorization.Request(
                IDENTITY, SttRequestAuthorization.Operation.TRANSCRIBE, CALLER_RESOURCE_KEY);
    }

    private static TranscribeRequest transcribeRequest() {
        return TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1, 2, 3, 4}))
                .setSampleRate(16_000)
                .setArtifactId(CALLER_RESOURCE_KEY)
                .build();
    }

    @FunctionalInterface
    private interface PolicyEvaluator {
        CompletionStage<PolicyDecisionRecord> evaluate(PolicyEvaluationRequest request);
    }

    @FunctionalInterface
    private interface Revalidation {
        CompletionStage<SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.Resolution> revalidate(
                SharedPolicySttRequestAuthorization.MediaRightsSourceResolver.SourceFacts expected);
    }

    private static final class CapturingObserver implements StreamObserver<TranscribeResponse> {
        private TranscribeResponse value;
        private Throwable error;
        @Override public void onNext(TranscribeResponse response) { value = response; }
        @Override public void onError(Throwable failure) { error = failure; }
        @Override public void onCompleted() { }
    }
}
