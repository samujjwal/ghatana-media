package com.ghatana.media.examples.creativepreview;

import tools.jackson.databind.ObjectMapper;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.production.audio.AudioRepairComparison;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.sound.sampled.AudioFileFormat;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import java.io.ByteArrayInputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.LinkOption;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AudioRepairPreviewTest {
    @TempDir Path tempDir;

    @Test
    void callerWavPreviewRepairsSyntheticClippedSineAgainstIndependentReference() throws Exception {
        Path input = tempDir.resolve("synthetic-clipped-sine.wav");
        Path output = tempDir.resolve("synthetic-output");
        short[] clean = new short[200];
        short[] clipped = new short[clean.length];
        for (int frame = 0; frame < clean.length; frame++) {
            clean[frame] = (short) Math.round(Math.sin(2.0 * Math.PI * frame / 200.0) * 29_000);
            clipped[frame] = clean[frame];
        }
        for (int frame = 48; frame <= 52; frame++) clipped[frame] = Short.MAX_VALUE;
        byte[] cleanPcm = pcm(clean);
        byte[] clippedPcm = pcm(clipped);
        writeWav(input, clippedPcm);
        byte[] originalWav = Files.readAllBytes(input);

        AudioRepairPreview.run(input, output);

        byte[] sourceBranch = readWav(output.resolve("source.wav"));
        byte[] repairedBranch = readWav(output.resolve("repaired-candidate.wav"));
        assertEquals(sha256(originalWav), sha256(Files.readAllBytes(input)), "caller WAV remains byte-identical");
        assertEquals(sha256(clippedPcm), sha256(sourceBranch), "source branch retains exact caller PCM");
        assertFalse(java.util.Arrays.equals(sourceBranch, repairedBranch), "clipped run produces changed candidate PCM");

        Duration duration = Duration.ofNanos((clean.length * 1_000_000_000L + 500) / 1_000);
        AudioData reference = new AudioData(cleanPcm, 1_000, 1, 16, duration, AudioFormat.PCM);
        AudioData source = new AudioData(sourceBranch, 1_000, 1, 16, duration, AudioFormat.PCM);
        AudioData candidate = new AudioData(repairedBranch, 1_000, 1, 16, duration, AudioFormat.PCM);
        AudioRepairComparison comparison = AudioRepairComparison.compare(source, candidate, reference);
        AudioRepairComparison baseline = AudioRepairComparison.compare(source, source, reference);
        assertTrue(comparison.metrics().hasIndependentReference());
        assertTrue(comparison.metrics().snrDbVsReference() > baseline.metrics().snrDbVsReference(),
                "the deterministic synthetic reference should show directionally lower sample error");
        assertEquals(sha256(clippedPcm), sha256(comparison.undo().data()), "undo returns original source PCM");
    }

    @Test
    void writesCallerWavABBranchesAndDigestBoundManifestWithoutChangingInput() throws Exception {
        Path input = tempDir.resolve("caller-source.wav");
        Path output = tempDir.resolve("output");
        byte[] sourcePcm = pcm(100, Short.MAX_VALUE, Short.MAX_VALUE, 100, 0, -100);
        writeWav(input, sourcePcm);
        byte[] originalWav = Files.readAllBytes(input);

        AudioRepairPreview.run(input, output);

        assertEquals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(originalWav)),
                HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(input))));
        assertWavFormat(output.resolve("source.wav"), 1_000, 1, 16, 6);
        assertWavFormat(output.resolve("repaired-candidate.wav"), 1_000, 1, 16, 6);
        byte[] sourceBranch = readWav(output.resolve("source.wav"));
        byte[] repairedBranch = readWav(output.resolve("repaired-candidate.wav"));
        assertEquals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(sourcePcm)),
                HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(sourceBranch)));
        assertFalse(java.util.Arrays.equals(sourceBranch, repairedBranch));

        String manifest = Files.readString(output.resolve("audio-repair-manifest.json"));
        assertTrue(manifest.contains("\"kind\": \"LOCAL_AUDIO_REPAIR_PREVIEW_ONLY\""));
        assertTrue(manifest.contains("\"filename\": \"caller-source.wav\""));
        assertTrue(manifest.contains("\"wavSha256\": \"" + sha256(originalWav) + "\""));
        var manifestTree = new ObjectMapper().readTree(manifest);
        assertEquals("signed PCM little-endian", manifestTree.path("format").path("encoding").asString());
        assertEquals(1_000, manifestTree.path("format").path("sampleRateHz").asInt());
        assertEquals(6, manifestTree.path("format").path("frameCount").asInt());
        assertEquals(6_000_000, manifestTree.path("format").path("durationNanosRounded").asLong());
        assertEquals("maximum absolute decoded signed sample-code magnitude across all channels; sample peak, not true peak",
                manifestTree.path("comparison").path("peakSemantics").asString());
        assertEquals(32_767, manifestTree.path("comparison").path("positiveFullScaleCode").asInt());
        assertEquals(32_767, manifestTree.path("comparison").path("sourceSamplePeakCodeMagnitude").asInt());
        assertEquals(100, manifestTree.path("comparison").path("repairedSamplePeakCodeMagnitude").asInt());
        assertEquals(sha256(sourcePcm), manifestTree.path("input").path("pcmSha256").asString());
        assertEquals(sha256(Files.readAllBytes(output.resolve("source.wav"))),
                manifestTree.path("outputs").path("source").path("wavSha256").asString());
        assertEquals(sha256(Files.readAllBytes(output.resolve("repaired-candidate.wav"))),
                manifestTree.path("outputs").path("repairedCandidate").path("wavSha256").asString());
        assertTrue(manifest.contains("\"hasIndependentReference\": false"));
        assertTrue(manifest.contains("\"snrDbVsReference\": null"));
        assertTrue(manifest.contains("\"qualityClaim\": false"));
        assertTrue(manifest.contains("\"changedSampleCount\": 2"));
        assertTrue(manifest.contains(sha256(sourceBranch)));
        assertTrue(manifest.contains(sha256(repairedBranch)));
    }

    @Test
    void refusesUnsupportedUnsignedPcmBeforeWritingOutputs() throws Exception {
        Path input = tempDir.resolve("unsigned.wav");
        javax.sound.sampled.AudioFormat format = new javax.sound.sampled.AudioFormat(
                javax.sound.sampled.AudioFormat.Encoding.PCM_UNSIGNED, 48_000, 8, 1, 1, 48_000, false);
        try (AudioInputStream audio = new AudioInputStream(new ByteArrayInputStream(new byte[4]), format, 4)) {
            AudioSystem.write(audio, AudioFileFormat.Type.WAVE, input.toFile());
        }
        Path output = tempDir.resolve("rejected");

        assertThrows(java.io.IOException.class, () -> AudioRepairPreview.run(input, output));
        assertFalse(Files.exists(output.resolve("source.wav")));
    }

    @Test
    void refusesCorruptWavBeforeCreatingAnyOutput() throws Exception {
        Path input = tempDir.resolve("corrupt.wav");
        Path output = tempDir.resolve("corrupt-output");
        Files.write(input, new byte[] {'R', 'I', 'F', 'F', 1, 2, 3});

        assertThrows(java.io.IOException.class, () -> AudioRepairPreview.run(input, output));
        assertFalse(Files.exists(output.resolve("source.wav")));
        assertFalse(Files.exists(output.resolve("repaired-candidate.wav")));
        assertFalse(Files.exists(output.resolve("audio-repair-manifest.json")));
    }

    @Test
    void refusesExistingDestinationAndSymlinkAliasWithoutClobberingAnything() throws Exception {
        Path input = tempDir.resolve("input.wav");
        Path output = tempDir.resolve("existing-output");
        writeWav(input, pcm(100, Short.MAX_VALUE, Short.MAX_VALUE, 100, 0, -100));
        Files.createDirectory(output);
        Path sentinel = output.resolve("sentinel");
        Files.writeString(sentinel, "do not replace");
        byte[] before = Files.readAllBytes(sentinel);

        assertThrows(java.io.IOException.class, () -> AudioRepairPreview.run(input, output));
        assertEquals(sha256(before), sha256(Files.readAllBytes(sentinel)));

        Path targetDirectory = Files.createDirectory(tempDir.resolve("symlink-target"));
        Path symlinkDestination = tempDir.resolve("symlink-destination");
        Files.createSymbolicLink(symlinkDestination, targetDirectory);
        assertThrows(java.io.IOException.class, () -> AudioRepairPreview.run(input, symlinkDestination));
        assertFalse(Files.exists(targetDirectory.resolve("source.wav")));
    }

    @Test
    void rejectsSymlinkAndHardlinkReservationAliases() throws Exception {
        Path input = tempDir.resolve("reservation-input.wav");
        writeWav(input, pcm(10, 20, 30, 40));
        String lockName = ".reserved.audio-repair.lock";
        Path target = tempDir.resolve("reservation-target");
        Files.writeString(target, "reservation target");
        Files.createSymbolicLink(tempDir.resolve(lockName), target);
        assertThrows(java.io.IOException.class,
                () -> AudioRepairPreview.run(input, tempDir.resolve("reserved")));
        Files.delete(tempDir.resolve(lockName));

        Files.createLink(tempDir.resolve(lockName), target);
        assertThrows(java.io.IOException.class,
                () -> AudioRepairPreview.run(input, tempDir.resolve("reserved")));
        assertFalse(Files.exists(tempDir.resolve("reserved"), LinkOption.NOFOLLOW_LINKS));
    }

    @Test
    void escapesControlCharactersInInputFilenameAsValidJson() throws Exception {
        String filename = "caller\n-source\t.wav";
        Path input = tempDir.resolve(filename);
        Path output = tempDir.resolve("escaped-output");
        writeWav(input, pcm(100, Short.MAX_VALUE, Short.MAX_VALUE, 100, 0, -100));

        AudioRepairPreview.run(input, output);

        String manifest = Files.readString(output.resolve("audio-repair-manifest.json"));
        assertEquals(filename, new ObjectMapper().readTree(manifest).path("input").path("filename").asString());
        assertTrue(manifest.contains("\"filename\": \"caller\\n-source\\t.wav\""));
    }

    @Test
    void roundTripsSignedTwentyFourAndThirtyTwoBitCallerWavBranches() throws Exception {
        for (int bits : new int[] {24, 32}) {
            Path input = tempDir.resolve("caller-source-" + bits + ".wav");
            Path output = tempDir.resolve("output-" + bits);
            long peak = (1L << (bits - 1)) - 1;
            byte[] pcm = packedPcm(bits, 1_000, peak, 1_000);
            writeWav(input, pcm, bits);

            AudioRepairPreview.run(input, output);

            assertEquals(sha256(pcm), sha256(readWav(output.resolve("source.wav"))), "source PCM " + bits);
            assertEquals(sha256(packedPcm(bits, 1_000, 1_000, 1_000)),
                    sha256(readWav(output.resolve("repaired-candidate.wav"))), "repaired PCM " + bits);
            assertTrue(Files.readString(output.resolve("audio-repair-manifest.json"))
                    .contains("\"bitsPerSample\": " + bits));
        }
    }

    @Test
    void hardStoppedCliKeepsPartialBundlePrivateAndRetryPublishesWholeDirectory() throws Exception {
        Path input = tempDir.resolve("hard-stop-input.wav");
        byte[] largePcm = new byte[com.ghatana.media.production.audio.BoundedPcmDeclipper.MAX_PCM_BYTES];
        for (int offset = 2; offset < largePcm.length - 2; offset += 4) {
            largePcm[offset] = (byte) 0xff;
            largePcm[offset + 1] = 0x7f;
        }
        writeWav(input, largePcm);
        Path destination = tempDir.resolve("hard-stop-output");
        Path childLog = tempDir.resolve("audio-repair-child.log");
        Path competingLog = tempDir.resolve("audio-repair-competing-child.log");

        Process first = startCli(input, destination, childLog);
        Path privateStage = awaitPartialStage(first, destination, Duration.ofSeconds(60));
        Path aliasedParent = tempDir.resolve("destination-parent-alias");
        Files.createSymbolicLink(aliasedParent, tempDir);
        Process competitor = startCli(input, aliasedParent.resolve(destination.getFileName()), competingLog);
        assertTrue(competitor.waitFor(10, java.util.concurrent.TimeUnit.SECONDS),
                "competing same-destination CLI exits while reservation is held");
        assertTrue(competitor.exitValue() != 0, Files.readString(competingLog));
        assertTrue(Files.readString(competingLog).contains("another audio repair attempt is using this destination"));
        assertFalse(Files.exists(destination, LinkOption.NOFOLLOW_LINKS),
                "concurrent attempt cannot publish through a symlink-parent alias");
        first.destroyForcibly();
        assertTrue(first.waitFor(10, java.util.concurrent.TimeUnit.SECONDS), "hard-stopped CLI exits");

        assertFalse(Files.exists(destination, LinkOption.NOFOLLOW_LINKS),
                "public bundle destination remains absent after SIGKILL");
        assertTrue(Files.isRegularFile(privateStage.resolve("source.wav"), LinkOption.NOFOLLOW_LINKS));
        assertFalse(Files.exists(privateStage.resolve("repaired-candidate.wav"), LinkOption.NOFOLLOW_LINKS));
        assertFalse(Files.exists(privateStage.resolve("audio-repair-manifest.json"), LinkOption.NOFOLLOW_LINKS));

        Process retry = startCli(input, destination, childLog);
        assertTrue(retry.waitFor(90, java.util.concurrent.TimeUnit.SECONDS), "retry CLI completes");
        assertEquals(0, retry.exitValue(), Files.readString(childLog));
        Path source = destination.resolve("source.wav");
        Path candidate = destination.resolve("repaired-candidate.wav");
        Path manifest = destination.resolve("audio-repair-manifest.json");
        assertTrue(Files.isRegularFile(source, LinkOption.NOFOLLOW_LINKS));
        assertTrue(Files.isRegularFile(candidate, LinkOption.NOFOLLOW_LINKS));
        assertTrue(Files.isRegularFile(manifest, LinkOption.NOFOLLOW_LINKS));
        var tree = new ObjectMapper().readTree(Files.readString(manifest));
        assertEquals(sha256(Files.readAllBytes(source)), tree.path("outputs").path("source").path("wavSha256").asString());
        assertEquals(sha256(Files.readAllBytes(candidate)),
                tree.path("outputs").path("repairedCandidate").path("wavSha256").asString());
    }

    private Path awaitPartialStage(Process process, Path destination, Duration timeout) throws Exception {
        Path stagingParent = destination.getParent();
        String prefix = "." + destination.getFileName() + ".audio-repair-staging-";
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline && process.isAlive()) {
            try (var entries = Files.list(stagingParent)) {
                for (Path entry : entries.toList()) {
                    if (entry.getFileName().toString().startsWith(prefix)
                            && Files.isRegularFile(entry.resolve("source.wav"), LinkOption.NOFOLLOW_LINKS)
                            && !Files.exists(entry.resolve("repaired-candidate.wav"), LinkOption.NOFOLLOW_LINKS)) {
                        return entry;
                    }
                }
            }
            Thread.sleep(1);
        }
        String childOutput = Files.exists(tempDir.resolve("audio-repair-child.log"))
                ? Files.readString(tempDir.resolve("audio-repair-child.log")) : "no child output";
        throw new AssertionError("CLI did not expose its private partial stage before completing: " + childOutput);
    }

    private static Process startCli(Path input, Path destination, Path log) throws Exception {
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        String classpath = String.join(System.getProperty("path.separator"), List.of(
                classLocation(AudioRepairPreview.class),
                classLocation(com.ghatana.media.production.audio.BoundedPcmDeclipper.class),
                classLocation(com.ghatana.media.common.AudioData.class)));
        return new ProcessBuilder(java, "-cp", classpath,
                AudioRepairPreview.class.getName(), input.toString(), destination.toString())
                .redirectErrorStream(true).redirectOutput(log.toFile()).start();
    }

    private static String classLocation(Class<?> type) throws Exception {
        return Path.of(type.getProtectionDomain().getCodeSource().getLocation().toURI()).toString();
    }

    private static byte[] pcm(int... samples) {
        ByteBuffer bytes = ByteBuffer.allocate(samples.length * 2).order(ByteOrder.LITTLE_ENDIAN);
        for (int sample : samples) bytes.putShort((short) sample);
        return bytes.array();
    }

    private static byte[] pcm(short[] samples) {
        byte[] result = new byte[samples.length * 2];
        for (int index = 0; index < samples.length; index++) {
            result[index * 2] = (byte) samples[index];
            result[index * 2 + 1] = (byte) (samples[index] >>> 8);
        }
        return result;
    }

    private static void writeWav(Path path, byte[] pcm) throws Exception {
        writeWav(path, pcm, 16);
    }

    private static void writeWav(Path path, byte[] pcm, int bits) throws Exception {
        int sampleBytes = bits / 8;
        javax.sound.sampled.AudioFormat format = new javax.sound.sampled.AudioFormat(
                javax.sound.sampled.AudioFormat.Encoding.PCM_SIGNED, 1_000, bits, 1, sampleBytes, 1_000, false);
        try (AudioInputStream audio = new AudioInputStream(new ByteArrayInputStream(pcm), format,
                pcm.length / sampleBytes)) {
            AudioSystem.write(audio, AudioFileFormat.Type.WAVE, path.toFile());
        }
    }

    private static byte[] packedPcm(int bits, long... samples) {
        int sampleBytes = bits / 8;
        ByteBuffer bytes = ByteBuffer.allocate(samples.length * sampleBytes).order(ByteOrder.LITTLE_ENDIAN);
        for (long sample : samples) {
            for (int index = 0; index < sampleBytes; index++) bytes.put((byte) (sample >>> (index * 8)));
        }
        return bytes.array();
    }

    private static byte[] readWav(Path path) throws Exception {
        try (AudioInputStream audio = AudioSystem.getAudioInputStream(path.toFile())) {
            return audio.readAllBytes();
        }
    }

    private static void assertWavFormat(Path path, float sampleRate, int channels, int bits, long frames)
            throws Exception {
        try (AudioInputStream audio = AudioSystem.getAudioInputStream(path.toFile())) {
            assertEquals(javax.sound.sampled.AudioFormat.Encoding.PCM_SIGNED, audio.getFormat().getEncoding());
            assertEquals(sampleRate, audio.getFormat().getSampleRate());
            assertEquals(channels, audio.getFormat().getChannels());
            assertEquals(bits, audio.getFormat().getSampleSizeInBits());
            assertEquals(frames, audio.getFrameLength());
        }
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}
