package com.ghatana.stt.provider;

import org.junit.jupiter.api.Test;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.stt.api.TranscriptionOptions;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.media.stt.engine.onnx.WhisperOnnxEngine;
import com.ghatana.stt.service.SttAudioInputDecoder;
import com.ghatana.media.common.EngineStatus;
import com.ghatana.media.config.SttConfig;
import com.ghatana.media.runtime.MediaModalityContracts;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactContentReadReceipt;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.Cancellation;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifactContentReader;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptQuery;
import com.ghatana.media.runtime.WhisperComputeClient;
import com.ghatana.media.runtime.WhisperComputeContracts.Result;
import com.ghatana.media.runtime.WhisperComputeContracts.Status;

import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.Optional;
import java.util.Map;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.CancellationException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;

/**
 * Source-tick emission coverage for the Whisper provider result path. The pinned
 * profile supplies no qualified word timings; the provider declares the measured
 * decoded span on the artifact's exact source clock or honestly declares nothing.
 */
class WhisperOnnxSttProviderTest {

    private static WhisperOnnxSttProvider.ProfileBinding binding(boolean productionEligible) {
        return new WhisperOnnxSttProvider.ProfileBinding(
                "whisper-provider", "whisper-v1", "whisper-profile", "v1",
                "sha256:" + "a".repeat(64), Set.of("en-US"), "", "local", productionEligible);
    }

