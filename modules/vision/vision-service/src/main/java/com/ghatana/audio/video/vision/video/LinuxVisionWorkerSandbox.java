package com.ghatana.audio.video.vision.video;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * Per-invocation Linux ARM64 isolation for FFmpeg and FFprobe.
 *
 * <p>The worker is placed in a delegated cgroup v2 before it execs bubblewrap. The cgroup
 * supplies hard CPU-rate, memory (which also accounts for output written to tmpfs), swap,
 * and process-count limits. Bubblewrap provides private PID/network namespaces and a
 * read-only filesystem with only the request workspace writable. Other hosts and incomplete
 * Linux installations fail closed; ProcessHandle sampling is not treated as isolation.
 */
final class LinuxVisionWorkerSandbox {
    private static final String CGROUP_ROOT_ENV = "GHATANA_MEDIA_VISION_CGROUP_ROOT";
    private static final String BWRAP_ENV = "GHATANA_MEDIA_VISION_BWRAP";
    private static final long MEMORY_MAX_BYTES = 1_610_612_736L; // 1.5 GiB, including tmpfs pages
    private static final int CPU_QUOTA_MICROS = 200_000;
    private static final int CPU_PERIOD_MICROS = 100_000;
    private static final int PID_MAX = 32;

    private LinuxVisionWorkerSandbox() { }

    static boolean isCodecCommand(List<String> command) {
        if (command.isEmpty()) return false;
        String executable = Path.of(command.get(0)).getFileName().toString().toLowerCase(Locale.ROOT);
        return executable.equals("ffmpeg") || executable.equals("ffprobe");
    }

    static Prepared prepare(List<String> command, Path workspace) throws IOException {
        if (!isLinuxArm64()) {
            throw new IOException("Vision native media processing is unavailable: bounded Linux ARM64 workers are required");
        }
        Path canonicalWorkspace = workspace.toRealPath(LinkOption.NOFOLLOW_LINKS);
        if (Files.isSymbolicLink(canonicalWorkspace) || !Files.isDirectory(canonicalWorkspace, LinkOption.NOFOLLOW_LINKS)
                || !isTmpfs(canonicalWorkspace)) {
            throw new IOException("Vision native media processing is unavailable: request workspace must be on tmpfs");
        }

        String configuredRoot = System.getenv(CGROUP_ROOT_ENV);
        if (configuredRoot == null || configuredRoot.isBlank()) {
            throw new IOException("Vision native media processing is unavailable: delegated cgroup v2 root is not configured");
        }
        Path cgroupRoot = Path.of(configuredRoot).toRealPath(LinkOption.NOFOLLOW_LINKS);
        if (!Files.isDirectory(cgroupRoot, LinkOption.NOFOLLOW_LINKS)
                || !Files.isWritable(cgroupRoot)
                || !Files.isRegularFile(cgroupRoot.resolve("cgroup.controllers"), LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Vision native media processing is unavailable: delegated cgroup v2 root is not writable");
        }

        String configuredBwrap = System.getenv(BWRAP_ENV);
        Path bwrap = Path.of(configuredBwrap == null || configuredBwrap.isBlank() ? "/usr/bin/bwrap" : configuredBwrap);
        if (!Files.isRegularFile(bwrap, LinkOption.NOFOLLOW_LINKS) || !Files.isExecutable(bwrap)) {
            throw new IOException("Vision native media processing is unavailable: bubblewrap is not installed");
        }

        Path cgroup = cgroupRoot.resolve("vision-" + UUID.randomUUID());
        Files.createDirectory(cgroup);
        try {
            requireCgroupFile(cgroup, "cpu.max", CPU_QUOTA_MICROS + " " + CPU_PERIOD_MICROS);
            requireCgroupFile(cgroup, "memory.max", Long.toString(MEMORY_MAX_BYTES));
            requireCgroupFile(cgroup, "memory.oom.group", "1");
            requireCgroupFile(cgroup, "memory.swap.max", "0");
            requireCgroupFile(cgroup, "pids.max", Integer.toString(PID_MAX));
            if (!Files.isRegularFile(cgroup.resolve("cgroup.kill"), LinkOption.NOFOLLOW_LINKS)) {
                throw new IOException("cgroup v2 cgroup.kill is required for complete worker-tree cleanup");
            }

            List<String> sandbox = new ArrayList<>();
            sandbox.add(bwrap.toString());
            sandbox.addAll(List.of("--unshare-user", "--uid", "0", "--gid", "0",
                    "--unshare-net", "--unshare-pid", "--unshare-ipc",
                    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
                    "--tmpfs", "/run", "--cap-drop", "ALL",
                    "--bind", canonicalWorkspace.toString(), canonicalWorkspace.toString(),
                    "--chdir", canonicalWorkspace.toString(), "--"));
            sandbox.addAll(command);

            // This small shell is the first process created. It joins the already-configured
            // cgroup before exec, so the codec and every descendant inherit the limits.
            List<String> launcher = List.of("/bin/sh", "-c",
                    "printf '%s\\n' \"$$\" > \"$1/cgroup.procs\" || exit 125; shift; exec \"$@\"",
                    "vision-cgroup-launch", cgroup.toString());
            List<String> full = new ArrayList<>(launcher);
            full.addAll(sandbox);
            boolean ephemeral = command.stream().skip(1).anyMatch("-version"::equals)
                    && canonicalWorkspace.getFileName().toString().startsWith(".media-video-codec-");
            return new Prepared(List.copyOf(full), cgroup, ephemeral ? canonicalWorkspace : null);
        } catch (IOException | RuntimeException failure) {
            deleteCgroup(cgroup);
            throw failure;
        }
    }

    private static boolean isLinuxArm64() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("linux")
                && (System.getProperty("os.arch", "").equalsIgnoreCase("aarch64")
                    || System.getProperty("os.arch", "").equalsIgnoreCase("arm64"));
    }

