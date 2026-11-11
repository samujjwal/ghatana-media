package com.ghatana.media.examples.creativepreview;

import com.ghatana.media.production.AnimationSpecCompiler;
import com.ghatana.media.production.animation.AnimationRenderer;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.production.audio.AudioRepairComparison;
import com.ghatana.media.production.audio.BoundedPcmDeclipper;
import com.ghatana.media.production.audio.PcmStemMixer;
import com.ghatana.media.production.simulation.PhysicalSimulation;
import com.ghatana.media.production.spatial.SpatialRigEngine;
import com.ghatana.media.runtime.MediaSimulationContracts;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import javax.imageio.ImageIO;
import javax.sound.sampled.AudioFileFormat;
import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CompletableFuture;

/** Thin local consumer for existing Media creative engines. */
public final class MediaCreativePreview {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SOURCE_VERSION = "local-fixture:creative-preview:v1";
    private static final Instant FIXTURE_INSTANT = Instant.parse("2026-01-01T00:00:00Z");

    private MediaCreativePreview() { }

    public static void main(String[] args) throws Exception {
        Path output = args.length == 0 ? Path.of("build/media-creative-preview") : Path.of(args[0]);
        Files.createDirectories(output);
        var animation = renderAnimation(output);
        var audio = renderAudio(output);
        var glb = renderSpatial(output);
        var simulation = renderSimulation(output);
        String manifest = """
                {
                  "kind": "LOCAL_PREVIEW_ONLY",
                  "sourceVersion": "%s",
                  "clocks": {
                    "animation": {"clockId": "preview-clock", "streamId": "preview-stream", "originRef": "%s", "startTicks": "0", "timeBase": "1/24", "framesPerSecond": "10/1", "frameCount": 6},
                    "audio": {"sampleRateHz": 48000, "channels": 2, "sampleFormat": "PCM_S16LE", "frameCount": 480},
                    "interactiveDemoAudio": {"fixtureVersionRef": "local-interactive-demo-tone-v1", "sampleRateHz": 48000, "channels": 2, "sampleFormat": "PCM_S16LE", "frameCount": 96000, "durationMs": 2000},
                    "spatial": {"clockId": "local-rig-clock", "timeUnit": "SECOND", "timeEncoding": "FLOAT32_SECONDS", "startTimeSeconds": 0.0, "endTimeSeconds": 1.0},
                    "simulation": {"clockId": "local-simulation-clock", "timeUnit": "SECOND", "startTimeSeconds": %s, "endTimeSeconds": %s, "observationCount": %s}
                  },
                  "audioInput": {"stemVersionRef": "local-tone-v1", "pcmSha256": "%s", "sampleRateHz": 48000, "channels": 2, "sampleFormat": "PCM_S16LE", "frameCount": 480},
                  "audioMix": %s,
                  "audioRepair": {"fixtureVersionRef": "local-clipped-tone-v1", "fixture": {"generator": "sine-hard-clip", "frequencyHz": 440, "preClipPeak": 40000, "clipLevelPositive": 32767, "clipLevelNegative": -32768}, "sampleRateHz": 48000, "channels": 2, "sampleFormat": "PCM_S16LE", "frameCount": 480, "sourcePcmSha256": "%s", "repairedPcmSha256": "%s", "sourceWav": %s, "repairedWav": %s, "repairAlgorithm": "BoundedPcmDeclipper.linear-interpolation", "repairThreshold": 0.94, "maxRunFrames": 64, "hasIndependentReference": false, "snrDbVsReference": null, "qualityClaim": false, "comparisonMetrics": %s},
                  "outputs": {"png": %s, "gif": %s, "wav": %s, "wavClipped": %s, "wavRepaired": %s, "interactiveDemoAudio": %s, "glb": %s, "simulation": %s},
                  "animation": %s,
                  "glbValidation": %s,
                  "limitations": ["fixture output is not lawful model quality", "clipped audio is synthetic and the repaired candidate is an estimate, not recovered source truth", "no independent audio reference was supplied; no SNR or quality claim is made", "simulation is not measurement evidence", "GLB uses FLOAT32_APPROXIMATION", "no hosted product, delivery receipt, or job finality is implied"]
                }
                """.formatted(SOURCE_VERSION, SOURCE_VERSION,
                simulation.startTimeSeconds, simulation.endTimeSeconds, simulation.observationCount,
                audio.inputPcmSha256, audio.mixMetricsJson, audio.clippedPcmSha256, audio.repairedPcmSha256,
                artifactJson(audio.clipped), artifactJson(audio.repaired),
                audioRepairMetricsJson(audio.comparisonMetrics),
                artifactJson(animation.png), artifactJson(animation.gif), artifactJson(audio.wav),
                artifactJson(audio.clipped), artifactJson(audio.repaired),
                artifactJson(audio.interactiveDemoAudio),
                artifactJson(glb.artifact), artifactJson(simulation.artifact),
                animation.manifestJson, glb.validation.toJson());
        Files.writeString(output.resolve("preview-manifest.json"), manifest, StandardCharsets.UTF_8);
        System.out.println("Local creative preview written to " + output.toAbsolutePath());
    }

