package com.ghatana.media.production.audio;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.common.AudioData;
import java.time.Duration;
import org.junit.jupiter.api.Test;

class BoundedPcmDeclipperTest {
    @Test
    void interpolates_short_interior_pcm16_run_without_mutating_source() {
        AudioData source = pcm16(new short[] {100, 32767, 32767, 400});
        byte[] original = source.data();

        AudioData repaired = BoundedPcmDeclipper.repair(source, 0.99, 2);

        assertThat(samples(repaired.data())).containsExactly(100, 200, 300, 400);
        assertThat(source.data()).containsExactly(original);
        assertThat(repaired.data()).isNotEqualTo(original);
        assertThat(repaired.duration()).isEqualTo(source.duration());
    }

    @Test
    void repairs_channels_independently_and_keeps_unclipped_channel_exact() {
        AudioData source = pcm16Stereo(new short[] {100, 20, 32767, 30, 32767, 40, 400, 50});

        AudioData repaired = BoundedPcmDeclipper.repair(source, 0.99, 2);
        short[] samples = samples(repaired.data());

        assertThat(samples).containsExactly(100, 20, 200, 30, 300, 40, 400, 50);
    }

    @Test
    void interpolates_signed_little_endian_pcm24_at_positive_and_negative_full_scale() {
        AudioData source = pcm24(new int[] {100, 8_388_607, 8_388_607, 400,
                -100, -8_388_608, -8_388_608, -400});

        AudioData repaired = BoundedPcmDeclipper.repair(source, 0.99, 2);

        assertThat(samples24(repaired.data())).containsExactly(100, 200, 300, 400,
                -100, -200, -300, -400);
        assertThat(samples24(source.data())).containsExactly(100, 8_388_607, 8_388_607, 400,
                -100, -8_388_608, -8_388_608, -400);
    }

    @Test
    void interpolates_signed_little_endian_pcm32_at_positive_and_negative_full_scale() {
        AudioData source = pcm32(new int[] {100, Integer.MAX_VALUE, Integer.MAX_VALUE, 400,
                -100, Integer.MIN_VALUE, Integer.MIN_VALUE, -400});

        AudioData repaired = BoundedPcmDeclipper.repair(source, 0.99, 2);

        assertThat(samples32(repaired.data())).containsExactly(100, 200, 300, 400,
                -100, -200, -300, -400);
        assertThat(samples32(source.data())).containsExactly(100, Integer.MAX_VALUE, Integer.MAX_VALUE, 400,
                -100, Integer.MIN_VALUE, Integer.MIN_VALUE, -400);
    }

    @Test
    void preserves_samples_below_the_threshold_boundary() {
        AudioData source = pcm16(new short[] {10, 32_439, -32_439, 20});

        AudioData repaired = BoundedPcmDeclipper.repair(source, 0.99, 2);

        assertThat(repaired.data()).containsExactly(source.data());
    }

    @Test
    void rejects_edge_and_over_budget_clipped_runs_with_typed_error() {
        assertCode(pcm16(new short[] {32767, 10, 20}), 0.99, 2,
                BoundedPcmDeclipper.ErrorCode.UNREPAIRABLE_RUN);
        assertCode(pcm16(new short[] {10, 32767, 32767, 32767, 20}), 0.99, 2,
                BoundedPcmDeclipper.ErrorCode.UNREPAIRABLE_RUN);
    }

    @Test
    void failed_edge_repair_keeps_source_pcm_recoverable_for_ab_undo() {
        AudioData source = pcm16(new short[] {120, 900, 32767, 32767});
        byte[] original = source.data();

        assertThatThrownBy(() -> BoundedPcmDeclipper.repair(source, 0.99, 2))
                .isInstanceOf(BoundedPcmDeclipper.RepairException.class)
                .extracting(error -> ((BoundedPcmDeclipper.RepairException) error).code())
                .isEqualTo(BoundedPcmDeclipper.ErrorCode.UNREPAIRABLE_RUN);

        assertThat(source.data()).containsExactly(original);
        AudioRepairComparison comparison = AudioRepairComparison.compare(source, source);
        assertThat(comparison.sourceSha256()).isEqualTo(comparison.repairedSha256());
        assertThat(comparison.undo().data()).containsExactly(original);
    }

    @Test
    void rejects_incomplete_frames_and_unsupported_depth() {
        AudioData incomplete = new AudioData(new byte[] {1}, 48_000, 1, 16);
        assertCode(incomplete, 0.99, 2, BoundedPcmDeclipper.ErrorCode.INVALID_INPUT);
        AudioData unsupported = new AudioData(new byte[] {1, 2}, 48_000, 1, 8);
        assertCode(unsupported, 0.99, 2, BoundedPcmDeclipper.ErrorCode.UNSUPPORTED_FORMAT);
    }

