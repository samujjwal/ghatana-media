package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaDevDubTiming.Fit;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Pure fit/assembly rules of the DEV_ONLY dubbing lane; the audio is synthetic constant-amplitude samples. */
class MediaDevDubTimingTest {
    /** Constant-amplitude audio of the given duration at 24 kHz. */
    static short[] tone(long millis, short amplitude) {
        short[] samples = new short[MediaDevDubTiming.samplesFor(millis)];
        java.util.Arrays.fill(samples, amplitude);
        return samples;
    }

    /** A tempo adjuster that compresses by dropping samples (no encoder involved), recording each requested factor. */
    static final class DroppingAdjuster implements MediaDevDubTiming.TempoAdjuster {
        final java.util.List<Double> factors = new java.util.ArrayList<>();

        @Override public short[] adjust(short[] samples, double tempo) throws IOException {
            factors.add(tempo);
            short[] out = new short[(int) Math.floor(samples.length / tempo)];
            for (int i = 0; i < out.length; i++) out[i] = samples[(int) Math.min(samples.length - 1, Math.round(i * tempo))];
            return out;
        }
    }

    @Test
    void aSegmentThatFitsIsPlacedUnchangedAtItsWindowStart() throws Exception {
        var placed = MediaDevDubTiming.fit(new MediaDevDubTiming.Segment("seg-0001", 1000, 4000, tone(2500, (short) 500)),
                new DroppingAdjuster());
        assertThat(placed.fit()).isEqualTo(Fit.FITS);
        assertThat(placed.tempoFactor()).isEqualTo(1.0);
        assertThat(placed.naturalMillis()).isEqualTo(2500);
        assertThat(placed.dubMillis()).isEqualTo(2500);
        assertThat(placed.placedStartMillis()).isEqualTo(1000);
        assertThat(placed.placedEndMillis()).isEqualTo(3500);
        assertThat(placed.windowMillis()).isEqualTo(3000);
        assertThat(placed.overflow()).isFalse();
    }

    @Test
    void aSlightlyLongSegmentIsSpedUpByABoundedTempoThatMakesItFit() throws Exception {
        DroppingAdjuster adjuster = new DroppingAdjuster();
        var placed = MediaDevDubTiming.fit(new MediaDevDubTiming.Segment("seg-0001", 0, 2000, tone(2400, (short) 500)), adjuster);
        assertThat(placed.fit()).isEqualTo(Fit.TEMPO_ADJUSTED);
        assertThat(placed.tempoFactor()).isBetween(1.19, 1.25);
        assertThat(placed.dubMillis()).isLessThanOrEqualTo(2000);
        assertThat(placed.naturalMillis()).isEqualTo(2400);
        assertThat(placed.overflowMillis()).isZero();
        assertThat(adjuster.factors).allSatisfy(factor -> assertThat(factor).isBetween(1.0, MediaDevDubTiming.MAX_TEMPO));
    }

    @Test
    void theTempoBoundIsExactAndAnythingBeyondItIsOverflowNeverTruncation() throws Exception {
        DroppingAdjuster adjuster = new DroppingAdjuster();
        var placed = MediaDevDubTiming.fit(new MediaDevDubTiming.Segment("seg-0001", 0, 2000, tone(4000, (short) 500)), adjuster);
        assertThat(placed.fit()).isEqualTo(Fit.OVERFLOW);
        assertThat(placed.tempoFactor()).isEqualTo(MediaDevDubTiming.MAX_TEMPO);
        assertThat(placed.naturalMillis()).isEqualTo(4000);
        assertThat(placed.dubMillis()).as("the sped-up audio is kept whole: 4000 / 1.25").isEqualTo(3200);
        assertThat(placed.samples()).hasSize(MediaDevDubTiming.samplesFor(3200));
        assertThat(placed.overflowMillis()).isEqualTo(1200);
        assertThat(placed.overflow()).isTrue();
    }

    @Test
    void withoutATempoAdjusterALongSegmentIsOverflowAtTempoOne() throws Exception {
        var placed = MediaDevDubTiming.fit(new MediaDevDubTiming.Segment("seg-0001", 0, 2000, tone(2400, (short) 500)), null);
        assertThat(placed.fit()).isEqualTo(Fit.OVERFLOW);
        assertThat(placed.tempoFactor()).isEqualTo(1.0);
        assertThat(placed.dubMillis()).isEqualTo(2400);
        assertThat(placed.overflowMillis()).isEqualTo(400);
    }