    private record Artifact(String fileName, String sha256, String sourceVersion) { }
    private record AnimationFiles(Artifact png, Artifact gif, String manifestJson) { }
    private record AudioFiles(Artifact wav, Artifact clipped, Artifact repaired, Artifact interactiveDemoAudio,
                             String inputPcmSha256, String clippedPcmSha256,
                             String repairedPcmSha256, AudioRepairComparison.Metrics comparisonMetrics,
                             String mixMetricsJson) { }
    private record SimulationFiles(Artifact artifact, double startTimeSeconds,
                                   double endTimeSeconds, int observationCount) { }
    private record GlbValidationSummary(String validator, String version, String assetSha256,
                                        int errors, int warnings,
                                        int infos, int hints) {
        private String toJson() {
            return "{\"validator\":\"" + validator + "\",\"version\":\"" + version
                    + "\",\"assetSha256\":\"" + assetSha256
                    + "\",\"issueCounts\":{\"errors\":" + errors + ",\"warnings\":" + warnings
                    + ",\"infos\":" + infos + ",\"hints\":" + hints + "}}";
        }
    }
    private record SpatialFiles(Artifact artifact, GlbValidationSummary validation) { }

    private static Artifact persistedArtifact(Path path) throws IOException {
        byte[] persistedBytes = Files.readAllBytes(path);
        return new Artifact(path.getFileName().toString(), sha256(persistedBytes), SOURCE_VERSION);
    }

