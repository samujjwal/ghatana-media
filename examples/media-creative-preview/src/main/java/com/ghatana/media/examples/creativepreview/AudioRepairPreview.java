package com.ghatana.media.examples.creativepreview;

import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.production.audio.AudioRepairComparison;
import com.ghatana.media.production.audio.BoundedPcmDeclipper;

import javax.sound.sampled.AudioFileFormat;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import javax.sound.sampled.UnsupportedAudioFileException;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Set;

/** A source-preserving local A/B consumer for caller-provided PCM WAV files. */
public final class AudioRepairPreview {
    private static final int MAX_INPUT_FILE_BYTES = BoundedPcmDeclipper.MAX_PCM_BYTES + 64 * 1024;

    private AudioRepairPreview() { }

    public static void main(String[] args) throws Exception {
        if (args.length < 1 || args.length > 2) {
            throw new IllegalArgumentException("usage: AudioRepairPreview <input-pcm.wav> [output-directory]");
        }
        Path input = Path.of(args[0]).toAbsolutePath().normalize();
        Path output = args.length == 2 ? Path.of(args[1]).toAbsolutePath().normalize()
                : Path.of("build/audio-repair-preview").toAbsolutePath().normalize();
        run(input, output);
        System.out.println("Local audio repair A/B written to " + output);
    }