    @Test
    void theRefusePolicyRefusesEveryOverflowAndSpillOnlyRefusesACollision() throws Exception {
        DroppingAdjuster adjuster = new DroppingAdjuster();
        var first = MediaDevDubTiming.fit(new MediaDevDubTiming.Segment("seg-0001", 0, 2000, tone(4000, (short) 500)), adjuster);
        var second = MediaDevDubTiming.fit(new MediaDevDubTiming.Segment("seg-0002", 3000, 5000, tone(1000, (short) 700)), adjuster);
        assertThat(MediaDevDubTiming.unaccommodated(List.of(first, second), false)).singleElement()
                .satisfies(overflow -> {
                    assertThat(overflow.segmentId()).isEqualTo("seg-0001");
                    assertThat(overflow.reason()).isEqualTo("EXCEEDS_WINDOW_AT_MAX_TEMPO");
                    assertThat(overflow.requiredTempo()).isEqualTo(2.0);
                });
        // Spill: 3200 ms of audio from 0 ends at 3200 ms, after the next window starts at 3000 ms: a collision.
        assertThat(MediaDevDubTiming.unaccommodated(List.of(first, second), true)).singleElement()
                .satisfies(overflow -> assertThat(overflow.reason()).isEqualTo("SPILL_COLLIDES_WITH_NEXT_SEGMENT"));
        var spaced = MediaDevDubTiming.fit(new MediaDevDubTiming.Segment("seg-0002", 3300, 5000, tone(1000, (short) 700)), adjuster);
        assertThat(MediaDevDubTiming.unaccommodated(List.of(first, spaced), true)).isEmpty();
    }

    @Test
    void assemblyPlacesEachSegmentAtItsSourceWindowStartWithSilenceBetween() throws Exception {
        var a = MediaDevDubTiming.fit(new MediaDevDubTiming.Segment("seg-0001", 500, 1500, tone(800, (short) 1000)), null);
        var b = MediaDevDubTiming.fit(new MediaDevDubTiming.Segment("seg-0002", 2000, 3000, tone(900, (short) 2000)), null);
        short[] track = MediaDevDubTiming.assemble(List.of(a, b), 3000);
        assertThat(MediaDevDubTiming.millis(track.length)).isBetween(3000L, 3001L);
        assertThat(track[MediaDevDubTiming.samplesFor(499)]).isZero();
        assertThat(track[MediaDevDubTiming.samplesFor(500)]).isEqualTo((short) 1000);
        assertThat(track[MediaDevDubTiming.samplesFor(1299)]).isEqualTo((short) 1000);
        assertThat(track[MediaDevDubTiming.samplesFor(1500)]).as("silence in the gap").isZero();
        assertThat(track[MediaDevDubTiming.samplesFor(1999)]).isZero();
        assertThat(track[MediaDevDubTiming.samplesFor(2000)]).isEqualTo((short) 2000);
        assertThat(track[MediaDevDubTiming.samplesFor(2899)]).isEqualTo((short) 2000);
        assertThat(track[MediaDevDubTiming.samplesFor(2950)]).isZero();
    }

    @Test
    void overlappingSegmentsAreSummedWithClippingNotWrapped() throws Exception {
        var a = MediaDevDubTiming.fit(new MediaDevDubTiming.Segment("seg-0001", 0, 1000, tone(1000, (short) 30000)), null);
        var b = MediaDevDubTiming.fit(new MediaDevDubTiming.Segment("seg-0002", 0, 1000, tone(1000, (short) 30000)), null);
        short[] track = MediaDevDubTiming.assemble(List.of(a, b), 1000);
        assertThat(track[100]).isEqualTo(Short.MAX_VALUE);
    }

    @Test
    void wavEncodingRoundTripsAndOnlyMono24kPcm16IsDecoded() {
        short[] samples = {0, 1, -1, 32767, -32768};
        byte[] wav = MediaDevDubTiming.encodeWav(samples);
        assertThat(wav).hasSize(44 + 10);
        assertThat(MediaDevDubTiming.decodeWav(wav)).containsExactly(samples);
        byte[] stereo = wav.clone();
        stereo[22] = 2;
        assertThatThrownBy(() -> MediaDevDubTiming.decodeWav(stereo)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MediaDevDubTiming.decodeWav(new byte[10])).isInstanceOf(IllegalArgumentException.class);
        byte[] wrongRate = wav.clone();
        wrongRate[24] = 0;
        assertThatThrownBy(() -> MediaDevDubTiming.decodeWav(wrongRate)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aProvenanceCommentChunkMakesBytesDifferWithoutTouchingTheSamples() throws Exception {
        short[] samples = {0, 5, -5, 1000, 0};
        byte[] plain = MediaDevDubTiming.encodeWav(samples);
        byte[] first = MediaDevDubTiming.encodeWav(samples, "media.dev.dub request=a translation=x");
        byte[] second = MediaDevDubTiming.encodeWav(samples, "media.dev.dub request=b translation=x");
        assertThat(first).isNotEqualTo(plain).isNotEqualTo(second);
        assertThat(MediaDevDubTiming.decodeWav(first)).containsExactly(samples);
        assertThat(MediaDevDubTiming.decodeWav(second)).containsExactly(samples);
        // The data chunk bytes are identical and the declared RIFF size covers the trailing chunk.
        assertThat(java.util.Arrays.copyOfRange(first, 44, 54)).isEqualTo(java.util.Arrays.copyOfRange(plain, 44, 54));
        assertThat(java.nio.ByteBuffer.wrap(first).order(java.nio.ByteOrder.LITTLE_ENDIAN).getInt(4)).isEqualTo(first.length - 8);
    }

    @Test
    void emptyOrNonPositiveWindowsAndOversizedTracksAreRefused() {
        assertThatThrownBy(() -> MediaDevDubTiming.fit(new MediaDevDubTiming.Segment("s", 1000, 1000, tone(100, (short) 1)), null))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MediaDevDubTiming.assemble(List.of(), MediaDevDubTiming.MAX_TRACK_MILLIS + 1))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