    @Test
    void observedModelProfileReflectsRealEngineStateWithoutClaimingWordTimingOrQualification() {
        Instant checkedAt = Instant.now().minusSeconds(5);
        var ready = WhisperOnnxSttProvider.observedCapabilityProfile(
                binding(false), "WHISPER-TINY", EngineStatus.State.READY, checkedAt);
        assertThat(ready.modelVersions()).containsExactly("whisper-tiny");
        assertThat(ready.codecs()).containsExactly("pcm_s16le");
        assertThat(ready.containers()).containsExactly("wav");
        assertThat(ready.sampleRatesHz()).containsExactly(16_000);
        assertThat(ready.timingAvailable()).isFalse();
        assertThat(ready.confidenceAvailable()).isFalse();
        assertThat(ready.biometricDerivativesAvailable()).isFalse();
        assertThat(ready.health().status())
                .isEqualTo(MediaModalityContracts.ProviderHealthStatus.HEALTHY);
        assertThat(ready.degradationPolicy())
                .isEqualTo(MediaModalityContracts.DegradationPolicy.LOCAL_DIAGNOSTIC_ONLY);

        var stopped = WhisperOnnxSttProvider.observedCapabilityProfile(
                binding(true), "WHISPER-TINY", EngineStatus.State.ERROR, checkedAt);
        assertThat(stopped.health().status())
                .isEqualTo(MediaModalityContracts.ProviderHealthStatus.UNAVAILABLE);
        assertThat(stopped.degradationPolicy())
                .isEqualTo(MediaModalityContracts.DegradationPolicy.FAIL_CLOSED);
        assertThatThrownBy(() -> WhisperOnnxSttProvider.observedCapabilityProfile(
                binding(false), "invalid/engine-path", EngineStatus.State.READY, checkedAt))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void speechProfileWithoutQualificationEvidenceRemainsExplicitlyUnqualified() {
        WhisperComputeClient unusedClient = new WhisperComputeClient() {
            @Override public Result execute(com.ghatana.media.runtime.WhisperComputeContracts.Request request) {
                throw new AssertionError("profile inspection must not execute inference");
            }
            @Override public Result status(java.util.UUID id, String profile, String locale, String digest) {
                throw new AssertionError("profile inspection must not query worker status");
            }
            @Override public Result cancel(java.util.UUID id, String profile, String locale, String digest) {
                throw new AssertionError("profile inspection must not cancel a worker");
            }
        };
        WhisperOnnxSttProvider provider = new WhisperOnnxSttProvider(
                SttConfig.builder().modelId("whisper-model").build(), binding(false), 1024,
                (providerId, providerVersion, modelRevision) -> Optional.empty(), unusedClient,
                "b".repeat(64));

        try {
            MediaSpeechToTextAdmission.Profile profile = provider.speechToTextProfile().orElseThrow();

            assertThat(profile.qualification())
                    .isEqualTo(MediaSpeechToTextAdmission.ProfileQualification.NOT_QUALIFIED);
            assertThat(profile.qualificationEvidenceRef()).isEmpty();
            assertThat(profile.timingDisposition())
                    .isEqualTo(MediaSpeechToTextAdmission.TimingDisposition.SOURCE_CLOCK_BOUND);
        } finally {
            provider.close();
        }
    }

    @Test
    void wrappedBrokerReconciliationUsesDurableWrapperIdentityAndRejectsForeignIdentity() {
        AtomicInteger statusCalls = new AtomicInteger();
        String sourceDigest = "c".repeat(64);
        var provider = new WhisperOnnxSttProvider(
                SttConfig.builder().modelId("whisper-model").build(), binding(false), 1024,
                (providerId, providerVersion, modelRevision) -> Optional.empty(),
                new WhisperComputeClient() {
                    @Override public Result execute(com.ghatana.media.runtime.WhisperComputeContracts.Request request) {
                        throw new AssertionError("reconciliation must not execute inference");
                    }
                    @Override public Result status(java.util.UUID id, String profile, String locale, String digest) {
                        statusCalls.incrementAndGet();
                        return new Result(id, profile, digest, "b".repeat(64), "fixture result", Status.SUCCESS,
                                true, true, false);
                    }
                    @Override public Result cancel(java.util.UUID id, String profile, String locale, String digest) {
                        throw new AssertionError("reconciliation must not cancel");
                    }
                }, "b".repeat(64));
        String receipt = "whisper-broker-v1:whisper-profile:en-US:" + sourceDigest;
        String invocation = java.util.UUID.randomUUID().toString();
        var matching = new ProviderAttemptQuery("tenant", "job", "request", 1, 7,
                "d".repeat(64), "whisper-provider", invocation, receipt);
        var foreign = new ProviderAttemptQuery("tenant", "job", "request", 1, 7,
                "d".repeat(64), "another-provider", invocation, receipt);

        var matchingObservation = provider.reconcileAttempt(matching).join();
        var foreignObservation = provider.reconcileAttempt(foreign).join();

        assertThat(matchingObservation.finality())
                .isEqualTo(com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality.SUCCEEDED);
        assertThat(matchingObservation.query()).isEqualTo(matching);
        assertThat(foreignObservation.finality())
                .isEqualTo(com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality.UNKNOWN);
        assertThat(foreignObservation.result()).isEmpty();
        assertThat(statusCalls.get()).isEqualTo(1);
        provider.close();
    }

    @Test
    void measuredQualityIsReadOnlyAndMustMatchTheExactSourceOwnedProviderAndModel() {
        var at = Instant.now().minusSeconds(12);
        var measured = new MediaModalityContracts.ProviderQualityObservation(
                "whisper-provider", "whisper-v1", JobType.SPEECH_TO_TEXT, "whisper-tiny",
                MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                1.0938, at, "a".repeat(64));
        assertThat(WhisperOnnxSttProvider.matchingQualityObservation(
                binding(false), "whisper-tiny", Optional.of(measured)))
                .contains(measured);
        assertThat(WhisperOnnxSttProvider.matchingQualityObservation(
                binding(false), "another-model", Optional.of(measured))).isEmpty();
        assertThat(WhisperOnnxSttProvider.matchingQualityObservation(
                binding(false), "whisper-tiny", Optional.empty())).isEmpty();
        assertThat(WhisperOnnxSttProvider.matchingQualityObservation(
                binding(false), "whisper-tiny", null)).isEmpty();
        var foreign = new MediaModalityContracts.ProviderQualityObservation(
                "other-provider", "whisper-v1", JobType.SPEECH_TO_TEXT, "whisper-tiny",
                MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                0.10, at, "b".repeat(64));
        assertThat(WhisperOnnxSttProvider.matchingQualityObservation(
                binding(false), "whisper-tiny", Optional.of(foreign))).isEmpty();
    }

    private static Map<String, Object> clockMetadata(long ticksPerSecond, long durationTicks) {
        return Map.of(
                "sourceClockId", "src-clock",
                "sourceClockMappingEvidenceRef", "mapping-evidence",
                "sourceClockTicksPerSecond", ticksPerSecond,
                "sourceDurationTicks", durationTicks);
    }

    private static byte[] pcmWav(int sampleRate, int channels, int pcmBytes) {
        byte[] wav = new byte[44 + pcmBytes];
        ByteBuffer header = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        header.put("RIFF".getBytes(StandardCharsets.US_ASCII));
        header.putInt(wav.length - 8);
        header.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII));
        header.putInt(16);
        header.putShort((short) 1);
        header.putShort((short) channels);
        header.putInt(sampleRate);
        header.putInt(sampleRate * channels * 2);
        header.putShort((short) (channels * 2));
        header.putShort((short) 16);
        header.put("data".getBytes(StandardCharsets.US_ASCII));
        header.putInt(pcmBytes);
        return wav;
    }

    @Test
    void providerWavDecoderUsesBoundedCanonicalPcmFraming() {
        var decoded = WhisperOnnxSttProvider.wavPcm16Mono16k(pcmWav(16_000, 1, 320));
        assertThat(decoded.format()).isEqualTo(AudioFormat.PCM);
        assertThat(decoded.sampleRate()).isEqualTo(16_000);
        assertThat(decoded.getSampleCount()).isEqualTo(160);

        byte[] truncated = pcmWav(16_000, 1, 320);
        truncated[4] = 0;
        truncated[5] = 0;
        truncated[6] = 0;
        truncated[7] = 0;
        assertThatThrownBy(() -> WhisperOnnxSttProvider.wavPcm16Mono16k(truncated))
                .isInstanceOf(SttAudioInputDecoder.InputException.class)
                .hasMessageContaining("STT_AUDIO_INVALID_WAV");
        assertThatThrownBy(() -> WhisperOnnxSttProvider.wavPcm16Mono16k(pcmWav(44_100, 1, 320)))
                .isInstanceOf(SttAudioInputDecoder.InputException.class)
                .hasMessageContaining("STT_AUDIO_SAMPLE_RATE_MISMATCH");
        assertThatThrownBy(() -> WhisperOnnxSttProvider.wavPcm16Mono16k(pcmWav(16_000, 2, 320)))
                .isInstanceOf(SttAudioInputDecoder.InputException.class)
                .hasMessageContaining("STT_AUDIO_CHANNEL_LAYOUT_NOT_ADMITTED");
    }

    @Test
    void providerWavDecoderRejectsInputOverTheBoundBeforeMaterialization() {
        byte[] overLimit = pcmWav(16_000, 1,
                Math.toIntExact(SttAudioInputDecoder.MAX_DECODED_PCM_BYTES + 2));
        assertThatThrownBy(() -> WhisperOnnxSttProvider.wavPcm16Mono16k(overLimit))
                .isInstanceOf(SttAudioInputDecoder.InputException.class)
                .hasMessageContaining("STT_AUDIO_TOO_LARGE");
    }

    @Test
    void sourceReaderCannotExceedPhysicalStagingCapacityEvenWhenItIgnoresTheLimit() throws Exception {
        byte[] source = "0123456789".getBytes(StandardCharsets.US_ASCII);
        ProcessingContext context = contextFor(source, (target, ignoredMax) -> {
            target.write(source);
            return receipt(source, source);
        });

        assertThatThrownBy(() -> WhisperOnnxSttProvider.readVerifiedSourceContent(context, 9))
                .isInstanceOf(java.io.IOException.class)
                .hasMessageContaining("STT_SOURCE_TOO_LARGE");
    }

    @Test
    void sourceStagingChecksCancellationWithinLargeReaderWrites() {
        byte[] source = new byte[192 * 1024];
        Cancellation cancellation = new Cancellation();
        ProcessingContext context = contextFor(source, (target, maxBytes) -> {
            target.write(source);
            return receipt(source, source);
        }, cancellation);
        AtomicInteger checks = new AtomicInteger();

        assertThatThrownBy(() -> WhisperOnnxSttProvider.readVerifiedSourceContent(
                context, source.length, () -> {
                    if (checks.incrementAndGet() == 3) cancellation.cancel();
                    cancellation.throwIfCancelled();
                }))
                .isInstanceOf(CancellationException.class);
        assertThat(checks).hasValue(3);
    }

    @Test
    void providerCancellationSignalForwardsRuntimeCancellationAndLateRegistration() throws Exception {
        byte[] source = "cancel-source".getBytes(StandardCharsets.US_ASCII);
        ProcessingContext context = contextFor(source, (target, maxBytes) -> {
            target.write(source);
            return receipt(source, source);
        });
        var signal = WhisperOnnxSttProvider.cancellationSignal(context);
        AtomicInteger callbacks = new AtomicInteger();
        AutoCloseable registration = signal.onCancel(callbacks::incrementAndGet);

        context.cancellation().cancel();
        registration.close();
        assertThat(signal.cancelled()).isTrue();
        assertThat(callbacks).hasValue(1);

        AtomicInteger lateCallback = new AtomicInteger();
        AutoCloseable late = signal.onCancel(lateCallback::incrementAndGet);
        late.close();
        assertThat(lateCallback).hasValue(1);
    }

    @Test
    void cancellationAfterInferenceCannotBecomeAProviderSuccess() {
        byte[] source = "post-inference-cancel".getBytes(StandardCharsets.US_ASCII);
        ProcessingContext context = contextFor(source, (target, maxBytes) -> {
            target.write(source);
            return receipt(source, source);
        });
        WhisperOnnxEngine engine = mock(WhisperOnnxEngine.class);
        doAnswer(invocation -> {
            context.cancellation().cancel();
            return mock(TranscriptionResult.class);
        }).when(engine).transcribe(any(AudioData.class), any(TranscriptionOptions.class),
                any(WhisperOnnxEngine.CancellationSignal.class));
        AudioData audio = new AudioData(new byte[320], 16_000, 1, 16,
                java.time.Duration.ofMillis(10), AudioFormat.PCM);

        assertThatThrownBy(() -> WhisperOnnxSttProvider.transcribeWithCancellationFence(
                engine, audio, TranscriptionOptions.defaults(), context))
                .isInstanceOf(CancellationException.class);
    }

    @Test
    void cancellationImmediatelyBeforeSubmissionCannotReturnSucceeded() {
        byte[] source = "pre-submit-cancel".getBytes(StandardCharsets.US_ASCII);
        ProcessingContext context = contextFor(source, (target, maxBytes) -> {
            target.write(source);
            return receipt(source, source);
        });
        context.cancellation().cancel();

        assertThatThrownBy(() -> WhisperOnnxSttProvider.ensureSubmissionNotCancelled(
                context, com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission.unknown()))
                .isInstanceOf(CancellationException.class);
    }

    @Test
    void cancellationListenerRegistrationRaceInvokesExactlyOnce() throws Exception {
        for (int iteration = 0; iteration < 100; iteration++) {
            Cancellation cancellation = new Cancellation();
            AtomicInteger callbacks = new AtomicInteger();
            AtomicReference<AutoCloseable> registration = new AtomicReference<>();
            CountDownLatch ready = new CountDownLatch(2);
            CountDownLatch start = new CountDownLatch(1);
            var register = java.util.concurrent.CompletableFuture.runAsync(() -> {
                ready.countDown();
                await(start);
                try {
                    registration.set(cancellation.onCancel(callbacks::incrementAndGet));
                } catch (Exception failure) {
                    throw new AssertionError(failure);
                }
            });
            var cancel = java.util.concurrent.CompletableFuture.runAsync(() -> {
                ready.countDown();
                await(start);
                cancellation.cancel();
            });
            ready.await();
            start.countDown();
            java.util.concurrent.CompletableFuture.allOf(register, cancel).join();
            registration.get().close();
            assertThat(callbacks).hasValue(1);
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError(interrupted);
        }
    }

    @Test
    void exactStagingLimitIsAcceptedOnlyWithMatchingReceiptAndArtifactVersion() throws Exception {
        byte[] source = "exact-cap".getBytes(StandardCharsets.US_ASCII);
        ProcessingContext context = contextFor(source, (target, maxBytes) -> {
            assertThat(maxBytes).isEqualTo(source.length);
            target.write(source);
            return receipt(source, source);
        });

        var staged = WhisperOnnxSttProvider.readVerifiedSourceContent(context, source.length);
        assertThat(staged.bytes()).containsExactly(source);
        assertThat(staged.receipt().bytesCopied()).isEqualTo(source.length);
        assertThat(staged.receipt().sha256()).isEqualTo(sha256(source));
    }

    @Test
    void stagedBytesMustMatchTheReaderReceiptAndPinnedArtifactVersion() {
        byte[] source = "actual".getBytes(StandardCharsets.US_ASCII);
        byte[] altered = "altered".getBytes(StandardCharsets.US_ASCII);
        ProcessingContext context = contextFor(source, (target, maxBytes) -> {
            target.write(altered);
            return receipt(source, source);
        });

        assertThatThrownBy(() -> WhisperOnnxSttProvider.readVerifiedSourceContent(context, 32))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("STT_SOURCE_CONTENT_RECEIPT_MISMATCH");
    }

    private static ProcessingContext contextFor(byte[] source, MediaArtifactContentReader reader) {
        return contextFor(source, reader, new Cancellation());
    }

    private static ProcessingContext contextFor(
            byte[] source, MediaArtifactContentReader reader, Cancellation cancellation) {
        String sourceHash = sha256(source);
        var artifact = new MediaArtifact("tenant", "principal", "artifact", "source.wav", "audio/wav",
                source.length, sourceHash, "object://source", "INTERNAL", Instant.now(),
                Instant.now().plusSeconds(60), Map.of());
        var request = new ProcessingJobRequest("request", "tenant", "principal", "correlation", "artifact",
                artifact.version().value(), JobType.SPEECH_TO_TEXT, "whisper-provider", Map.of());
        return new ProcessingContext(request, artifact, cancellation, null, reader);
    }

    private static ArtifactContentReadReceipt receipt(byte[] bytesToHash, byte[] copiedBytes) {
        String hash = sha256(bytesToHash);
        return new ArtifactContentReadReceipt(ArtifactVersion.fromSha256(hash), hash, copiedBytes.length);
    }

    private static String sha256(byte[] value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new AssertionError(impossible);
        }
    }

    @Test
    void declaresMeasuredSpanOnTheDeclaredSourceClock() {
        // One second of 16kHz PCM on a declared 48kHz source clock: exact rational map.
        List<Map<String, Object>> observations = WhisperOnnxSttProvider.sourceTickObservations(
                16_000, 16_000, clockMetadata(48_000, 96_000));
        assertThat(observations).hasSize(1);
        Map<String, Object> entry = observations.get(0);
        assertThat(entry).containsEntry("label", "transcript-span")
                .containsEntry("startTick", 0L)
                .containsEntry("endTick", 48_000L)
                .containsEntry("sourceClockId", "src-clock")
                .containsEntry("ticksPerSecond", 48_000L);
    }

    @Test
    void identityClockMapsSamplesOneToOne() {
        List<Map<String, Object>> observations = WhisperOnnxSttProvider.sourceTickObservations(
                8_000, 16_000, clockMetadata(16_000, 16_000));
        assertThat(observations).hasSize(1);
        assertThat(observations.get(0)).containsEntry("endTick", 8_000L);
    }

    @Test
    void omitsObservationsWithoutACompleteDeclaredClock() {
        assertThat(WhisperOnnxSttProvider.sourceTickObservations(16_000, 16_000, Map.of()))
                .isEmpty();
        assertThat(WhisperOnnxSttProvider.sourceTickObservations(16_000, 16_000, Map.of(
                        "sourceClockId", "src-clock",
                        "sourceClockTicksPerSecond", 48_000)))
                .isEmpty();
        assertThat(WhisperOnnxSttProvider.sourceTickObservations(16_000, 16_000,
                        clockMetadata(0, 96_000)))
                .isEmpty();
    }

    @Test
    void omitsObservationsThatCannotMapExactly() {
        // 7 samples at 16kHz on a 44.1kHz clock is not an integral source position.
        assertThat(WhisperOnnxSttProvider.sourceTickObservations(7, 16_000,
                        clockMetadata(44_100, 96_000)))
                .isEmpty();
        assertThat(WhisperOnnxSttProvider.sourceTickObservations(0, 16_000,
                        clockMetadata(48_000, 96_000)))
                .isEmpty();
    }

    @Test
    void omitsTimingThatExceedsTheDeclaredSourceDuration() {
        Map<String, Object> shortClock = clockMetadata(48_000, 47_999);
        assertThat(WhisperOnnxSttProvider.sourceTickObservations(
                16_000, 16_000, shortClock)).isEmpty();
        assertThat(WhisperOnnxSttProvider.sourceTickSegment(
                "decoded text", 16_000, 16_000, shortClock)).isNull();

        // The exact declared upper bound remains usable.
        Map<String, Object> exactClock = clockMetadata(48_000, 48_000);
        assertThat(WhisperOnnxSttProvider.sourceTickObservations(
                16_000, 16_000, exactClock)).hasSize(1);
        assertThat(WhisperOnnxSttProvider.sourceTickSegment(
                "decoded text", 16_000, 16_000, exactClock)).isNotNull();
    }

    @Test
    void declaredSpanBecomesOneSourceTicksTranscriptSegment() {
        Map<String, Object> segment = WhisperOnnxSttProvider.sourceTickSegment(
                "decoded text", 16_000, 16_000, clockMetadata(48_000, 96_000));
        assertThat(segment).isNotNull();
        assertThat(segment).containsEntry("segmentId", "transcript-span")
                .containsEntry("text", "decoded text")
                .containsEntry("origin", "PROVIDER");
        assertThat(segment.get("timing")).isInstanceOf(Map.class);
        @SuppressWarnings("unchecked")
        Map<String, Object> timing = (Map<String, Object>) segment.get("timing");
        assertThat(timing).containsEntry("tag", "SOURCE_TICKS")
                .containsEntry("startTick", 0L)
                .containsEntry("endTick", 48_000L)
                .containsEntry("sourceClockId", "src-clock")
                .containsEntry("sourceTicksPerSecond", 48_000L)
                .containsEntry("sourceDurationTicks", 96_000L);
    }

    @Test
    void noVerifiedSpanMeansNoSegmentIsDeclared() {
        assertThat(WhisperOnnxSttProvider.sourceTickSegment(
                "text", 16_000, 16_000, Map.of())).isNull();
        assertThat(WhisperOnnxSttProvider.sourceTickSegment(
                "text", 7, 16_000, clockMetadata(44_100, 96_000))).isNull();
        assertThat(WhisperOnnxSttProvider.sourceTickSegment(
                "text", 0, 16_000, clockMetadata(48_000, 96_000))).isNull();
    }
}