    static boolean requiresSandboxHost() { return isLinuxArm64(); }

    /** Environment passed to the untrusted native codec, with service secrets and loader overrides removed. */
    static Map<String, String> workerEnvironment(Path workspace) {
        String privateTemp = workspace.toAbsolutePath().normalize().toString();
        Map<String, String> environment = new LinkedHashMap<>();
        environment.put("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
        environment.put("LANG", "C.UTF-8");
        environment.put("LC_ALL", "C.UTF-8");
        environment.put("HOME", privateTemp);
        environment.put("TMPDIR", privateTemp);
        return Map.copyOf(environment);
    }

    static boolean isTmpfs(Path path) throws IOException {
        String mountInfo = Files.readString(Path.of("/proc/self/mountinfo"), StandardCharsets.UTF_8);
        Path absolute = path.toAbsolutePath().normalize();
        return mountInfo.lines().map(line -> line.split(" - ", 2)).filter(parts -> parts.length == 2)
                .filter(parts -> parts[1].startsWith("tmpfs "))
                .map(parts -> parts[0].split(" "))
                .anyMatch(fields -> fields.length > 4 && absolute.startsWith(Path.of(fields[4].replace("\\040", " "))));
    }

    static Path workspaceFor(List<String> command) throws IOException {
        // Match the canonical temp root used by media staging. On macOS the configured
        // java.io.tmpdir is commonly /var/... while toRealPath() returns /private/var/...;
        // comparing a canonical candidate to the unresolved alias rejects valid workspaces.
        Path temp = Path.of(System.getProperty("java.io.tmpdir")).toRealPath();
        for (String argument : command) {
            try {
                Path absolute = Path.of(argument).toAbsolutePath().normalize();
                Path parent = absolute.getParent();
                // Canonicalize the parent chain so macOS /var -> /private/var aliases compare
                // equal to the resolved temp root, while an unresolvable or symlinked leaf
                // cannot smuggle a path outside the checked workspace.
                Path candidate = parent == null
                        ? absolute
                        : parent.toRealPath().resolve(absolute.getFileName());
                if (!candidate.startsWith(temp)) continue;
                for (Path cursor = candidate; cursor != null && cursor.startsWith(temp); cursor = cursor.getParent()) {
                    if (cursor.getFileName() != null && cursor.getFileName().toString().startsWith(".media-video-codec-")) {
                        return cursor;
                    }
                }
            } catch (IOException | RuntimeException ignored) { }
        }
        if (command.size() > 1 && command.stream().skip(1).anyMatch("-version"::equals)) {
            Path shm = Path.of("/dev/shm");
            if (Files.isDirectory(shm) && isTmpfs(shm)) {
                Path scratch = Files.createTempDirectory(shm, ".media-video-codec-");
                try {
                    Files.setPosixFilePermissions(scratch, java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"));
                    return scratch;
                } catch (IOException failure) {
                    Files.deleteIfExists(scratch);
                    throw failure;
                }
            }
        }
        throw new IOException("Vision native media processing is unavailable: request workspace cannot be identified");
    }

    private static void requireCgroupFile(Path cgroup, String name, String value) throws IOException {
        Path file = cgroup.resolve(name);
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Delegated cgroup v2 does not expose required " + name);
        }
        Files.writeString(file, value, StandardCharsets.US_ASCII);
    }

    private static void deleteCgroup(Path cgroup) {
        try {
            if (Files.exists(cgroup.resolve("cgroup.kill"), LinkOption.NOFOLLOW_LINKS)) {
                Files.writeString(cgroup.resolve("cgroup.kill"), "1", StandardCharsets.US_ASCII);
            }
        } catch (IOException ignored) { }
        try { Files.deleteIfExists(cgroup); } catch (IOException ignored) { }
    }

    static final class Prepared implements AutoCloseable {
        private final List<String> command;
        private final Path cgroup;
        private final Path ephemeralWorkspace;

        private Prepared(List<String> command, Path cgroup, Path ephemeralWorkspace) {
            this.command = command;
            this.cgroup = cgroup;
            this.ephemeralWorkspace = ephemeralWorkspace;
        }

        List<String> command() { return command; }

        void killAll() {
            try { Files.writeString(cgroup.resolve("cgroup.kill"), "1", StandardCharsets.US_ASCII); }
            catch (IOException ignored) { }
        }

        @Override public void close() {
            deleteCgroup(cgroup);
            if (ephemeralWorkspace != null) {
                try { Files.deleteIfExists(ephemeralWorkspace); } catch (IOException ignored) { }
            }
        }
    }
}
