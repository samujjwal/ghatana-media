/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionFailure;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.agent.framework.tools.ToolExecutionStatus;
import com.ghatana.agent.framework.tools.ToolTransport;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.ClaimResult;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.InvocationLedger;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.LogicalAction;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.LogicalOutcome;
import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;
import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException.Reason;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import com.ghatana.tools.testing.EventloopTestBase;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Canonical Media job mapping for the four agent tools. The submission port below is a
 * TEST-ONLY fixture: it stands in for the Media runtime and proves nothing about any real
 * provider, model, voice, licence or consent being admitted.
 */
final class MediaToolJobSubmissionTest extends EventloopTestBase {

    private static final String TENANT = "tenant-jobs";
    private static final String AGENT = "agent-jobs";
    private static final String VERSION = "sha256:" + "a".repeat(64);

    /** TEST-ONLY fixture port; behavior is supplied per test. */
    private static final class TestOnlyPort implements MediaJobSubmissionPort {
        final List<ProcessingJobRequest> submitted = new ArrayList<>();
        final List<AuthenticatedPrincipal> principals = new ArrayList<>();
        final Map<String, ProcessingJob> byRequest = new HashMap<>();
        Function<ProcessingJobRequest, ProcessingJob> behavior;

        @Override public ProcessingJob submit(ProcessingJobRequest request, AuthenticatedPrincipal authenticated) {
            submitted.add(request);
            principals.add(authenticated);
            return behavior.apply(request);
        }
        @Override public Optional<ProcessingJob> findByRequestId(String tenantId, String requestId) {
            return Optional.ofNullable(byRequest.get(requestId));
        }
    }

    private static final class TestLedger implements InvocationLedger {
        private final Map<String, LogicalAction> actions = new HashMap<>();
        @Override public synchronized Optional<LogicalAction> find(String id) { return Optional.ofNullable(actions.get(id)); }
        @Override public synchronized void record(LogicalAction action) { actions.put(action.invocationId(), action); }
        @Override public synchronized ClaimResult claim(LogicalAction fence) {
            return actions.putIfAbsent(fence.invocationId(), fence) == null ? ClaimResult.CLAIMED : ClaimResult.ALREADY_CLAIMED;
        }
        @Override public synchronized boolean complete(LogicalAction terminal) {
            actions.put(terminal.invocationId(), terminal);
            return true;
        }
    }

    private record Case(String toolId, JobType jobType, Map<String, Object> input, Map<String, Object> expectedParams,
            String sourceId) { }

    private static List<Case> cases() {
        return List.of(
                new Case("av.speech-to-text", JobType.SPEECH_TO_TEXT,
                        Map.of("audioSource", Map.of("mediaArtifactId", "art-stt"), "languageCode", "en-US",
                                "sourceArtifactVersion", VERSION),
                        Map.of("language", "en-US", "diarization", false, "model", "default"), "art-stt"),
                new Case("av.text-to-speech", JobType.TEXT_TO_SPEECH,
                        Map.of("text", "hello", "sourceArtifactId", "art-tts", "sourceArtifactVersion", VERSION),
                        Map.of("text", "hello", "voice", "en-US-default", "speakingRate", 1.0, "pitch", 0.0,
                                "audioEncoding", "MP3", "storeAsArtifact", false), "art-tts"),
                new Case("av.vision-analysis", JobType.VISION,
                        Map.of("mediaSource", Map.of("mediaArtifactId", "art-vis"),
                                "analysisTypes", List.of("OCR"), "sourceArtifactVersion", VERSION),
                        Map.of("analysisTypes", List.of("OCR"), "maxResults", 10, "confidenceThreshold", 0.5), "art-vis"),
                new Case("av.multimodal-inference", JobType.MULTIMODAL,
                        Map.of("mediaArtifactId", "art-mm", "sourceArtifactVersion", VERSION),
                        Map.of("inferenceMode", "SUMMARY", "samplingRateMs", 1000, "language", "en-US",
                                "enableTranscription", true, "enableVisionAnalysis", true), "art-mm"));
    }

    private static ToolExecutionEnvelope envelope(Case c, Map<String, Object> input) {
        return ToolExecutionEnvelope.of(c.toolId(), "1.0.0", AGENT, null, TENANT,
                ToolActionClass.CALL_EXTERNAL, "1.0", input);
    }

