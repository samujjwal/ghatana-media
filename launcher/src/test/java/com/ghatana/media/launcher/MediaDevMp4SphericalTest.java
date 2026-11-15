package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaDevMp4Spherical.Mp4SphericalException;
import com.ghatana.media.launcher.MediaDevMp4Spherical.Pose;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/** Box-level behaviour of the Spherical Video V2 writer on a hand-built MP4 and, when FFmpeg is present, a real one. */
class MediaDevMp4SphericalTest {
    private static byte[] box(String type, byte[]... children) {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        for (byte[] child : children) body.writeBytes(child);
        ByteBuffer out = ByteBuffer.allocate(8 + body.size());
        out.putInt(8 + body.size()).put(type.getBytes(StandardCharsets.US_ASCII)).put(body.toByteArray());
        return out.array();
    }

    private static byte[] full(String type, int version, byte[]... children) {
        byte[] head = new byte[] {(byte) version, 0, 0, 0};
        byte[][] all = new byte[children.length + 1][];
        all[0] = head;
        System.arraycopy(children, 0, all, 1, children.length);
        return box(type, all);
    }

    /** moov(trak(mdia(hdlr vide, minf(stbl(stsd(entry), stco))))) preceding or following mdat. */
    private static byte[] mp4(boolean moovFirst, int chunkOffsetPlaceholder) {
        byte[] entry = new byte[8 + 78];
        ByteBuffer.wrap(entry).putInt(entry.length).put("avc1".getBytes(StandardCharsets.US_ASCII));
        byte[] stsd = full("stsd", 0, new byte[] {0, 0, 0, 1}, entry);
        byte[] stco = full("stco", 0, ByteBuffer.allocate(8).putInt(1).putInt(chunkOffsetPlaceholder).array());
        byte[] hdlr = full("hdlr", 0, ByteBuffer.allocate(16).putInt(0).put("vide".getBytes(StandardCharsets.US_ASCII)).array());
        byte[] moov = box("moov", box("trak", box("mdia", hdlr, box("minf", box("stbl", stsd, stco)))));
        byte[] ftyp = box("ftyp", "isom\0\0\0\0isom".getBytes(StandardCharsets.US_ASCII));
        byte[] mdat = box("mdat", new byte[] {1, 2, 3, 4});
        ByteArrayOutputStream file = new ByteArrayOutputStream();
        file.writeBytes(ftyp);
        if (moovFirst) { file.writeBytes(moov); file.writeBytes(mdat); } else { file.writeBytes(mdat); file.writeBytes(moov); }
        return file.toByteArray();
    }

    private static int find(byte[] bytes, String type) {
        byte[] needle = type.getBytes(StandardCharsets.US_ASCII);
        outer:
        for (int i = 4; i + 4 <= bytes.length; i++) {
            for (int j = 0; j < 4; j++) if (bytes[i + j] != needle[j]) continue outer;
            return i - 4;
        }
        return -1;
    }

    @Test
    void theBoxesHaveTheSpecifiedLayoutAndTheDeclaredPose() {
        ByteBuffer st3d = ByteBuffer.wrap(MediaDevMp4Spherical.st3d());
        assertThat(st3d.getInt()).isEqualTo(13);
        assertThat(st3d.get(12)).isZero(); // stereo_mode mono
        byte[] sv3d = MediaDevMp4Spherical.sv3d(new Pose(30, -15, 0));
        assertThat(ByteBuffer.wrap(sv3d).getInt()).isEqualTo(sv3d.length);
        int prhd = find(sv3d, "prhd");
        ByteBuffer pose = ByteBuffer.wrap(sv3d, prhd + 12, 12);
        assertThat(pose.getInt()).isEqualTo(30 * 65536);
        assertThat(pose.getInt()).isEqualTo(-15 * 65536);
        assertThat(pose.getInt()).isZero();
        int equi = find(sv3d, "equi");
        for (int i = 0; i < 16; i++) assertThat(sv3d[equi + 12 + i]).as("full-sphere bounds").isZero();
    }

    @Test
    void aMoovAfterMdatKeepsEveryOffsetAndGrowsTheAncestors() {
        byte[] file = mp4(false, 40);
        byte[] out = MediaDevMp4Spherical.insert(file, Pose.identity());
        int added = out.length - file.length;
        assertThat(added).isEqualTo(MediaDevMp4Spherical.spatialBoxes(Pose.identity()).length);
        assertThat(ByteBuffer.wrap(out, find(out, "moov"), 4).getInt()).isEqualTo(ByteBuffer.wrap(file, find(file, "moov"), 4).getInt() + added);
        int stco = find(out, "stco");
        assertThat(ByteBuffer.wrap(out, stco + 16, 4).getInt()).as("chunk offset before the insertion point").isEqualTo(40);
        assertThat(find(out, "st3d")).isPositive();
        assertThat(find(out, "sv3d")).isPositive();
    }

