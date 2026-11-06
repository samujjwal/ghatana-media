package com.ghatana.audio.streaming;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;

class GrpcAudioSourceCaptureTest {
    private static final GrpcAudioSourceCapture.Request REQUEST = new GrpcAudioSourceCapture.Request(
            "tenant-1", "stream-1", "principal-1", "purpose-1", "source@v7");

    @Test
    void reordersWithinBoundAndUsesCanonicalPortAsOnlyWriter() {
        FakePort port = new FakePort();
        FakeSource source = new FakeSource(new GrpcAudioSourceCapture.Batch(List.of(
                frame(11, 1, "source@v7"), frame(10, 0, "source@v7")), false));

        var result = new GrpcAudioSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcAudioSourceCapture.Disposition.ACCEPTED);
        assertThat(port.offeredSequences).containsExactly(0, 1);
        assertThat(result.acknowledgedFrames()).isEqualTo(2);
    }

    @Test
    void gapDoesNotWriteFramesPastTheMissingCursor() {
        FakePort port = new FakePort();
        FakeSource source = new FakeSource(new GrpcAudioSourceCapture.Batch(List.of(frame(11, 1, "source@v7")), false));

        var result = new GrpcAudioSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcAudioSourceCapture.Disposition.GAP);
        assertThat(port.offeredSequences).isEmpty();
    }

    @Test
    void unknownAndDeniedInitialReadbackReturnNoFramesAndDoNotFetchSourceBatch() {
        for (var decision : List.of(GrpcAudioSourceCapture.Authorization.UNKNOWN,
                GrpcAudioSourceCapture.Authorization.DENIED, GrpcAudioSourceCapture.Authorization.REVOKED)) {
            FakePort port = new FakePort();
            FakeSource source = new FakeSource(new GrpcAudioSourceCapture.Batch(List.of(frame(10, 0, "source@v7")), false));
            source.authorization = decision;

            var result = new GrpcAudioSourceCapture(port, source).capture(REQUEST);

            var expected = switch (decision) {
                case UNKNOWN -> GrpcAudioSourceCapture.Disposition.UNKNOWN;
                case DENIED -> GrpcAudioSourceCapture.Disposition.DENIED;
                case REVOKED -> GrpcAudioSourceCapture.Disposition.REVOKED;
                case AUTHORIZED -> throw new AssertionError("test case must not be authorized");
            };
            assertThat(result.disposition()).isEqualTo(expected);
            assertThat(source.batchReads).isZero();
            assertThat(port.offeredSequences).isEmpty();
        }
    }

    @Test
    void revocationBetweenFramesStopsBeforeTheNextCanonicalOffer() {
        FakePort port = new FakePort();
        FakeSource source = new FakeSource(new GrpcAudioSourceCapture.Batch(List.of(
                frame(10, 0, "source@v7"), frame(11, 1, "source@v7")), false));
        source.denyReadbackCall = 3; // initial readback, frame 0, then before frame 1

        var result = new GrpcAudioSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcAudioSourceCapture.Disposition.REVOKED);
        assertThat(port.offeredSequences).containsExactly(0);
    }

    @Test
    void lostCanonicalAckIsUnknownAndNeverBlindlyReplayed() {
        FakePort port = new FakePort();
        port.offerResult = new CanonicalStreamFramePort.Result(
                CanonicalStreamFramePort.Disposition.OUTCOME_UNKNOWN, -1, "transport lost");
        FakeSource source = new FakeSource(new GrpcAudioSourceCapture.Batch(List.of(frame(10, 0, "source@v7")), false));

        var result = new GrpcAudioSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcAudioSourceCapture.Disposition.OUTCOME_UNKNOWN);
        assertThat(port.offerCalls).isEqualTo(1);
        assertThat(port.offeredSequences).containsExactly(0);
    }

    @Test
    void expiredCanonicalLeaseStopsBeforeAcknowledgingOrRetryingFrame() {
        FakePort port = new FakePort();
        port.offerResult = new CanonicalStreamFramePort.Result(
                CanonicalStreamFramePort.Disposition.LEASE_EXPIRED, -1, "lease expired");
        FakeSource source = new FakeSource(new GrpcAudioSourceCapture.Batch(
                List.of(frame(10, 0, "source@v7")), false));

        var result = new GrpcAudioSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcAudioSourceCapture.Disposition.LEASE_EXPIRED);
        assertThat(result.acknowledgedFrames()).isZero();
        assertThat(result.lastSourceCursor()).isEqualTo(-1);
        assertThat(port.offerCalls).isEqualTo(1);
        assertThat(port.offeredSequences).containsExactly(0);
        assertThat(port.lastAck).isEqualTo(-1);
    }

    @Test
    void expiredCanonicalLeaseDuringEosKeepsLeaseExpiryDistinctFromUnknown() {
        FakePort port = new FakePort();
        port.eosResult = new CanonicalStreamFramePort.Result(
                CanonicalStreamFramePort.Disposition.LEASE_EXPIRED, -1, "lease expired");
        FakeSource source = new FakeSource(new GrpcAudioSourceCapture.Batch(List.of(), true));

        var result = new GrpcAudioSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcAudioSourceCapture.Disposition.LEASE_EXPIRED);
        assertThat(result.acknowledgedFrames()).isZero();
        assertThat(result.lastSourceCursor()).isEqualTo(-1);
        assertThat(port.offerCalls).isZero();
        assertThat(port.eosCalls).isEqualTo(1);
    }

    @Test
    void initialReadbackOutageReturnsUnknownWithoutThrowingOrFetchingFrames() {
        FakePort port = new FakePort();
        FakeSource source = new FakeSource(new GrpcAudioSourceCapture.Batch(List.of(frame(10, 0, "source@v7")), false));
        source.throwReadbackCall = 1;

        var result = new GrpcAudioSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcAudioSourceCapture.Disposition.UNKNOWN);
        assertThat(source.batchReads).isZero();
        assertThat(port.offeredSequences).isEmpty();
    }

    @Test
    void nullCanonicalOfferFeedbackIsOutcomeUnknownAndNotRetried() {
        FakePort port = new FakePort();
        port.nullOfferFeedback = true;
        FakeSource source = new FakeSource(new GrpcAudioSourceCapture.Batch(List.of(frame(10, 0, "source@v7")), false));

        var result = new GrpcAudioSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcAudioSourceCapture.Disposition.OUTCOME_UNKNOWN);
        assertThat(port.offerCalls).isEqualTo(1);
    }

    @Test
    void eosUsesCanonicalEosMarkerAfterFreshAuthorizationReadback() {
        FakePort port = new FakePort();
        FakeSource source = new FakeSource(new GrpcAudioSourceCapture.Batch(List.of(), true));

        var result = new GrpcAudioSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcAudioSourceCapture.Disposition.EOS);
        assertThat(source.readbackCalls).isEqualTo(2);
        assertThat(port.eosCalls).isEqualTo(1);
        assertThat(port.offeredSequences).isEmpty();
    }

    @Test
    void exactSourceVersionIsRequiredForEveryFrame() {
        FakePort port = new FakePort();
        FakeSource source = new FakeSource(new GrpcAudioSourceCapture.Batch(List.of(frame(10, 0, "source@v8")), false));

        var result = new GrpcAudioSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcAudioSourceCapture.Disposition.UNKNOWN);
        assertThat(port.offeredSequences).isEmpty();
    }

    @Test
    void boundedBackpressureStopsTheBatchAfterAcknowledgedFrame() {
        FakePort port = new FakePort();
        port.backpressured = true;
        FakeSource source = new FakeSource(new GrpcAudioSourceCapture.Batch(List.of(
                frame(10, 0, "source@v7"), frame(11, 1, "source@v7")), false));

        var result = new GrpcAudioSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcAudioSourceCapture.Disposition.BACKPRESSURED);
        assertThat(port.offeredSequences).containsExactly(0);
    }

    @Test
    void unavailableBackpressureFeedbackStopsFurtherFrameOffers() {
        FakePort port = new FakePort();
        port.feedbackUnavailable = true;
        FakeSource source = new FakeSource(new GrpcAudioSourceCapture.Batch(List.of(
                frame(10, 0, "source@v7"), frame(11, 1, "source@v7")), false));

        var result = new GrpcAudioSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcAudioSourceCapture.Disposition.UNKNOWN);
        assertThat(result.acknowledgedFrames()).isEqualTo(1);
        assertThat(port.offeredSequences).containsExactly(0);
    }

    private static GrpcAudioSourceCapture.SourceFrame frame(long cursor, int sequence, String version) {
        return new GrpcAudioSourceCapture.SourceFrame(version, cursor, sequence, 1234L, new byte[] {(byte) sequence});
    }

    private static final class FakeSource implements GrpcAudioSourceCapture.AuthenticatedGrpcSource {
        private final GrpcAudioSourceCapture.Batch batch;
        private GrpcAudioSourceCapture.Authorization authorization = GrpcAudioSourceCapture.Authorization.AUTHORIZED;
        private int denyReadbackCall = -1;
        private int throwReadbackCall = -1;
        private int readbackCalls;
        private int batchReads;

        private FakeSource(GrpcAudioSourceCapture.Batch batch) { this.batch = batch; }

        @Override public GrpcAudioSourceCapture.Readback readback(
                GrpcAudioSourceCapture.Request request, long cursor, long mediaSequence) {
            readbackCalls++;
            if (readbackCalls == throwReadbackCall) throw new IllegalStateException("readback unavailable");
            var status = readbackCalls == denyReadbackCall ? GrpcAudioSourceCapture.Authorization.REVOKED : authorization;
            return new GrpcAudioSourceCapture.Readback(status,
                    status == GrpcAudioSourceCapture.Authorization.AUTHORIZED ? request.sourceVersion() : null,
                    cursor < 0 ? 10 : cursor, mediaSequence);
        }

        @Override public GrpcAudioSourceCapture.Batch readBatch(
                GrpcAudioSourceCapture.Request request, GrpcAudioSourceCapture.Readback readback,
                int maxFrames, long maxBytes) {
            batchReads++;
            assertThat(maxFrames).isEqualTo(GrpcAudioSourceCapture.MAX_BATCH_FRAMES);
            assertThat(maxBytes).isEqualTo(GrpcAudioSourceCapture.MAX_BATCH_BYTES);
            return batch;
        }
    }

    private static final class FakePort implements CanonicalStreamFramePort {
        private final List<Integer> offeredSequences = new java.util.ArrayList<>();
        private long lastAck = -1;
        private int offerCalls;
        private int eosCalls;
        private boolean backpressured;
        private boolean feedbackUnavailable;
        private boolean nullOfferFeedback;
        private Result offerResult;
        private Result eosResult;

        @Override public Optional<Binding> currentBinding(String tenantId, String streamId, String principalId) {
            return Optional.of(new Binding(streamId, tenantId, principalId, "purpose-1", 1, 1, lastAck,
                    Instant.now().plusSeconds(30)));
        }

        @Override public Result offer(Binding expected, AudioStreamSession.DecodedFrame frame) {
            offerCalls++;
            offeredSequences.add(frame.sequenceNumber());
            if (offerResult != null) return offerResult;
            lastAck = frame.sequenceNumber();
            return Result.acknowledged(lastAck);
        }

        @Override public OfferFeedback offerWithFeedback(Binding expected, AudioStreamSession.DecodedFrame frame) {
            Result result = offer(expected, frame);
            if (nullOfferFeedback) return null;
            if (feedbackUnavailable) return OfferFeedback.unavailable(result);
            return new OfferFeedback(result, 0, backpressured, true);
        }

        @Override public OfferFeedback endOfStreamWithFeedback(Binding expected) {
            eosCalls++;
            Result result = eosResult == null
                    ? Result.acknowledged(expected.lastAcknowledgedSequence() + 1) : eosResult;
            return OfferFeedback.unavailable(result);
        }
    }
}