    private static String sha256(byte[] bytes) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            var hex = new StringBuilder(digest.length * 2);
            for (byte value : digest) hex.append(String.format("%02x", value & 0xff));
            return hex.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is required by the Java runtime", impossible);
        }
    }

    private static String artifactJson(Artifact artifact) {
        return "{\"filename\":\"" + artifact.fileName + "\",\"sha256\":\"" + artifact.sha256
                + "\",\"sourceVersion\":\"" + artifact.sourceVersion + "\"}";
    }

    private static String audioRepairMetricsJson(AudioRepairComparison.Metrics metrics) {
        return "{\"kind\":\"DESCRIPTIVE_PCM_ONLY\",\"sourceRms\":" + jsonNumber(metrics.sourceRms())
                + ",\"repairedRms\":" + jsonNumber(metrics.repairedRms())
                + ",\"sourcePeak\":" + metrics.sourcePeak()
                + ",\"repairedPeak\":" + metrics.repairedPeak()
                + ",\"sourceNearClipSampleCount\":" + metrics.sourceNearClipSampleCount()
                + ",\"repairedNearClipSampleCount\":" + metrics.repairedNearClipSampleCount()
                + ",\"changedSampleCount\":" + metrics.changedSampleCount()
                + ",\"rmsChangeDb\":" + jsonNumber(metrics.rmsChangeDb()) + "}";
    }

    private static String audioMixMetricsJson(PcmStemMixer.MixResult mix, String outputPcmSha256) {
        return "{\"kind\":\"LOCAL_MIX_ESTIMATES\",\"samplePeakAfterCeiling\":"
                + jsonNumber(mix.samplePeakAfterCeiling())
                + ",\"estimatedTruePeakBeforeCeiling\":" + jsonNumber(mix.estimatedTruePeakBeforeCeiling())
                + ",\"estimatedTruePeakAfterCeiling\":" + jsonNumber(mix.estimatedTruePeakAfterCeiling())
                + ",\"rmsDbfsAfterCeiling\":" + jsonNumber(mix.rmsDbfsAfterCeiling())
                + ",\"outputPcmSha256\":\"" + outputPcmSha256 + "\""
                + ",\"truePeakEvidence\":\"LOCAL_ESTIMATE_NOT_CERTIFIED\"}";
    }

    private static String jsonNumber(double value) {
        if (!Double.isFinite(value)) throw new IllegalArgumentException("manifest numeric metrics must be finite");
        return Double.toString(value);
    }

    static void verifyPngFrame(Path path, int expectedWidth, int expectedHeight) throws IOException {
        var decoded = ImageIO.read(path.toFile());
        if (decoded == null || decoded.getWidth() != expectedWidth || decoded.getHeight() != expectedHeight) {
            if (decoded != null) decoded.flush();
            throw new IOException("PNG frame could not be independently decoded with expected dimensions");
        }
        decoded.flush();
    }

    private static AnimationFiles renderAnimation(Path output) throws IOException {
        var story = new AnimationSpecCompiler.StoryTime("story", "preview-clock", "preview-stream",
                "local-fixture:creative-preview:v1", "0",
                new AnimationSpecCompiler.PositiveRational("1", "24"));
        var spec = new AnimationSpecCompiler.AnimationSpec("media.declarative.value.animation-spec.v1",
                "local:scene:v1", "local:animation:v1", "local:operator:v1", "local:assets:v1",
                List.of(), story, "local:render:v1");
        var scene = new AnimationRenderer.Scene(96, 64, 0xff101820, List.of(
                new AnimationRenderer.Shape("moving-card", AnimationRenderer.Primitive.RECTANGLE,
                        12, 20, 24, 18, 0, 0xff55c2a3,
                        List.of(new AnimationRenderer.Keyframe(0, 12, 20, 1, 1, 0, 1,
                                        AnimationRenderer.Easing.LINEAR),
                                new AnimationRenderer.Keyframe(5, 54, 20, 1, 1, 0, 1,
                                        AnimationRenderer.Easing.LINEAR)))));
        var renderer = new AnimationRenderer();
        var profile = new AnimationRenderer.Profile(10, 1, 6);
        var rendered = renderer.render(spec, scene, profile);
        var frameArtifacts = new java.util.ArrayList<Artifact>();
        var frameJson = new StringBuilder("[");
        for (int index = 0; index < rendered.frames().size(); index++) {
            var frame = rendered.frames().get(index);
            Path framePath = output.resolve("animation-frame-%03d.png".formatted(index));
            Files.write(framePath, frame.png());
            byte[] persistedPng = Files.readAllBytes(framePath);
            verifyPngFrame(framePath, scene.width(), scene.height());
            Artifact artifact = persistedArtifact(framePath);
            if (!java.util.Arrays.equals(persistedPng, frame.png())) {
                throw new IOException("persisted PNG frame differs from the renderer output");
            }
            frameArtifacts.add(artifact);
            if (index > 0) frameJson.append(',');
            frameJson.append("{\"index\":").append(frame.index())
                    .append(",\"filename\":\"").append(artifact.fileName)
                    .append("\",\"sha256\":\"").append(artifact.sha256)
                    .append("\",\"sourceVersion\":\"").append(artifact.sourceVersion)
                    .append("\",\"pts\":\"").append(frame.ptsNumerator()).append('/')
                    .append(frame.ptsDenominator()).append("\",\"storyTicks\":\"")
                    .append(frame.storyTicksNumerator()).append('/')
                    .append(frame.storyTicksDenominator()).append("\"}");
        }
        frameJson.append(']');

        var encoded = renderer.renderAnimated(spec, scene, profile, AnimationRenderer.AnimatedFormat.GIF);
        if (encoded.status() != AnimationRenderer.ExportStatus.ENCODED) {
            throw new IOException("GIF preview unavailable: " + encoded.failure());
        }
        var encodedFrames = encoded.encoded().orElseThrow().frameTimes();
        if (encodedFrames.size() != rendered.frames().size()) {
            throw new IOException("GIF timing metadata count differs from rendered PNG frames");
        }
        for (int index = 0; index < encodedFrames.size(); index++) {
            var encodedTime = encodedFrames.get(index);
            var pngFrame = rendered.frames().get(index);
            if (encodedTime.index() != pngFrame.index()
                    || !encodedTime.ptsNumerator().equals(pngFrame.ptsNumerator())
                    || !encodedTime.ptsDenominator().equals(pngFrame.ptsDenominator())
                    || !encodedTime.storyTicksNumerator().equals(pngFrame.storyTicksNumerator())
                    || !encodedTime.storyTicksDenominator().equals(pngFrame.storyTicksDenominator())) {
                throw new IOException("GIF exact timing metadata differs from the rendered PNG frame clock");
            }
        }
        Path gif = output.resolve("animation.gif");
        Files.write(gif, encoded.encoded().orElseThrow().bytes());
        try (var imageInput = ImageIO.createImageInputStream(gif.toFile())) {
            var readers = ImageIO.getImageReaders(imageInput);
            if (!readers.hasNext()) throw new IOException("GIF decoder unavailable for independent readback");
            var reader = readers.next();
            try {
                reader.setInput(imageInput);
                if (reader.getNumImages(true) != profile.frameCount()) throw new IOException("GIF frame count mismatch");
                for (int i = 0; i < profile.frameCount(); i++) {
                    var frame = reader.read(i);
                    if (frame == null || frame.getWidth() != scene.width() || frame.getHeight() != scene.height()) {
                        throw new IOException("GIF frame failed independent decode");
                    }
                    frame.flush();
                }
            } finally {
                reader.dispose();
            }
        }
        var firstFrame = rendered.frames().getFirst();
        String animationManifest = "{\"clockId\":\"preview-clock\",\"streamId\":\"preview-stream\","
                + "\"originRef\":\"" + SOURCE_VERSION + "\",\"timeBase\":\"1/24\","
                + "\"framesPerSecond\":\"10/1\",\"gifDelayCentiseconds\":"
                + encoded.encoded().orElseThrow().frameDelayCentiseconds()
                + ",\"frameCount\":" + rendered.frames().size() + ",\"frames\":" + frameJson + "}";
        return new AnimationFiles(frameArtifacts.getFirst(), persistedArtifact(gif), animationManifest);
    }

    private static AudioFiles renderAudio(Path output) throws Exception {
        short[] samples = new short[480 * 2];
        for (int frame = 0; frame < 480; frame++) {
            short value = (short) Math.round(Math.sin(2 * Math.PI * 440 * frame / 48_000.0) * 8_000);
            samples[frame * 2] = value;
            samples[frame * 2 + 1] = value;
        }
        ByteBuffer pcm = ByteBuffer.allocate(samples.length * 2).order(ByteOrder.LITTLE_ENDIAN);
        for (short sample : samples) pcm.putShort(sample);
        String inputPcmSha256 = sha256(pcm.array());
        var stem = new PcmStemMixer.Stem("local-tone-v1", 48_000, 2, 16, pcm.array(), 1f, 0f,
                new PcmStemMixer.SyntheticProvenance("sine-fixture", "1", "440Hz/10ms"));
        var mix = new PcmStemMixer().mix(List.of(stem), new PcmStemMixer.MixSpec(48_000, 480, 0.95f),
                Clock.fixed(FIXTURE_INSTANT, java.time.ZoneOffset.UTC));
        Path wav = output.resolve("preview.wav");
        Files.write(wav, mix.wav());
        byte[] expectedMixPcm = mix.pcmS16Le();
        String expectedMixPcmSha256 = mix.pcmSha256();
        byte[] reopenedMixPcm;
        try (var decoded = AudioSystem.getAudioInputStream(wav.toFile())) {
            var format = decoded.getFormat();
            reopenedMixPcm = decoded.readAllBytes();
            if (!AudioSystem.getAudioFileFormat(wav.toFile()).getType()
                    .equals(javax.sound.sampled.AudioFileFormat.Type.WAVE)
                    || !javax.sound.sampled.AudioFormat.Encoding.PCM_SIGNED.equals(format.getEncoding())
                    || format.getSampleRate() != 48_000 || format.getSampleSizeInBits() != 16
                    || format.getChannels() != 2 || format.getFrameSize() != 4
                    || format.isBigEndian() || decoded.getFrameLength() != 480
                    || reopenedMixPcm.length != 1_920) {
                throw new IOException("WAV failed independent format/frame readback");
            }
        }
        String reopenedMixPcmSha256 = sha256(reopenedMixPcm);
        if (!java.util.Arrays.equals(reopenedMixPcm, expectedMixPcm)
                || !sha256(expectedMixPcm).equals(expectedMixPcmSha256)
                || !reopenedMixPcmSha256.equals(expectedMixPcmSha256)) {
            throw new IOException("preview WAV PCM differs from the PcmStemMixer result");
        }

        // A separate, longer deterministic fixture for native browser media consumers.
        // Keep the original 480-frame preview.wav contract unchanged.
        Path interactiveDemoWav = output.resolve("interactive-demo-preview.wav");
        byte[] interactiveDemoPcm = new byte[96_000 * 4];
        ByteBuffer interactiveDemoSamples = ByteBuffer.wrap(interactiveDemoPcm).order(ByteOrder.LITTLE_ENDIAN);
        for (int frame = 0; frame < 96_000; frame++) {
            short value = (short) Math.round(Math.sin(2 * Math.PI * 440 * frame / 48_000.0) * 8_000);
            interactiveDemoSamples.putShort(value).putShort(value);
        }
        writePcmWav(interactiveDemoWav, new AudioData(interactiveDemoPcm, 48_000, 2, 16,
                Duration.ofSeconds(2), com.ghatana.media.common.AudioFormat.PCM));
        byte[] interactiveDemoReadback = readPcmWav(interactiveDemoWav, 96_000);
        if (!java.util.Arrays.equals(interactiveDemoReadback, interactiveDemoPcm)) {
            throw new IOException("interactive demo WAV PCM differs from its deterministic fixture");
        }

        ByteBuffer clippedPcm = ByteBuffer.allocate(480 * 2 * 2).order(ByteOrder.LITTLE_ENDIAN);
        for (int frame = 0; frame < 480; frame++) {
            int generated = (int) Math.round(Math.sin(2 * Math.PI * 440 * frame / 48_000.0) * 40_000);
            short clipped = (short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, generated));
            clippedPcm.putShort(clipped).putShort(clipped);
        }
        AudioData clippedSource = new AudioData(clippedPcm.array(), 48_000, 2, 16,
                Duration.ofMillis(10), com.ghatana.media.common.AudioFormat.PCM);
        AudioData repaired = BoundedPcmDeclipper.repair(clippedSource, 0.94, 64);
        AudioRepairComparison comparison = AudioRepairComparison.compare(clippedSource, repaired);
        if (comparison.metrics().hasIndependentReference()
                || !Double.isNaN(comparison.metrics().snrDbVsReference())) {
            throw new IOException("repair comparison must not claim reference SNR without an independent reference");
        }

        Path clippedWav = output.resolve("original-clipped.wav");
        Path repairedWav = output.resolve("repaired-candidate.wav");
        writePcmWav(clippedWav, comparison.source());
        writePcmWav(repairedWav, comparison.repaired());
        byte[] reopenedClipped = readPcmWav(clippedWav, 480);
        byte[] reopenedRepaired = readPcmWav(repairedWav, 480);
        if (!java.util.Arrays.equals(reopenedClipped, comparison.source().data())
                || !java.util.Arrays.equals(reopenedRepaired, comparison.repaired().data())) {
            throw new IOException("audio repair WAV bytes differ from the immutable comparison branches");
        }
        String clippedDigest = sha256(reopenedClipped);
        String repairedDigest = sha256(reopenedRepaired);
        if (!clippedDigest.equals(comparison.sourceSha256())
                || !repairedDigest.equals(comparison.repairedSha256())) {
            throw new IOException("audio repair PCM digests differ from comparison lineage");
        }
        return new AudioFiles(persistedArtifact(wav), persistedArtifact(clippedWav),
                persistedArtifact(repairedWav), persistedArtifact(interactiveDemoWav), inputPcmSha256,
                clippedDigest, repairedDigest, comparison.metrics(),
                audioMixMetricsJson(mix, reopenedMixPcmSha256));
    }

    private static void writePcmWav(Path path, AudioData audio) throws IOException {
        AudioFormat format = new AudioFormat(AudioFormat.Encoding.PCM_SIGNED, audio.sampleRate(),
                audio.bitsPerSample(), audio.channels(), audio.channels() * (audio.bitsPerSample() / 8),
                audio.sampleRate(), false);
        byte[] pcm = audio.data();
        try (AudioInputStream input = new AudioInputStream(new java.io.ByteArrayInputStream(pcm),
                format, pcm.length / format.getFrameSize())) {
            if (AudioSystem.write(input, AudioFileFormat.Type.WAVE, path.toFile()) <= 0) {
                throw new IOException("WAV writer produced no bytes for " + path.getFileName());
            }
        }
    }

    private static byte[] readPcmWav(Path path, int expectedFrames) throws IOException {
        try (var decoded = AudioSystem.getAudioInputStream(path.toFile())) {
            var format = decoded.getFormat();
            byte[] pcm = decoded.readAllBytes();
            if (!AudioFileFormat.Type.WAVE.equals(AudioSystem.getAudioFileFormat(path.toFile()).getType())
                    || !AudioFormat.Encoding.PCM_SIGNED.equals(format.getEncoding())
                    || format.getSampleRate() != 48_000 || format.getSampleSizeInBits() != 16
                    || format.getChannels() != 2 || format.getFrameSize() != 4 || format.isBigEndian()
                    || decoded.getFrameLength() != expectedFrames || pcm.length != expectedFrames * 4) {
                throw new IOException("WAV failed independent PCM format/frame readback: " + path.getFileName());
            }
            return pcm;
        } catch (javax.sound.sampled.UnsupportedAudioFileException unsupported) {
            throw new IOException("WAV could not be independently decoded: " + path.getFileName(), unsupported);
        }
    }

    private static SpatialFiles renderSpatial(Path output) throws Exception {
        var frame = new SpatialRigEngine.CoordinateFrame("local-frame", "v1",
                SpatialRigEngine.Handedness.RIGHT_HANDED, SpatialRigEngine.AxisDirection.POS_X,
                SpatialRigEngine.AxisDirection.POS_Y, SpatialRigEngine.AxisDirection.POS_Z,
                SpatialRigEngine.GLB_METRE_UNIT_REF, SpatialRigEngine.GLB_QUATERNION_UNIT_REF);
        var source = new SpatialRigEngine.SourceVersionRef("local-tenant", "fixture-artifact", "v1");
        var bone = new SpatialRigEngine.Bone("root", null, SpatialRigEngine.LocalTransform.identity(),
                new SpatialRigEngine.JointConstraint(SpatialRigEngine.JointKind.BALL, Math.PI));
        var rig = new SpatialRigEngine.Rig("local-rig-v1", frame, "UNIT_QUATERNION_XYZW", List.of(source),
                List.of(bone), Map.of("root", List.of(
                        new SpatialRigEngine.PoseKeyframe(SpatialRigEngine.RationalTime.of(0, 1),
                                SpatialRigEngine.LocalTransform.identity()),
                        new SpatialRigEngine.PoseKeyframe(SpatialRigEngine.RationalTime.of(1, 1),
                                new SpatialRigEngine.LocalTransform(new SpatialRigEngine.Vec3(0.1, 0, 0),
                                        SpatialRigEngine.Quaternion.IDENTITY)))), "local-project:revision-v1");
        var artifact = new SpatialRigEngine().exportGlb(rig, ignored -> SpatialRigEngine.RightsOutcome.ELIGIBLE);
        Path glb = output.resolve("preview.glb");
        Files.write(glb, artifact.bytes());
        byte[] reopened = Files.readAllBytes(glb);
        Artifact persisted = persistedArtifact(glb);
        GlbValidationSummary validation = runKhronosGlbValidator(glb);
        if (!validation.assetSha256.equals(persisted.sha256)) {
            throw new IOException("Khronos validator input digest differs from persisted GLB digest");
        }
        CreativePreviewReadback.parseSupportedGlbJson(reopened);
        return new SpatialFiles(persisted, validation);
    }

    static GlbValidationSummary runKhronosGlbValidator(Path glb) throws Exception {
        Path script = findGlbValidatorScript();
        Process process = new ProcessBuilder("node", script.toString(), glb.toAbsolutePath().toString())
                .redirectErrorStream(true).start();
        CompletableFuture<byte[]> output = CompletableFuture.supplyAsync(() -> {
            try {
                return process.getInputStream().readAllBytes();
            } catch (IOException failure) {
                throw new java.util.concurrent.CompletionException(failure);
            }
        });
        if (!process.waitFor(60, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            throw new IOException("Khronos glTF Validator exceeded the 60-second local preview limit");
        }
        String result = new String(output.join(), StandardCharsets.UTF_8).trim();
        if (process.exitValue() != 0) {
            throw new IOException("Khronos glTF Validator rejected preview.glb: " + result);
        }
        JsonNode report;
        try {
            report = JSON.readTree(result);
        } catch (tools.jackson.core.JacksonException malformed) {
            throw new IOException("Khronos glTF Validator returned invalid JSON: " + result, malformed);
        }
        JsonNode counts = report.path("issueCounts");
        if (!report.path("validator").asString().equals("KhronosGroup/glTF-Validator")
                || !report.path("version").asString().equals("2.0.0-dev.3.10")
                || !report.path("assetSha256").asString().matches("[0-9a-f]{64}")
                || !counts.path("errors").isIntegralNumber() || !counts.path("warnings").isIntegralNumber()
                || !counts.path("infos").isIntegralNumber() || !counts.path("hints").isIntegralNumber()) {
            throw new IOException("Khronos glTF Validator result lacks the pinned identity or issue counts: " + result);
        }
        int errors = counts.path("errors").intValue();
        if (errors != 0) throw new IOException("Khronos glTF Validator reported " + errors + " errors: " + result);
        return new GlbValidationSummary(report.path("validator").asString(), report.path("version").asString(),
                report.path("assetSha256").asString(), errors, counts.path("warnings").intValue(),
                counts.path("infos").intValue(),
                counts.path("hints").intValue());
    }

    private static Path findGlbValidatorScript() throws IOException {
        Path current = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        for (Path candidate = current; candidate != null; candidate = candidate.getParent()) {
            Path direct = candidate.resolve("scripts/validate-preview-glb.mjs");
            if (Files.isRegularFile(direct)) return direct;
            Path nested = candidate.resolve("examples/media-creative-preview/scripts/validate-preview-glb.mjs");
            if (Files.isRegularFile(nested)) return nested;
        }
        throw new IOException("Cannot locate examples/media-creative-preview/scripts/validate-preview-glb.mjs from "
                + current);
    }

    private static SimulationFiles renderSimulation(Path output) throws IOException {
        var zero = new MediaSimulationContracts.Quantity(0, MediaSimulationContracts.Unit.METER);
        var zeroVelocity = new MediaSimulationContracts.Quantity(0, MediaSimulationContracts.Unit.METER_PER_SECOND);
        var mass = new MediaSimulationContracts.Measurement(
                new MediaSimulationContracts.Quantity(1, MediaSimulationContracts.Unit.KILOGRAM),
                new MediaSimulationContracts.Quantity(0, MediaSimulationContracts.Unit.KILOGRAM));
        var force = new MediaSimulationContracts.Measurement(
                new MediaSimulationContracts.Quantity(1, MediaSimulationContracts.Unit.NEWTON),
                new MediaSimulationContracts.Quantity(0, MediaSimulationContracts.Unit.NEWTON));
        var request = new MediaSimulationContracts.RunRequest(
                new MediaSimulationContracts.ConstantForce(mass, force),
                new MediaSimulationContracts.InitialState(
                        new MediaSimulationContracts.Measurement(zero, zero),
                        new MediaSimulationContracts.Measurement(zeroVelocity, zeroVelocity)),
                new MediaSimulationContracts.SolverPolicy(
                        new MediaSimulationContracts.Quantity(1, MediaSimulationContracts.Unit.SECOND),
                        new MediaSimulationContracts.Quantity(0.1, MediaSimulationContracts.Unit.SECOND),
                        new MediaSimulationContracts.Quantity(0.001, MediaSimulationContracts.Unit.SECOND),
                        new MediaSimulationContracts.Quantity(1e-6, MediaSimulationContracts.Unit.METER),
                        new MediaSimulationContracts.Quantity(1e-6, MediaSimulationContracts.Unit.METER_PER_SECOND),
                        100, 1000));
        var outcome = PhysicalSimulation.run(request);
        if (outcome.status() != MediaSimulationContracts.OutcomeStatus.COMPLETED) {
            throw new IOException("simulation preview did not complete: " + outcome.failureCode());
        }
        var trace = outcome.trace();
        if (trace.observations().isEmpty()) throw new IOException("simulation returned no observations");
        var json = new StringBuilder("{\"kind\":\"DETERMINISTIC_SIMULATION_ONLY\",\"sourceVersion\":\"")
                .append(SOURCE_VERSION).append("\",\"solver\":\"").append(trace.solverId())
                .append("\",\"evidenceClass\":\"").append(trace.evidenceClass())
                .append("\",\"clock\":{\"clockId\":\"local-simulation-clock\",\"timeUnit\":\"SECOND\"},\"observations\":[");
        for (int i = 0; i < trace.observations().size(); i++) {
            var observation = trace.observations().get(i);
            if (i > 0) json.append(',');
            json.append("{\"timeSeconds\":").append(observation.time().value())
                    .append(",\"positionMeters\":").append(observation.position().value())
                    .append(",\"velocityMetersPerSecond\":").append(observation.velocity().value())
                    .append('}');
        }
        json.append("]}");
        Path path = output.resolve("simulation.json");
        Files.writeString(path, json, StandardCharsets.UTF_8);
        String reopened = Files.readString(path, StandardCharsets.UTF_8);
        var summary = CreativePreviewReadback.parseSimulation(reopened, SOURCE_VERSION);
        return new SimulationFiles(persistedArtifact(path), summary.startTimeSeconds(), summary.endTimeSeconds(),
                summary.observationCount());
    }
}
