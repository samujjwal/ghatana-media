package com.ghatana.media.production.rendering;

import static com.ghatana.media.production.rendering.TemporalVideoRestoration.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.security.MessageDigest;
import java.util.AbstractList;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Test;

class PngFrameCodecTest {
    private static final TimeBase TIME_BASE = new TimeBase(1_001, 30_000);

    @Test
    void sequenceDecodePreservesCallerClockAndFrameMetadataWithoutClaimingArtifactBinding() {
        Roi roi = new Roi(1, 0, 1, 1);
        byte[][] rgb = {{10, 20, 30, 40, 50, 60}, {11, 21, 31, 41, 51, 61}, {12, 22, 32, 42, 52, 62}};
        List<PngFrameCodec.PngFrame> pngs = List.of(
                inputFrame(0, 0, roi, rgb[0]),
                inputFrame(1, 1_001, roi, rgb[1]),
                inputFrame(2, 3_003, roi, rgb[2]));

        PngFrameCodec.DecodedPngFrameSequence sequence = PngFrameCodec.decodeSequence(TIME_BASE, pngs);

        assertThat(sequence.timeBase()).isEqualTo(TIME_BASE);
        assertThat(sequence.frames()).extracting(Frame::frameIndex).containsExactly(0, 1, 2);
        assertThat(sequence.frames()).extracting(Frame::presentationTicks).containsExactly(0L, 1_001L, 3_003L);
        assertThat(sequence.frames()).allSatisfy(frame -> assertThat(frame.roi()).isEqualTo(roi));
        assertThat(sequence.frames().get(1).rgb()).containsExactly(rgb[1]);
    }

    @Test
    void sequenceDecodePreservesSignedPtsAndStillRejectsDuplicateOrDecreasingPts() {
        Roi roi = new Roi(0, 0, 1, 1);
        byte[] pixels = {1, 2, 3, 4, 5, 6};
        List<PngFrameCodec.PngFrame> signedPts = List.of(
                inputFrame(0, Long.MIN_VALUE, roi, pixels),
                inputFrame(1, -1, roi, pixels),
                inputFrame(2, 0, roi, pixels));

        PngFrameCodec.DecodedPngFrameSequence decoded = PngFrameCodec.decodeSequence(TIME_BASE, signedPts);

        assertThat(decoded.frames()).extracting(Frame::presentationTicks)
                .containsExactly(Long.MIN_VALUE, -1L, 0L);
        assertThatThrownBy(() -> PngFrameCodec.decodeSequence(TIME_BASE, List.of(
                inputFrame(0, -2, roi, pixels), inputFrame(1, -2, roi, pixels), inputFrame(2, 0, roi, pixels))))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("strictly increasing");
        assertThatThrownBy(() -> PngFrameCodec.decodeSequence(TIME_BASE, List.of(
                inputFrame(0, -1, roi, pixels), inputFrame(1, 0, roi, pixels), inputFrame(2, -2, roi, pixels))))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("strictly increasing");
    }

    @Test
    void decodedSequenceRejectsDeclaredOversizeBeforeReadingFrames() {
        AtomicInteger reads = new AtomicInteger();
        List<Frame> hostile = new AbstractList<>() {
            @Override public Frame get(int index) {
                reads.incrementAndGet();
                throw new AssertionError("declared oversized list must be rejected before frame access");
            }
            @Override public int size() { return Integer.MAX_VALUE; }
        };

        assertThatThrownBy(() -> new PngFrameCodec.DecodedPngFrameSequence(TIME_BASE, hostile))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("between 3 and 64 frames");
        assertThat(reads).hasValue(0);
    }

    @Test
    void decodedSequenceRejectsUnderreportedIteratorAtFrameLimit() {
        AtomicInteger reads = new AtomicInteger();
        Roi roi = new Roi(0, 0, 1, 1);
        Frame frame = new Frame(0, 1, 1, 1, roi, new byte[] {1, 2, 3});
        List<Frame> underreported = new AbstractList<>() {
            @Override public Frame get(int index) { throw new AssertionError("custom iterator should be used"); }
            @Override public int size() { return 3; }
            @Override public Iterator<Frame> iterator() {
                return new Iterator<>() {
                    private int index;
                    @Override public boolean hasNext() { return index < 100; }
                    @Override public Frame next() {
                        reads.incrementAndGet();
                        index++;
                        return frame;
                    }
                };
            }
        };

        assertThatThrownBy(() -> new PngFrameCodec.DecodedPngFrameSequence(TIME_BASE, underreported))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("between 3 and 64 frames");
        assertThat(reads).hasValue(TemporalVideoRestoration.MAX_FRAMES);
    }