    @Test
    void validates_parameter_bounds() {
        assertCode(pcm16(new short[] {10, 20}), Double.NaN, 2,
                BoundedPcmDeclipper.ErrorCode.INVALID_INPUT);
        assertCode(pcm16(new short[] {10, 20}), 0.99, BoundedPcmDeclipper.MAX_RUN_FRAMES + 1,
                BoundedPcmDeclipper.ErrorCode.INVALID_INPUT);
    }

    private static void assertCode(AudioData input, double threshold, int maxRun,
                                   BoundedPcmDeclipper.ErrorCode code) {
        assertThatThrownBy(() -> BoundedPcmDeclipper.repair(input, threshold, maxRun))
                .isInstanceOf(BoundedPcmDeclipper.RepairException.class)
                .extracting(error -> ((BoundedPcmDeclipper.RepairException) error).code())
                .isEqualTo(code);
    }

    private static AudioData pcm16(short[] values) {
        byte[] bytes = new byte[values.length * 2];
        for (int index = 0; index < values.length; index++) {
            bytes[index * 2] = (byte) values[index];
            bytes[index * 2 + 1] = (byte) (values[index] >>> 8);
        }
        return new AudioData(bytes, 48_000, 1, 16,
                Duration.ofNanos((values.length * 1_000_000_000L + 24_000) / 48_000),
                com.ghatana.media.common.AudioFormat.PCM);
    }

    private static AudioData pcm16Stereo(short[] values) {
        byte[] bytes = new byte[values.length * 2];
        for (int index = 0; index < values.length; index++) {
            bytes[index * 2] = (byte) values[index];
            bytes[index * 2 + 1] = (byte) (values[index] >>> 8);
        }
        return new AudioData(bytes, 48_000, 2, 16,
                Duration.ofNanos((values.length / 2 * 1_000_000_000L + 24_000) / 48_000),
                com.ghatana.media.common.AudioFormat.PCM);
    }

    private static AudioData pcm24(int[] values) {
        byte[] bytes = new byte[values.length * 3];
        for (int index = 0; index < values.length; index++) {
            int value = values[index];
            bytes[index * 3] = (byte) value;
            bytes[index * 3 + 1] = (byte) (value >>> 8);
            bytes[index * 3 + 2] = (byte) (value >>> 16);
        }
        return new AudioData(bytes, 48_000, 1, 24,
                Duration.ofNanos((values.length * 1_000_000_000L + 24_000) / 48_000),
                com.ghatana.media.common.AudioFormat.PCM);
    }

    private static AudioData pcm32(int[] values) {
        byte[] bytes = new byte[values.length * 4];
        for (int index = 0; index < values.length; index++) {
            int value = values[index];
            bytes[index * 4] = (byte) value;
            bytes[index * 4 + 1] = (byte) (value >>> 8);
            bytes[index * 4 + 2] = (byte) (value >>> 16);
            bytes[index * 4 + 3] = (byte) (value >>> 24);
        }
        return new AudioData(bytes, 48_000, 1, 32,
                Duration.ofNanos((values.length * 1_000_000_000L + 24_000) / 48_000),
                com.ghatana.media.common.AudioFormat.PCM);
    }

    private static short[] samples(byte[] bytes) {
        short[] result = new short[bytes.length / 2];
        for (int index = 0; index < result.length; index++) {
            result[index] = (short) ((bytes[index * 2] & 0xff) | (bytes[index * 2 + 1] << 8));
        }
        return result;
    }

    private static int[] samples24(byte[] bytes) {
        int[] result = new int[bytes.length / 3];
        for (int index = 0; index < result.length; index++) {
            int offset = index * 3;
            int value = (bytes[offset] & 0xff) | ((bytes[offset + 1] & 0xff) << 8)
                    | ((bytes[offset + 2] & 0xff) << 16);
            result[index] = (value << 8) >> 8;
        }
        return result;
    }

    private static int[] samples32(byte[] bytes) {
        int[] result = new int[bytes.length / 4];
        for (int index = 0; index < result.length; index++) {
            int offset = index * 4;
            result[index] = (bytes[offset] & 0xff) | ((bytes[offset + 1] & 0xff) << 8)
                    | ((bytes[offset + 2] & 0xff) << 16) | (bytes[offset + 3] << 24);
        }
        return result;
    }
}