    private static ToolContract contract(ToolExecutionEnvelope e) {
        return new ToolContract(e.toolId(), e.toolVersion(), "test", "test", e.actionClass(), false, true,
                Map.of(), Map.of(), Set.of(), ToolTransport.IN_PROCESS, null, Map.of());
    }

    private static AuthenticatedPrincipal principal() {
        return new AuthenticatedPrincipal(TENANT, AGENT, Instant.now());
    }

    private static ProcessingJob job(ProcessingJobRequest r, JobStatus status, Map<String, Object> result, String failure) {
        return new ProcessingJob("job-1", r.requestId(), r.tenantId(), r.principalId(), r.artifactId(), r.jobType(),
                status == JobStatus.ACCEPTED ? "" : "test-only-provider", status, Instant.now(), null, null,
                result, failure, 1, r.expectedArtifactVersion(), "");
    }

    private MediaToolExecutionBinder binder(TestLedger ledger, MediaToolJobBridge bridge) {
        return new MediaToolExecutionBinder(ledger, bridge.readback(),
                (p, id) -> p.tenantId().equals(id.tenantId()) && p.principalId().equals(id.callerAgentId()));
    }

    private ToolExecutionResult run(AudioVideoToolHandlerFactory factory, Case c, ToolExecutionEnvelope e,
            AuthenticatedPrincipal p) {
        return runPromise(() -> factory.createAuthenticated(c.toolId()).handle(e, contract(e), p));
    }

    @Test
    void notAdmittedPassesRuntimeRefusalThroughForEachToolWithoutProviderEffect() {
        for (Case c : cases()) {
            TestOnlyPort port = new TestOnlyPort();
            port.behavior = r -> { throw new MediaCapabilityNotAdmittedException(Reason.NOT_ADMITTED, r.jobType().name()); };
            MediaToolJobBridge bridge = new MediaToolJobBridge(port, "dev");
            var factory = new AudioVideoToolHandlerFactory(binder(new TestLedger(), bridge), bridge);

            ToolExecutionResult result = run(factory, c, envelope(c, c.input()), principal());

            assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(result.failure().kind()).isEqualTo(ToolExecutionFailure.Kind.UNAVAILABLE);
            assertThat(result.failure().stage()).isEqualTo(ToolExecutionFailure.Stage.ADMISSION);
            assertThat(result.failure().code()).isEqualTo("MEDIA_NOT_ADMITTED");
            assertThat(result.output()).isNull();
            assertThat(port.submitted).hasSize(1); // the refusal is the runtime's, zero provider calls are in the port
        }
    }

    @Test
    void positiveMapsExactJobRequestAndReturnsObservedTerminalOutcome() {
        for (Case c : cases()) {
            TestOnlyPort port = new TestOnlyPort();
            port.behavior = r -> job(r, JobStatus.COMPLETED, Map.of("audioArtifactRef", "urn:out", "text", "t"), "");
            MediaToolJobBridge bridge = new MediaToolJobBridge(port, "test");
            var factory = new AudioVideoToolHandlerFactory(binder(new TestLedger(), bridge), bridge);
            ToolExecutionEnvelope e = envelope(c, c.input());

            ToolExecutionResult result = run(factory, c, e, principal());

            assertThat(port.submitted).hasSize(1);
            ProcessingJobRequest r = port.submitted.get(0);
            assertThat(r.jobType()).isEqualTo(c.jobType());
            assertThat(r.artifactId()).isEqualTo(c.sourceId());
            assertThat(r.expectedArtifactVersion()).isEqualTo(VERSION);
            assertThat(r.requestId()).isEqualTo(MediaToolJobBridge.requestIdFor(e.invocationId()));
            assertThat(r.correlationId()).isEqualTo(e.invocationId());
            assertThat(r.tenantId()).isEqualTo(TENANT);
            assertThat(r.principalId()).isEqualTo(AGENT);
            assertThat(r.providerHint()).isEmpty();
            assertThat(r.parameters()).containsAllEntriesOf(c.expectedParams());
            assertThat(r.governanceContext().consentId()).isEmpty();
            assertThat(r.governanceContext().externalProcessingAllowed()).isFalse();
            assertThat(port.principals.get(0).principalId()).isEqualTo(AGENT);

            assertThat(result.status()).isEqualTo(ToolExecutionStatus.SUCCESS);
            @SuppressWarnings("unchecked") Map<String, Object> out = (Map<String, Object>) result.output();
            assertThat(out).containsEntry("jobId", "job-1").containsEntry("status", "COMPLETED")
                    .containsEntry("jobType", c.jobType().name())
                    .containsEntry("sourceArtifactVersion", VERSION);
            assertThat(out.get("result")).isEqualTo(Map.of("audioArtifactRef", "urn:out", "text", "t"));
        }
    }