    @Test
    void decodedSequenceKeepsAnImmutableSnapshotOfValidFrames() {
        Roi roi = new Roi(0, 0, 1, 1);
        List<Frame> input = new java.util.ArrayList<>(List.of(
                new Frame(0, 1, 1, 1, roi, new byte[] {1, 2, 3}),
                new Frame(1, 2, 1, 1, roi, new byte[] {4, 5, 6}),
                new Frame(2, 3, 1, 1, roi, new byte[] {7, 8, 9})));

        PngFrameCodec.DecodedPngFrameSequence decoded =
                new PngFrameCodec.DecodedPngFrameSequence(TIME_BASE, input);
        input.clear();

        assertThat(decoded.frames()).hasSize(3);
        assertThat(decoded.frames()).extracting(Frame::frameIndex).containsExactly(0, 1, 2);
        assertThatThrownBy(() -> decoded.frames().clear()).isInstanceOf(UnsupportedOperationException.class);
    }

    @Test
    void candidatePngRoundTripEncodesActualRgbPayloadAndCallerMetadataRemainsAvailable() {
        byte[] pixels = {(byte) 250, 2, 3, 4, 5, 6};
        Roi roi = new Roi(0, 0, 2, 1);
        Frame source = new Frame(7, 9_001, 2, 1, roi, pixels);
        CandidateFrame candidate = new CandidateFrame(source.frameIndex(), source.presentationTicks(), source.width(),
                source.height(), source.roi(), source.rgb(), source.frameSha256());

        byte[] png = PngFrameCodec.encode(candidate);
        Frame decoded = PngFrameCodec.decode(png,
                new PngFrameCodec.FrameMetadata(7, 9_001, 2, 1, roi));

        assertThat(decoded.rgb()).containsExactly(pixels);
        assertThat(decoded.frameIndex()).isEqualTo(candidate.frameIndex());
        assertThat(decoded.presentationTicks()).isEqualTo(candidate.presentationTicks());
        assertThat(decoded.roi()).isEqualTo(candidate.roi());
        assertThat(ImageIO.getImageReadersByFormatName("png").hasNext()).isTrue();
    }

    @Test
    void candidateSequenceEncodingPreservesFrameClockRoiAndPixelsWithoutClaimingAContainer() {
        Roi roi = new Roi(0, 0, 2, 1);
        List<CandidateFrame> candidates = List.of(
                candidateFrame(0, 0, roi, new byte[] {10, 20, 30, 40, 50, 60}),
                candidateFrame(1, 1_001, roi, new byte[] {11, 21, 31, 41, 51, 61}),
                candidateFrame(2, 3_003, roi, new byte[] {12, 22, 32, 42, 52, 62}));

        PngFrameCodec.EncodedPngFrameSequence encoded = PngFrameCodec.encodeSequence(TIME_BASE, candidates);
        PngFrameCodec.DecodedPngFrameSequence decoded =
                PngFrameCodec.decodeSequence(encoded.timeBase(), encoded.frames());

        assertThat(encoded.timeBase()).isEqualTo(TIME_BASE);
        assertThat(encoded.frames()).extracting(frame -> frame.metadata().frameIndex()).containsExactly(0, 1, 2);
        assertThat(encoded.frames()).extracting(frame -> frame.metadata().presentationTicks())
                .containsExactly(0L, 1_001L, 3_003L);
        assertThat(decoded.timeBase()).isEqualTo(TIME_BASE);
        assertThat(decoded.frames()).extracting(Frame::presentationTicks).containsExactly(0L, 1_001L, 3_003L);
        assertThat(decoded.frames()).extracting(Frame::roi).containsOnly(roi);
        assertThat(decoded.frames()).extracting(Frame::rgb)
                .containsExactly(candidates.get(0).rgb(), candidates.get(1).rgb(), candidates.get(2).rgb());
    }