    static void run(Path input, Path output) throws Exception {
        if (!Files.isRegularFile(input)) throw new IOException("input must be an existing WAV file");
        if (Files.size(input) > MAX_INPUT_FILE_BYTES) throw new IOException("input WAV exceeds the local size bound");
        Path requestedDestination = output.toAbsolutePath().normalize();
        Path requestedParent = requestedDestination.getParent();
        if (requestedParent == null || !Files.isDirectory(requestedParent)) {
            throw new IOException("output parent must be an existing directory");
        }
        Path parent = requestedParent.toRealPath();
        Path destination = parent.resolve(requestedDestination.getFileName());
        if (Files.exists(destination, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("output destination must not already exist: " + destination);
        }
        Path lockPath = parent.resolve("." + destination.getFileName() + ".audio-repair.lock");
        if (samePath(input, destination) || samePath(input, lockPath)) {
            throw new IOException("output destination and reservation path must not alias the input WAV");
        }

        try (DestinationLock destinationLock = DestinationLock.acquire(lockPath, input)) {
            if (Files.exists(destination, LinkOption.NOFOLLOW_LINKS)) {
                throw new IOException("output destination was published by another writer: " + destination);
            }
            byte[] inputWav = readBoundedInput(input);
            AudioData source = readPcmWav(inputWav);
            Path staging = Files.createTempDirectory(parent,
                    "." + destination.getFileName() + ".audio-repair-staging-");
            Object stagingKey = fileKey(staging);
            boolean published = false;
            try {
                Path stagedSource = staging.resolve("source.wav");
                Path stagedRepaired = staging.resolve("repaired-candidate.wav");
                Path stagedManifest = staging.resolve("audio-repair-manifest.json");
                byte[] sourceWavBytes = encodePcmWav(source);
                writePrivateFile(stagedSource, sourceWavBytes);

                // Keep the source branch private while the bounded repair runs. A hard stop
                // here can leave staging residue, but never an incomplete public bundle.
                AudioData repaired = BoundedPcmDeclipper.repair(source, 0.94, 64);
                AudioRepairComparison comparison = AudioRepairComparison.compare(source, repaired);
                byte[] repairedWavBytes = encodePcmWav(comparison.repaired());
                writePrivateFile(stagedRepaired, repairedWavBytes);

                byte[] persistedSourceWav = readPrivateFile(stagedSource);
                byte[] persistedRepairedWav = readPrivateFile(stagedRepaired);
                if (!sha256(persistedSourceWav).equals(sha256(sourceWavBytes))
                        || !sha256(persistedRepairedWav).equals(sha256(repairedWavBytes))) {
                    throw new IOException("persisted A/B WAV digests do not match the bytes selected for output");
                }
                AudioData reopenedSource = readPcmWav(persistedSourceWav);
                AudioData reopenedRepaired = readPcmWav(persistedRepairedWav);
                byte[] sourceReadback = reopenedSource.data();
                byte[] repairedReadback = reopenedRepaired.data();
                if (!sameFormatAndDuration(source, reopenedSource)
                        || !sameFormatAndDuration(source, reopenedRepaired)
                        || !java.util.Arrays.equals(sourceReadback, comparison.source().data())
                        || !java.util.Arrays.equals(repairedReadback, comparison.repaired().data())) {
                    throw new IOException("persisted A/B WAV bytes do not match their immutable PCM branches");
                }
                AudioRepairComparison readback = AudioRepairComparison.compare(
                        new AudioData(sourceReadback, source.sampleRate(), source.channels(), source.bitsPerSample(),
                                source.duration(), AudioFormat.PCM),
                        new AudioData(repairedReadback, source.sampleRate(), source.channels(), source.bitsPerSample(),
                                source.duration(), AudioFormat.PCM));
                if (!readback.sourceSha256().equals(comparison.sourceSha256())
                        || !readback.repairedSha256().equals(comparison.repairedSha256())) {
                    throw new IOException("persisted A/B digests do not match the in-memory comparison");
                }
                String manifest = manifest(input, inputWav, stagedSource, stagedRepaired,
                        sourceWavBytes, repairedWavBytes, source, comparison, readback);
                byte[] manifestBytes = manifest.getBytes(StandardCharsets.UTF_8);
                writePrivateFile(stagedManifest, manifestBytes);
                if (!java.util.Arrays.equals(readPrivateFile(stagedManifest), manifestBytes)) {
                    throw new IOException("persisted audio repair manifest differs from the generated manifest");
                }
                if (!stagingKey.equals(fileKey(staging))) {
                    throw new IOException("private staging directory identity changed before publication");
                }
                destinationLock.verifyStable();
                if (Files.exists(destination, LinkOption.NOFOLLOW_LINKS)) {
                    throw new IOException("output destination appeared before atomic publication: " + destination);
                }
                try {
                    Files.move(staging, destination, StandardCopyOption.ATOMIC_MOVE);
                } catch (AtomicMoveNotSupportedException unsupported) {
                    throw new IOException("filesystem cannot atomically publish the complete output directory",
                            unsupported);
                } catch (FileAlreadyExistsException collision) {
                    throw new IOException("output destination appeared before atomic publication", collision);
                }
                published = true;
            } finally {
                if (!published) cleanupStaging(staging, stagingKey);
            }
        }
    }

    private static byte[] readBoundedInput(Path path) throws IOException {
        try (InputStream input = Files.newInputStream(path)) {
            byte[] snapshot = input.readNBytes(MAX_INPUT_FILE_BYTES + 1);
            if (snapshot.length == 0 || snapshot.length > MAX_INPUT_FILE_BYTES) {
                throw new IOException("input WAV exceeds the local size bound");
            }
            return snapshot;
        }
    }

    private static AudioData readPcmWav(byte[] wavBytes) throws IOException {
        try {
            if (!AudioFileFormat.Type.WAVE.equals(AudioSystem.getAudioFileFormat(
                    new ByteArrayInputStream(wavBytes)).getType())) {
                throw new IOException("input must be a WAVE file");
            }
            try (AudioInputStream stream = AudioSystem.getAudioInputStream(new ByteArrayInputStream(wavBytes))) {
                javax.sound.sampled.AudioFormat format = stream.getFormat();
                int bits = format.getSampleSizeInBits();
                int channels = format.getChannels();
                if (!javax.sound.sampled.AudioFormat.Encoding.PCM_SIGNED.equals(format.getEncoding())
                        || format.isBigEndian() || (bits != 16 && bits != 24 && bits != 32)
                        || (channels != 1 && channels != 2) || !Float.isFinite(format.getSampleRate())
                        || format.getSampleRate() < 1 || format.getSampleRate() > Integer.MAX_VALUE
                        || format.getSampleRate() != Math.rint(format.getSampleRate())
                        || format.getFrameSize() != channels * (bits / 8)) {
                    throw new IOException("WAV must be little-endian signed PCM16/24/32 mono or stereo");
                }
                byte[] pcm = stream.readNBytes(BoundedPcmDeclipper.MAX_PCM_BYTES + 1);
                if (pcm.length == 0 || pcm.length > BoundedPcmDeclipper.MAX_PCM_BYTES
                        || pcm.length % format.getFrameSize() != 0) {
                    throw new IOException("WAV PCM must be non-empty, complete-frame, and at most 16 MiB");
                }
                long frames = pcm.length / format.getFrameSize();
                if (stream.getFrameLength() != AudioSystem.NOT_SPECIFIED && stream.getFrameLength() != frames) {
                    throw new IOException("WAV declared frame length does not match decoded PCM");
                }
                Duration duration = duration(frames, (int) format.getSampleRate());
                return new AudioData(pcm, (int) format.getSampleRate(), channels, bits, duration, AudioFormat.PCM);
            }
        } catch (UnsupportedAudioFileException unsupported) {
            throw new IOException("input must be a valid WAV file", unsupported);
        }
    }

    private static Duration duration(long frames, int sampleRate) {
        long whole = frames / sampleRate;
        long remainder = frames % sampleRate;
        long nanos = (remainder * 1_000_000_000L + sampleRate / 2L) / sampleRate;
        return Duration.ofSeconds(whole, nanos);
    }

    private static boolean sameFormatAndDuration(AudioData expected, AudioData actual) {
        return expected.format() == actual.format()
                && expected.sampleRate() == actual.sampleRate()
                && expected.channels() == actual.channels()
                && expected.bitsPerSample() == actual.bitsPerSample()
                && expected.duration().equals(actual.duration())
                && expected.dataLength() == actual.dataLength();
    }

    private static boolean samePath(Path input, Path output) throws IOException {
        return input.equals(output) || (Files.exists(output) && Files.isSameFile(input, output));
    }

    private static Object fileKey(Path path) throws IOException {
        Object key = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS).fileKey();
        if (key == null) throw new IOException("filesystem cannot identify output path safely: " + path);
        return key;
    }

