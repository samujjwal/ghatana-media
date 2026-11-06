package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class BoundedDockerOutputTransferTest {
    @TempDir Path temp;

    @Test
    void extractsValidFlatRegularFileWithoutBufferingOrChangingItsBytes() throws Exception {
        Path output = Files.createDirectory(temp.resolve("output"));
        byte[] frame = "bounded-frame".getBytes(StandardCharsets.UTF_8);

        BoundedDockerOutputTransfer.extractTar(new ByteArrayInputStream(tar("./frame_0001.png", '0', frame)),
                output, frame.length, 4_096);

        assertThat(Files.readAllBytes(output.resolve("frame_0001.png"))).isEqualTo(frame);
        assertThat(Files.getPosixFilePermissions(output.resolve("frame_0001.png")))
                .containsExactlyInAnyOrderElementsOf(PosixFilePermissions.fromString("rw-r-----"));
    }

    @Test
    void rejectsDeclaredAndActualAggregateOveragesAndRemovesEarlierExtractedEntries() throws Exception {
        Path output = Files.createDirectory(temp.resolve("output-overage"));
        byte[] overDeclared = tar("frame.png", '0', 6, new byte[0]);
        assertThatThrownBy(() -> BoundedDockerOutputTransfer.extractTar(
                new ByteArrayInputStream(overDeclared), output, 5, 4_096))
                .isInstanceOf(IOException.class);
        assertThat(Files.list(output)).isEmpty();

        byte[] aggregateOverage = concat(tar("frame_0001.png", '0', "abc".getBytes(StandardCharsets.UTF_8)),
                tar("frame_0002.png", '0', "def".getBytes(StandardCharsets.UTF_8)));
        assertThatThrownBy(() -> BoundedDockerOutputTransfer.extractTar(
                new ByteArrayInputStream(aggregateOverage), output, 5, 4_096))
                .isInstanceOf(IOException.class);
        assertThat(Files.list(output)).isEmpty();
    }

    @Test
    void acceptsManySmallFramesWithinTheEntryCeilingAndTarsPaddingAllowance() throws Exception {
        Path output = Files.createDirectory(temp.resolve("output-small-frames"));
        byte[] archive = new byte[0];
        for (int index = 1; index <= 64; index++) {
            archive = concat(archive, tarEntry(String.format("frame_%04d.png", index), '0',
                    new byte[] {(byte) index}));
        }
        archive = concat(archive, new byte[1024]);

        BoundedDockerOutputTransfer.extractTar(new ByteArrayInputStream(archive), output, 64, 64);

        assertThat(Files.list(output)).hasSize(64);
        assertThat(Files.readAllBytes(output.resolve("frame_0064.png"))).containsExactly((byte) 64);
    }

    @Test
    void rejectsUnsafePathsLinksAndTruncatedPayloadAndPreservesUnownedEntries() throws Exception {
        Path output = Files.createDirectory(temp.resolve("output-unsafe"));
        Path sentinel = Files.writeString(output.resolve("sentinel"), "keep");
        assertThatThrownBy(() -> BoundedDockerOutputTransfer.extractTar(
                new ByteArrayInputStream(tar("../escape.png", '0', new byte[] {1})), output, 10, 4_096))
                .isInstanceOf(IOException.class);
        assertThat(Files.readString(sentinel)).isEqualTo("keep");

        Files.delete(sentinel);
        assertThatThrownBy(() -> BoundedDockerOutputTransfer.extractTar(
                new ByteArrayInputStream(tar("frame.png", '2', new byte[] {1})), output, 10, 4_096))
                .isInstanceOf(IOException.class);
        assertThat(Files.list(output)).isEmpty();

        byte[] shortPayload = java.util.Arrays.copyOf(
                tarEntry("frame.png", '0', 4, new byte[] {1, 2}), 514);
        assertThatThrownBy(() -> BoundedDockerOutputTransfer.extractTar(
                new ByteArrayInputStream(shortPayload), output, 10, 4_096))
                .isInstanceOf(IOException.class);
        assertThat(Files.list(output)).isEmpty();
    }

    @Test
    void processFailureAndTimeoutLeavePrivateOutputEmpty() throws Exception {
        Path output = Files.createDirectory(temp.resolve("output-process"));
        Path cli = temp.resolve("fake-docker");
        Path archive = temp.resolve("partial-result.tar");
        Files.write(archive, tar("frame.png", '0', "frame-data".getBytes(StandardCharsets.UTF_8)));
        Files.writeString(cli, "#!/bin/sh\ncat '" + archive + "'\nexit 17\n");
        Files.setPosixFilePermissions(cli, PosixFilePermissions.fromString("rwx------"));
        assertThatThrownBy(() -> BoundedDockerOutputTransfer.copyFromContainer(
                cli.toString(), "a".repeat(64), output, 128, Duration.ofSeconds(1)))
                .isInstanceOf(IOException.class);
        assertThat(Files.list(output)).isEmpty();

        Files.write(archive, tarEntry("frame.png", '0', "partial-data".getBytes(StandardCharsets.UTF_8)));
        Files.writeString(cli, "#!/bin/sh\ncat '" + archive + "'\nsleep 3\n");
        assertThatThrownBy(() -> BoundedDockerOutputTransfer.copyFromContainer(
                cli.toString(), "a".repeat(64), output, 128, Duration.ofMillis(50)))
                .isInstanceOf(IOException.class).hasMessageContaining("timed out");
        assertThat(Files.list(output)).isEmpty();
    }

    private static byte[] tar(String name, char type, byte[] content) throws IOException {
        return tar(name, type, content.length, content);
    }

    private static byte[] tar(String name, char type, long declaredSize, byte[] content) throws IOException {
        return concat(tarEntry(name, type, declaredSize, content), new byte[1024]);
    }

    private static byte[] tarEntry(String name, char type, byte[] content) throws IOException {
        return tarEntry(name, type, content.length, content);
    }

    private static byte[] tarEntry(String name, char type, long declaredSize, byte[] content) throws IOException {
        byte[] header = new byte[512];
        byte[] path = name.getBytes(StandardCharsets.UTF_8);
        System.arraycopy(path, 0, header, 0, Math.min(path.length, 100));
        octal(header, 100, 8, 0640);
        octal(header, 108, 8, 1000);
        octal(header, 116, 8, 1000);
        octal(header, 124, 12, declaredSize);
        octal(header, 136, 12, 0);
        java.util.Arrays.fill(header, 148, 156, (byte) ' ');
        header[156] = (byte) type;
        System.arraycopy("ustar\0".getBytes(StandardCharsets.US_ASCII), 0, header, 257, 6);
        int checksum = 0;
        for (byte value : header) checksum += value & 0xff;
        byte[] checksumField = String.format("%06o\0 ", checksum).getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(checksumField, 0, header, 148, 8);
        ByteArrayOutputStream tar = new ByteArrayOutputStream();
        tar.write(header);
        tar.write(content);
        int padding = (int) ((512 - content.length % 512) % 512);
        tar.write(new byte[padding]);
        return tar.toByteArray();
    }

    private static void octal(byte[] header, int offset, int length, long value) {
        byte[] text = String.format("%0" + (length - 1) + "o", value).getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(text, 0, header, offset + length - 1 - text.length, text.length);
        header[offset + length - 1] = 0;
    }

    private static byte[] concat(byte[] left, byte[] right) {
        byte[] result = new byte[left.length + right.length];
        System.arraycopy(left, 0, result, 0, left.length);
        System.arraycopy(right, 0, result, left.length, right.length);
        return result;
    }
}