    @Test
    void nonTerminalJobIsReportedWithJobReferenceNotInventedContent() {
        Case c = cases().get(0);
        TestOnlyPort port = new TestOnlyPort();
        port.behavior = r -> job(r, JobStatus.ACCEPTED, Map.of(), "");
        MediaToolJobBridge bridge = new MediaToolJobBridge(port, "dev");
        var factory = new AudioVideoToolHandlerFactory(binder(new TestLedger(), bridge), bridge);

        ToolExecutionResult result = run(factory, c, envelope(c, c.input()), principal());

        assertThat(result.status()).isEqualTo(ToolExecutionStatus.OUTCOME_UNKNOWN);
        assertThat(result.operationId()).isEqualTo("job-1");
        assertThat(result.sideEffectSummary()).containsEntry("reasonCode", "MEDIA_JOB_ACCEPTED");
        assertThat(result.output()).isNull();
    }

    @Test
    void failedJobAndPolicyDeniedAreFaithfullyTyped() {
        Case c = cases().get(2);
        TestOnlyPort port = new TestOnlyPort();
        port.behavior = r -> job(r, JobStatus.FAILED, Map.of(), "provider_timeout");
        MediaToolJobBridge bridge = new MediaToolJobBridge(port, "dev");
        var factory = new AudioVideoToolHandlerFactory(binder(new TestLedger(), bridge), bridge);
        ToolExecutionResult failed = run(factory, c, envelope(c, c.input()), principal());
        assertThat(failed.status()).isEqualTo(ToolExecutionStatus.FAILED);
        assertThat(failed.failure().code()).isEqualTo("PROVIDER_TIMEOUT");

        port.behavior = r -> { throw new MediaCapabilityNotAdmittedException(Reason.POLICY_DENIED, "VISION"); };
        ToolExecutionEnvelope second = ToolExecutionEnvelope.of(c.toolId(), "1.0.0", AGENT, null, TENANT,
                ToolActionClass.CALL_EXTERNAL, "1.0", c.input());
        ToolExecutionResult denied = run(factory, c, second, principal());
        assertThat(denied.status()).isEqualTo(ToolExecutionStatus.DENIED);
        assertThat(denied.failure().code()).isEqualTo("MEDIA_POLICY_DENIED");
    }

    @Test
    void duplicateInvocationSubmitsOnlyOnceAndReplaysTerminalResult() {
        Case c = cases().get(3);
        TestOnlyPort port = new TestOnlyPort();
        port.behavior = r -> job(r, JobStatus.COMPLETED, Map.of("answer", "x"), "");
        MediaToolJobBridge bridge = new MediaToolJobBridge(port, "dev");
        var factory = new AudioVideoToolHandlerFactory(binder(new TestLedger(), bridge), bridge);
        ToolExecutionEnvelope e = envelope(c, c.input());

        ToolExecutionResult first = run(factory, c, e, principal());
        ToolExecutionResult replay = run(factory, c, e, principal());

        assertThat(port.submitted).hasSize(1);
        assertThat(replay).isSameAs(first);
    }

