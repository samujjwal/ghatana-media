package com.ghatana.media.stt.engine.onnx;

import com.ghatana.media.common.ModelLoadingError;
import org.junit.jupiter.api.Test;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WhisperMelFilterBankTest {
    @Test
    void readsExactLittleEndianFloat32Mel80Shape() {
        byte[] npy = npy("<f4", 80, 201, 0.25f);
        float[][] filters = WhisperMelFilterBank.parseNpy80(npy);

        assertThat(filters).hasDimensions(80, 201);
        assertThat(filters[0][0]).isEqualTo(0.25f);
        assertThat(filters[79][200]).isEqualTo(0.25f);
    }

    @Test
    void rejectsUnsupportedDtypeShapeAndNonFiniteWeights() {
        assertThatThrownBy(() -> WhisperMelFilterBank.parseNpy80(npy(">f4", 80, 201, 0.25f)))
                .isInstanceOf(ModelLoadingError.class).hasMessageContaining("dtype");
        assertThatThrownBy(() -> WhisperMelFilterBank.parseNpy80(npy("<f4", 80, 200, 0.25f)))
                .isInstanceOf(ModelLoadingError.class).hasMessageContaining("dimensions");
        assertThatThrownBy(() -> WhisperMelFilterBank.parseNpy80(npy("<f4", 80, 201, Float.NaN)))
                .isInstanceOf(ModelLoadingError.class).hasMessageContaining("invalid coefficient");
    }

    private static byte[] npy(String descriptor, int bands, int bins, float value) {
        String rawHeader = "{'descr': '" + descriptor + "', 'fortran_order': False, 'shape': ("
                + bands + ", " + bins + "), }";
        int padding = 16 - ((10 + rawHeader.length() + 1) % 16);
        String header = rawHeader + " ".repeat(padding) + "\n";
        byte[] headerBytes = header.getBytes(StandardCharsets.US_ASCII);
        int dataLength = bands * bins * Float.BYTES;
        ByteBuffer buffer = ByteBuffer.allocate(10 + headerBytes.length + dataLength)
                .order(ByteOrder.LITTLE_ENDIAN);
        buffer.put((byte) 0x93).put("NUMPY".getBytes(StandardCharsets.US_ASCII));
        buffer.put((byte) 1).put((byte) 0);
        buffer.putShort((short) headerBytes.length).put(headerBytes);
        for (int i = 0; i < bands * bins; i++) buffer.putFloat(value);
        return buffer.array();
    }
}
