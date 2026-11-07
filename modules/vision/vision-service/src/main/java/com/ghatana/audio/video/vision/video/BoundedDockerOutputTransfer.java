package com.ghatana.audio.video.vision.video;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Streams OCI output archives through a strict byte-, entry-, path-, and type-bounded extractor. */
final class BoundedDockerOutputTransfer {
    private static final int TAR_BLOCK = 512;

    private BoundedDockerOutputTransfer() { }

    static void copyFromContainer(String dockerCli, String containerId, Path outputDirectory,
            long maximumBytes, Duration timeout) throws IOException {
        if (dockerCli == null || dockerCli.isBlank() || containerId == null
                || !containerId.matches("[a-f0-9]{64}")) {
            throw new IOException("Vision output transfer bounds or identity are invalid");
        }
        copyFromCommand(dockerCli, List.of(dockerCli, "cp", containerId + ":/output/.", "-"),
                null, outputDirectory, maximumBytes, timeout);
    }

    /**
     * Streams a stopped worker's persistent tmpfs volume through a restricted helper. Docker
     * does not include a container's tmpfs contents in `docker cp` after that container stops.
     */
    static void copyFromVolume(String dockerCli, String imageDigest, String volumeName,
            long uid, long gid, Path outputDirectory, long maximumBytes, Duration timeout) throws IOException {
        if (imageDigest == null || !imageDigest.matches("(?:[^\\s,@]+@)?sha256:[a-f0-9]{64}")
                || volumeName == null || !volumeName.matches("media-vision-output-[a-f0-9-]{36}")
                || uid <= 0 || uid > Integer.MAX_VALUE || gid < 0 || gid > Integer.MAX_VALUE) {
            throw new IOException("Vision output volume identity is invalid");
        }
        String helperName = "media-vision-output-copy-" + java.util.UUID.randomUUID();
        List<String> command = volumeTransferCommand(dockerCli, helperName, imageDigest, volumeName, uid, gid);
        copyFromCommand(dockerCli, command, helperName, outputDirectory, maximumBytes, timeout);
    }

    static List<String> volumeTransferCommand(String dockerCli, String helperName, String imageDigest,
            String volumeName, long uid, long gid) throws IOException {
        if (dockerCli == null || dockerCli.isBlank() || helperName == null
                || !helperName.matches("media-vision-output-copy-[a-f0-9-]{36}")
                || imageDigest == null || !imageDigest.matches("(?:[^\\s,@]+@)?sha256:[a-f0-9]{64}")
                || volumeName == null || !volumeName.matches("media-vision-output-[a-f0-9-]{36}")
                || uid <= 0 || uid > Integer.MAX_VALUE || gid < 0 || gid > Integer.MAX_VALUE) {
            throw new IOException("Vision output volume identity is invalid");
        }
        return List.of(dockerCli, "run", "--name", helperName,
                "--pull=never", "--platform=linux/arm64", "--network=none", "--read-only",
                "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
                "--memory=134217728", "--memory-swap=134217728", "--pids-limit=4",
                "--ulimit=nofile=64:64", "--tmpfs", "/tmp:rw,nosuid,nodev,exec,size=16m,nr_inodes=256",
                "--user=" + uid + ":" + gid,
                "--mount", "type=volume,source=" + volumeName + ",target=/output,readonly,volume-nocopy",
                "--entrypoint=/bin/tar", imageDigest, "--format=ustar", "-C", "/output", "-cf", "-", ".");
    }