    @Test
    void trustedPngSourceRestoresAndReencodesWhileRetainingCallerFrameMetadata() {
        ArtifactBinding binding = sourceBinding();
        Roi roi = new Roi(1, 0, 1, 1);
        List<PngFrameCodec.PngFrame> pngs = List.of(
                inputFrame(0, 0, roi, new byte[] {1, 2, 3, 4, 5, 6}),
                inputFrame(1, 1_001, roi, new byte[] {11, 12, 13, 40, 50, 60}),
                inputFrame(2, 3_003, roi, new byte[] {21, 22, 23, 70, 80, 90}));
        AtomicInteger reads = new AtomicInteger();
        DecodedFrameSource source = PngFrameCodec.asTrustedDecodedFrameSource(requested -> {
            reads.incrementAndGet();
            assertThat(requested).isEqualTo(binding);
            return PngFrameCodec.decodeSequence(TIME_BASE, pngs);
        });

        Result result = TemporalVideoRestoration.restore(
                new RestorationRequest("png-restore", binding),
                (requested, operation) -> new AuthorityDecision(AuthorityStatus.ALLOWED, "rights-v4"),
                source,
                Optional.empty(), null, null);

        assertThat(result.outcome()).isEqualTo(Outcome.COMPLETED);
        assertThat(reads).hasValue(1);
        Candidate candidate = result.candidate().orElseThrow();
        assertThat(candidate.timeBase()).isEqualTo(TIME_BASE);
        assertThat(candidate.frames()).extracting(CandidateFrame::frameIndex).containsExactly(0, 1, 2);
        assertThat(candidate.frames()).extracting(CandidateFrame::presentationTicks).containsExactly(0L, 1_001L, 3_003L);
        assertThat(candidate.frames()).extracting(CandidateFrame::roi).containsOnly(roi);
        assertThat(candidate.frames().get(1).rgb()).containsExactly(new byte[] {11, 12, 13, 40, 50, 60});
        assertThat(candidate.lineage().sourceArtifactId()).isEqualTo(binding.artifactId());
        assertThat(candidate.lineage().sourceVersionId()).isEqualTo(binding.versionId());
        assertThat(candidate.lineage().sourceSha256()).isEqualTo(binding.sha256());

        PngFrameCodec.EncodedPngFrameSequence output =
                PngFrameCodec.encodeSequence(candidate.timeBase(), candidate.frames());
        assertThat(output.timeBase()).isEqualTo(TIME_BASE);
        assertThat(output.frames()).extracting(frame -> frame.metadata().presentationTicks())
                .containsExactly(0L, 1_001L, 3_003L);
        assertThat(PngFrameCodec.decodeSequence(output.timeBase(), output.frames()).frames().get(1).rgb())
                .containsExactly(candidate.frames().get(1).rgb());
    }

    @Test
    void deniedRightsStopBeforeTrustedPngSourceIsRead() {
        AtomicInteger reads = new AtomicInteger();
        DecodedFrameSource source = PngFrameCodec.asTrustedDecodedFrameSource(binding -> {
            reads.incrementAndGet();
            throw new AssertionError("denied source must not be read");
        });

        Result result = TemporalVideoRestoration.restore(
                new RestorationRequest("png-denied", sourceBinding()),
                (binding, operation) -> new AuthorityDecision(AuthorityStatus.DENIED, ""),
                source,
                Optional.empty(), null, null);

        assertThat(result.outcome()).isEqualTo(Outcome.NOT_ADMITTED);
        assertThat(result.reason()).contains(Reason.SOURCE_RIGHTS_DENIED);
        assertThat(reads).hasValue(0);
    }

