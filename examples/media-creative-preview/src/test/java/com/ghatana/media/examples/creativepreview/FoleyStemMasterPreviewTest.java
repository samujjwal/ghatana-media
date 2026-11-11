package com.ghatana.media.examples.creativepreview;

import com.ghatana.media.production.audio.PcmStemMixer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.sound.sampled.AudioFileFormat;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import java.io.ByteArrayInputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HexFormat;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class FoleyStemMasterPreviewTest {
    private static final int RATE = 48_000;
    private static final Instant NOW = Instant.parse("2026-11-09T20:00:00Z");
    private static final Clock CLOCK = Clock.fixed(NOW, ZoneOffset.UTC);
    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir Path tempDir;

    @Test
    void mixesCallerStemsWritesPlayableMasterAndBindsPersistedInputsAndMetrics() throws Exception {
        Path first = tempDir.resolve("foley-a.wav");
        Path second = tempDir.resolve("foley-b.wav");
        byte[] firstPcm = pcm(10_000, -10_000, 6_000, -6_000, 0, 0, 1_000, -1_000);
        byte[] secondPcm = pcm(5_000, -5_000, -2_000, 2_000, 0, 0, 3_000, -3_000);
        writeWav(first, firstPcm, RATE);
        writeWav(second, secondPcm, RATE);
        byte[] firstWav = Files.readAllBytes(first);
        byte[] secondWav = Files.readAllBytes(second);
        Path request = request(4, List.of(stem("foley-a.wav", "foley/a@v1", "1.0", "0.0", "decision/a"),
                stem("foley-b.wav", "foley/b@v2", "0.5", "-0.25", "decision/b")));
        Path output = tempDir.resolve("master-output");

        FoleyStemMasterPreview.run(request, output, CLOCK);

        Path master = output.resolve("foley-master.wav");
        byte[] masterWav = Files.readAllBytes(master);
        byte[] masterPcm = decodeWav(master);
        assertEquals(sha256(firstWav), sha256(Files.readAllBytes(first)));
        assertEquals(sha256(secondWav), sha256(Files.readAllBytes(second)));
        assertEquals(4, masterPcm.length / 4);

        try (AudioInputStream decoded = AudioSystem.getAudioInputStream(master.toFile())) {
            assertEquals(AudioFileFormat.Type.WAVE, AudioSystem.getAudioFileFormat(master.toFile()).getType());
            assertEquals(RATE, decoded.getFormat().getSampleRate());
            assertEquals(2, decoded.getFormat().getChannels());
            assertEquals(16, decoded.getFormat().getSampleSizeInBits());
            assertEquals(4, decoded.getFrameLength());
        }

        JsonNode manifest = JSON.readTree(output.resolve("foley-master-manifest.json").toFile());
        assertEquals("LOCAL_FOLEY_STEM_MASTER_PREVIEW_ONLY", manifest.path("kind").asString());
        assertEquals("CALLER_DECLARED_UNVERIFIED", manifest.path("rightsAuthority").asString());
        assertEquals(2, manifest.path("inputs").size());
        assertEquals(sha256(firstWav), manifest.path("inputs").get(0).path("wavSha256").asString());
        assertEquals(sha256(firstPcm), manifest.path("inputs").get(0).path("pcmSha256").asString());
        assertEquals("CALLER_DECLARED_UNVERIFIED",
                manifest.path("inputs").get(0).path("rightsDeclaration").path("authority").asString());
        assertEquals(sha256(masterWav), manifest.path("output").path("wavSha256").asString());
        assertEquals(sha256(masterPcm), manifest.path("readback").path("pcmSha256").asString());
        JsonNode metrics = manifest.path("mix").path("metrics");
        assertEquals("BS.1770-5 Annex 2-based 4x FIR estimate; not standards-certified",
                metrics.path("truePeakMethod").asString());
        assertEquals("itu-r-bs.1770-5-annex-2-4x-fir-plus-sample-peak-estimate",
                metrics.path("annex2TruePeakBeforeCeiling").path("methodId").asString());
        assertEquals("48-order-4-phase-table-v1",
                metrics.path("annex2TruePeakBeforeCeiling").path("methodVersion").asString());
        assertEquals("zero-extension-including-fir-tail",
                metrics.path("annex2TruePeakBeforeCeiling").path("edgePolicy").asString());
        assertTruePeakComponents(metrics.path("annex2TruePeakBeforeCeiling"));
        assertTruePeakComponents(metrics.path("annex2TruePeakAfterCeiling"));
        assertEquals(metrics.path("estimatedTruePeakBeforeCeiling").doubleValue(),
                metrics.path("windowedSincTruePeakEstimateBeforeCeiling").doubleValue());
        assertEquals(metrics.path("estimatedTruePeakAfterCeiling").doubleValue(),
                metrics.path("windowedSincTruePeakEstimateAfterCeiling").doubleValue());
        assertFalse(manifest.path("limitations").isEmpty());
    }

    @Test
    void rendersSilenceAsSilenceAndUsesNullForUndefinedRms() throws Exception {
        Path input = tempDir.resolve("silence.wav");
        writeWav(input, new byte[16], RATE);
        Path request = request(4, List.of(stem("silence.wav", "foley/silence@v1", "1.0", "0.0", "decision/silence")));
        Path output = tempDir.resolve("silence-output");

        FoleyStemMasterPreview.run(request, output, CLOCK);

        assertArrayEquals(new byte[16], decodeWav(output.resolve("foley-master.wav")));
        JsonNode metrics = JSON.readTree(output.resolve("foley-master-manifest.json").toFile())
                .path("mix").path("metrics");
        assertTrue(metrics.path("rmsIsSilence").asBoolean());
        assertTrue(metrics.path("rmsDbfsAfterCeiling").isNull());
        assertEquals(0.0, metrics.path("estimatedTruePeakAfterCeiling").doubleValue());
        JsonNode annex2Before = metrics.path("annex2TruePeakBeforeCeiling");
        JsonNode annex2After = metrics.path("annex2TruePeakAfterCeiling");
        assertEquals(0.0, annex2Before.path("linear").doubleValue());
        assertEquals(0.0, annex2After.path("linear").doubleValue());
        assertEquals(0.0, annex2Before.path("samplePeakLinear").doubleValue());
        assertEquals(0.0, annex2Before.path("oversampledFirPeakLinear").doubleValue());
        assertEquals(0.0, annex2After.path("samplePeakLinear").doubleValue());
        assertEquals(0.0, annex2After.path("oversampledFirPeakLinear").doubleValue());
        assertTrue(annex2Before.path("dbTp").isNull());
        assertTrue(annex2After.path("dbTp").isNull());
        assertTrue(annex2Before.path("isSilence").asBoolean());
        assertTrue(annex2After.path("isSilence").asBoolean());
    }

    @Test
    void limitsHotCallerStemsWithoutClippingThePersistedMaster() throws Exception {
        Path first = tempDir.resolve("hot-a.wav");
        Path second = tempDir.resolve("hot-b.wav");
        writeWav(first, pcm(Short.MAX_VALUE, Short.MIN_VALUE, Short.MAX_VALUE, Short.MIN_VALUE,
                Short.MAX_VALUE, Short.MIN_VALUE, Short.MAX_VALUE, Short.MIN_VALUE), RATE);
        writeWav(second, pcm(Short.MAX_VALUE, Short.MIN_VALUE, Short.MAX_VALUE, Short.MIN_VALUE,
                Short.MAX_VALUE, Short.MIN_VALUE, Short.MAX_VALUE, Short.MIN_VALUE), RATE);
        Path request = request(4, List.of(stem("hot-a.wav", "foley/hot-a@v1", "1.0", "0.0", "decision/hot-a"),
                stem("hot-b.wav", "foley/hot-b@v1", "1.0", "0.0", "decision/hot-b")));
        Path output = tempDir.resolve("hot-output");

        FoleyStemMasterPreview.run(request, output, CLOCK);

        byte[] pcm = decodeWav(output.resolve("foley-master.wav"));
        ByteBuffer samples = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN);
        while (samples.hasRemaining()) {
            int sample = Math.abs((int) samples.getShort());
            assertTrue(sample < Short.MAX_VALUE, "master has no full-scale/clipped sample");
            assertTrue(sample / 32768.0 <= 0.95, "quantized samples respect the requested ceiling");
        }
        JsonNode metrics = JSON.readTree(output.resolve("foley-master-manifest.json").toFile())
                .path("mix").path("metrics");
        assertTrue(metrics.path("appliedMasterGain").floatValue() < 1.0f);
        assertTrue(metrics.path("estimatedTruePeakAfterCeiling").doubleValue() <= 0.95);
        JsonNode truePeakAfter = metrics.path("annex2TruePeakAfterCeiling");
        assertTruePeakComponents(truePeakAfter);
        assertTrue(truePeakAfter.path("samplePeakLinear").doubleValue() <= 0.95);
        assertTrue(truePeakAfter.path("oversampledFirPeakLinear").doubleValue() <= 0.95);
        assertTrue(truePeakAfter.path("linear").doubleValue() <= 0.95);
        assertEquals(samplePeak(pcm), metrics.path("samplePeakAfterCeiling").doubleValue());
        assertTrue(samplePeak(pcm) <= 0.95);
    }

    @Test
    void rejectsFrameMismatchAndMalformedOrUnsupportedWaveBeforeCreatingOutputs() throws Exception {
        Path input = tempDir.resolve("short.wav");
        writeWav(input, new byte[8], RATE);
        Path request = request(5, List.of(stem("short.wav", "foley/short@v1", "1.0", "0.0", "decision/short")));
        Path output = tempDir.resolve("mismatch-output");
        assertThrows(java.io.IOException.class, () -> FoleyStemMasterPreview.run(request, output, CLOCK));
        assertFalse(Files.exists(output.resolve("foley-master.wav")));

        Path wrongRate = tempDir.resolve("wrong-rate.wav");
        writeWav(wrongRate, new byte[16], 44_100);
        Path wrongRateRequest = request(4, List.of(stem("wrong-rate.wav", "foley/wrong-rate@v1", "1.0", "0.0", "decision/rate")));
        Path wrongRateOutput = tempDir.resolve("wrong-rate-output");
        assertThrows(java.io.IOException.class, () -> FoleyStemMasterPreview.run(wrongRateRequest, wrongRateOutput, CLOCK));
        assertFalse(Files.exists(wrongRateOutput.resolve("foley-master.wav")));

        Path invalid = tempDir.resolve("not-wave.wav");
        Files.writeString(invalid, "not a WAV", StandardCharsets.UTF_8);
        Path malformedRequest = request(4, List.of(stem("not-wave.wav", "foley/not-wave@v1", "1.0", "0.0", "decision/no-wave")));
        Path malformedOutput = tempDir.resolve("malformed-output");
        assertThrows(java.io.IOException.class, () -> FoleyStemMasterPreview.run(malformedRequest, malformedOutput, CLOCK));
        assertFalse(Files.exists(malformedOutput.resolve("foley-master.wav")));

        Path duplicateFields = tempDir.resolve("duplicate-fields.json");
        Files.writeString(duplicateFields,
                "{\"sampleRateHz\":48000,\"sampleRateHz\":44100,\"frameCount\":4,"
                        + "\"truePeakCeiling\":0.95,\"stems\":[]}", StandardCharsets.UTF_8);
        assertThrows(java.io.IOException.class, () -> FoleyStemMasterPreview.run(
                duplicateFields, tempDir.resolve("duplicate-fields-output"), CLOCK));

        Path trailingJson = tempDir.resolve("trailing-json.json");
        Files.writeString(trailingJson,
                "{\"sampleRateHz\":48000,\"frameCount\":4,\"truePeakCeiling\":0.95,\"stems\":[]} {}",
                StandardCharsets.UTF_8);
        assertThrows(java.io.IOException.class, () -> FoleyStemMasterPreview.run(
                trailingJson, tempDir.resolve("trailing-json-output"), CLOCK));
    }

    @Test
    void rejectsStaleUnknownAndDeniedRightsBeforeCreatingAnyMaster() throws Exception {
        Path input = tempDir.resolve("rights.wav");
        writeWav(input, new byte[16], RATE);
        for (String[] rights : new String[][] {
                {"UNKNOWN", "2026-11-09T19:00:00Z", "2026-11-09T21:00:00Z"},
                {"DENIED", "2026-11-09T19:00:00Z", "2026-11-09T21:00:00Z"},
                {"CLEARED", "2026-11-09T18:00:00Z", "2026-11-09T19:00:00Z"}
        }) {
            Path request = request(4, List.of(stem("rights.wav", "foley/rights@v1", "1.0", "0.0",
                    "decision/rights", rights[0], rights[1], rights[2])));
            Path output = tempDir.resolve("rights-output-" + rights[0] + "-" + rights[2]);
            var failure = assertThrows(PcmStemMixer.MixException.class,
                    () -> FoleyStemMasterPreview.run(request, output, CLOCK));
            assertEquals(rights[0].equals("CLEARED")
                            ? PcmStemMixer.ErrorCode.RIGHTS_STALE : PcmStemMixer.ErrorCode.RIGHTS_DENIED,
                    failure.code());
            assertFalse(Files.exists(output.resolve("foley-master.wav")));
        }
    }

    @Test
    void rejectsFrameAndStemBudgetsBeforeOutputAndPreservesExistingOutputs() throws Exception {
        Path input = tempDir.resolve("budget.wav");
        writeWav(input, new byte[16], RATE);
        Path tooManyFrames = request(1_000_001, List.of(stem("budget.wav", "foley/budget@v1", "1.0", "0.0", "decision/budget")));
        Path rejected = tempDir.resolve("budget-rejected");
        assertThrows(java.io.IOException.class, () -> FoleyStemMasterPreview.run(tooManyFrames, rejected, CLOCK));
        assertFalse(Files.exists(rejected.resolve("foley-master.wav")));

        Path oversized = tempDir.resolve("oversized.wav");
        Files.write(oversized, new byte[PcmStemMixer.MAX_STEM_PCM_BYTES + 64 * 1024 + 1]);
        Path oversizedRequest = request(4, List.of(stem("oversized.wav", "foley/oversized@v1", "1.0", "0.0", "decision/oversized")));
        Path oversizedRejected = tempDir.resolve("oversized-rejected");
        assertThrows(java.io.IOException.class, () -> FoleyStemMasterPreview.run(oversizedRequest, oversizedRejected, CLOCK));
        assertFalse(Files.exists(oversizedRejected.resolve("foley-master.wav")));

        Path output = tempDir.resolve("occupied");
        Files.createDirectories(output);
        Path existingMaster = output.resolve("foley-master.wav");
        byte[] sentinel = new byte[] {9, 8, 7};
        Files.write(existingMaster, sentinel);
        Path goodRequest = request(4, List.of(stem("budget.wav", "foley/budget@v1", "1.0", "0.0", "decision/budget")));
        assertThrows(java.io.IOException.class, () -> FoleyStemMasterPreview.run(goodRequest, output, CLOCK));
        assertArrayEquals(sentinel, Files.readAllBytes(existingMaster));
        assertFalse(Files.exists(output.resolve("foley-master-manifest.json")));
    }

    private Path request(int frames, java.util.List<String> stems) throws Exception {
        String json = "{\"sampleRateHz\":" + RATE + ",\"frameCount\":" + frames
                + ",\"truePeakCeiling\":0.95,\"stems\":[" + String.join(",", stems) + "]}";
        Path request = tempDir.resolve("request-" + Math.abs(json.hashCode()) + ".json");
        Files.writeString(request, json, StandardCharsets.UTF_8);
        return request;
    }

    private static String stem(String filename, String version, String gain, String pan, String decision) {
        return stem(filename, version, gain, pan, decision, "CLEARED", "2026-11-09T19:00:00Z", "2026-11-09T21:00:00Z");
    }

    private static String stem(String filename, String version, String gain, String pan, String decision,
                               String disposition, String from, String until) {
        return "{\"path\":\"" + filename + "\",\"sourceVersionRef\":\"" + version
                + "\",\"gain\":" + gain + ",\"pan\":" + pan
                + ",\"rightsEvidence\":{\"decisionRef\":\"" + decision
                + "\",\"purpose\":\"PCM_STEM_MIX\",\"disposition\":\"" + disposition
                + "\",\"validFrom\":\"" + from + "\",\"validUntil\":\"" + until + "\"}}";
    }

    private static void writeWav(Path path, byte[] pcm, int sampleRate) throws Exception {
        javax.sound.sampled.AudioFormat format = new javax.sound.sampled.AudioFormat(
                javax.sound.sampled.AudioFormat.Encoding.PCM_SIGNED, sampleRate, 16, 2, 4, sampleRate, false);
        try (AudioInputStream audio = new AudioInputStream(new ByteArrayInputStream(pcm), format, pcm.length / 4)) {
            AudioSystem.write(audio, AudioFileFormat.Type.WAVE, path.toFile());
        }
    }

    private static byte[] pcm(int... samples) {
        ByteBuffer bytes = ByteBuffer.allocate(samples.length * 2).order(ByteOrder.LITTLE_ENDIAN);
        for (int sample : samples) bytes.putShort((short) sample);
        return bytes.array();
    }

    private static byte[] decodeWav(Path path) throws Exception {
        try (AudioInputStream audio = AudioSystem.getAudioInputStream(path.toFile())) {
            return audio.readAllBytes();
        }
    }

    private static double samplePeak(byte[] pcm) {
        ByteBuffer samples = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN);
        double peak = 0.0;
        while (samples.hasRemaining()) {
            peak = Math.max(peak, Math.abs(samples.getShort() / 32768.0));
        }
        return peak;
    }

    private static void assertTruePeakComponents(JsonNode measurement) {
        double samplePeak = measurement.path("samplePeakLinear").doubleValue();
        double firPeak = measurement.path("oversampledFirPeakLinear").doubleValue();
        double combined = measurement.path("linear").doubleValue();
        double dbTp = measurement.path("dbTp").doubleValue();
        assertTrue(Double.isFinite(samplePeak));
        assertTrue(Double.isFinite(firPeak));
        assertEquals(Math.max(samplePeak, firPeak), combined, 1.0e-12);
        assertEquals(20.0 * Math.log10(combined), dbTp, 1.0e-9);
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}