    private static void copyFromCommand(String dockerCli, List<String> command, String cleanupName,
            Path outputDirectory, long maximumBytes, Duration timeout) throws IOException {
        if (dockerCli == null || dockerCli.isBlank() || outputDirectory == null
                || maximumBytes <= 0 || maximumBytes > MediaOciBrokerPolicy.MAX_VISION_OUTPUT_BYTES
                || timeout == null || timeout.isNegative() || timeout.isZero()) {
            throw new IOException("Vision output transfer bounds or identity are invalid");
        }
        Path root = outputDirectory.toAbsolutePath().normalize();
        if (Files.isSymbolicLink(root) || !Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS)
                || !root.toRealPath(LinkOption.NOFOLLOW_LINKS).equals(root) || !Files.isWritable(root)) {
            throw new IOException("Vision output transfer directory is unsafe");
        }
        try (var entries = Files.list(root)) {
            if (entries.findAny().isPresent()) {
                throw new IOException("Vision output transfer directory must be empty");
            }
        }
        Process process = new ProcessBuilder(command).redirectErrorStream(false).start();
        AtomicBoolean timedOut = new AtomicBoolean();
        Thread watchdog = new Thread(() -> {
            try {
                if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                    timedOut.set(true);
                    terminate(process);
                    process.waitFor(2, TimeUnit.SECONDS);
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }, "vision-output-copy-timeout");
        watchdog.setDaemon(true);
        watchdog.start();
        Thread stderrDrain = drainStderr(process.getErrorStream());
        List<Path> transferred = List.of();
        try (InputStream archive = process.getInputStream()) {
            transferred = extractTar(archive, root, maximumBytes, VideoFrameExtractor.MAX_OUTPUT_ENTRIES);
        } catch (IOException | RuntimeException failure) {
            terminate(process);
            IOException reported = timedOut.get()
                    ? new IOException("Vision output archive transfer timed out", failure)
                    : failure instanceof IOException io ? io : new IOException("Vision output archive is invalid", failure);
            cleanupCreated(transferred, reported);
            cleanupHelper(dockerCli, cleanupName, reported);
            throw reported;
        } finally {
            try { process.getInputStream().close(); } catch (IOException ignored) { }
        }
        try {
            if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                timedOut.set(true);
                terminate(process);
                process.waitFor(2, TimeUnit.SECONDS);
            }
            watchdog.join(1_000);
            stderrDrain.join(1_000);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            terminate(process);
            IOException failure = new IOException("Vision output archive transfer was interrupted", interrupted);
            cleanupCreated(transferred, failure);
            cleanupHelper(dockerCli, cleanupName, failure);
            throw failure;
        }
        if (timedOut.get() || process.exitValue() != 0) {
            IOException failure = new IOException(timedOut.get()
                    ? "Vision output archive transfer timed out" : "Vision output archive transfer failed");
            cleanupCreated(transferred, failure);
            cleanupHelper(dockerCli, cleanupName, failure);
            throw failure;
        }
        cleanupHelper(dockerCli, cleanupName, null);
    }

    private static void cleanupHelper(String dockerCli, String helperName, IOException primary) throws IOException {
        if (helperName == null) return;
        try {
            Process cleanup = new ProcessBuilder(dockerCli, "rm", "--force", helperName)
                    .redirectErrorStream(true).start();
            if (!cleanup.waitFor(10, TimeUnit.SECONDS)) {
                cleanup.destroyForcibly();
                throw new IOException("Vision output transfer helper cleanup timed out");
            }
            if (cleanup.exitValue() != 0) throw new IOException("Vision output transfer helper cleanup failed");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            IOException failure = new IOException("Vision output transfer helper cleanup was interrupted", interrupted);
            if (primary != null) primary.addSuppressed(failure); else throw failure;
        } catch (IOException failure) {
            if (primary != null) primary.addSuppressed(failure); else throw failure;
        }
    }

    /** Extracts only flat regular output files, never links, extensions, or special tar entries. */
    static List<Path> extractTar(InputStream archive, Path root, long maximumBytes, int maximumEntries)
            throws IOException {
        if (maximumBytes <= 0 || maximumEntries <= 0) throw new IOException("Invalid output archive limits");
        Set<String> names = new HashSet<>();
        List<Path> created = new ArrayList<>();
        long totalBytes = 0;
        long archiveBytes = 0;
        int files = 0;
        int tarEntries = 0;
        boolean rootDirectorySeen = false;
        int zeroBlocks = 0;
        long outputGroup;
        try { outputGroup = ((Number) Files.getAttribute(root, "unix:gid", LinkOption.NOFOLLOW_LINKS)).longValue(); }
        catch (RuntimeException failure) { throw new IOException("Output transfer group cannot be established", failure); }
        try {
            byte[] header = new byte[TAR_BLOCK];
            while (true) {
                int headerRead = readBlock(archive, header);
                if (headerRead == 0) {
                    if (zeroBlocks < 2) throw new IOException("Output tar archive has no complete terminator");
                    break;
                }
                if (headerRead != TAR_BLOCK) throw new IOException("Output tar header is truncated");
                archiveBytes += TAR_BLOCK;
                checkArchiveBound(archiveBytes, maximumBytes, maximumEntries);
                if (allZero(header)) {
                    zeroBlocks++;
                    if (zeroBlocks == 2) {
                        int trailing;
                        while ((trailing = archive.read()) >= 0) {
                            archiveBytes++;
                            checkArchiveBound(archiveBytes, maximumBytes, maximumEntries);
                            if (trailing != 0) throw new IOException("Output tar has nonzero bytes after terminator");
                        }
                        break;
                    }
                    continue;
                }
                if (zeroBlocks != 0) throw new IOException("Output tar has a partial terminator");
                if (++tarEntries > maximumEntries + 1) {
                    throw new IOException("Output tar entry count exceeds its directory allowance");
                }
                validateChecksum(header);
                String path = tarPath(header);
                long size = octal(header, 124, 12);
                byte type = header[156];
                if (type == '5') {
                    if (!(path.equals(".") || path.equals("./")) || size != 0 || rootDirectorySeen) {
                        throw new IOException("Output tar contains an unsupported directory entry");
                    }
                    rootDirectorySeen = true;
                    continue;
                }
                if (type != 0 && type != '0') throw new IOException("Output tar contains a link or special entry");
                String name = normalizedFlatName(path);
                if (!allowedName(name) || !names.add(name) || size <= 0 || size > maximumBytes
                        || totalBytes > maximumBytes - size || ++files > maximumEntries) {
                    throw new IOException("Output tar entry violates the file, name, or aggregate bound");
                }
                Path destination = root.resolve(name);
                if (!destination.getParent().equals(root) || Files.exists(destination, LinkOption.NOFOLLOW_LINKS)) {
                    throw new IOException("Output tar entry escapes or collides with the private directory");
                }
                try (OutputStream output = Files.newOutputStream(destination,
                        StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                    created.add(destination);
                    copyExactly(archive, output, size);
                }
                Files.setPosixFilePermissions(destination, PosixFilePermissions.fromString("rw-r-----"));
                long fileGroup = ((Number) Files.getAttribute(destination, "unix:gid", LinkOption.NOFOLLOW_LINKS)).longValue();
                int fileMode = ((Number) Files.getAttribute(destination, "unix:mode", LinkOption.NOFOLLOW_LINKS)).intValue() & 07777;
                if (fileGroup != outputGroup || fileMode != 0640) {
                    throw new IOException("Output transfer did not preserve its dedicated shared group");
                }
                totalBytes += size;
                archiveBytes += size;
                checkArchiveBound(archiveBytes, maximumBytes, maximumEntries);
                long padding = (TAR_BLOCK - size % TAR_BLOCK) % TAR_BLOCK;
                skipExactly(archive, padding);
                archiveBytes += padding;
                checkArchiveBound(archiveBytes, maximumBytes, maximumEntries);
            }
            return List.copyOf(created);
        } catch (IOException | RuntimeException failure) {
            cleanupCreated(created, failure);
            throw failure instanceof IOException io ? io : new IOException("Output tar archive is invalid", failure);
        }
    }

    private static void checkArchiveBound(long archiveBytes, long maximumBytes, int maximumEntries) throws IOException {
        long maximumArchiveBytes = maximumBytes + (2L * maximumEntries + 4) * TAR_BLOCK;
        if (archiveBytes > maximumArchiveBytes) {
            throw new IOException("Output tar archive exceeds its bounded transfer size");
        }
    }

    private static int readBlock(InputStream input, byte[] block) throws IOException {
        int offset = 0;
        while (offset < block.length) {
            int read = input.read(block, offset, block.length - offset);
            if (read < 0) break;
            if (read == 0) continue;
            offset += read;
        }
        return offset;
    }

    private static boolean allZero(byte[] bytes) {
        for (byte value : bytes) if (value != 0) return false;
        return true;
    }

    private static void validateChecksum(byte[] header) throws IOException {
        long expected = octal(header, 148, 8);
        long actual = 0;
        for (int i = 0; i < header.length; i++) actual += (i >= 148 && i < 156) ? 32 : (header[i] & 0xff);
        if (expected != actual) throw new IOException("Output tar header checksum is invalid");
    }

    private static String tarPath(byte[] header) throws IOException {
        String name = field(header, 0, 100);
        String prefix = field(header, 345, 155);
        if (!prefix.isEmpty()) name = prefix + "/" + name;
        if (name.indexOf('\\') >= 0 || name.indexOf('\0') >= 0) throw new IOException("Output tar path is invalid");
        return name;
    }

    private static String field(byte[] header, int offset, int length) {
        int end = offset;
        while (end < offset + length && header[end] != 0) end++;
        return new String(header, offset, end - offset, java.nio.charset.StandardCharsets.UTF_8);
    }

    private static String normalizedFlatName(String name) throws IOException {
        while (name.startsWith("./")) name = name.substring(2);
        if (name.isEmpty() || name.startsWith("/") || name.contains("/") || name.equals(".")
                || name.equals("..") || name.contains("..")) throw new IOException("Output tar path is not flat");
        return name;
    }

    private static boolean allowedName(String name) {
        return name.matches("frame_[0-9]{4,}\\.(?:jpg|jpeg|png|bmp|tiff)")
                || name.matches("frame\\.(?:jpg|jpeg|png|bmp|tiff)") || name.equals("audio.pcm");
    }

    private static long octal(byte[] field, int offset, int length) throws IOException {
        long result = 0;
        int end = offset + length;
        int cursor = offset;
        while (cursor < end && (field[cursor] == 0 || field[cursor] == ' ')) cursor++;
        boolean digit = false;
        while (cursor < end && field[cursor] != 0 && field[cursor] != ' ') {
            int value = field[cursor++] - '0';
            if (value < 0 || value > 7 || result > (Long.MAX_VALUE - value) / 8) {
                throw new IOException("Output tar numeric field is invalid");
            }
            result = result * 8 + value;
            digit = true;
        }
        while (cursor < end) {
            if (field[cursor++] != 0 && field[cursor - 1] != ' ') {
                throw new IOException("Output tar numeric field has trailing data");
            }
        }
        return digit ? result : 0;
    }

    private static void copyExactly(InputStream input, OutputStream output, long size) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        long remaining = size;
        while (remaining > 0) {
            int read = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
            if (read < 0) throw new IOException("Output tar file payload is truncated");
            if (read == 0) continue;
            output.write(buffer, 0, read);
            remaining -= read;
        }
    }

    private static void skipExactly(InputStream input, long size) throws IOException {
        while (size > 0) {
            long skipped = input.skip(size);
            if (skipped == 0) {
                if (input.read() < 0) throw new IOException("Output tar padding is truncated");
                skipped = 1;
            }
            size -= skipped;
        }
    }

    private static Thread drainStderr(InputStream input) {
        Thread drain = new Thread(() -> {
            byte[] buffer = new byte[1024];
            try (input) { while (input.read(buffer) >= 0) { /* discard bounded diagnostics */ } }
            catch (IOException ignored) { }
        }, "vision-output-copy-stderr");
        drain.setDaemon(true);
        drain.start();
        return drain;
    }

    private static void terminate(Process process) {
        process.descendants().forEach(ProcessHandle::destroyForcibly);
        process.destroyForcibly();
    }

    private static void cleanupCreated(List<Path> files, Throwable failure) {
        for (Path path : files) {
            try { Files.deleteIfExists(path); }
            catch (IOException cleanupFailure) { failure.addSuppressed(cleanupFailure); }
        }
    }
}