    @Test
    void ambiguousSubmitIsOutcomeUnknownAndReconcilesViaReadbackByDerivedRequestId() {
        Case c = cases().get(0);
        TestOnlyPort port = new TestOnlyPort();
        port.behavior = r -> { throw new IllegalStateException("connection reset after send"); };
        MediaToolJobBridge bridge = new MediaToolJobBridge(port, "dev");
        var factory = new AudioVideoToolHandlerFactory(binder(new TestLedger(), bridge), bridge);
        ToolExecutionEnvelope e = envelope(c, c.input());

        assertThatThrownBy(() -> run(factory, c, e, principal()))
                .isInstanceOf(MediaToolExecutionBinder.OutcomeUnknownException.class)
                .satisfies(t -> assertThat(((MediaToolExecutionBinder.OutcomeUnknownException) t).durableJobState()).isNull());

        // The job turns out to have been created; readback by the derived request id finds it.
        String requestId = MediaToolJobBridge.requestIdFor(e.invocationId());
        ProcessingJobRequest sent = port.submitted.get(0);
        assertThat(sent.requestId()).isEqualTo(requestId);
        port.byRequest.put(requestId, job(sent, JobStatus.RUNNING, Map.of(), ""));
        assertThatThrownBy(() -> run(factory, c, e, principal()))
                .isInstanceOf(MediaToolExecutionBinder.OutcomeUnknownException.class)
                .satisfies(t -> assertThat(((MediaToolExecutionBinder.OutcomeUnknownException) t).durableJobState())
                        .isEqualTo("RUNNING"));
        assertThat(port.submitted).hasSize(1); // no second submission while the fence is UNKNOWN
        assertThat(bridge.readback().durableJobState(TENANT, e.invocationId())).contains("RUNNING");
    }

    @Test
    void wrongPrincipalTenantIsRejectedBeforeAnySubmission() {
        Case c = cases().get(0);
        TestOnlyPort port = new TestOnlyPort();
        port.behavior = r -> job(r, JobStatus.COMPLETED, Map.of("text", "t"), "");
        MediaToolJobBridge bridge = new MediaToolJobBridge(port, "dev");
        var factory = new AudioVideoToolHandlerFactory(binder(new TestLedger(), bridge), bridge);
        AuthenticatedPrincipal other = new AuthenticatedPrincipal("other-tenant", AGENT, Instant.now());

        assertThatThrownBy(() -> run(factory, c, envelope(c, c.input()), other))
                .isInstanceOf(MediaToolExecutionBinder.InvocationReplayDeniedException.class);
        // Defense in depth: the handler itself refuses a mismatched principal even if invoked directly.
        ToolExecutionEnvelope e = envelope(c, c.input());
        ToolExecutionResult direct = runPromise(() -> new SpeechToTextToolHandler(bridge, other).handle(e, contract(e)));
        assertThat(direct.status()).isEqualTo(ToolExecutionStatus.DENIED);
        assertThat(direct.failure().code()).isEqualTo(MediaToolJobBridge.PRINCIPAL_TENANT_MISMATCH);
        ToolExecutionResult anonymous = runPromise(() -> new SpeechToTextToolHandler(bridge, null).handle(e, contract(e)));
        assertThat(anonymous.failure().code()).isEqualTo(MediaToolJobBridge.PRINCIPAL_REQUIRED);
        assertThat(port.submitted).isEmpty();
    }

    @Test
    void missingOrMalformedSourceVersionOrInlineSourceIsRejectedWithoutSubmission() {
        for (Case c : cases()) {
            TestOnlyPort port = new TestOnlyPort();
            port.behavior = r -> job(r, JobStatus.COMPLETED, Map.of("text", "t"), "");
            MediaToolJobBridge bridge = new MediaToolJobBridge(port, "dev");
            var factory = new AudioVideoToolHandlerFactory(binder(new TestLedger(), bridge), bridge);

            Map<String, Object> noVersion = new HashMap<>(c.input());
            noVersion.remove("sourceArtifactVersion");
            assertThat(run(factory, c, envelope(c, noVersion), principal()).failure().code())
                    .isEqualTo("SOURCE_VERSION_REQUIRED");

            Map<String, Object> badVersion = new HashMap<>(c.input());
            badVersion.put("sourceArtifactVersion", "v1");
            assertThat(run(factory, c, envelope(c, badVersion), principal()).failure().code())
                    .isEqualTo("SOURCE_VERSION_INVALID");
            assertThat(port.submitted).isEmpty();
        }
        // Inline audio is never a canonical source version-bound artifact.
        Case stt = cases().get(0);
        TestOnlyPort port = new TestOnlyPort();
        MediaToolJobBridge bridge = new MediaToolJobBridge(port, "dev");
        var factory = new AudioVideoToolHandlerFactory(binder(new TestLedger(), bridge), bridge);
        Map<String, Object> inline = Map.of("audioSource", Map.of("audioBytes", "AAAA"), "sourceArtifactVersion", VERSION);
        assertThat(run(factory, stt, envelope(stt, inline), principal()).failure().code())
                .isEqualTo("SOURCE_ARTIFACT_REQUIRED");
        assertThat(port.submitted).isEmpty();
    }

