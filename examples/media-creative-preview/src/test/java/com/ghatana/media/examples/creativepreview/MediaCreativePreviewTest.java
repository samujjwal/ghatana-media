package com.ghatana.media.examples.creativepreview;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import javax.imageio.ImageIO;
import javax.imageio.stream.ImageInputStream;
import javax.sound.sampled.AudioSystem;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class MediaCreativePreviewTest {
    private static final String SOURCE_VERSION = "local-fixture:creative-preview:v1";
    private static final List<String> OUTPUTS = List.of("png", "gif", "wav", "wavClipped", "wavRepaired", "interactiveDemoAudio", "glb", "simulation");

    @TempDir Path tempDir;

    @Test
    void manifestBindsPersistedOutputsAndLocalAudioInput() throws Exception {
        Path output = Files.createDirectory(tempDir.resolve("preview"));
        MediaCreativePreview.main(new String[]{output.toString()});

        Map<String, Object> manifest = object(new JsonParser(Files.readString(output.resolve("preview-manifest.json"))).parse());
        assertEquals("LOCAL_PREVIEW_ONLY", manifest.get("kind"));
        assertEquals(SOURCE_VERSION, manifest.get("sourceVersion"));

        Map<String, Object> outputs = object(manifest.get("outputs"));
        assertEquals(OUTPUTS.size(), outputs.size());
        for (String key : OUTPUTS) {
            Map<String, Object> entry = object(outputs.get(key));
            assertEquals(SOURCE_VERSION, entry.get("sourceVersion"), key + " source version");
            String filename = string(entry.get("filename"));
            String digest = string(entry.get("sha256"));
            assertTrue(filename.matches("[A-Za-z0-9._-]+"), "output must be a simple file name: " + filename);
            Path artifact = output.resolve(filename);
            assertTrue(Files.isRegularFile(artifact), key + " output exists: " + filename);
            assertEquals(sha256(Files.readAllBytes(artifact)), digest, key + " digest matches persisted bytes");
        }

        Map<String, Object> animation = object(manifest.get("animation"));
        assertEquals("preview-clock", animation.get("clockId"));
        assertEquals("preview-stream", animation.get("streamId"));
        assertEquals(SOURCE_VERSION, animation.get("originRef"));
        assertEquals("1/24", animation.get("timeBase"));
        assertEquals("10/1", animation.get("framesPerSecond"));
        assertEquals(10L, number(animation.get("gifDelayCentiseconds")));
        assertEquals(6L, number(animation.get("frameCount")));
        List<Object> frames = array(animation.get("frames"));
        assertEquals(6, frames.size());
        for (int index = 0; index < frames.size(); index++) {
            Map<String, Object> frame = object(frames.get(index));
            assertEquals((long) index, number(frame.get("index")));
            assertEquals(SOURCE_VERSION, frame.get("sourceVersion"));
            assertEquals(fraction(index, 10), frame.get("pts"));
            assertEquals(fraction(12L * index, 5), frame.get("storyTicks"));
            Path framePng = output.resolve(string(frame.get("filename")));
            byte[] bytes = Files.readAllBytes(framePng);
            assertEquals(sha256(bytes), frame.get("sha256"));
            MediaCreativePreview.verifyPngFrame(framePng, 96, 64);
            var decoded = ImageIO.read(framePng.toFile());
            assertTrue(decoded != null && decoded.getWidth() == 96 && decoded.getHeight() == 64);
            decoded.flush();
        }
        Map<String, Object> firstFrame = object(frames.getFirst());
        Map<String, Object> pngOutput = object(outputs.get("png"));
        assertEquals(pngOutput.get("filename"), firstFrame.get("filename"));
        assertEquals(pngOutput.get("sha256"), firstFrame.get("sha256"));
        try (ImageInputStream gifInput = ImageIO.createImageInputStream(
                output.resolve(string(object(outputs.get("gif")).get("filename"))).toFile())) {
            var readers = ImageIO.getImageReaders(gifInput);
            assertTrue(readers.hasNext(), "persisted GIF has a local decoder");
            var reader = readers.next();
            try {
                reader.setInput(gifInput);
                assertEquals(6, reader.getNumImages(true));
                for (int index = 0; index < 6; index++) {
                    var decoded = reader.read(index);
                    assertTrue(decoded != null && decoded.getWidth() == 96 && decoded.getHeight() == 64,
                            "persisted GIF frame decodes at expected dimensions: " + index);
                    decoded.flush();
                }
            } finally {
                reader.dispose();
            }
        }

        Map<String, Object> glbValidation = object(manifest.get("glbValidation"));
        assertEquals("KhronosGroup/glTF-Validator", glbValidation.get("validator"));
        assertEquals("2.0.0-dev.3.10", glbValidation.get("version"));
        Map<String, Object> glbIssues = object(glbValidation.get("issueCounts"));
        Map<String, Object> glbOutput = object(outputs.get("glb"));
        assertEquals(glbOutput.get("sha256"), glbValidation.get("assetSha256"));
        assertEquals(0L, number(glbIssues.get("errors")).longValue());
        assertEquals(0L, number(glbIssues.get("warnings")).longValue());
        assertEquals(0L, number(glbIssues.get("infos")).longValue());
        assertEquals(0L, number(glbIssues.get("hints")).longValue());

        Map<String, Object> audioInput = object(manifest.get("audioInput"));
        assertEquals("local-tone-v1", audioInput.get("stemVersionRef"));
        assertEquals(sha256(fixturePcm()), audioInput.get("pcmSha256"));
        assertEquals(48000L, number(audioInput.get("sampleRateHz")));
        assertEquals(2L, number(audioInput.get("channels")));
        assertEquals("PCM_S16LE", audioInput.get("sampleFormat"));
        assertEquals(480L, number(audioInput.get("frameCount")));

        Map<String, Object> audioMix = object(manifest.get("audioMix"));
        assertEquals("LOCAL_MIX_ESTIMATES", audioMix.get("kind"));
        assertEquals("LOCAL_ESTIMATE_NOT_CERTIFIED", audioMix.get("truePeakEvidence"));
        byte[] previewPcm = decodedPcm(output.resolve("preview.wav"));
        assertEquals(1_920, previewPcm.length);
        assertEquals(sha256(previewPcm), audioMix.get("outputPcmSha256"));
        double samplePeak = number(audioMix.get("samplePeakAfterCeiling")).doubleValue();
        double estimatedTruePeak = number(audioMix.get("estimatedTruePeakAfterCeiling")).doubleValue();
        assertTrue(Double.isFinite(samplePeak) && samplePeak > 0.0 && samplePeak <= 0.95);
        assertTrue(Double.isFinite(estimatedTruePeak) && estimatedTruePeak >= samplePeak
                && estimatedTruePeak <= 0.95);
        assertTrue(Double.isFinite(number(audioMix.get("estimatedTruePeakBeforeCeiling")).doubleValue()));
        assertTrue(Double.isFinite(number(audioMix.get("rmsDbfsAfterCeiling")).doubleValue()));

        Map<String, Object> audioRepair = object(manifest.get("audioRepair"));
        assertEquals("local-clipped-tone-v1", audioRepair.get("fixtureVersionRef"));
        assertEquals(48000L, number(audioRepair.get("sampleRateHz")));
        assertEquals(2L, number(audioRepair.get("channels")));
        assertEquals("PCM_S16LE", audioRepair.get("sampleFormat"));
        assertEquals(480L, number(audioRepair.get("frameCount")));
        Map<String, Object> fixture = object(audioRepair.get("fixture"));
        assertEquals("sine-hard-clip", fixture.get("generator"));
        assertEquals(440L, number(fixture.get("frequencyHz")));
        assertEquals(40000L, number(fixture.get("preClipPeak")));
        assertEquals(32767L, number(fixture.get("clipLevelPositive")));
        assertEquals(-32768L, number(fixture.get("clipLevelNegative")));
        assertEquals("BoundedPcmDeclipper.linear-interpolation", audioRepair.get("repairAlgorithm"));
        assertEquals(false, audioRepair.get("hasIndependentReference"));
        assertEquals(null, audioRepair.get("snrDbVsReference"));
        assertEquals(false, audioRepair.get("qualityClaim"));
        Map<String, Object> comparisonMetrics = object(audioRepair.get("comparisonMetrics"));
        assertEquals("DESCRIPTIVE_PCM_ONLY", comparisonMetrics.get("kind"));
        assertEquals(32768L, number(comparisonMetrics.get("sourcePeak")));
        assertTrue(number(comparisonMetrics.get("repairedPeak")).longValue() < 32768L);
        assertTrue(number(comparisonMetrics.get("sourceNearClipSampleCount")).longValue() > 0);
        assertTrue(number(comparisonMetrics.get("changedSampleCount")).longValue() > 0);
        assertTrue(number(comparisonMetrics.get("sourceRms")).doubleValue() > 0.0);
        assertTrue(number(comparisonMetrics.get("repairedRms")).doubleValue() > 0.0);
        assertTrue(Double.isFinite(number(comparisonMetrics.get("rmsChangeDb")).doubleValue()));
        byte[] clippedPcm = decodedPcm(output.resolve("original-clipped.wav"));
        byte[] repairedPcm = decodedPcm(output.resolve("repaired-candidate.wav"));
        assertTrue(hasClippedSample(clippedPcm), "fixture includes hard-clipped PCM samples");
        assertEquals(sha256(clippedPcm), audioRepair.get("sourcePcmSha256"));
        assertEquals(sha256(repairedPcm), audioRepair.get("repairedPcmSha256"));
        assertEquals(countChangedSamples(clippedPcm, repairedPcm),
                number(comparisonMetrics.get("changedSampleCount")).longValue());
        assertTrue(!java.util.Arrays.equals(clippedPcm, repairedPcm), "repair candidate preserves a distinct PCM revision");
        assertEquals("original-clipped.wav", string(object(audioRepair.get("sourceWav")).get("filename")));
        assertEquals("repaired-candidate.wav", string(object(audioRepair.get("repairedWav")).get("filename")));
        assertEquals(outputs.get("wavClipped"), audioRepair.get("sourceWav"));
        assertEquals(outputs.get("wavRepaired"), audioRepair.get("repairedWav"));

        Map<String, Object> audioClock = object(object(manifest.get("clocks")).get("audio"));
        assertEquals(48000L, number(audioClock.get("sampleRateHz")));
        assertEquals(2L, number(audioClock.get("channels")));
        assertEquals("PCM_S16LE", audioClock.get("sampleFormat"));
        assertEquals(480L, number(audioClock.get("frameCount")));

        Map<String, Object> browserAudioClock = object(object(manifest.get("clocks")).get("interactiveDemoAudio"));
        assertEquals("local-interactive-demo-tone-v1", browserAudioClock.get("fixtureVersionRef"));
        assertEquals(48000L, number(browserAudioClock.get("sampleRateHz")));
        assertEquals(2L, number(browserAudioClock.get("channels")));
        assertEquals("PCM_S16LE", browserAudioClock.get("sampleFormat"));
        assertEquals(96000L, number(browserAudioClock.get("frameCount")));
        assertEquals(2000L, number(browserAudioClock.get("durationMs")));
        var browserAudio = AudioSystem.getAudioFileFormat(output.resolve("interactive-demo-preview.wav").toFile());
        assertEquals(javax.sound.sampled.AudioFileFormat.Type.WAVE, browserAudio.getType());
        assertEquals(96000L, browserAudio.getFrameLength());
        assertEquals(48_000f, browserAudio.getFormat().getSampleRate());
        assertEquals(2, browserAudio.getFormat().getChannels());
        assertEquals(16, browserAudio.getFormat().getSampleSizeInBits());
        byte[] interactiveDemoPcm = decodedPcm(output.resolve("interactive-demo-preview.wav"));
        assertEquals(384_000, interactiveDemoPcm.length);
        for (int window = 0; window < 20; window++) {
            assertTrue(hasNonSilentSample(interactiveDemoPcm, window * 4_800 * 4, (window + 1) * 4_800 * 4),
                    "interactive demo audio has signal in 100 ms window " + window);
        }

        Map<String, Object> spatialClock = object(object(manifest.get("clocks")).get("spatial"));
        assertEquals("local-rig-clock", spatialClock.get("clockId"));
        assertEquals("SECOND", spatialClock.get("timeUnit"));
        assertEquals("FLOAT32_SECONDS", spatialClock.get("timeEncoding"));
        assertEquals(0.0, number(spatialClock.get("startTimeSeconds")).doubleValue());
        assertEquals(1.0, number(spatialClock.get("endTimeSeconds")).doubleValue());

        Map<String, Object> simulationClock = object(object(manifest.get("clocks")).get("simulation"));
        assertEquals("local-simulation-clock", simulationClock.get("clockId"));
        assertEquals("SECOND", simulationClock.get("timeUnit"));
        assertEquals(0.0, number(simulationClock.get("startTimeSeconds")).doubleValue());
        assertEquals(1.0, number(simulationClock.get("endTimeSeconds")).doubleValue());
        assertTrue(number(simulationClock.get("observationCount")).intValue() > 1);

        List<Object> limitations = array(manifest.get("limitations"));
        assertTrue(limitations.contains("fixture output is not lawful model quality"));
        assertTrue(limitations.contains("simulation is not measurement evidence"));
        assertTrue(limitations.contains("clipped audio is synthetic and the repaired candidate is an estimate, not recovered source truth"));
        assertTrue(limitations.contains("no independent audio reference was supplied; no SNR or quality claim is made"));
        assertTrue(limitations.contains("GLB uses FLOAT32_APPROXIMATION"));
        assertTrue(limitations.contains("no hosted product, delivery receipt, or job finality is implied"));
    }

    @Test
    void animationPngReadbackRejectsWrongDimensionsAndCorruptBytes() throws Exception {
        Path wrongSize = tempDir.resolve("wrong-size.png");
        assertTrue(ImageIO.write(new java.awt.image.BufferedImage(2, 2,
                java.awt.image.BufferedImage.TYPE_INT_ARGB), "png", wrongSize.toFile()));
        IOException dimensions = assertThrows(IOException.class,
                () -> MediaCreativePreview.verifyPngFrame(wrongSize, 1, 2));
        assertTrue(dimensions.getMessage().contains("expected dimensions"));

        Path corrupt = tempDir.resolve("corrupt.png");
        Files.write(corrupt, new byte[]{1, 2, 3, 4});
        IOException decode = assertThrows(IOException.class,
                () -> MediaCreativePreview.verifyPngFrame(corrupt, 2, 2));
        assertTrue(decode.getMessage().contains("independently decoded"));
    }

    @Test
    void glbReadbackRejectsMalformedJsonEvenWhenLineageTextRemains() throws Exception {
        Path output = Files.createDirectory(tempDir.resolve("malformed-glb"));
        MediaCreativePreview.main(new String[]{output.toString()});
        byte[] glb = Files.readAllBytes(output.resolve("preview.glb"));
        int jsonLength = ByteBuffer.wrap(glb).order(ByteOrder.LITTLE_ENDIAN).getInt(12);
        int jsonStart = 20;
        String json = new String(glb, jsonStart, jsonLength, StandardCharsets.UTF_8);
        int separator = json.indexOf("\"version\":\"2.0\"");
        assertTrue(separator >= 0, "valid preview GLB contains asset version");
        int colon = separator + "\"version\"".length();
        glb[jsonStart + colon] = '?';

        Path malformedGlb = output.resolve("malformed-preview.glb");
        Files.write(malformedGlb, glb);
        IOException validatorFailure = assertThrows(IOException.class,
                () -> MediaCreativePreview.runKhronosGlbValidator(malformedGlb));
        assertTrue(validatorFailure.getMessage().contains("Khronos glTF Validator"));

        IOException malformed = assertThrows(IOException.class,
                () -> CreativePreviewReadback.parseSupportedGlbJson(glb));
        assertTrue(malformed.getMessage().contains("not valid JSON"));
    }

    @Test
    void glbReadbackRejectsCoordinateAndExactTimeManifestTampering() throws Exception {
        Path output = Files.createDirectory(tempDir.resolve("spatial-profile-tamper"));
        MediaCreativePreview.main(new String[]{output.toString()});
        byte[] original = Files.readAllBytes(output.resolve("preview.glb"));
        String json = glbJson(original);

        byte[] wrongHandedness = replaceJson(original, json, "RIGHT_HANDED", "WRONG_HANDED");
        IOException handedness = assertThrows(IOException.class,
                () -> CreativePreviewReadback.parseSupportedGlbJson(wrongHandedness));
        assertTrue(handedness.getMessage().contains("coordinate profile"));

        byte[] wrongExactTime = replaceJson(original, json,
                "[[\"0\",\"1\"],[\"1\",\"1\"]]", "[[\"0\",\"1\"],[\"2\",\"1\"]]");
        IOException time = assertThrows(IOException.class,
                () -> CreativePreviewReadback.parseSupportedGlbJson(wrongExactTime));
        assertTrue(time.getMessage().contains("exact rational keyframe-time"));
    }

    @Test
    void glbReadbackBindsRationalTimesToPersistedAccessorAndChecksTransformData() throws Exception {
        Path output = Files.createDirectory(tempDir.resolve("spatial-binary-tamper"));
        MediaCreativePreview.main(new String[]{output.toString()});
        byte[] original = Files.readAllBytes(output.resolve("preview.glb"));
        int jsonLength = ByteBuffer.wrap(original).order(ByteOrder.LITTLE_ENDIAN).getInt(12);
        int bin = 28 + jsonLength;

        byte[] wrongEncodedTime = original.clone();
        ByteBuffer.wrap(wrongEncodedTime).order(ByteOrder.LITTLE_ENDIAN).putFloat(bin + 4, 0.75f);
        IOException time = assertThrows(IOException.class,
                () -> CreativePreviewReadback.parseSupportedGlbJson(wrongEncodedTime));
        assertTrue(time.getMessage().contains("time accessor disagrees"));

        byte[] nonFiniteTranslation = original.clone();
        ByteBuffer.wrap(nonFiniteTranslation).order(ByteOrder.LITTLE_ENDIAN)
                .putFloat(bin + 8, Float.NaN);
        IOException translation = assertThrows(IOException.class,
                () -> CreativePreviewReadback.parseSupportedGlbJson(nonFiniteTranslation));
        assertTrue(translation.getMessage().contains("translation accessor"));

        byte[] invalidRotation = original.clone();
        ByteBuffer.wrap(invalidRotation).order(ByteOrder.LITTLE_ENDIAN).putFloat(bin + 44, 2.0f);
        IOException rotation = assertThrows(IOException.class,
                () -> CreativePreviewReadback.parseSupportedGlbJson(invalidRotation));
        assertTrue(rotation.getMessage().contains("non-unit quaternion"));
    }

    @Test
    void glbReadbackRejectsOverflowingAccessorOffsetsWithoutEscapingIOException() throws Exception {
        Path output = Files.createDirectory(tempDir.resolve("spatial-offset-overflow"));
        MediaCreativePreview.main(new String[]{output.toString()});
        byte[] original = Files.readAllBytes(output.resolve("preview.glb"));
        String json = glbJson(original);
        String malformed = json.replace("\"byteOffset\":0,\"byteLength\":8",
                "\"byteOffset\":2147483647,\"byteLength\":8");
        assertTrue(!malformed.equals(json), "fixture has the expected tight time buffer view");
        byte[] overflow = withGlbJson(original, malformed);
        IOException rejected = assertThrows(IOException.class,
                () -> CreativePreviewReadback.parseSupportedGlbJson(overflow));
        assertTrue(rejected.getMessage().contains("accessor exceeds BIN chunk bounds"));
    }

    private static String glbJson(byte[] glb) {
        int length = ByteBuffer.wrap(glb).order(ByteOrder.LITTLE_ENDIAN).getInt(12);
        return new String(glb, 20, length, StandardCharsets.UTF_8).stripTrailing();
    }

    private static byte[] replaceJson(byte[] source, String json, String from, String to) {
        if (from.length() != to.length()) throw new IllegalArgumentException("replacement must preserve GLB chunk length");
        int index = json.indexOf(from);
        if (index < 0) return source;
        byte[] result = source.clone();
        byte[] replacement = to.getBytes(StandardCharsets.UTF_8);
        System.arraycopy(replacement, 0, result, 20 + index, replacement.length);
        return result;
    }

    private static byte[] withGlbJson(byte[] source, String replacementJson) {
        int oldJsonLength = ByteBuffer.wrap(source).order(ByteOrder.LITTLE_ENDIAN).getInt(12);
        int binaryChunkStart = 20 + oldJsonLength;
        int binaryChunkLength = ByteBuffer.wrap(source).order(ByteOrder.LITTLE_ENDIAN).getInt(binaryChunkStart);
        int paddedJsonLength = (replacementJson.getBytes(StandardCharsets.UTF_8).length + 3) & ~3;
        int binaryDataLength = 8 + binaryChunkLength;
        byte[] output = new byte[20 + paddedJsonLength + binaryDataLength];
        ByteBuffer header = ByteBuffer.wrap(output).order(ByteOrder.LITTLE_ENDIAN);
        header.putInt(0x46546c67).putInt(2).putInt(output.length);
        header.putInt(paddedJsonLength).putInt(0x4e4f534a);
        byte[] jsonBytes = replacementJson.getBytes(StandardCharsets.UTF_8);
        header.put(jsonBytes);
        while (header.position() < 20 + paddedJsonLength) header.put((byte) 0x20);
        System.arraycopy(source, binaryChunkStart, output, 20 + paddedJsonLength, binaryDataLength);
        return output;
    }

    @Test
    void simulationReadbackRejectsMismatchedEvidenceAndNonFiniteObservations() {
        String prefix = "{\"kind\":\"DETERMINISTIC_SIMULATION_ONLY\",\"sourceVersion\":\""
                + SOURCE_VERSION + "\",\"solver\":\"local-solver-v1\",\"evidenceClass\":\"";
        String clock = "\",\"clock\":{\"clockId\":\"local-simulation-clock\",\"timeUnit\":\"SECOND\"},\"observations\":["
                + "{\"timeSeconds\":0,\"positionMeters\":0,\"velocityMetersPerSecond\":0},"
                + "{\"timeSeconds\":1,\"positionMeters\":1,\"velocityMetersPerSecond\":1}]}";
        assertThrows(IOException.class, () -> CreativePreviewReadback.parseSimulation(
                prefix + "MEASUREMENT_EVIDENCE" + clock, SOURCE_VERSION));

        String nonFinite = "{\"kind\":\"DETERMINISTIC_SIMULATION_ONLY\",\"sourceVersion\":\""
                + SOURCE_VERSION + "\",\"solver\":\"local-solver-v1\",\"evidenceClass\":"
                + "\"DETERMINISTIC_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE\",\"clock\":{"
                + "\"clockId\":\"local-simulation-clock\",\"timeUnit\":\"SECOND\"},\"observations\":["
                + "{\"timeSeconds\":0,\"positionMeters\":0,\"velocityMetersPerSecond\":0},"
                + "{\"timeSeconds\":1e999,\"positionMeters\":1,\"velocityMetersPerSecond\":1}]}";
        assertThrows(IOException.class,
                () -> CreativePreviewReadback.parseSimulation(nonFinite, SOURCE_VERSION));
    }

    private static byte[] fixturePcm() {
        ByteBuffer pcm = ByteBuffer.allocate(480 * 2 * 2).order(ByteOrder.LITTLE_ENDIAN);
        for (int frame = 0; frame < 480; frame++) {
            short sample = (short) Math.round(Math.sin(2 * Math.PI * 440 * frame / 48_000.0) * 8_000);
            pcm.putShort(sample).putShort(sample);
        }
        return pcm.array();
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static String fraction(long numerator, long denominator) {
        long gcd = java.math.BigInteger.valueOf(numerator).abs()
                .gcd(java.math.BigInteger.valueOf(denominator)).longValueExact();
        return (numerator / gcd) + "/" + (denominator / gcd);
    }

    private static byte[] decodedPcm(Path wav) throws Exception {
        try (var stream = AudioSystem.getAudioInputStream(wav.toFile())) {
            return stream.readAllBytes();
        }
    }

    private static boolean hasNonSilentSample(byte[] pcm, int startOffset, int endOffset) {
        for (int offset = startOffset; offset < endOffset; offset += 2) {
            if (ByteBuffer.wrap(pcm, offset, Short.BYTES).order(ByteOrder.LITTLE_ENDIAN).getShort() != 0) return true;
        }
        return false;
    }

    private static boolean hasClippedSample(byte[] pcm) {
        for (int offset = 0; offset < pcm.length; offset += 2) {
            short sample = ByteBuffer.wrap(pcm, offset, 2).order(ByteOrder.LITTLE_ENDIAN).getShort();
            if (sample == Short.MAX_VALUE || sample == Short.MIN_VALUE) return true;
        }
        return false;
    }

    private static long countChangedSamples(byte[] left, byte[] right) {
        if (left.length != right.length) throw new AssertionError("PCM branches must have equal lengths");
        long changed = 0;
        for (int offset = 0; offset < left.length; offset += Short.BYTES) {
            if (ByteBuffer.wrap(left, offset, Short.BYTES).order(ByteOrder.LITTLE_ENDIAN).getShort()
                    != ByteBuffer.wrap(right, offset, Short.BYTES).order(ByteOrder.LITTLE_ENDIAN).getShort()) {
                changed++;
            }
        }
        return changed;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value) {
        if (!(value instanceof Map<?, ?>)) throw new AssertionError("expected JSON object, got " + value);
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> array(Object value) {
        if (!(value instanceof List<?>)) throw new AssertionError("expected JSON array, got " + value);
        return (List<Object>) value;
    }

    private static String string(Object value) {
        if (!(value instanceof String text)) throw new AssertionError("expected JSON string, got " + value);
        return text;
    }

    private static Number number(Object value) {
        if (!(value instanceof Number number)) throw new AssertionError("expected JSON number, got " + value);
        return number;
    }

    /** Small strict JSON parser for the manifest, avoiding regex-based field extraction. */
    private static final class JsonParser {
        private final String input;
        private int offset;

        JsonParser(String input) { this.input = input; }

        Object parse() {
            Object value = value();
            whitespace();
            if (offset != input.length()) fail("trailing content");
            return value;
        }

        private Object value() {
            whitespace();
            if (offset >= input.length()) return fail("unexpected end");
            return switch (input.charAt(offset)) {
                case '{' -> objectValue();
                case '[' -> arrayValue();
                case '"' -> stringValue();
                case 't' -> literal("true", Boolean.TRUE);
                case 'f' -> literal("false", Boolean.FALSE);
                case 'n' -> literal("null", null);
                default -> numberValue();
            };
        }

        private Map<String, Object> objectValue() {
            offset++;
            var result = new java.util.LinkedHashMap<String, Object>();
            whitespace();
            if (take('}')) return result;
            do {
                whitespace();
                if (offset >= input.length() || input.charAt(offset) != '"') return fail("object key expected");
                String key = stringValue();
                whitespace(); expect(':');
                if (result.putIfAbsent(key, value()) != null) return fail("duplicate object key: " + key);
                whitespace();
                if (take('}')) return result;
                expect(',');
            } while (true);
        }

        private List<Object> arrayValue() {
            offset++;
            var result = new java.util.ArrayList<Object>();
            whitespace();
            if (take(']')) return result;
            do {
                result.add(value());
                whitespace();
                if (take(']')) return result;
                expect(',');
            } while (true);
        }

        private String stringValue() {
            expect('"');
            var result = new StringBuilder();
            while (offset < input.length()) {
                char c = input.charAt(offset++);
                if (c == '"') return result.toString();
                if (c == '\\') {
                    if (offset >= input.length()) return fail("unfinished escape");
                    char escape = input.charAt(offset++);
                    switch (escape) {
                        case '"', '\\', '/' -> result.append(escape);
                        case 'b' -> result.append('\b');
                        case 'f' -> result.append('\f');
                        case 'n' -> result.append('\n');
                        case 'r' -> result.append('\r');
                        case 't' -> result.append('\t');
                        case 'u' -> {
                            if (offset + 4 > input.length()) return fail("short unicode escape");
                            try { result.append((char) Integer.parseInt(input.substring(offset, offset + 4), 16)); }
                            catch (NumberFormatException e) { return fail("invalid unicode escape"); }
                            offset += 4;
                        }
                        default -> { return fail("invalid escape"); }
                    }
                } else {
                    if (c < 0x20) return fail("control character in string");
                    result.append(c);
                }
            }
            return fail("unterminated string");
        }

        private Number numberValue() {
            int start = offset;
            if (take('-')) { }
            digits();
            if (take('.')) digits();
            if (take('e') || take('E')) { if (!take('+')) take('-'); digits(); }
            try {
                String text = input.substring(start, offset);
                if (text.contains(".") || text.contains("e") || text.contains("E")) {
                    return Double.parseDouble(text);
                }
                return Long.parseLong(text);
            }
            catch (NumberFormatException e) { return fail("invalid or unsupported number"); }
        }

        private void digits() {
            int start = offset;
            while (offset < input.length() && Character.isDigit(input.charAt(offset))) offset++;
            if (start == offset) fail("digit expected");
        }

        private Object literal(String literal, Object value) {
            if (!input.startsWith(literal, offset)) return fail("invalid literal");
            offset += literal.length();
            return value;
        }

        private void whitespace() { while (offset < input.length() && Character.isWhitespace(input.charAt(offset))) offset++; }
        private boolean take(char c) { if (offset < input.length() && input.charAt(offset) == c) { offset++; return true; } return false; }
        private void expect(char c) { if (!take(c)) fail("expected '" + c + "'"); }
        private <T> T fail(String message) { throw new IllegalArgumentException(message + " at byte/char " + offset); }
    }
}
