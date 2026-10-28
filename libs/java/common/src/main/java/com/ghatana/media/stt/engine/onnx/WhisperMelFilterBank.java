package com.ghatana.media.stt.engine.onnx;

import com.ghatana.media.common.ModelLoadingError;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Reads OpenAI Whisper's pinned, non-pickle mel filter bank asset. */
final class WhisperMelFilterBank {
    static final int MEL_BANDS = 80;
    static final int SPECTRUM_BINS = 201;
    static final long PINNED_SIZE_BYTES = 4_271L;
    static final String PINNED_SHA256 = "7450ae70723a5ef9d341e3cee628c7cb0177f36ce42c44b7ed2bf3325f0f6d4c";
    private static final int MAX_ASSET_BYTES = 64 * 1024;

    private WhisperMelFilterBank() { }

    static float[][] load(Path path) {
        try {
            long size = Files.size(path);
            if (size != PINNED_SIZE_BYTES || size > MAX_ASSET_BYTES) {
                throw new ModelLoadingError("Whisper mel filter asset has an unexpected size");
            }
            byte[] asset = Files.readAllBytes(path);
            if (asset.length != size || !PINNED_SHA256.equals(sha256(asset))) {
                throw new ModelLoadingError("Whisper mel filter asset SHA-256 does not match its source pin");
            }
            byte[] npy = readNpy80(asset);
            return parseNpy80(npy);
        } catch (IOException failure) {
            throw new ModelLoadingError("Unable to read Whisper mel filter asset", failure);
        }
    }

    static float[][] parseNpy80(byte[] npy) {
        if (npy == null || npy.length < 16 || npy[0] != (byte) 0x93
                || !Arrays.equals(Arrays.copyOfRange(npy, 1, 6), "NUMPY".getBytes(StandardCharsets.US_ASCII))) {
            throw new ModelLoadingError("Whisper mel filter NPY header is malformed");
        }
        int major = npy[6] & 0xff;
        int minor = npy[7] & 0xff;
        int headerLength;
        int prefixLength;
        if (major == 1 && minor == 0) {
            headerLength = ByteBuffer.wrap(npy, 8, 2).order(ByteOrder.LITTLE_ENDIAN).getShort() & 0xffff;
            prefixLength = 10;
        } else if (major == 2 && minor == 0) {
            headerLength = ByteBuffer.wrap(npy, 8, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
            prefixLength = 12;
        } else {
            throw new ModelLoadingError("Whisper mel filter NPY version is unsupported");
        }
        if (headerLength <= 0 || prefixLength + headerLength > npy.length) {
            throw new ModelLoadingError("Whisper mel filter NPY header length is invalid");
        }
        String header = new String(npy, prefixLength, headerLength, StandardCharsets.US_ASCII);
        if (!header.matches("(?s).*['\"]descr['\"]\\s*:\\s*['\"]<f4['\"].*"
                + "['\"]fortran_order['\"]\\s*:\\s*False.*"
                + "['\"]shape['\"]\\s*:\\s*\\(\\s*80\\s*,\\s*201\\s*\\).*")) {
            throw new ModelLoadingError("Whisper mel filter NPY dtype, order, or dimensions are unsupported");
        }
        int dataOffset = prefixLength + headerLength;
        int expectedDataBytes = MEL_BANDS * SPECTRUM_BINS * Float.BYTES;
        if (npy.length - dataOffset != expectedDataBytes) {
            throw new ModelLoadingError("Whisper mel filter NPY payload has an unexpected size");
        }
        ByteBuffer data = ByteBuffer.wrap(npy, dataOffset, expectedDataBytes).order(ByteOrder.LITTLE_ENDIAN);
        float[][] filters = new float[MEL_BANDS][SPECTRUM_BINS];
        for (int band = 0; band < MEL_BANDS; band++) {
            for (int bin = 0; bin < SPECTRUM_BINS; bin++) {
                float value = data.getFloat();
                if (!Float.isFinite(value) || value < 0) {
                    throw new ModelLoadingError("Whisper mel filter NPY contains an invalid coefficient");
                }
                filters[band][bin] = value;
            }
        }
        return filters;
    }

    private static byte[] readNpy80(byte[] asset) throws IOException {
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(asset))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if ("mel_80.npy".equals(entry.getName())) {
                    ByteArrayOutputStream output = new ByteArrayOutputStream();
                    byte[] block = new byte[4096];
                    int read;
                    while ((read = zip.read(block)) >= 0) {
                        if (output.size() + read > MAX_ASSET_BYTES) {
                            throw new ModelLoadingError("Whisper mel filter archive expansion exceeds its size bound");
                        }
                        output.write(block, 0, read);
                    }
                    return output.toByteArray();
                }
            }
            throw new ModelLoadingError("Whisper mel filter archive is missing mel_80.npy");
        }
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("JDK does not provide SHA-256", impossible);
        }
    }
}
