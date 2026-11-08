package com.ghatana.video.streaming;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.AbstractList;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class GrpcVideoSourceCaptureTest {
    private static final GrpcVideoSourceCapture.Request REQUEST = new GrpcVideoSourceCapture.Request(
            "tenant-1", "stream-1", "principal-1", "purpose-1", "video@v3");

    @Test
    void requestRejectsUnicodeEdgeSpaceAroundExactSourceVersion() {
        assertThatThrownBy(() -> new GrpcVideoSourceCapture.Request(
                "tenant-1", "stream-1", "principal-1", "purpose-1", "\u00a0video@v3"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sourceVersion must be present and canonical");
        assertThatThrownBy(() -> new GrpcVideoSourceCapture.Request(
                "tenant-1", "stream-1", "principal-1", "purpose-1", "video@v3\u00a0"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sourceVersion must be present and canonical");
    }

    @Test
    void requestRejectsOpaqueIdsOutsideAsciiGrammarAndLength() {
        assertThatThrownBy(() -> new GrpcVideoSourceCapture.Request(
                "tenant/1", "stream-1", "principal-1", "purpose-1", "video@v3"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("tenantId must be an opaque ASCII identifier");
        assertThatThrownBy(() -> new GrpcVideoSourceCapture.Request(
                "tenant-1", "stream-1", "principal-" + "1".repeat(128), "purpose-1", "video@v3"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("principalId must be an opaque ASCII identifier");
        assertThatThrownBy(() -> new GrpcVideoSourceCapture.Request(
                "tenant-1", "stream-1", "principal-1", "purpose-1", "v".repeat(385)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sourceVersion must not exceed 384 characters");
    }

    @Test
    void trustedSourceVersionsRespectVersionReferenceLength() {
        String overlength = "v".repeat(385);
        assertThatThrownBy(() -> new GrpcVideoSourceCapture.Readback(
                GrpcVideoSourceCapture.Authorization.AUTHORIZED, overlength, 0, 0))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sourceVersion must not exceed 384 characters");
        assertThatThrownBy(() -> new GrpcVideoSourceCapture.SourceFrame(
                overlength, 0, 0, true, 0,
                VideoFrameTimebase.SourceTimestamp.unknown("capture"), new byte[] {1}))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sourceVersion must not exceed 384 characters");
    }

    @Test
    void versionReferenceLengthUsesUnicodeCodePoints() {
        String maxCodePoints = "\uD83D\uDE00".repeat(384);
        assertThat(new GrpcVideoSourceCapture.Request(
                "tenant-1", "stream-1", "principal-1", maxCodePoints, maxCodePoints))
                .isNotNull();
    }

    @Test
    void batchFrameCapUsesActualIteratorEntriesBeforeCopying() {
        GrpcVideoSourceCapture.SourceFrame repeated = frame(10, 0, "video@v3", 20);
        List<GrpcVideoSourceCapture.SourceFrame> actualFrames = new ArrayList<>(
                Collections.nCopies(GrpcVideoSourceCapture.MAX_BATCH_FRAMES + 1, repeated));
        AtomicInteger consumed = new AtomicInteger();
        List<GrpcVideoSourceCapture.SourceFrame> underreported = new AbstractList<>() {
            @Override public GrpcVideoSourceCapture.SourceFrame get(int index) { return actualFrames.get(index); }
            @Override public int size() { return 1; }
            @Override public Iterator<GrpcVideoSourceCapture.SourceFrame> iterator() {
                Iterator<GrpcVideoSourceCapture.SourceFrame> delegate = actualFrames.iterator();
                return new Iterator<>() {
                    @Override public boolean hasNext() { return delegate.hasNext(); }
                    @Override public GrpcVideoSourceCapture.SourceFrame next() {
                        consumed.incrementAndGet();
                        return delegate.next();
                    }
                };
            }
        };

        assertThatThrownBy(() -> new GrpcVideoSourceCapture.Batch(underreported, false))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("video source batch exceeds the frame bound");
        assertThat(consumed).hasValue(GrpcVideoSourceCapture.MAX_BATCH_FRAMES);
    }

    @Test
    void batchByteCapStopsAtFirstOverBudgetFrameBeforeReadingLaterEntries() {
        int maximumBytes = Math.toIntExact(GrpcVideoSourceCapture.MAX_BATCH_BYTES);
        List<GrpcVideoSourceCapture.SourceFrame> actualFrames = List.of(
                frameWithPayload(0, new byte[maximumBytes]),
                frameWithPayload(1, new byte[] {1}),
                frameWithPayload(2, new byte[] {2}));
        AtomicInteger consumed = new AtomicInteger();
        List<GrpcVideoSourceCapture.SourceFrame> underreported = new AbstractList<>() {
            @Override public GrpcVideoSourceCapture.SourceFrame get(int index) { return actualFrames.get(index); }
            @Override public int size() { return 1; }
            @Override public Iterator<GrpcVideoSourceCapture.SourceFrame> iterator() {
                Iterator<GrpcVideoSourceCapture.SourceFrame> delegate = actualFrames.iterator();
                return new Iterator<>() {
                    @Override public boolean hasNext() { return delegate.hasNext(); }
                    @Override public GrpcVideoSourceCapture.SourceFrame next() {
                        consumed.incrementAndGet();
                        return delegate.next();
                    }
                };
            }
        };

        assertThatThrownBy(() -> new GrpcVideoSourceCapture.Batch(underreported, false))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("video source batch exceeds the byte bound");
        assertThat(consumed).hasValue(2);
    }

    @Test
    void reordersFramesAndUsesCanonicalPortAsOnlyWriter() {
        FakePort port = new FakePort();
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(List.of(
                frame(11, 1, "video@v3", 30), frame(10, 0, "video@v3", 20)), false));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.ACCEPTED);
        assertThat(port.offeredSequences).containsExactly(0, 1);
    }

    @Test
    void sourceGapDoesNotOfferLaterFrames() {
        FakePort port = new FakePort();
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(List.of(frame(11, 1, "video@v3", 30)), false));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.GAP);
        assertThat(port.offeredSequences).isEmpty();
    }

    @Test
    void staleSequenceWithCursorAtOrAfterAdmissionIsRejectedBeforeOffer() {
        FakePort port = new FakePort();
        port.lastAck = 0;
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(List.of(
                frame(11, 0, "video@v3", 20), frame(10, 1, "video@v3", 30)), false));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.UNKNOWN);
        assertThat(result.acknowledgedFrames()).isZero();
        assertThat(port.offeredSequences).isEmpty();
    }

    @Test
    void deniedReadbackDoesNotFetchOrOfferFrames() {
        FakePort port = new FakePort();
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(List.of(frame(10, 0, "video@v3", 20)), false));
        source.authorization = GrpcVideoSourceCapture.Authorization.DENIED;

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.DENIED);
        assertThat(source.batchReads).isZero();
        assertThat(port.offeredSequences).isEmpty();
    }

    @Test
    void unknownReadbackDoesNotFetchOrOfferFrames() {
        FakePort port = new FakePort();
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(List.of(frame(10, 0, "video@v3", 20)), false));
        source.authorization = GrpcVideoSourceCapture.Authorization.UNKNOWN;

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.UNKNOWN);
        assertThat(source.batchReads).isZero();
        assertThat(port.offeredSequences).isEmpty();
    }

    @Test
    void explicitRevocationHasADistinctDisposition() {
        FakePort port = new FakePort();
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(List.of(frame(10, 0, "video@v3", 20)), false));
        source.authorization = GrpcVideoSourceCapture.Authorization.REVOKED;

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.REVOKED);
        assertThat(source.batchReads).isZero();
        assertThat(port.offeredSequences).isEmpty();
    }

    @Test
    void revokeBetweenFramesStopsBeforeTheNextOffer() {
        FakePort port = new FakePort();
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(List.of(
                frame(10, 0, "video@v3", 20), frame(11, 1, "video@v3", 30)), false));
        source.denyReadbackCall = 3;

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.REVOKED);
        assertThat(port.offeredSequences).containsExactly(0);
    }

    @Test
    void lostAckIsUnknownAndNotRetried() {
        FakePort port = new FakePort();
        port.offerResult = new CanonicalVideoStreamFramePort.Result(
                CanonicalVideoStreamFramePort.Disposition.OUTCOME_UNKNOWN, -1, "lost acknowledgement");
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(List.of(frame(10, 0, "video@v3", 20)), false));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.OUTCOME_UNKNOWN);
        assertThat(port.offerCalls).isEqualTo(1);
        assertThat(port.offeredSequences).containsExactly(0);
    }

    @Test
    void expiredCanonicalLeaseStopsBeforeAcknowledgingOrRetryingFrame() {
        FakePort port = new FakePort();
        port.offerResult = new CanonicalVideoStreamFramePort.Result(
                CanonicalVideoStreamFramePort.Disposition.LEASE_EXPIRED, -1, "lease expired");
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(
                List.of(frame(10, 0, "video@v3", 20)), false));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.LEASE_EXPIRED);
        assertThat(result.acknowledgedFrames()).isZero();
        assertThat(result.lastSourceCursor()).isEqualTo(-1);
        assertThat(port.offerCalls).isEqualTo(1);
        assertThat(port.offeredSequences).containsExactly(0);
        assertThat(port.lastAck).isEqualTo(-1);
    }

    @Test
    void expiredCanonicalLeaseDuringEosKeepsLeaseExpiryDistinctFromUnknown() {
        FakePort port = new FakePort();
        port.eosResult = new CanonicalVideoStreamFramePort.Result(
                CanonicalVideoStreamFramePort.Disposition.LEASE_EXPIRED, -1, "lease expired");
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(List.of(), true));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.LEASE_EXPIRED);
        assertThat(result.acknowledgedFrames()).isZero();
        assertThat(result.lastSourceCursor()).isEqualTo(-1);
        assertThat(port.offerCalls).isZero();
        assertThat(port.eosCalls).isEqualTo(1);
    }

    @Test
    void nullCanonicalOfferFeedbackIsUnknownAndNotRetried() {
        FakePort port = new FakePort();
        port.nullOfferFeedback = true;
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(List.of(frame(10, 0, "video@v3", 20)), false));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.OUTCOME_UNKNOWN);
        assertThat(port.offerCalls).isEqualTo(1);
    }

    @Test
    void eosUsesFreshReadbackAndCanonicalMarker() {
        FakePort port = new FakePort();
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(List.of(), true));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.EOS);
        assertThat(source.readbackCalls).isEqualTo(2);
        assertThat(port.eosCalls).isEqualTo(1);
    }

    @Test
    void changedCanonicalGenerationBeforeSourceReadDoesNotFetchSourceFrames() {
        FakePort port = new FakePort();
        port.changeGenerationOnBindingCall = 2;
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(
                List.of(frame(10, 0, "video@v3", 20)), false));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.UNKNOWN);
        assertThat(source.batchReads).isZero();
        assertThat(port.offeredSequences).isEmpty();
    }

    @Test
    void changedCanonicalAckCursorBeforeSourceReadDoesNotFetchSourceFrames() {
        FakePort port = new FakePort();
        port.changeAckCursorOnBindingCall = 2;
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(
                List.of(frame(10, 0, "video@v3", 20)), false));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.UNKNOWN);
        assertThat(source.batchReads).isZero();
        assertThat(port.offeredSequences).isEmpty();
    }

    @Test
    void expiredCanonicalLeaseBeforeSourceReadDoesNotFetchSourceFrames() {
        FakePort port = new FakePort();
        port.expireLeaseOnBindingCall = 2;
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(
                List.of(frame(10, 0, "video@v3", 20)), false));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.LEASE_EXPIRED);
        assertThat(source.batchReads).isZero();
        assertThat(port.offeredSequences).isEmpty();
    }

    @Test
    void eosRequiresAcknowledgementOfTheExactNextMediaSequence() {
        FakePort port = new FakePort();
        port.eosResult = CanonicalVideoStreamFramePort.Result.acknowledged(1);
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(List.of(), true));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.UNKNOWN);
        assertThat(result.acknowledgedFrames()).isZero();
        assertThat(port.eosCalls).isEqualTo(1);
    }

    @Test
    void expiredCanonicalLeaseAfterEosReadbackDoesNotDispatchEos() {
        FakePort port = new FakePort();
        port.expireLeaseOnBindingCall = 3;
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(List.of(), true));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.LEASE_EXPIRED);
        assertThat(source.readbackCalls).isEqualTo(2);
        assertThat(port.eosCalls).isZero();
    }

    @Test
    void highestLegalFrameDoesNotDispatchEosOutsideCanonicalSequenceRange() {
        FakePort port = new FakePort();
        port.lastAck = VideoStreamSession.MAX_FRAME_SEQUENCE - 1L;
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(List.of(
                frame(10, VideoStreamSession.MAX_FRAME_SEQUENCE, "video@v3", 20)), true));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.UNKNOWN);
        assertThat(result.acknowledgedFrames()).isEqualTo(1);
        assertThat(port.offeredSequences).containsExactly(VideoStreamSession.MAX_FRAME_SEQUENCE);
        assertThat(port.eosCalls).isZero();
    }

    @Test
    void exactSourceVersionMustMatchEveryFrame() {
        FakePort port = new FakePort();
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(List.of(frame(10, 0, "video@v4", 20)), false));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.UNKNOWN);
        assertThat(port.offeredSequences).isEmpty();
    }

    @Test
    void unknownSourcePtsRemainsUnknownEvenWhenLegacyTimestampMillisIsPresent() {
        FakePort port = new FakePort();
        var frame = new GrpcVideoSourceCapture.SourceFrame("video@v3", 10, 0, true, 987654L,
                VideoFrameTimebase.SourceTimestamp.unknown("SOURCE_PTS_NOT_SUPPLIED"), new byte[] {1});
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(List.of(frame), false));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.ACCEPTED);
        assertThat(port.offeredFrames.get(0).timestampMillis()).isEqualTo(987654L);
    }

    @Test
    void knownPtsMustUseOneClockAndNondecreasingTicks() {
        FakePort port = new FakePort();
        var one = knownFrame(10, 0, 20);
        var two = knownFrame(11, 1, 19);
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(List.of(one, two), false));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.UNKNOWN);
        assertThat(port.offeredSequences).containsExactly(0);
    }

    @Test
    void knownPtsClockChangeStopsBeforeOfferingTheChangedFrame() {
        FakePort port = new FakePort();
        var first = knownFrame(10, 0, 20);
        var changedClock = new GrpcVideoSourceCapture.SourceFrame("video@v3", 11, 1,
                false, 701L,
                VideoFrameTimebase.SourceTimestamp.known(21, 1, 90_000, "other-source-clock"),
                new byte[] {1});
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(
                List.of(first, changedClock), false));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.UNKNOWN);
        assertThat(result.acknowledgedFrames()).isEqualTo(1);
        assertThat(result.lastSourceCursor()).isEqualTo(10);
        assertThat(port.offeredSequences).containsExactly(0);
    }

    @Test
    void knownPtsTimebaseChangeStopsBeforeOfferingTheChangedFrame() {
        FakePort port = new FakePort();
        var first = knownFrame(10, 0, 20);
        var changedTimebase = new GrpcVideoSourceCapture.SourceFrame("video@v3", 11, 1,
                false, 701L,
                VideoFrameTimebase.SourceTimestamp.known(21, 1, 1_000, "source-clock"),
                new byte[] {1});
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(
                List.of(first, changedTimebase), false));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.UNKNOWN);
        assertThat(result.acknowledgedFrames()).isEqualTo(1);
        assertThat(result.lastSourceCursor()).isEqualTo(10);
        assertThat(port.offeredSequences).containsExactly(0);
    }

    @Test
    void backpressureStopsFurtherFrameOffers() {
        FakePort port = new FakePort();
        port.backpressured = true;
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(List.of(
                frame(10, 0, "video@v3", 20), frame(11, 1, "video@v3", 30)), false));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.BACKPRESSURED);
        assertThat(port.offeredSequences).containsExactly(0);
    }

    @Test
    void unavailableBackpressureFeedbackStopsFurtherFrameOffers() {
        FakePort port = new FakePort();
        port.feedbackUnavailable = true;
        FakeSource source = new FakeSource(new GrpcVideoSourceCapture.Batch(List.of(
                frame(10, 0, "video@v3", 20), frame(11, 1, "video@v3", 30)), false));

        var result = new GrpcVideoSourceCapture(port, source).capture(REQUEST);

        assertThat(result.disposition()).isEqualTo(GrpcVideoSourceCapture.Disposition.UNKNOWN);
        assertThat(result.acknowledgedFrames()).isEqualTo(1);
        assertThat(port.offeredSequences).containsExactly(0);
    }

    private static GrpcVideoSourceCapture.SourceFrame frame(long cursor, int sequence, String version, long pts) {
        return new GrpcVideoSourceCapture.SourceFrame(version, cursor, sequence, sequence == 0, 700L + sequence,
                VideoFrameTimebase.SourceTimestamp.known(pts, 1, 90_000, "source-clock"),
                new byte[] {(byte) sequence});
    }

    private static GrpcVideoSourceCapture.SourceFrame frameWithPayload(int sequence, byte[] payload) {
        return new GrpcVideoSourceCapture.SourceFrame("video@v3", 10 + sequence, sequence, sequence == 0,
                700L + sequence,
                VideoFrameTimebase.SourceTimestamp.known(20 + sequence, 1, 90_000, "source-clock"), payload);
    }

    private static GrpcVideoSourceCapture.SourceFrame knownFrame(long cursor, int sequence, long pts) {
        return frame(cursor, sequence, "video@v3", pts);
    }

    private static final class FakeSource implements GrpcVideoSourceCapture.AuthenticatedGrpcSource {
        private final GrpcVideoSourceCapture.Batch batch;
        private GrpcVideoSourceCapture.Authorization authorization = GrpcVideoSourceCapture.Authorization.AUTHORIZED;
        private int denyReadbackCall = -1;
        private int readbackCalls;
        private int batchReads;

        private FakeSource(GrpcVideoSourceCapture.Batch batch) { this.batch = batch; }

        @Override public GrpcVideoSourceCapture.Readback readback(
                GrpcVideoSourceCapture.Request request, long cursor, long mediaSequence) {
            readbackCalls++;
            var status = readbackCalls == denyReadbackCall ? GrpcVideoSourceCapture.Authorization.REVOKED : authorization;
            return new GrpcVideoSourceCapture.Readback(status,
                    status == GrpcVideoSourceCapture.Authorization.AUTHORIZED ? request.sourceVersion() : null,
                    cursor < 0 ? 10 : cursor, mediaSequence);
        }

        @Override public GrpcVideoSourceCapture.Batch readBatch(
                GrpcVideoSourceCapture.Request request, GrpcVideoSourceCapture.Readback readback,
                int maxFrames, long maxBytes) {
            batchReads++;
            assertThat(maxFrames).isEqualTo(GrpcVideoSourceCapture.MAX_BATCH_FRAMES);
            assertThat(maxBytes).isEqualTo(GrpcVideoSourceCapture.MAX_BATCH_BYTES);
            return batch;
        }
    }

    private static final class FakePort implements CanonicalVideoStreamFramePort {
        private final List<Integer> offeredSequences = new ArrayList<>();
        private final List<VideoStreamSession.DecodedFrame> offeredFrames = new ArrayList<>();
        private long lastAck = -1;
        private int offerCalls;
        private int eosCalls;
        private int bindingCalls;
        private int changeGenerationOnBindingCall = -1;
        private int changeAckCursorOnBindingCall = -1;
        private int expireLeaseOnBindingCall = -1;
        private boolean backpressured;
        private boolean feedbackUnavailable;
        private boolean nullOfferFeedback;
        private Result offerResult;
        private Result eosResult;

        @Override public Optional<Binding> currentBinding(String tenantId, String streamId, String principalId) {
            bindingCalls++;
            long generation = bindingCalls == changeGenerationOnBindingCall ? 2 : 1;
            long acknowledged = bindingCalls == changeAckCursorOnBindingCall ? lastAck + 1 : lastAck;
            Instant leaseExpiry = bindingCalls == expireLeaseOnBindingCall
                    ? Instant.EPOCH : Instant.now().plusSeconds(30);
            return Optional.of(new Binding(streamId, tenantId, principalId, "purpose-1", generation, 1, acknowledged,
                    leaseExpiry));
        }

        @Override public Result offer(Binding expected, VideoStreamSession.DecodedFrame frame) {
            offerCalls++;
            offeredSequences.add(frame.sequenceNumber());
            offeredFrames.add(frame);
            if (offerResult != null) return offerResult;
            lastAck = frame.sequenceNumber();
            return Result.acknowledged(lastAck);
        }

        @Override public OfferFeedback offerWithFeedback(Binding expected, VideoStreamSession.DecodedFrame frame) {
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