    @Test
    void runtimeStaleSourceVersionRefusalAndMismatchedJobIdentityAreNotMaskedAsSuccess() {
        Case c = cases().get(0);
        TestOnlyPort port = new TestOnlyPort();
        port.behavior = r -> { throw new MediaCapabilityNotAdmittedException(Reason.SOURCE_VERSION_STALE, "SPEECH_TO_TEXT"); };
        MediaToolJobBridge bridge = new MediaToolJobBridge(port, "dev");
        var factory = new AudioVideoToolHandlerFactory(binder(new TestLedger(), bridge), bridge);
        assertThat(run(factory, c, envelope(c, c.input()), principal()).failure().code())
                .isEqualTo("MEDIA_SOURCE_VERSION_STALE");

        TestOnlyPort mismatch = new TestOnlyPort();
        mismatch.behavior = r -> new ProcessingJob("job-x", r.requestId(), r.tenantId(), r.principalId(), "other-artifact",
                r.jobType(), "p", JobStatus.COMPLETED, Instant.now(), null, null, Map.of("text", "t"), "", 1,
                r.expectedArtifactVersion(), "");
        MediaToolJobBridge bridge2 = new MediaToolJobBridge(mismatch, "dev");
        var factory2 = new AudioVideoToolHandlerFactory(binder(new TestLedger(), bridge2), bridge2);
        assertThatThrownBy(() -> run(factory2, c, envelope(c, c.input()), principal()))
                .isInstanceOf(MediaToolExecutionBinder.OutcomeUnknownException.class);
    }

    @Test
    void productionLikeAndUnknownProfilesFailClosedWithoutSubmission() {
        for (String profile : List.of("prod", "production", "staging", "sovereign", "integration", "e2e", "bogus", "")) {
            for (Case c : cases()) {
                TestOnlyPort port = new TestOnlyPort();
                port.behavior = r -> job(r, JobStatus.COMPLETED, Map.of("text", "t"), "");
                MediaToolJobBridge bridge = new MediaToolJobBridge(port, profile);
                var factory = new AudioVideoToolHandlerFactory(binder(new TestLedger(), bridge), bridge);

                ToolExecutionResult result = run(factory, c, envelope(c, c.input()), principal());

                assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
                assertThat(result.failure().code()).isEqualTo(MediaToolJobBridge.IDENTITY_CONTRACT_UNAVAILABLE);
                assertThat(result.failure().stage()).isEqualTo(ToolExecutionFailure.Stage.ADMISSION);
                assertThat(port.submitted).isEmpty();
            }
        }
    }