    @Test
    void candidateSequenceEnforcesActualIteratorAndAggregateOutputBounds() {
        Roi roi = new Roi(0, 0, 1, 1);
        CandidateFrame candidate = candidateFrame(0, 1, roi, new byte[] {1, 2, 3, 4, 5, 6});
        int[] yielded = {0};
        List<CandidateFrame> underreported = new AbstractList<>() {
            @Override public CandidateFrame get(int index) { throw new UnsupportedOperationException(); }
            @Override public int size() { return 3; }
            @Override public Iterator<CandidateFrame> iterator() {
                return new Iterator<>() {
                    @Override public boolean hasNext() { return yielded[0] < 100; }
                    @Override public CandidateFrame next() {
                        yielded[0]++;
                        return new CandidateFrame(yielded[0] - 1, yielded[0], 2, 1, roi,
                                candidate.rgb(), candidate.frameSha256());
                    }
                };
            }
        };

        assertThatThrownBy(() -> PngFrameCodec.encodeSequence(TIME_BASE, underreported))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("between 3 and 64 frames");
        assertThat(yielded[0]).isEqualTo(TemporalVideoRestoration.MAX_FRAMES);

        List<CandidateFrame> withinLimit = List.of(
                candidateFrame(0, 1, roi, new byte[] {1, 2, 3, 4, 5, 6}),
                candidateFrame(1, 2, roi, new byte[] {4, 5, 6, 7, 8, 9}),
                candidateFrame(2, 3, roi, new byte[] {7, 8, 9, 10, 11, 12}));
        PngFrameCodec.Limits tinyAggregate = new PngFrameCodec.Limits(1_000, 1_000, 10, 10, 10);
        assertThatThrownBy(() -> PngFrameCodec.encodeSequence(TIME_BASE, withinLimit, tinyAggregate))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("output bound");
    }