    private static void writePrivateFile(Path path, byte[] bytes) throws IOException {
        try (FileChannel channel = FileChannel.open(path, Set.of(StandardOpenOption.CREATE_NEW,
                StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS))) {
            java.nio.ByteBuffer buffer = java.nio.ByteBuffer.wrap(bytes);
            while (buffer.hasRemaining()) channel.write(buffer);
            channel.force(true);
        } catch (FileAlreadyExistsException collision) {
            throw new IOException("private staging output already exists: " + path, collision);
        } catch (UnsupportedOperationException unsupported) {
            throw new IOException("filesystem cannot safely create private staging output: " + path, unsupported);
        }
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("private staging output is not a regular file: " + path);
        }
        fileKey(path);
    }

    private static byte[] readPrivateFile(Path path) throws IOException {
        try (InputStream input = Files.newInputStream(path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            byte[] bytes = input.readNBytes(MAX_INPUT_FILE_BYTES + 64 * 1024 + 1);
            if (bytes.length == 0 || bytes.length > MAX_INPUT_FILE_BYTES + 64 * 1024) {
                throw new IOException("private staged output exceeds its readback bound: " + path);
            }
            return bytes;
        }
    }

    private static void cleanupStaging(Path staging, Object expectedKey) throws IOException {
        if (!Files.exists(staging, LinkOption.NOFOLLOW_LINKS)) return;
        if (!Files.isDirectory(staging, LinkOption.NOFOLLOW_LINKS) || !expectedKey.equals(fileKey(staging))) {
            throw new IOException("private staging path changed identity; refusing unsafe cleanup: " + staging);
        }
        try (var entries = Files.list(staging)) {
            for (Path entry : entries.toList()) {
                String name = entry.getFileName().toString();
                if (!Set.of("source.wav", "repaired-candidate.wav", "audio-repair-manifest.json").contains(name)
                        || !Files.isRegularFile(entry, LinkOption.NOFOLLOW_LINKS)) {
                    throw new IOException("unexpected object in private staging directory; refusing cleanup: " + entry);
                }
                Files.delete(entry);
            }
        }
        Files.delete(staging);
    }

    /** Persistent sibling lock file coordinates cooperating runs even if an owner is killed. */
    private static final class DestinationLock implements AutoCloseable {
        private final FileChannel channel;
        private final FileLock lock;
        private final Path path;
        private final Object fileKey;

        private DestinationLock(FileChannel channel, FileLock lock, Path path, Object fileKey) {
            this.channel = channel;
            this.lock = lock;
            this.path = path;
            this.fileKey = fileKey;
        }

        static DestinationLock acquire(Path path, Path input) throws IOException {
            FileChannel channel;
            try {
                channel = FileChannel.open(path, Set.of(StandardOpenOption.CREATE, StandardOpenOption.READ,
                        StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS));
            } catch (UnsupportedOperationException unsupported) {
                throw new IOException("filesystem cannot safely open destination reservation: " + path, unsupported);
            }
            try {
                if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(path)
                        || Files.isSameFile(path, input)) {
                    throw new IOException("destination reservation must be a distinct regular file: " + path);
                }
                Object links;
                try {
                    links = Files.getAttribute(path, "unix:nlink", LinkOption.NOFOLLOW_LINKS);
                } catch (UnsupportedOperationException unsupported) {
                    throw new IOException("filesystem cannot verify destination reservation aliases", unsupported);
                }
                if (!(links instanceof Number count) || count.longValue() != 1L) {
                    throw new IOException("destination reservation must not have hardlink aliases: " + path);
                }
                Object key = fileKey(path);
                FileLock lock;
                try {
                    lock = channel.tryLock();
                } catch (OverlappingFileLockException busy) {
                    throw new IOException("another audio repair attempt is using this destination", busy);
                }
                if (lock == null) throw new IOException("another audio repair attempt is using this destination");
                return new DestinationLock(channel, lock, path, key);
            } catch (IOException | RuntimeException failure) {
                try { channel.close(); } catch (IOException close) { failure.addSuppressed(close); }
                throw failure;
            }
        }

        void verifyStable() throws IOException {
            if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(path)
                    || !fileKey.equals(fileKey(path))) {
                throw new IOException("destination reservation changed identity before publication");
            }
            Object links = Files.getAttribute(path, "unix:nlink", LinkOption.NOFOLLOW_LINKS);
            if (!(links instanceof Number count) || count.longValue() != 1L) {
                throw new IOException("destination reservation acquired a hardlink alias");
            }
        }

        @Override public void close() throws IOException {
            IOException failure = null;
            try { lock.release(); } catch (IOException close) { failure = close; }
            try { channel.close(); } catch (IOException close) {
                if (failure == null) failure = close;
                else failure.addSuppressed(close);
            }
            if (failure != null) throw failure;
        }
    }

    private static byte[] encodePcmWav(AudioData audio) throws IOException {
        int frameSize = audio.channels() * (audio.bitsPerSample() / 8);
        javax.sound.sampled.AudioFormat format = new javax.sound.sampled.AudioFormat(
                javax.sound.sampled.AudioFormat.Encoding.PCM_SIGNED, audio.sampleRate(), audio.bitsPerSample(),
                audio.channels(), frameSize, audio.sampleRate(), false);
        byte[] pcm = audio.data();
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (AudioInputStream stream = new AudioInputStream(new ByteArrayInputStream(pcm), format,
                pcm.length / frameSize)) {
            if (AudioSystem.write(stream, AudioFileFormat.Type.WAVE, output) <= 0) {
                throw new IOException("WAV writer produced no output");
            }
        }
        return output.toByteArray();
    }

    private static String manifest(Path input, byte[] inputWav, Path sourceWav, Path repairedWav,
                                   byte[] sourceWavBytes, byte[] repairedWavBytes, AudioData source,
                                   AudioRepairComparison comparison, AudioRepairComparison readback)
            throws IOException {
        var metrics = readback.metrics();
        String inputName = json(input.getFileName().toString());
        return """
                {
                  "kind": "LOCAL_AUDIO_REPAIR_PREVIEW_ONLY",
                  "input": {"filename": %s, "wavSha256": "%s", "pcmSha256": "%s"},
                  "format": {"encoding": "signed PCM little-endian", "sampleRateHz": %d, "channels": %d, "bitsPerSample": %d, "frameCount": %d, "durationNanosRounded": %d},
                  "repair": {"algorithm": "BoundedPcmDeclipper.linear-interpolation", "threshold": 0.94, "maxRunFrames": 64},
                  "comparison": {"sourcePcmSha256": "%s", "repairedPcmSha256": "%s", "changedSampleCount": %d, "peakSemantics": "maximum absolute decoded signed sample-code magnitude across all channels; sample peak, not true peak", "positiveFullScaleCode": %d, "sourceSamplePeakCodeMagnitude": %d, "repairedSamplePeakCodeMagnitude": %d, "sourceNearClipSampleCount": %d, "repairedNearClipSampleCount": %d, "sourceRmsSampleCodeUnits": %s, "repairedRmsSampleCodeUnits": %s, "hasIndependentReference": false, "snrDbVsReference": null, "qualityClaim": false},
                  "outputs": {"source": {"filename": %s, "wavSha256": "%s"}, "repairedCandidate": {"filename": %s, "wavSha256": "%s"}},
                  "limitations": ["caller must determine rights and suitability of the input", "near-full-scale samples are only a clipping heuristic", "linear interpolation estimates missing samples and does not recover source truth", "no independent reference, perceptual-quality claim, durable project revision, or hosted job is supplied"]
                }
                """.formatted(inputName, sha256(inputWav), comparison.sourceSha256(),
                source.sampleRate(), source.channels(), source.bitsPerSample(), source.dataLength()
                        / (source.channels() * (source.bitsPerSample() / 8)), source.duration().toNanos(),
                comparison.sourceSha256(), comparison.repairedSha256(), metrics.changedSampleCount(),
                (1L << (source.bitsPerSample() - 1)) - 1L, metrics.sourcePeak(), metrics.repairedPeak(), metrics.sourceNearClipSampleCount(),
                metrics.repairedNearClipSampleCount(), metrics.sourceRms(), metrics.repairedRms(),
                json(sourceWav.getFileName().toString()), sha256(sourceWavBytes),
                json(repairedWav.getFileName().toString()), sha256(repairedWavBytes));
    }

    private static String json(String value) {
        StringBuilder escaped = new StringBuilder(value.length() + 2).append('"');
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            switch (character) {
                case '"' -> escaped.append("\\\"");
                case '\\' -> escaped.append("\\\\");
                case '\b' -> escaped.append("\\b");
                case '\f' -> escaped.append("\\f");
                case '\n' -> escaped.append("\\n");
                case '\r' -> escaped.append("\\r");
                case '\t' -> escaped.append("\\t");
                default -> {
                    if (character < 0x20) {
                        escaped.append("\\u00");
                        escaped.append(Character.forDigit((character >>> 4) & 0xf, 16));
                        escaped.append(Character.forDigit(character & 0xf, 16));
                    } else {
                        escaped.append(character);
                    }
                }
            }
        }
        return escaped.append('"').toString();
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("JDK SHA-256 is unavailable", impossible);
        }
    }
}