    @Test
    void aMoovBeforeMdatShiftsTheChunkOffsets() {
        byte[] file = mp4(true, 100_000);
        // point the offset at the real mdat payload, which follows moov
        int mdat = find(file, "mdat");
        ByteBuffer.wrap(file).putInt(find(file, "stco") + 16, mdat + 8);
        byte[] out = MediaDevMp4Spherical.insert(file, Pose.identity());
        int added = out.length - file.length;
        int newMdat = find(out, "mdat");
        assertThat(newMdat).isEqualTo(mdat + added);
        assertThat(ByteBuffer.wrap(out, find(out, "stco") + 16, 4).getInt()).isEqualTo(newMdat + 8);
        assertThat(out[newMdat + 8]).isEqualTo((byte) 1);
    }

    @Test
    void theBoxesAreReadBackExactlyIncludingAFractionalPose() {
        var read = MediaDevMp4Spherical.readBack(MediaDevMp4Spherical.insert(mp4(false, 40), new Pose(30.5, -15.25, 7.125)));
        assertThat(read.hasSt3d()).isTrue();
        assertThat(read.stereoMode()).isZero();
        assertThat(read.hasSv3d()).isTrue();
        assertThat(read.equirectangular()).isTrue();
        assertThat(read.boundsSum()).isZero();
        assertThat(read.yawDegrees()).isEqualTo(30.5);
        assertThat(read.pitchDegrees()).isEqualTo(-15.25);
        assertThat(read.rollDegrees()).isEqualTo(7.125);
        var none = MediaDevMp4Spherical.readBack(mp4(false, 40));
        assertThat(none.hasSt3d()).isFalse();
        assertThat(none.hasSv3d()).isFalse();
    }

    @Test
    void existingSpatialBoxesAndNonMp4InputAreRefused() {
        byte[] once = MediaDevMp4Spherical.insert(mp4(false, 40), Pose.identity());
        assertThatThrownBy(() -> MediaDevMp4Spherical.insert(once, Pose.identity())).isInstanceOf(Mp4SphericalException.class)
                .hasMessageContaining("already");
        assertThatThrownBy(() -> MediaDevMp4Spherical.insert("not an mp4 file at all".getBytes(StandardCharsets.US_ASCII), Pose.identity()))
                .isInstanceOf(Mp4SphericalException.class);
    }

    @Test
    void anOutOfRangePoseIsRefused() {
        assertThatThrownBy(() -> new Pose(180, 0, 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Pose(0, 91, 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Pose(Double.NaN, 0, 0)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void ffprobeReadsBackExactlyWhatWasWrittenIntoARealFaststartAndAFlatMp4() throws Exception {
        String ffmpeg = System.getenv("MEDIA_DEV_RENDER_FFMPEG");
        String ffprobe = System.getenv("MEDIA_DEV_RENDER_FFPROBE");
        assumeTrue(ffmpeg != null && ffprobe != null && Files.isExecutable(Path.of(ffmpeg)), "FFmpeg is not configured");
        Path dir = Files.createTempDirectory("media-spherical-test-");
        try {
            for (boolean faststart : new boolean[] {true, false}) {
                Path plain = dir.resolve("plain-" + faststart + ".mp4");
                List<String> command = new java.util.ArrayList<>(List.of(ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i",
                        "testsrc2=s=256x128:r=10:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p"));
                if (faststart) command.addAll(List.of("-movflags", "+faststart"));
                command.add(plain.toString());
                run(command.toArray(String[]::new));
                byte[] out = MediaDevMp4Spherical.insert(Files.readAllBytes(plain), new Pose(30, -15, 0));
                Path spherical = dir.resolve("sph-" + faststart + ".mp4");
                Files.write(spherical, out);
                String probe = run(ffprobe, "-v", "error", "-select_streams", "v:0", "-show_streams", "-of", "json", spherical.toString());
                assertThat(probe).contains("\"projection\": \"equirectangular\"").contains("Stereo 3D").contains("\"type\": \"2D\"");
                // still decodes, same frame count, same packets
                assertThat(run(ffmpeg, "-v", "error", "-i", spherical.toString(), "-map", "0:v:0", "-c", "copy", "-f", "md5", "-"))
                        .isEqualTo(run(ffmpeg, "-v", "error", "-i", plain.toString(), "-map", "0:v:0", "-c", "copy", "-f", "md5", "-"));
                run(ffmpeg, "-v", "error", "-xerror", "-i", spherical.toString(), "-f", "null", "-");
            }
        } finally {
            try (var walk = Files.walk(dir)) { walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete()); }
        }
    }

    private static String run(String... command) throws Exception {
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(process.waitFor(60, TimeUnit.SECONDS)).isTrue();
        assertThat(process.exitValue()).as(output).isZero();
        return output.trim();
    }
}
