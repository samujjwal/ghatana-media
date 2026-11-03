package com.ghatana.stt.provider;

import com.ghatana.media.runtime.MediaRuntimeContracts;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext;
import com.ghatana.media.runtime.WhisperComputeClient;
import com.ghatana.media.runtime.MediaRuntimeContracts.Cancellation;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.WhisperComputeContracts;
import com.ghatana.media.runtime.WhisperComputeContracts.Request;
import com.ghatana.media.runtime.WhisperComputeContracts.Result;
import com.ghatana.media.runtime.WhisperComputeContracts.Status;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.Duration;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class WhisperBrokerSttProviderTest {
    private static final String MODEL = "a".repeat(64);
    private static final String CONFIG = "b".repeat(64);

    @Test
    void invocationAndReceiptAreDeterministicAndBindSourceAndLocale() {
        var provider = new WhisperBrokerSttProvider(null, null, "profile.en", "whisper-r1",
                MODEL, CONFIG, null);
        var request = request("en-GB");
        var artifact = artifact("c".repeat(64));
        var attempt = attempt();

        var first = provider.prepareAttemptIdentity(request, artifact, attempt).orElseThrow();
        var second = provider.prepareAttemptIdentity(request, artifact, attempt).orElseThrow();

        assertThat(first).isEqualTo(second);
        assertThat(first.providerOperationId()).isEqualTo(second.providerOperationId());
        assertThat(first.providerReceiptId()).isEqualTo(
                "whisper-broker-v1:profile.en:en-GB:" + artifact.sha256());
    }

    @Test
    void exactStatusCanObservePersistedInvocationButNeverExecutesAgain() throws Exception {
        AtomicReference<UUID> observedId = new AtomicReference<>();
        AtomicReference<String> observedDigest = new AtomicReference<>();
        var provider = new WhisperBrokerSttProvider(null, null, "profile.en", "whisper-r1",
                MODEL, CONFIG, new WhisperComputeClient() {
                    @Override public Result execute(Request request) {
                        throw new AssertionError("status reconciliation must not execute");
                    }
                    @Override public Result status(UUID id, String profile, String locale, String digest) {
                        observedId.set(id);
                        observedDigest.set(digest);
                        return new Result(id, profile, digest, MODEL, "hello", Status.SUCCESS,
                                true, true, false);
                    }
                    @Override public Result cancel(UUID id, String profile, String locale, String digest) {
                        return new Result(id, profile, digest, null, "", Status.UNKNOWN_OUTCOME,
                                false, false, false);
                    }
                });
        String source = "c".repeat(64);
        UUID invocation = UUID.randomUUID();
        String receipt = "whisper-broker-v1:profile.en:en-GB:" + source;
        var query = new MediaRuntimeContracts.ProviderAttemptQuery("tenant", "job", "request", 1, 7,
                "d".repeat(64), provider.providerId(), invocation.toString(), receipt);

        var observation = provider.reconcileAttempt(query).join();

        assertThat(observedId.get()).isEqualTo(invocation);
        assertThat(observedDigest.get()).isEqualTo(source);
        assertThat(observation.finality()).isEqualTo(AttemptFinality.SUCCEEDED);
        assertThat(observation.result()).containsKey("semanticObservations");
    }

    @Test
    void reconciliationWithForeignProviderIdentityStaysUnknownWithoutStatusLookup() {
        AtomicReference<Integer> statusCalls = new AtomicReference<>(0);
        var provider = new WhisperBrokerSttProvider(null, null, "profile.en", "whisper-r1",
                MODEL, CONFIG, new WhisperComputeClient() {
                    @Override public Result execute(Request request) {
                        throw new AssertionError("reconciliation must not execute");
                    }
                    @Override public Result status(UUID id, String profile, String locale, String digest) {
                        statusCalls.updateAndGet(calls -> calls + 1);
                        return new Result(id, profile, digest, MODEL, "foreign receipt result", Status.SUCCESS,
                                true, true, false);
                    }
                    @Override public Result cancel(UUID id, String profile, String locale, String digest) {
                        throw new AssertionError("reconciliation must not cancel");
                    }
                });
        String source = "c".repeat(64);
        var query = new MediaRuntimeContracts.ProviderAttemptQuery("tenant", "job", "request", 1, 7,
                "d".repeat(64), "different-provider", UUID.randomUUID().toString(),
                "whisper-broker-v1:profile.en:en-GB:" + source);

        var observation = provider.reconcileAttempt(query).join();

        assertThat(observation.query()).isEqualTo(query);
        assertThat(observation.finality()).isEqualTo(AttemptFinality.UNKNOWN);
        assertThat(observation.result()).isEmpty();
        assertThat(statusCalls.get()).isZero();
        provider.close();
    }

    @Test
    void blockingStatusReconciliationReturnsPromptlyAndCancellationCannotPromoteSuccess() throws Exception {
        CountDownLatch statusEntered = new CountDownLatch(1);
        CountDownLatch releaseStatus = new CountDownLatch(1);
        UUID invocation = UUID.randomUUID();
        String source = "c".repeat(64);
        var provider = new WhisperBrokerSttProvider(null, null, "profile.en", "whisper-r1",
                MODEL, CONFIG, new WhisperComputeClient() {
                    @Override public Result execute(Request request) { throw new AssertionError("must not replay"); }
                    @Override public Result status(UUID id, String profile, String locale, String digest) {
                        statusEntered.countDown();
                        boolean released = false;
                        while (!released) {
                            try { released = releaseStatus.await(2, TimeUnit.SECONDS); }
                            catch (InterruptedException ignored) { /* model a transport ignoring cancel */ }
                        }
                        return new Result(id, profile, digest, MODEL, "late", Status.SUCCESS,
                                true, true, false);
                    }
                    @Override public Result cancel(UUID id, String profile, String locale, String digest) {
                        throw new AssertionError("status reconciliation must not cancel");
                    }
                });
        String receipt = "whisper-broker-v1:profile.en:en-GB:" + source;
        var query = new MediaRuntimeContracts.ProviderAttemptQuery("tenant", "job", "request", 1, 7,
                "d".repeat(64), provider.providerId(), invocation.toString(), receipt);

        long before = System.nanoTime();
        var future = provider.reconcileAttempt(query);
        assertThat(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - before)).isLessThan(100);
        assertThat(future.isDone()).isFalse();
        assertThat(statusEntered.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(future.cancel(true)).isTrue();
        releaseStatus.countDown();
        assertThat(future.isCancelled()).isTrue();
        provider.close();
    }

    @Test
    void absentServerPinnedProfileKeepsProviderUnavailableAndUnqualified() {
        var provider = new WhisperBrokerSttProvider(Map.of());
        assertThat(provider.ready()).isFalse();
        assertThat(provider.productionEligible()).isFalse();
        assertThat(provider.speechToTextProfile()).isEmpty();
    }

    @Test
    void statusUnknownIsNeverPromotedToSuccess() {
        var provider = new WhisperBrokerSttProvider(null, null, "profile.en", "whisper-r1",
                MODEL, CONFIG, new WhisperComputeClient() {
                    @Override public Result execute(Request request) { throw new AssertionError(); }
                    @Override public Result status(UUID id, String profile, String locale, String digest) {
                        return new Result(id, profile, digest, null, "", Status.UNKNOWN_OUTCOME,
                                false, false, false);
                    }
                    @Override public Result cancel(UUID id, String profile, String locale, String digest) {
                        return new Result(id, profile, digest, null, "", Status.UNKNOWN_OUTCOME,
                                false, false, false);
                    }
                });
        var query = new MediaRuntimeContracts.ProviderAttemptQuery("tenant", "job", "request", 1, 7,
                "d".repeat(64), provider.providerId(), UUID.randomUUID().toString(),
                "whisper-broker-v1:profile.en:en:" + "c".repeat(64));
        assertThat(provider.reconcileAttempt(query).join().finality()).isEqualTo(AttemptFinality.UNKNOWN);
    }

    @Test
    void onlyAuthenticatedNotAdmittedDispositionProvesPreDispatchNoEffect() {
        UUID id = UUID.randomUUID();
        var rejected = new Result(id, "profile.en", "c".repeat(64), null, "",
                Status.NOT_ADMITTED, false, false, false);

        assertThat(WhisperBrokerSttProvider.notDispatched(
                rejected, id, "profile.en", "c".repeat(64))).isTrue();
        assertThat(WhisperBrokerSttProvider.notDispatched(
                rejected, UUID.randomUUID(), "profile.en", "c".repeat(64))).isFalse();

        var deadline = new Result(id, "profile.en", "c".repeat(64), null, "",
                Status.DEADLINE_EXCEEDED, false, false, false);
        assertThat(WhisperBrokerSttProvider.notDispatched(
                deadline, id, "profile.en", "c".repeat(64))).isFalse();
        assertThat(WhisperBrokerSttProvider.notDispatched(
                deadline, UUID.randomUUID(), "profile.en", "c".repeat(64))).isFalse();
    }

    @Test
    void expiredAtEntryReturnsNoEffectWithoutCallingBroker() {
        AtomicReference<Integer> calls = new AtomicReference<>(0);
        var provider = new WhisperBrokerSttProvider("profile.en", "whisper-r1", MODEL, CONFIG,
                new WhisperComputeClient() {
                    @Override public Result execute(Request request) { calls.updateAndGet(v -> v + 1); throw new AssertionError(); }
                    @Override public Result status(UUID id, String profile, String locale, String digest) { throw new AssertionError(); }
                    @Override public Result cancel(UUID id, String profile, String locale, String digest) { throw new AssertionError(); }
                });
        var artifact = artifact("c".repeat(64));
        var context = new ProcessingContext(request("en"), artifact, new Cancellation(), null,
                null, null, null, Instant.now().minusSeconds(1));
        var prepared = new ProviderAttemptContext("tenant", "job", "request", 1, 7, "d".repeat(64),
                UUID.randomUUID().toString(), "receipt");

        var result = provider.processAttempt(context, prepared).join();

        assertThat(result.finality()).isEqualTo(AttemptFinality.NO_EFFECT_PROVEN);
        assertThat(calls.get()).isZero();
        provider.close();
    }

    @Test
    void deadlineCancellationAckDoesNotProveNoEffectAndRequiresExactIdentity() {
        UUID id = UUID.randomUUID();
        var deadlineAck = new Result(id, "profile.en", "c".repeat(64), null, "",
                Status.DEADLINE_EXCEEDED, false, false, false);
        var ambiguous = new Result(id, "profile.en", "c".repeat(64), null, "",
                Status.UNKNOWN_OUTCOME, false, false, false);
        var wrongInvocation = new Result(UUID.randomUUID(), "profile.en", "c".repeat(64), null, "",
                Status.DEADLINE_EXCEEDED, false, false, false);
        var wrongProfile = new Result(id, "profile.other", "c".repeat(64), null, "",
                Status.DEADLINE_EXCEEDED, false, false, false);
        var wrongDigest = new Result(id, "profile.en", "e".repeat(64), null, "",
                Status.DEADLINE_EXCEEDED, false, false, false);

        assertThat(WhisperBrokerSttProvider.confirmedStop(
                deadlineAck, id, "profile.en", "en", "c".repeat(64))).isFalse();
        assertThat(WhisperBrokerSttProvider.confirmedStop(
                ambiguous, id, "profile.en", "en", "c".repeat(64))).isFalse();
        assertThat(WhisperBrokerSttProvider.confirmedStop(
                wrongInvocation, id, "profile.en", "en", "c".repeat(64))).isFalse();
        assertThat(WhisperBrokerSttProvider.confirmedStop(
                wrongProfile, id, "profile.en", "en", "c".repeat(64))).isFalse();
        assertThat(WhisperBrokerSttProvider.confirmedStop(
                wrongDigest, id, "profile.en", "en", "c".repeat(64))).isFalse();
    }

    @Test
    void cancellationWithLateExecuteSuccessAndDeadlineAckRemainsUnknown() throws Exception {
        byte[] wav = tinyWav();
        String digest = sha256(wav);
        CountDownLatch dispatched = new CountDownLatch(1);
        CountDownLatch releaseExecute = new CountDownLatch(1);
        CountDownLatch cancelFinished = new CountDownLatch(1);
        AtomicReference<MediaRuntimeContracts.ProcessingContext.MonotonicDeadline> receivedDeadline =
                new AtomicReference<>();
        var client = new WhisperComputeClient() {
            @Override public Result execute(Request request) {
                dispatched.countDown();
                try { releaseExecute.await(3, TimeUnit.SECONDS); }
                catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
                return new Result(request.invocationId(), request.profileId(), request.sourceSha256(),
                        MODEL, "late transcript", Status.SUCCESS, true, true, false);
            }
            @Override public Result execute(Request request,
                    MediaRuntimeContracts.ProcessingContext.MonotonicDeadline deadline) throws java.io.IOException {
                receivedDeadline.set(deadline);
                return execute(request);
            }
            @Override public Result status(UUID id, String profile, String locale, String sourceSha256) {
                throw new AssertionError("cancellation must not use status as finality");
            }
            @Override public Result cancel(UUID id, String profile, String locale, String sourceSha256) {
                try {
                    return new Result(id, profile, sourceSha256, null, "", Status.DEADLINE_EXCEEDED,
                            false, false, false);
                } finally { cancelFinished.countDown(); }
            }
        };
        var provider = new WhisperBrokerSttProvider("profile.en", "whisper-r1", MODEL, CONFIG, client);
        var artifact = new MediaArtifact("tenant", "principal", "artifact", "source.wav", "audio/wav",
                wav.length, digest, "object://source", "INTERNAL", Instant.now(),
                Instant.now().plusSeconds(60), Map.of());
        var request = new ProcessingJobRequest("request", "tenant", "principal", "correlation",
                "artifact", artifact.version().value(), JobType.SPEECH_TO_TEXT,
                provider.providerId(), Map.of("languageIntent", Map.of("languageTag", "en")));
        var auth = new MediaSourceAuthorizationContracts.Evidence("rights", "decision", "tenant",
                "principal", "owner", "artifact", artifact.version(), digest, "speech_to_text", "transcription",
                provider.providerId(), provider.providerVersion(), ProcessingBoundary.LOCAL, "local",
                ProviderDataRetention.NONE, java.util.Set.of("speech_to_text"), java.util.Set.of("local"),
                java.util.Set.of(ProviderDataRetention.NONE), "rights-1", "policy-1", "policy-v1",
                MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                "", "source-clock-1", 0, Instant.now(), Instant.now().plusSeconds(30));
        var cancellation = new Cancellation();
        ProcessingContext context = new ProcessingContext(request, artifact, cancellation, null,
                (target, maxBytes) -> {
                    target.write(wav);
                    return new MediaRuntimeContracts.ArtifactContentReadReceipt(artifact.version(), digest, wav.length);
                }, auth, null, Instant.now().plusSeconds(2));
        var prepared = provider.prepareAttemptIdentity(request, artifact, attempt()).orElseThrow();
        var attempt = new ProviderAttemptContext("tenant", "job", "request", 1, 7, "d".repeat(64),
                prepared.providerOperationId(), prepared.providerReceiptId());

        var result = provider.processAttempt(context, attempt);
        assertThat(dispatched.await(2, TimeUnit.SECONDS)).isTrue();
        cancellation.cancel();
        assertThat(cancelFinished.await(2, TimeUnit.SECONDS)).isTrue();
        releaseExecute.countDown();

        assertThat(result.get(3, TimeUnit.SECONDS).finality()).isEqualTo(AttemptFinality.UNKNOWN);
        assertThat(receivedDeadline.get()).isSameAs(context.deadlineBudget());
        provider.close();
    }

    @Test
    void cancellationCallsBrokerAndKeepsUnknownWhenStopIsNotConfirmed() throws Exception {
        byte[] wav = tinyWav();
        String digest = sha256(wav);
        CountDownLatch dispatched = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch cancelStarted = new CountDownLatch(1);
        CountDownLatch releaseCancel = new CountDownLatch(1);
        CountDownLatch cancelFinished = new CountDownLatch(1);
        AtomicReference<String> cancelDigest = new AtomicReference<>();
        var client = new WhisperComputeClient() {
            @Override public Result execute(Request request) {
                dispatched.countDown();
                try { release.await(3, TimeUnit.SECONDS); }
                catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
                return new Result(request.invocationId(), request.profileId(), request.sourceSha256(),
                        MODEL, "", Status.UNKNOWN_OUTCOME, false, false, false);
            }
            @Override public Result status(UUID id, String profile, String locale, String sourceSha256) {
                throw new AssertionError("cancellation is not status finality");
            }
            @Override public Result cancel(UUID id, String profile, String locale, String sourceSha256) {
                cancelDigest.set(sourceSha256);
                cancelStarted.countDown();
                try { releaseCancel.await(3, TimeUnit.SECONDS); }
                catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
                finally { cancelFinished.countDown(); }
                return new Result(UUID.randomUUID(), profile, sourceSha256, null, "", Status.DEADLINE_EXCEEDED,
                        false, false, false);
            }
        };
        var provider = new WhisperBrokerSttProvider("profile.en", "whisper-r1", MODEL, CONFIG, client);
        var artifact = new MediaArtifact("tenant", "principal", "artifact", "source.wav", "audio/wav",
                wav.length, digest, "object://source", "INTERNAL", Instant.now(),
                Instant.now().plusSeconds(60), Map.of());
        var request = new ProcessingJobRequest("request", "tenant", "principal", "correlation",
                "artifact", artifact.version().value(), JobType.SPEECH_TO_TEXT,
                provider.providerId(), Map.of("languageIntent", Map.of("languageTag", "en")));
        var auth = new MediaSourceAuthorizationContracts.Evidence("rights", "decision", "tenant",
                "principal", "owner", "artifact", artifact.version(), digest, "speech_to_text", "transcription",
                provider.providerId(), provider.providerVersion(), ProcessingBoundary.LOCAL, "local",
                ProviderDataRetention.NONE, java.util.Set.of("speech_to_text"), java.util.Set.of("local"),
                java.util.Set.of(ProviderDataRetention.NONE), "rights-1", "policy-1", "policy-v1",
                MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                "", "source-clock-1", 0, Instant.now(), Instant.now().plusSeconds(30));
        var cancellation = new Cancellation();
        ProcessingContext context = new ProcessingContext(request, artifact, cancellation, null,
                (target, maxBytes) -> {
                    target.write(wav);
                    return new MediaRuntimeContracts.ArtifactContentReadReceipt(artifact.version(), digest, wav.length);
                }, auth, null, Instant.now().plusSeconds(2));
        var prepared = provider.prepareAttemptIdentity(request, artifact, attempt()).orElseThrow();
        var attempt = new ProviderAttemptContext("tenant", "job", "request", 1, 7, "d".repeat(64),
                prepared.providerOperationId(), prepared.providerReceiptId());

        var result = provider.processAttempt(context, attempt);
        assertThat(dispatched.await(2, TimeUnit.SECONDS)).isTrue();
        long beforeCancel = System.nanoTime();
        cancellation.cancel();
        long cancelCallMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - beforeCancel);
        assertThat(cancelCallMillis).isLessThan(500);
        assertThat(cancelStarted.await(2, TimeUnit.SECONDS)).isTrue();
        release.countDown();

        assertThat(result.get(3, TimeUnit.SECONDS).finality()).isEqualTo(AttemptFinality.UNKNOWN);
        assertThat(cancelDigest.get()).isEqualTo(digest);
        releaseCancel.countDown();
        assertThat(cancelFinished.await(2, TimeUnit.SECONDS)).isTrue();
        // A late, authenticated stop acknowledgement cannot mutate the already-returned UNKNOWN.
        assertThat(result.join().finality()).isEqualTo(AttemptFinality.UNKNOWN);
        provider.close();
    }

    private static ProcessingJobRequest request(String locale) {
        return new ProcessingJobRequest("request", "tenant", "principal", "correlation", "artifact",
                "sha256:" + "c".repeat(64), JobType.SPEECH_TO_TEXT, "whisper-host-broker",
                Map.of("languageIntent", Map.of("languageTag", locale)));
    }

    private static MediaArtifact artifact(String digest) {
        return new MediaArtifact("tenant", "principal", "artifact", "source.wav", "audio/wav", 44,
                digest, "object://source", "INTERNAL", Instant.now(), Instant.now().plusSeconds(60), Map.of());
    }

    private static ProviderAttemptContext attempt() {
        return new ProviderAttemptContext("tenant", "job", "request", 1, 7, "d".repeat(64));
    }

    private static byte[] tinyWav() {
        ByteBuffer data = ByteBuffer.allocate(46).order(ByteOrder.LITTLE_ENDIAN);
        data.put("RIFF".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt(38);
        data.put("WAVEfmt ".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        data.putInt(16).putShort((short) 1).putShort((short) 1).putInt(16_000).putInt(32_000)
                .putShort((short) 2).putShort((short) 16);
        data.put("data".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt(2).putShort((short) 0);
        return data.array();
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}