    @Test
    void productionLikeProfilesAdmitOnlyAnOidcVerifiedInvokingPrincipalAndCarryItUnchanged() {
        var verified = new AuthenticatedPrincipal(TENANT, "oidc:0123456789abcdef01234567:subject-1", Instant.now(),
                com.ghatana.media.runtime.MediaVerifiedIdentityContracts.AssuranceSource.OIDC_VERIFIED);
        for (String profile : List.of("prod", "production", "staging", "sovereign")) {
            Case c = cases().get(0);
            TestOnlyPort port = new TestOnlyPort();
            port.behavior = r -> job(r, JobStatus.COMPLETED, Map.of("text", "t"), "");
            MediaToolJobBridge bridge = new MediaToolJobBridge(port, profile);
            // The host maps the verified invoking principal to the envelope's agent: here, same tenant and verified.
            var factory = new AudioVideoToolHandlerFactory(new MediaToolExecutionBinder(new TestLedger(),
                    bridge.readback(), (p, id) -> p.idpVerified() && p.tenantId().equals(id.tenantId())), bridge);

            ToolExecutionResult result = run(factory, c, envelope(c, c.input()), verified);

            assertThat(result.status()).isEqualTo(ToolExecutionStatus.SUCCESS);
            assertThat(port.principals).containsExactly(verified);
            assertThat(port.submitted).singleElement().satisfies(request -> {
                assertThat(request.principalId()).isEqualTo(verified.principalId());
                assertThat(request.tenantId()).isEqualTo(TENANT);
            });
        }
        // Every non-IdP assurance, including an unstated one, stays unavailable in production-like profiles.
        for (var assurance : com.ghatana.media.runtime.MediaVerifiedIdentityContracts.AssuranceSource.values()) {
            if (assurance.idpVerified()) continue;
            Case c = cases().get(0);
            TestOnlyPort port = new TestOnlyPort();
            MediaToolJobBridge bridge = new MediaToolJobBridge(port, "production");
            var factory = new AudioVideoToolHandlerFactory(binder(new TestLedger(), bridge), bridge);
            ToolExecutionResult result = run(factory, c, envelope(c, c.input()),
                    new AuthenticatedPrincipal(TENANT, AGENT, Instant.now(), assurance));
            assertThat(result.failure().code()).isEqualTo(MediaToolJobBridge.IDENTITY_CONTRACT_UNAVAILABLE);
            assertThat(port.submitted).isEmpty();
        }
        // An unknown profile never admits, even with a verified identity.
        TestOnlyPort port = new TestOnlyPort();
        MediaToolJobBridge bridge = new MediaToolJobBridge(port, "bogus");
        var factory = new AudioVideoToolHandlerFactory(new MediaToolExecutionBinder(new TestLedger(),
                bridge.readback(), (p, id) -> p.idpVerified() && p.tenantId().equals(id.tenantId())), bridge);
        Case c = cases().get(0);
        assertThat(run(factory, c, envelope(c, c.input()), verified).failure().code())
                .isEqualTo(MediaToolJobBridge.IDENTITY_CONTRACT_UNAVAILABLE);
        assertThat(port.submitted).isEmpty();
    }

    @Test
    void handlersWithoutABridgeRemainTypedNotAdmitted() {
        Case c = cases().get(1);
        ToolExecutionEnvelope e = envelope(c, c.input());
        ToolExecutionResult result = runPromise(() -> new TextToSpeechToolHandler().handle(e, contract(e)));
        assertThat(result.failure().code()).isEqualTo("TTS_NOT_ADMITTED");
    }

    private static final MediaToolJobBridge.SpeechProfilePin PIN = new MediaToolJobBridge.SpeechProfilePin(
            "whisper-large-v3-turbo-cpp-local", "rev-1", "sha256:" + "b".repeat(64));