    @Test
    void rejectsTrailingBytesMalformedPngDimensionMismatchAndEncodedInputOverflow() throws Exception {
        byte[] valid = png(2, 1, new byte[] {1, 2, 3, 4, 5, 6});
        PngFrameCodec.FrameMetadata metadata = new PngFrameCodec.FrameMetadata(0, 0, 2, 1, new Roi(0, 0, 2, 1));
        byte[] trailing = java.util.Arrays.copyOf(valid, valid.length + 1);
        trailing[trailing.length - 1] = 42;

        assertThatThrownBy(() -> PngFrameCodec.decode(trailing, metadata))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("trailing bytes");
        assertThatThrownBy(() -> PngFrameCodec.decode(new byte[] {1, 2, 3}, metadata))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("not a PNG");
        assertThatThrownBy(() -> PngFrameCodec.decode(valid,
                new PngFrameCodec.FrameMetadata(0, 0, 1, 1, new Roi(0, 0, 1, 1))))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("dimensions do not match");
        assertThatThrownBy(() -> PngFrameCodec.decode(valid, metadata,
                new PngFrameCodec.Limits(valid.length - 1, 1_000, 10, 10, 10_000)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("encoded byte bound");
    }

    @Test
    void rejectsPixelLimitBeforeImageAllocationAndCapsEncodedOutput() {
        byte[] valid = png(2, 1, new byte[] {1, 2, 3, 4, 5, 6});
        PngFrameCodec.FrameMetadata metadata = new PngFrameCodec.FrameMetadata(0, 0, 2, 1, new Roi(0, 0, 2, 1));
        assertThatThrownBy(() -> PngFrameCodec.decode(valid, metadata,
                new PngFrameCodec.Limits(1_000, 1_000, 10, 1, 10_000)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("pixel or frame bounds");

        CandidateFrame candidate = new CandidateFrame(0, 0, 2, 1, metadata.roi(),
                new byte[] {1, 2, 3, 4, 5, 6}, sha256(new byte[] {1, 2, 3, 4, 5, 6}));
        assertThatThrownBy(() -> PngFrameCodec.encode(candidate,
                new PngFrameCodec.Limits(1_000, 8, 10, 10, 10_000)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("output bound");
    }

    @Test
    void defensivelyCopiesPngBuffers() {
        byte[] encoded = png(1, 1, new byte[] {8, 9, 10});
        byte[] expected = encoded.clone();
        PngFrameCodec.PngFrame input = new PngFrameCodec.PngFrame(encoded,
                new PngFrameCodec.FrameMetadata(0, 0, 1, 1, new Roi(0, 0, 1, 1)));
        encoded[0] = 0;
        byte[] returned = input.png();
        returned[0] = 0;
        assertThat(input.png()).containsExactly(expected);
    }

    @Test
    void rejectsAggregatePixelOverflowBeforeAttemptingToDecodeAnyFrame() {
        Roi fullFrame = new Roi(0, 0, 2_048, 2_048);
        List<PngFrameCodec.PngFrame> frames = List.of(
                new PngFrameCodec.PngFrame(new byte[] {1}, new PngFrameCodec.FrameMetadata(0, 1, 2_048, 2_048, fullFrame)),
                new PngFrameCodec.PngFrame(new byte[] {1}, new PngFrameCodec.FrameMetadata(1, 2, 2_048, 2_048, fullFrame)),
                new PngFrameCodec.PngFrame(new byte[] {1}, new PngFrameCodec.FrameMetadata(2, 3, 2_048, 2_048, fullFrame)),
                new PngFrameCodec.PngFrame(new byte[] {1}, new PngFrameCodec.FrameMetadata(3, 4, 2_048, 2_048, fullFrame)));

        assertThatThrownBy(() -> PngFrameCodec.decodeSequence(TIME_BASE, frames))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("aggregate pixel");
    }

    @Test
    void rejectsAggregateEncodedOverflowBeforeDecodingAnyFrame() {
        Roi roi = new Roi(0, 0, 2, 1);
        List<PngFrameCodec.PngFrame> frames = List.of(
                inputFrame(0, 1, roi, new byte[] {1, 2, 3, 4, 5, 6}),
                inputFrame(1, 2, roi, new byte[] {1, 2, 3, 4, 5, 6}),
                inputFrame(2, 3, roi, new byte[] {1, 2, 3, 4, 5, 6}));
        long encodedBytes = frames.stream().mapToLong(frame -> frame.png().length).sum();
        PngFrameCodec.Limits limits = new PngFrameCodec.Limits(1_000, 1_000, 10, 10, encodedBytes - 1);

        assertThatThrownBy(() -> PngFrameCodec.decodeSequence(TIME_BASE, frames, limits))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("aggregate encoded byte bound");
    }

    @Test
    void rejectsUnderreportedFrameListAfterReadingAtMostTheBoundedFrameCount() {
        int[] yielded = {0};
        PngFrameCodec.FrameMetadata metadata =
                new PngFrameCodec.FrameMetadata(0, 1, 1, 1, new Roi(0, 0, 1, 1));
        PngFrameCodec.PngFrame frame = new PngFrameCodec.PngFrame(new byte[] {1}, metadata);
        List<PngFrameCodec.PngFrame> underreported = new AbstractList<>() {
            @Override public PngFrameCodec.PngFrame get(int index) { throw new UnsupportedOperationException(); }
            @Override public int size() { return 3; }
            @Override public Iterator<PngFrameCodec.PngFrame> iterator() {
                return new Iterator<>() {
                    @Override public boolean hasNext() { return yielded[0] < 100; }
                    @Override public PngFrameCodec.PngFrame next() {
                        yielded[0]++;
                        return frame;
                    }
                };
            }
        };

        assertThatThrownBy(() -> PngFrameCodec.decodeSequence(TIME_BASE, underreported))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("between 3 and 64 frames");
        assertThat(yielded[0]).isEqualTo(TemporalVideoRestoration.MAX_FRAMES);
    }

    private static PngFrameCodec.PngFrame inputFrame(int index, long pts, Roi roi, byte[] rgb) {
        return new PngFrameCodec.PngFrame(png(2, 1, rgb),
                new PngFrameCodec.FrameMetadata(index, pts, 2, 1, roi));
    }

    private static CandidateFrame candidateFrame(int index, long pts, Roi roi, byte[] rgb) {
        return new CandidateFrame(index, pts, 2, 1, roi, rgb, sha256(rgb));
    }

    private static ArtifactBinding sourceBinding() {
        return new ArtifactBinding("tenant-a", "principal-a", "video-source", "revision-7", "a".repeat(64),
                "restore-purpose", List.of("rights-evidence-1"), "policy-decision-3");
    }

    private static byte[] png(int width, int height, byte[] rgb) {
        try {
            BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
            int[] row = new int[width];
            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) {
                    int offset = (y * width + x) * 3;
                    row[x] = (Byte.toUnsignedInt(rgb[offset]) << 16)
                            | (Byte.toUnsignedInt(rgb[offset + 1]) << 8) | Byte.toUnsignedInt(rgb[offset + 2]);
                }
                image.setRGB(0, y, width, 1, row, 0, width);
            }
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            ImageIO.write(image, "PNG", output);
            return output.toByteArray();
        } catch (Exception ex) {
            throw new AssertionError(ex);
        }
    }

    private static String sha256(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (Exception ex) { throw new AssertionError(ex); }
    }
}
