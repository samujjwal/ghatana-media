package com.ghatana.media.examples.creativepreview;

import com.ghatana.media.production.audio.PcmStemMixer;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import javax.sound.sampled.AudioFileFormat;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Caller-file consumer for bounded, local PCM stem mixing. Rights fields are caller declarations only. */
public final class FoleyStemMasterPreview {
    private static final int MAX_REQUEST_BYTES = 256 * 1024;
    private static final int WAV_HEADER_ALLOWANCE = 64 * 1024;
    private static final ObjectMapper JSON = new ObjectMapper(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build())
            .rebuild().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    private static final PcmStemMixer MIXER = new PcmStemMixer();

    private FoleyStemMasterPreview() { }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            throw new IllegalArgumentException("usage: FoleyStemMasterPreview <request.json> <output-directory>");
        }
        run(Path.of(args[0]), Path.of(args[1]), Clock.systemUTC());
        System.out.println("Local caller-input stem master written; rights and master qualification are not verified.");
    }

    static void run(Path requestPath, Path outputDirectory, Clock clock) throws Exception {
        Path request = requestPath.toAbsolutePath().normalize();
        Path output = outputDirectory.toAbsolutePath().normalize();
        if (!Files.isRegularFile(request, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("request must be a regular JSON file");
        }
        byte[] requestBytes = readBounded(request, MAX_REQUEST_BYTES, "request JSON");
        JsonNode root;
        try {
            root = JSON.readTree(requestBytes);
        } catch (RuntimeException malformed) {
            throw new IOException("request JSON is malformed", malformed);
        }
        Request parsed = parseRequest(root, request.getParent());
        List<StemSource> sources = loadSources(parsed, request, output);

        List<PcmStemMixer.Stem> stems = sources.stream().map(source -> new PcmStemMixer.Stem(
                source.sourceVersionRef(), parsed.sampleRateHz(), PcmStemMixer.CHANNELS,
                PcmStemMixer.BITS_PER_SAMPLE, source.pcm(), source.gain(), source.pan(),
                new PcmStemMixer.AssetProvenance(source.sourceVersionRef(), source.rightsEvidence()))).toList();
        PcmStemMixer.MixResult result = MIXER.mix(stems,
                new PcmStemMixer.MixSpec(parsed.sampleRateHz(), parsed.frameCount(), parsed.truePeakCeiling()), clock);

        Files.createDirectories(output);
        Path mixPath = output.resolve("foley-master.wav").toAbsolutePath().normalize();
        Path manifestPath = output.resolve("foley-master-manifest.json").toAbsolutePath().normalize();
        Path[] outputPaths = {mixPath, manifestPath};
        validateOutputPaths(outputPaths, sources, request);

        try (ExclusiveOutputs outputs = ExclusiveOutputs.create(outputPaths)) {
            byte[] wav = result.wav();
            outputs.write(0, wav);
            byte[] persistedWav = outputs.read(0);
            DecodedPcm readback = decodeWav(persistedWav, parsed.sampleRateHz(), parsed.frameCount());
            if (!java.util.Arrays.equals(readback.pcm(), result.pcmS16Le())
                    || !sha256(persistedWav).equals(result.wavSha256())) {
                throw new IOException("persisted master WAV does not match the mixer result");
            }
            byte[] manifest = JSON.writeValueAsBytes(manifest(request, requestBytes, parsed, sources,
                    mixPath, persistedWav, readback, result));
            outputs.write(1, manifest);
            if (!java.util.Arrays.equals(outputs.read(1), manifest)) {
                throw new IOException("persisted master manifest differs from the generated manifest");
            }
            outputs.commit();
        }
    }

    private static Request parseRequest(JsonNode root, Path requestDirectory) throws IOException {
        requireObject(root, "request");
        requireFields(root, List.of("sampleRateHz", "frameCount", "truePeakCeiling", "stems"), "request");
        int sampleRate = requiredInt(root, "sampleRateHz");
        int frameCount = requiredInt(root, "frameCount");
        double ceilingValue = requiredFiniteNumber(root, "truePeakCeiling");
        if (sampleRate < 8_000 || sampleRate > 192_000 || frameCount <= 0
                || frameCount > PcmStemMixer.MAX_FRAMES || ceilingValue <= 0 || ceilingValue > 0.98) {
            throw new IOException("request sample rate, frame count, or peak ceiling is outside the mixer bounds");
        }
        if (!root.path("stems").isArray() || root.path("stems").isEmpty()
                || root.path("stems").size() > PcmStemMixer.MAX_STEMS) {
            throw new IOException("request must contain 1..16 stems");
        }
        List<StemRequest> stems = new ArrayList<>();
        for (int index = 0; index < root.path("stems").size(); index++) {
            JsonNode stem = root.path("stems").get(index);
            requireObject(stem, "stem " + index);
            requireFields(stem, List.of("path", "sourceVersionRef", "gain", "pan", "rightsEvidence"), "stem " + index);
            String rawPath = requiredText(stem, "path");
            Path supplied = Path.of(rawPath);
            Path sourcePath = (supplied.isAbsolute() ? supplied : requestDirectory.resolve(supplied))
                    .toAbsolutePath().normalize();
            String version = requiredText(stem, "sourceVersionRef");
            double gain = requiredFiniteNumber(stem, "gain");
            double pan = requiredFiniteNumber(stem, "pan");
            if (gain < 0 || gain > 4 || pan < -1 || pan > 1) {
                throw new IOException("stem gain or pan is outside the mixer bounds");
            }
            JsonNode evidence = stem.path("rightsEvidence");
            requireObject(evidence, "stem rightsEvidence");
            requireFields(evidence, List.of("decisionRef", "purpose", "disposition", "validFrom", "validUntil"),
                    "stem rightsEvidence");
            PcmStemMixer.RightsEvidence rights;
            try {
                rights = new PcmStemMixer.RightsEvidence(version, requiredText(evidence, "decisionRef"),
                        PcmStemMixer.RightsPurpose.valueOf(requiredText(evidence, "purpose")),
                        PcmStemMixer.RightsDisposition.valueOf(requiredText(evidence, "disposition")),
                        Instant.parse(requiredText(evidence, "validFrom")),
                        Instant.parse(requiredText(evidence, "validUntil")));
            } catch (IllegalArgumentException | java.time.DateTimeException invalid) {
                throw new IOException("stem rights declaration is malformed", invalid);
            }
            stems.add(new StemRequest(sourcePath, version, (float) gain, (float) pan, rights));
        }
        return new Request(sampleRate, frameCount, (float) ceilingValue, List.copyOf(stems));
    }

    private static List<StemSource> loadSources(Request request, Path requestPath, Path outputDirectory)
            throws IOException {
        List<StemSource> sources = new ArrayList<>(request.stems().size());
        long aggregatePcmBytes = 0;
        for (StemRequest stem : request.stems()) {
            if (!Files.isRegularFile(stem.path(), LinkOption.NOFOLLOW_LINKS)) {
                throw new IOException("every stem path must be an existing regular file");
            }
            if (samePath(stem.path(), requestPath)) {
                throw new IOException("a stem input cannot be the request JSON");
            }
            if (Files.size(stem.path()) > PcmStemMixer.MAX_STEM_PCM_BYTES + WAV_HEADER_ALLOWANCE) {
                throw new IOException("stem WAV exceeds the local input byte bound");
            }
            byte[] wav = readBounded(stem.path(), PcmStemMixer.MAX_STEM_PCM_BYTES + WAV_HEADER_ALLOWANCE,
                    "stem WAV");
            DecodedPcm decoded = decodeWav(wav, request.sampleRateHz(), request.frameCount());
            aggregatePcmBytes += decoded.pcm().length;
            if (aggregatePcmBytes > PcmStemMixer.MAX_AGGREGATE_INPUT_BYTES) {
                throw new IOException("aggregate stem PCM exceeds the local mixer byte bound");
            }
            sources.add(new StemSource(stem.path(), stem.sourceVersionRef(), stem.gain(), stem.pan(),
                    stem.rightsEvidence(), wav, decoded.pcm()));
        }
        return List.copyOf(sources);
    }

    private static DecodedPcm decodeWav(byte[] wav, int expectedSampleRate, int expectedFrameCount)
            throws IOException {
        try {
            if (!AudioFileFormat.Type.WAVE.equals(AudioSystem.getAudioFileFormat(new ByteArrayInputStream(wav)).getType())) {
                throw new IOException("stem input must be a WAVE file");
            }
            try (AudioInputStream stream = AudioSystem.getAudioInputStream(new ByteArrayInputStream(wav))) {
                javax.sound.sampled.AudioFormat format = stream.getFormat();
                if (!javax.sound.sampled.AudioFormat.Encoding.PCM_SIGNED.equals(format.getEncoding())
                        || format.isBigEndian() || format.getChannels() != PcmStemMixer.CHANNELS
                        || format.getSampleSizeInBits() != PcmStemMixer.BITS_PER_SAMPLE
                        || format.getFrameSize() != PcmStemMixer.CHANNELS * 2
                        || format.getSampleRate() != expectedSampleRate) {
                    throw new IOException("stem WAV must be little-endian PCM16 stereo at the requested sample rate");
                }
                int maximumPcm = PcmStemMixer.MAX_STEM_PCM_BYTES;
                byte[] pcm = stream.readNBytes(maximumPcm + 1);
                if (pcm.length == 0 || pcm.length > maximumPcm || pcm.length % format.getFrameSize() != 0) {
                    throw new IOException("stem PCM must be non-empty, complete-frame, and within the mixer frame budget");
                }
                int frames = pcm.length / format.getFrameSize();
                if (frames != expectedFrameCount || (stream.getFrameLength() != AudioSystem.NOT_SPECIFIED
                        && stream.getFrameLength() != frames)) {
                    throw new IOException("all stem WAVs must have the exact requested frame count; no trim or pad is applied");
                }
                return new DecodedPcm(pcm, expectedSampleRate, format.getChannels(), format.getSampleSizeInBits(), frames);
            }
        } catch (javax.sound.sampled.UnsupportedAudioFileException unsupported) {
            throw new IOException("stem input is not a supported WAV file", unsupported);
        }
    }

    private static Map<String, Object> manifest(Path requestPath, byte[] requestBytes, Request request,
            List<StemSource> sources, Path mixPath, byte[] wav, DecodedPcm readback,
            PcmStemMixer.MixResult result) {
        List<Map<String, Object>> inputs = new ArrayList<>();
        for (StemSource source : sources) {
            Map<String, Object> rights = new LinkedHashMap<>();
            rights.put("sourceVersionRef", source.sourceVersionRef());
            rights.put("decisionRef", source.rightsEvidence().decisionRef());
            rights.put("purpose", source.rightsEvidence().purpose().name());
            rights.put("disposition", source.rightsEvidence().disposition().name());
            rights.put("validFrom", source.rightsEvidence().validFrom().toString());
            rights.put("validUntil", source.rightsEvidence().validUntil().toString());
            rights.put("authority", "CALLER_DECLARED_UNVERIFIED");
            Map<String, Object> input = new LinkedHashMap<>();
            input.put("filename", source.path().getFileName().toString());
            input.put("sourceVersionRef", source.sourceVersionRef());
            input.put("wavSha256", sha256(source.wav()));
            input.put("pcmSha256", sha256(source.pcm()));
            input.put("sampleRateHz", readback.sampleRate());
            input.put("channels", readback.channels());
            input.put("bitsPerSample", readback.bitsPerSample());
            input.put("frameCount", readback.frameCount());
            input.put("gain", source.gain());
            input.put("pan", source.pan());
            input.put("rightsDeclaration", rights);
            inputs.add(input);
        }
        Map<String, Object> metrics = new LinkedHashMap<>();
        metrics.put("appliedMasterGain", result.appliedMasterGain());
        // Keep the legacy windowed-sinc estimate distinct from the Annex 2-based FIR measurement.
        metrics.put("windowedSincTruePeakEstimateBeforeCeiling", finiteOrNull(result.estimatedTruePeakBeforeCeiling()));
        metrics.put("windowedSincTruePeakEstimateAfterCeiling", finiteOrNull(result.estimatedTruePeakAfterCeiling()));
        // Preserve the previous field names for callers of this local preview manifest.
        metrics.put("estimatedTruePeakBeforeCeiling", finiteOrNull(result.estimatedTruePeakBeforeCeiling()));
        metrics.put("estimatedTruePeakAfterCeiling", finiteOrNull(result.estimatedTruePeakAfterCeiling()));
        metrics.put("annex2TruePeakBeforeCeiling", truePeakMeasurement(result.annex2TruePeakBeforeCeiling()));
        metrics.put("annex2TruePeakAfterCeiling", truePeakMeasurement(result.annex2TruePeakAfterCeiling()));
        metrics.put("samplePeakAfterCeiling", finiteOrNull(result.samplePeakAfterCeiling()));
        metrics.put("rmsDbfsAfterCeiling", finiteOrNull(result.rmsDbfsAfterCeiling()));
        metrics.put("rmsIsSilence", !Double.isFinite(result.rmsDbfsAfterCeiling()));
        metrics.put("truePeakMethod", "BS.1770-5 Annex 2-based 4x FIR estimate; not standards-certified");

        Map<String, Object> root = new LinkedHashMap<>();
        root.put("kind", "LOCAL_FOLEY_STEM_MASTER_PREVIEW_ONLY");
        root.put("rightsAuthority", "CALLER_DECLARED_UNVERIFIED");
        root.put("request", Map.of("filename", requestPath.getFileName().toString(),
                "sha256", sha256(requestBytes)));
        root.put("format", Map.of("sampleRateHz", request.sampleRateHz(), "channels", PcmStemMixer.CHANNELS,
                "bitsPerSample", PcmStemMixer.BITS_PER_SAMPLE, "frameCount", request.frameCount()));
        root.put("inputs", inputs);
        root.put("mix", Map.of("truePeakCeiling", request.truePeakCeiling(), "metrics", metrics));
        root.put("output", Map.of("filename", mixPath.getFileName().toString(),
                "wavSha256", sha256(wav), "pcmSha256", result.pcmSha256()));
        root.put("readback", Map.of("decoder", "Java Sound WAVE/PCM readback", "sampleRateHz", readback.sampleRate(),
                "channels", readback.channels(), "bitsPerSample", readback.bitsPerSample(),
                "frameCount", readback.frameCount(), "pcmSha256", sha256(readback.pcm())));
        root.put("limitations", List.of("rights evidence is a caller declaration and is not authenticated or independently reviewed",
                "this local mix does not generate Foley, perform loudness normalization, or certify true peak",
                "no source authority, production host, canonical project/job, artifact registration, or delivery receipt is used"));
        return root;
    }

    private static void validateOutputPaths(Path[] outputs, List<StemSource> sources, Path request) throws IOException {
        for (int i = 0; i < outputs.length; i++) {
            Path output = outputs[i];
            if (samePath(output, request)) throw new IOException("output cannot replace the request JSON");
            for (StemSource source : sources) {
                if (samePath(output, source.path())) throw new IOException("output cannot replace a stem WAV");
            }
            if (Files.exists(output, LinkOption.NOFOLLOW_LINKS)) {
                throw new IOException("output path already exists; choose an empty output directory: " + output.getFileName());
            }
            for (int j = 0; j < i; j++) {
                if (samePath(output, outputs[j])) throw new IOException("output paths must be distinct");
            }
        }
    }

    private static boolean samePath(Path left, Path right) throws IOException {
        return left.equals(right) || (Files.exists(left, LinkOption.NOFOLLOW_LINKS)
                && Files.exists(right, LinkOption.NOFOLLOW_LINKS) && Files.isSameFile(left, right));
    }

    private static byte[] readBounded(Path path, int maximumBytes, String label) throws IOException {
        try (InputStream input = Files.newInputStream(path)) {
            byte[] bytes = input.readNBytes(maximumBytes + 1);
            if (bytes.length == 0 || bytes.length > maximumBytes) throw new IOException(label + " exceeds the local byte bound");
            return bytes;
        }
    }

    private static void requireObject(JsonNode node, String label) throws IOException {
        if (node == null || !node.isObject()) throw new IOException(label + " must be an object");
    }

    private static void requireFields(JsonNode node, List<String> expected, String label) throws IOException {
        List<String> actual = new ArrayList<>();
        for (Map.Entry<String, JsonNode> property : node.properties()) actual.add(property.getKey());
        if (actual.size() != expected.size() || !actual.containsAll(expected)) {
            throw new IOException(label + " has missing or unsupported fields");
        }
    }

    private static String requiredText(JsonNode node, String field) throws IOException {
        JsonNode value = node.path(field);
        if (!value.isString() || value.asString().isBlank() || !value.asString().equals(value.asString().trim())) {
            throw new IOException(field + " must be non-blank text without surrounding whitespace");
        }
        return value.asString();
    }

    private static int requiredInt(JsonNode node, String field) throws IOException {
        JsonNode value = node.path(field);
        if (!value.isIntegralNumber() || !value.canConvertToInt()) throw new IOException(field + " must be an integer");
        return value.intValue();
    }

    private static double requiredFiniteNumber(JsonNode node, String field) throws IOException {
        JsonNode value = node.path(field);
        if (!value.isNumber() || !Double.isFinite(value.doubleValue())) throw new IOException(field + " must be finite");
        return value.doubleValue();
    }

    private static Object finiteOrNull(double value) { return Double.isFinite(value) ? value : null; }

    private static Map<String, Object> truePeakMeasurement(PcmStemMixer.TruePeakMeasurement measurement) {
        Map<String, Object> serialized = new LinkedHashMap<>();
        serialized.put("linear", finiteOrNull(measurement.linear()));
        // Silence has a defined zero linear peak but an undefined (-infinite) dBTP value.
        serialized.put("dbTp", finiteOrNull(measurement.dbTp()));
        serialized.put("isSilence", !Double.isFinite(measurement.dbTp()));
        serialized.put("samplePeakLinear", finiteOrNull(measurement.samplePeakLinear()));
        serialized.put("oversampledFirPeakLinear", finiteOrNull(measurement.oversampledFirPeakLinear()));
        serialized.put("methodId", measurement.methodId());
        serialized.put("methodVersion", measurement.methodVersion());
        serialized.put("edgePolicy", measurement.edgePolicy());
        return serialized;
    }

    private static String sha256(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException("SHA-256 is unavailable", impossible); }
    }

    private record Request(int sampleRateHz, int frameCount, float truePeakCeiling, List<StemRequest> stems) { }
    private record StemRequest(Path path, String sourceVersionRef, float gain, float pan,
                               PcmStemMixer.RightsEvidence rightsEvidence) { }
    private record StemSource(Path path, String sourceVersionRef, float gain, float pan,
                              PcmStemMixer.RightsEvidence rightsEvidence, byte[] wav, byte[] pcm) {
        private StemSource {
            wav = wav.clone();
            pcm = pcm.clone();
        }
        @Override public byte[] wav() { return wav.clone(); }
        @Override public byte[] pcm() { return pcm.clone(); }
    }
    private record DecodedPcm(byte[] pcm, int sampleRate, int channels, int bitsPerSample, int frameCount) {
        private DecodedPcm { pcm = pcm.clone(); }
        @Override public byte[] pcm() { return pcm.clone(); }
    }

    /** Holds exclusive output handles and removes partial files if any step fails. */
    private static final class ExclusiveOutputs implements AutoCloseable {
        private final List<Path> paths;
        private final List<FileChannel> channels;
        private boolean committed;

        private ExclusiveOutputs(List<Path> paths, List<FileChannel> channels) {
            this.paths = paths;
            this.channels = channels;
        }

        static ExclusiveOutputs create(Path[] paths) throws IOException {
            List<Path> createdPaths = new ArrayList<>();
            List<FileChannel> channels = new ArrayList<>();
            try {
                for (Path path : paths) {
                    Set<OpenOption> options = Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.READ,
                            StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
                    try { channels.add(FileChannel.open(path, options)); }
                    catch (FileAlreadyExistsException exists) {
                        throw new IOException("output path already exists; choose an empty output directory", exists);
                    }
                    createdPaths.add(path);
                }
                return new ExclusiveOutputs(List.copyOf(createdPaths), channels);
            } catch (IOException failure) {
                for (FileChannel channel : channels) try { channel.close(); } catch (IOException close) { failure.addSuppressed(close); }
                for (Path path : createdPaths) try { Files.deleteIfExists(path); } catch (IOException cleanup) { failure.addSuppressed(cleanup); }
                throw failure;
            }
        }

        void write(int index, byte[] bytes) throws IOException {
            FileChannel channel = channels.get(index);
            channel.position(0);
            ByteBuffer buffer = ByteBuffer.wrap(bytes);
            while (buffer.hasRemaining()) channel.write(buffer);
            channel.truncate(bytes.length);
            channel.force(true);
        }

        byte[] read(int index) throws IOException {
            FileChannel channel = channels.get(index);
            long size = channel.size();
            if (size <= 0 || size > 48L * 1024 * 1024) throw new IOException("persisted output has an invalid size");
            byte[] bytes = new byte[(int) size];
            ByteBuffer buffer = ByteBuffer.wrap(bytes);
            channel.position(0);
            while (buffer.hasRemaining()) {
                if (channel.read(buffer) < 0) throw new IOException("persisted output was truncated during readback");
            }
            return bytes;
        }

        void commit() { committed = true; }

        @Override public void close() throws IOException {
            IOException failure = null;
            for (FileChannel channel : channels) {
                try { channel.close(); } catch (IOException close) { if (failure == null) failure = close; else failure.addSuppressed(close); }
            }
            if (!committed) {
                for (Path path : paths) {
                    try { Files.deleteIfExists(path); } catch (IOException cleanup) { if (failure == null) failure = cleanup; else failure.addSuppressed(cleanup); }
                }
            }
            if (failure != null) throw failure;
        }
    }
}