    @Test
    void serverOwnedSpeechProfilePinAndLanguageIntentAreAddedOnlyToSpeechToTextJobs() {
        for (Case c : cases()) {
            TestOnlyPort port = new TestOnlyPort();
            port.behavior = r -> job(r, JobStatus.COMPLETED, Map.of("text", "t"), "");
            MediaToolJobBridge bridge = new MediaToolJobBridge(port, "test", PIN, java.time.Duration.ZERO);
            var factory = new AudioVideoToolHandlerFactory(binder(new TestLedger(), bridge), bridge);
            run(factory, c, envelope(c, c.input()), principal());
            Map<String, Object> params = port.submitted.get(0).parameters();
            if (c.jobType() == JobType.SPEECH_TO_TEXT) {
                assertThat(params).containsEntry("profileId", PIN.profileId())
                        .containsEntry("profileVersion", PIN.profileVersion())
                        .containsEntry("profileConfigurationDigest", PIN.configurationDigest())
                        .containsEntry("languageIntent", Map.of("mode", "EXPLICIT", "languageTag", "en"));
            } else {
                assertThat(params).doesNotContainKeys("profileId", "profileVersion", "languageIntent");
            }
        }
        assertThatThrownBy(() -> new MediaToolJobBridge.SpeechProfilePin("p", "v", "not-a-digest"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void boundedAwaitReturnsTheObservedTerminalJobNotTheAcceptedSnapshot() {
        Case c = cases().get(0);
        TestOnlyPort port = new TestOnlyPort();
        port.behavior = r -> job(r, JobStatus.ACCEPTED, Map.of(), "");
        java.util.concurrent.atomic.AtomicInteger polls = new java.util.concurrent.atomic.AtomicInteger();
        MediaJobSubmissionPort waiting = new MediaJobSubmissionPort() {
            @Override public ProcessingJob submit(ProcessingJobRequest request, AuthenticatedPrincipal authenticated) {
                return port.submit(request, authenticated);
            }
            @Override public Optional<ProcessingJob> findByRequestId(String tenantId, String requestId) {
                ProcessingJobRequest r = port.submitted.get(0);
                return Optional.of(job(r, polls.incrementAndGet() < 3 ? JobStatus.RUNNING : JobStatus.COMPLETED,
                        Map.of("text", "observed transcript"), ""));
            }
        };
        MediaToolJobBridge bridge = new MediaToolJobBridge(waiting, "test", null, java.time.Duration.ofSeconds(10));
        var factory = new AudioVideoToolHandlerFactory(binder(new TestLedger(), bridge), bridge);

        ToolExecutionResult result = run(factory, c, envelope(c, c.input()), principal());

        assertThat(result.status()).isEqualTo(ToolExecutionStatus.SUCCESS);
        @SuppressWarnings("unchecked") Map<String, Object> out = (Map<String, Object>) result.output();
        assertThat(out).containsEntry("status", "COMPLETED");
        assertThat(out.get("result")).isEqualTo(Map.of("text", "observed transcript"));
        assertThat(polls.get()).isGreaterThanOrEqualTo(3);
    }

    @Test
    void awaitDeadlineLeavesARunningJobOutcomeUnknownNeverSuccess() {
        Case c = cases().get(0);
        TestOnlyPort port = new TestOnlyPort();
        port.behavior = r -> job(r, JobStatus.ACCEPTED, Map.of(), "");
        MediaJobSubmissionPort waiting = new MediaJobSubmissionPort() {
            @Override public ProcessingJob submit(ProcessingJobRequest request, AuthenticatedPrincipal authenticated) {
                return port.submit(request, authenticated);
            }
            @Override public Optional<ProcessingJob> findByRequestId(String tenantId, String requestId) {
                return Optional.of(job(port.submitted.get(0), JobStatus.RUNNING, Map.of(), ""));
            }
        };
        MediaToolJobBridge bridge = new MediaToolJobBridge(waiting, "test", null, java.time.Duration.ofMillis(500));
        var factory = new AudioVideoToolHandlerFactory(binder(new TestLedger(), bridge), bridge);

        ToolExecutionResult result = run(factory, c, envelope(c, c.input()), principal());

        assertThat(result.status()).isEqualTo(ToolExecutionStatus.OUTCOME_UNKNOWN);
        assertThat(result.sideEffectSummary()).containsEntry("reasonCode", "MEDIA_JOB_RUNNING");
    }

    @Test
    void serverOwnedGovernanceContextIsAppliedPerJobTypeAndOthersKeepTheConservativeDefault() {
        var stt = new com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext("", "transcription",
                com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification.CONFIDENTIAL, "local",
                Set.of("local"), false, "short-lived-media", false, false, "",
                com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity.NONE,
                com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk.ASSISTIVE);
        for (Case c : cases()) {
            TestOnlyPort port = new TestOnlyPort();
            port.behavior = r -> job(r, JobStatus.COMPLETED, Map.of("text", "t"), "");
            MediaToolJobBridge bridge = new MediaToolJobBridge(port, "test", PIN, java.time.Duration.ZERO,
                    Map.of(JobType.SPEECH_TO_TEXT, stt));
            var factory = new AudioVideoToolHandlerFactory(binder(new TestLedger(), bridge), bridge);
            run(factory, c, envelope(c, c.input()), principal());
            var governance = port.submitted.get(0).governanceContext();
            if (c.jobType() == JobType.SPEECH_TO_TEXT) {
                assertThat(governance).isEqualTo(stt);
            } else {
                assertThat(governance.purpose()).isEqualTo("unspecified");
            }
        }
    }
}
