package com.ghatana.audio.video.vision.video;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * Trusted host-side OCI launcher for one FFmpeg/FFprobe invocation.
 *
 * <p>The Media process invokes the trusted Docker CLI on its host. The codec runs as the
 * mapped, unprivileged owner of a single read-only source file and a single private output
 * directory. The container receives neither the Docker socket nor host credentials. A
 * digest-pinned worker image is required; missing or mismatched runtime limits fail closed.
 */
final class HostOciVisionWorkerSupervisor {
    static final String IMAGE_ENV = "GHATANA_MEDIA_VISION_WORKER_IMAGE";
    static final String DOCKER_CLI_ENV = "GHATANA_MEDIA_VISION_DOCKER_CLI";

    private static final long MEMORY_BYTES = 1_610_612_736L;
    private static final long CPU_NANOS = 2_000_000_000L;
    private static final int PID_LIMIT = 32;
    private static final Pattern PINNED_IMAGE = Pattern.compile("(?:[^\\s,@]+@)?sha256:[a-f0-9]{64}");
    private static final Pattern CONTAINER_ID = Pattern.compile("[a-f0-9]{64}");
    private static final int AUXILIARY_OUTPUT_LIMIT = 8192;

    private HostOciVisionWorkerSupervisor() { }

    static Prepared prepare(List<String> command, Path workspace, Path outputDirectory) throws IOException {
        String image = System.getenv(IMAGE_ENV);
        if (image == null || image.isBlank()) {
            throw new IOException("Vision native media processing is unavailable: digest-pinned host OCI worker image is not configured");
        }
        String docker = System.getenv(DOCKER_CLI_ENV);
        if (docker == null || docker.isBlank()) docker = "docker";
        LaunchPlan plan = plan(command, workspace, outputDirectory, image, docker,
                null, null, UUID.randomUUID().toString());

        CommandResult created;
        try {
            created = runAuxiliary(plan.createCommand(), Duration.ofSeconds(15));
        } catch (IOException failure) {
            try { removeContainer(plan.dockerCli(), plan.containerName()); }
            catch (IOException cleanup) { failure.addSuppressed(cleanup); }
            throw failure;
        }
        String containerId = created.output().trim();
        if (created.exitCode() != 0 || !CONTAINER_ID.matcher(containerId).matches()) {
            IOException failure = new IOException(
                    "Vision native media processing is unavailable: host OCI worker could not be created");
            try { removeContainer(plan.dockerCli(), plan.containerName()); }
            catch (IOException cleanup) { failure.addSuppressed(cleanup); }
            throw failure;
        }
        try {
            CommandResult inspection = runAuxiliary(List.of(
                    plan.dockerCli(), "inspect", "--format", "{{json .HostConfig}}|{{json .Config}}|{{json .Mounts}}", containerId),
                    Duration.ofSeconds(10));
            List<String> mismatches = inspection.exitCode() == 0
                    ? effectiveLimitMismatches(inspection.output(), plan.source() != null,
                            outputDirectory != null, plan.uid() + ":" + plan.gid(),
                            "/usr/bin/" + Path.of(command.getFirst()).getFileName().toString().toLowerCase(Locale.ROOT),
                            plan.imageDigest(), plan.source(), plan.output())
                    : List.of("inspect");
            if (!mismatches.isEmpty()) {
                throw new IOException("Vision native media processing is unavailable: OCI preflight mismatch "
                        + String.join(",", mismatches));
            }
            return new Prepared(plan, containerId);
        } catch (IOException | RuntimeException failure) {
            try { removeContainer(plan.dockerCli(), containerId); }
            catch (IOException cleanup) { failure.addSuppressed(cleanup); }
            throw failure;
        }
    }

    /** Build the complete host command without contacting Docker, for contract tests. */
    static LaunchPlan plan(
            List<String> command,
            Path workspace,
            Path outputDirectory,
            String image,
            String dockerCli,
            Long expectedUid,
            Long expectedGid,
            String invocationId) throws IOException {
        if (command == null || command.isEmpty() || !LinuxVisionWorkerSandbox.isCodecCommand(command)) {
            throw new IOException("Only the allow-listed FFmpeg and FFprobe tools may enter the Vision worker");
        }
        if (image == null || !PINNED_IMAGE.matcher(image).matches()) {
            throw new IOException("Vision worker image must be pinned by a SHA-256 digest");
        }
        if (dockerCli == null || dockerCli.isBlank() || dockerCli.chars().anyMatch(Character::isWhitespace)) {
            throw new IOException("A single trusted Docker CLI executable is required");
        }
        if (invocationId == null || !invocationId.matches("[a-f0-9-]{36}")) {
            throw new IOException("Invalid Vision worker invocation identity");
        }

        Path source = locateSource(command, workspace, outputDirectory);
        Path output = canonicalPrivateDirectory(outputDirectory, "Vision worker output directory");
        if (source == null && !isVersionProbe(command)) {
            throw new IOException("Vision worker request must name one private staged source file");
        }

        long uid;
        long gid;
        if (source != null) {
            uid = unixId(source, "uid");
            gid = unixId(source, "gid");
            if (uid == 0 || uid > Integer.MAX_VALUE || gid > Integer.MAX_VALUE) {
                throw new IOException("Vision worker source must be owned by a mapped, unprivileged host identity");
            }
            if (output != null && (unixId(output, "uid") != uid || unixId(output, "gid") != gid)) {
                throw new IOException("Vision worker source and output must have the same mapped owner");
            }
        } else {
            Path identityPath = Path.of(System.getProperty("java.io.tmpdir")).toRealPath(LinkOption.NOFOLLOW_LINKS);
            uid = expectedUid == null ? unixId(identityPath, "uid") : expectedUid;
            gid = expectedGid == null ? unixId(identityPath, "gid") : expectedGid;
            if (uid <= 0 || uid > Integer.MAX_VALUE || gid < 0 || gid > Integer.MAX_VALUE) {
                throw new IOException("Version probes require an unprivileged mapped host identity");
            }
        }
        if (expectedUid != null && expectedUid != uid || expectedGid != null && expectedGid != gid) {
            throw new IOException("Vision worker identity does not match its staged files");
        }

        List<String> workerCommand = rewriteCommand(command, source, output);
        String containerName = "media-vision-" + invocationId;
        List<String> create = new ArrayList<>();
        create.add(dockerCli);
        create.addAll(List.of("create", "--name", containerName, "--pull=never", "--platform=linux/arm64",
                "--label", "com.ghatana.media.vision.worker=true",
                "--memory=" + MEMORY_BYTES, "--memory-swap=" + MEMORY_BYTES, "--cpus=2",
                "--pids-limit=" + PID_LIMIT, "--network=none", "--read-only", "--cap-drop=ALL",
                "--security-opt=no-new-privileges:true", "--init", "--stop-timeout=2",
                "--tmpfs", "/tmp:rw,nosuid,nodev,exec,size=128m",
                "--user=" + uid + ":" + gid, "--workdir=/tmp",
                "--env=HOME=/tmp", "--env=TMPDIR=/tmp", "--env=PATH=/usr/bin:/bin",
                "--env=LANG=C.UTF-8", "--env=LC_ALL=C.UTF-8"));
        if (source != null) {
            requireDockerMountPath(source);
            create.addAll(List.of("--mount", "type=bind,source=" + source + ",target=/source/input,readonly"));
        }
        if (output != null) {
            requireDockerMountPath(output);
            create.addAll(List.of("--mount", "type=bind,source=" + output + ",target=/output"));
        }
        String executable = Path.of(command.getFirst()).getFileName().toString().toLowerCase(Locale.ROOT);
        create.addAll(List.of("--entrypoint=/usr/bin/" + executable, image));
        if (workerCommand.size() > 1) create.addAll(workerCommand.subList(1, workerCommand.size()));

        return new LaunchPlan(dockerCli, containerName, List.copyOf(create), source, output, uid, gid,
                MEMORY_BYTES, CPU_NANOS, PID_LIMIT, image);
    }

    private static Path locateSource(List<String> command, Path workspace, Path outputDirectory) throws IOException {
        if (isVersionProbe(command)) return null;
        if (workspace == null) throw new IOException("Vision worker source workspace is unavailable");
        Path root = workspace.toRealPath(LinkOption.NOFOLLOW_LINKS);
        if (Files.isSymbolicLink(root) || !Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Vision worker source workspace is unsafe");
        }
        Path expected = null;
        for (int i = 1; i < command.size(); i++) {
            if (command.get(i).equals("-i")) {
                if (i + 1 >= command.size() || expected != null) {
                    throw new IOException("Vision worker supports exactly one source input");
                }
                expected = parseStagedPath(command.get(++i));
            }
        }
        if (expected == null) {
            List<Path> candidates = new ArrayList<>();
            Path outputRoot = outputDirectory == null ? null
                    : outputDirectory.toRealPath(LinkOption.NOFOLLOW_LINKS);
            for (String argument : command) {
                Path candidate = parseStagedPath(argument);
                if (candidate == null || !candidate.isAbsolute() || Files.isSymbolicLink(candidate)) continue;
                candidate = commandPath(candidate);
                if (!candidate.startsWith(root) || outputRoot != null && candidate.startsWith(outputRoot)) continue;
                if (Files.isRegularFile(candidate, LinkOption.NOFOLLOW_LINKS)) candidates.add(candidate);
            }
            if (candidates.size() == 1) expected = candidates.getFirst();
            else if (candidates.size() > 1) throw new IOException("Vision worker supports exactly one source input");
        }
        if (expected == null || Files.isSymbolicLink(expected)) {
            throw new IOException("Vision worker source must be a regular file inside its private request workspace");
        }
        expected = commandPath(expected);
        if (!expected.startsWith(root) || !Files.isRegularFile(expected, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Vision worker source must be a regular file inside its private request workspace");
        }
        Path source = expected.toRealPath(LinkOption.NOFOLLOW_LINKS);
        if (!source.equals(expected) || Files.size(source) <= 0) {
            throw new IOException("Vision worker source snapshot is not a stable regular file");
        }
        long mode = ((Number) Files.getAttribute(source, "unix:mode", LinkOption.NOFOLLOW_LINKS)).longValue();
        if ((mode & 0077) != 0 || (mode & 0400) == 0) {
            throw new IOException("Vision worker source file must remain private to its mapped owner");
        }
        return source;
    }

    private static List<String> rewriteCommand(List<String> command, Path source, Path output) throws IOException {
        String tool = Path.of(command.getFirst()).getFileName().toString().toLowerCase(Locale.ROOT);
        List<String> rewritten = new ArrayList<>(command.size());
        rewritten.add(tool);
        for (int i = 1; i < command.size(); i++) {
            String argument = command.get(i);
            Path path = parseStagedPath(argument);
            if (path == null || !path.isAbsolute()) {
                rewritten.add(argument);
            } else {
                Path resolved = commandPath(path);
                if (source != null && resolved.equals(source)) {
                    rewritten.add("/source/input");
                    continue;
                }
                if (output == null || !resolved.startsWith(output)) {
                    throw new IOException("Vision worker command contains an unmounted host path");
                }
                Path relative = output.relativize(resolved);
                if (relative.toString().isBlank() || relative.startsWith("..")) {
                    throw new IOException("Vision worker output path is outside the private output mount");
                }
                rewritten.add("/output/" + relative.toString().replace('\\', '/'));
            }
        }
        return List.copyOf(rewritten);
    }

    private static Path commandPath(Path path) throws IOException {
        Path absolute = path.toAbsolutePath().normalize();
        if (Files.exists(absolute, LinkOption.NOFOLLOW_LINKS)) {
            return absolute.toRealPath(LinkOption.NOFOLLOW_LINKS);
        }
        Path parent = absolute.getParent();
        if (parent != null && Files.isDirectory(parent, LinkOption.NOFOLLOW_LINKS)) {
            return parent.toRealPath(LinkOption.NOFOLLOW_LINKS).resolve(absolute.getFileName()).normalize();
        }
        return absolute;
    }

    private static Path parseStagedPath(String value) {
        try { return Path.of(value).normalize(); }
        catch (RuntimeException invalid) { return null; }
    }

    private static boolean isVersionProbe(List<String> command) {
        return command.size() > 1 && command.stream().skip(1).anyMatch("-version"::equals);
    }

    private static Path canonicalPrivateDirectory(Path path, String description) throws IOException {
        if (path == null) return null;
        Path absolute = path.toAbsolutePath().normalize();
        if (Files.isSymbolicLink(absolute) || !Files.isDirectory(absolute, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException(description + " is unsafe");
        }
        Path real = absolute.toRealPath(LinkOption.NOFOLLOW_LINKS);
        long mode = ((Number) Files.getAttribute(real, "unix:mode", LinkOption.NOFOLLOW_LINKS)).longValue();
        if ((mode & 0077) != 0 || (mode & 0100) == 0 || (mode & 0200) == 0) {
            throw new IOException(description + " must be owner-only and writable");
        }
        return real;
    }

    private static long unixId(Path path, String name) throws IOException {
        Object value = Files.getAttribute(path, "unix:" + name, LinkOption.NOFOLLOW_LINKS);
        if (!(value instanceof Number number)) throw new IOException("Filesystem cannot map Vision worker ownership");
        return number.longValue();
    }

    private static void requireDockerMountPath(Path path) throws IOException {
        String value = path.toString();
        if (!path.isAbsolute() || value.contains(",") || value.indexOf('\n') >= 0 || value.indexOf('\r') >= 0) {
            throw new IOException("Vision worker mount path is not representable by the trusted OCI launcher");
        }
    }

    static boolean effectiveLimitsMatch(
            String inspection,
            boolean hasSourceMount,
            boolean hasOutputMount,
            String expectedUser,
            String expectedEntrypoint,
            String expectedImage,
            Path expectedSource,
            Path expectedOutput) {
        return effectiveLimitMismatches(inspection, hasSourceMount, hasOutputMount, expectedUser,
                expectedEntrypoint, expectedImage, expectedSource, expectedOutput).isEmpty();
    }

    private static List<String> effectiveLimitMismatches(
            String inspection,
            boolean hasSourceMount,
            boolean hasOutputMount,
            String expectedUser,
            String expectedEntrypoint,
            String expectedImage,
            Path expectedSource,
            Path expectedOutput) {
        if (inspection == null) return List.of("inspect");
        String[] inspected = inspection.split("\\|", 3);
        if (inspected.length != 3) return List.of("inspect-format");
        String hostConfig = inspected[0];
        String config = inspected[1];
        String mounts = inspected[2];
        java.util.ArrayList<String> mismatches = new java.util.ArrayList<>();
        requireMatch(mismatches, "memory", hostConfig.contains("\"Memory\":" + MEMORY_BYTES));
        requireMatch(mismatches, "swap", hostConfig.contains("\"MemorySwap\":" + MEMORY_BYTES));
        requireMatch(mismatches, "cpu", hostConfig.contains("\"NanoCpus\":" + CPU_NANOS));
        requireMatch(mismatches, "pids", hostConfig.contains("\"PidsLimit\":" + PID_LIMIT));
        requireMatch(mismatches, "network", hostConfig.contains("\"NetworkMode\":\"none\""));
        requireMatch(mismatches, "rootfs", hostConfig.contains("\"ReadonlyRootfs\":true"));
        requireMatch(mismatches, "privileged", hostConfig.contains("\"Privileged\":false"));
        requireMatch(mismatches, "capabilities", hostConfig.contains("\"CapDrop\":[\"ALL\"]")
                && hostConfig.contains("\"CapAdd\":null"));
        requireMatch(mismatches, "devices", hostConfig.contains("\"Devices\":[]")
                && hostConfig.contains("\"DeviceRequests\":null"));
        requireMatch(mismatches, "security-opt", hostConfig.contains("\"SecurityOpt\":[\"no-new-privileges:true\"]"));
        requireMatch(mismatches, "tmpfs", hostConfig.contains("\"Tmpfs\":{\"/tmp\":\"rw,nosuid,nodev,exec,size=128m\"}"));
        requireMatch(mismatches, "ports", hostConfig.contains("\"PortBindings\":{}")
                && hostConfig.contains("\"PublishAllPorts\":false"));
        requireMatch(mismatches, "user", config.contains("\"User\":\"" + expectedUser + "\""));
        requireMatch(mismatches, "entrypoint", config.contains("\"Entrypoint\":[\"" + expectedEntrypoint + "\"]"));
        requireMatch(mismatches, "image", config.contains("\"Image\":\"" + jsonEscape(expectedImage) + "\""));
        requireMatch(mismatches, "environment", workerEnvironmentMatches(config));
        requireMatch(mismatches, "socket", !mounts.contains("/var/run/docker.sock"));
        int expectedMounts = (hasSourceMount ? 1 : 0) + (hasOutputMount ? 1 : 0);
        requireMatch(mismatches, "mount-count", occurrenceCount(mounts, "\"Destination\":") == expectedMounts
                && occurrenceCount(hostConfig, "\"Target\":") == expectedMounts);
        if (hasSourceMount) {
            requireMatch(mismatches, "source-readonly-config",
                    mountIsConfiguredReadOnly(hostConfig, "/source/input", expectedSource));
            requireMatch(mismatches, "source-readonly-runtime",
                    mountIsReadOnly(mounts, "/source/input", expectedSource));
        }
        if (hasOutputMount) {
            requireMatch(mismatches, "output-writable",
                    mountIsWritable(mounts, "/output", expectedOutput));
        }
        return List.copyOf(mismatches);
    }

    private static void requireMatch(List<String> mismatches, String name, boolean matches) {
        if (!matches) mismatches.add(name);
    }

    private static boolean workerEnvironmentMatches(String config) {
        int start = config.indexOf("\"Env\":[");
        if (start < 0) return false;
        start += "\"Env\":[".length();
        int end = config.indexOf(']', start);
        if (end < 0) return false;
        String environmentJson = config.substring(start, end);
        java.util.regex.Matcher values = Pattern.compile("\"([^\"]*)\"").matcher(environmentJson);
        java.util.Set<String> actual = new java.util.HashSet<>();
        while (values.find()) actual.add(values.group(1));
        return actual.equals(java.util.Set.of("HOME=/tmp", "TMPDIR=/tmp", "PATH=/usr/bin:/bin",
                "LANG=C.UTF-8", "LC_ALL=C.UTF-8"));
    }

    private static boolean mountIsReadOnly(String mounts, String destination, Path expectedSource) {
        return mountBlock(mounts, destination)
                .filter(block -> block.contains("\"Type\":\"bind\"")
                        && block.contains("\"RW\":false")
                        && block.contains("\"Source\":\"" + jsonEscape(expectedSource.toString()) + "\""))
                .isPresent();
    }

    private static boolean mountIsConfiguredReadOnly(String hostConfig, String destination, Path expectedSource) {
        int mountsStart = hostConfig.indexOf("\"Mounts\":[");
        if (mountsStart < 0) return false;
        String configuredMounts = hostConfig.substring(mountsStart);
        int marker = configuredMounts.indexOf("\"Target\":\"" + destination + "\"");
        if (marker < 0) return false;
        int start = configuredMounts.lastIndexOf('{', marker);
        int end = configuredMounts.indexOf('}', marker);
        if (start < 0 || end < 0) return false;
        String block = configuredMounts.substring(start, end + 1);
        return block.contains("\"Type\":\"bind\"")
                && block.contains("\"ReadOnly\":true")
                && block.contains("\"Source\":\"" + jsonEscape(expectedSource.toString()) + "\"");
    }

    private static boolean mountIsWritable(String mounts, String destination, Path expectedSource) {
        return mountBlock(mounts, destination)
                .filter(block -> block.contains("\"Type\":\"bind\"") && block.contains("\"RW\":true")
                        && block.contains("\"Source\":\"" + jsonEscape(expectedSource.toString()) + "\""))
                .isPresent();
    }

    private static String jsonEscape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static java.util.Optional<String> mountBlock(String mounts, String destination) {
        int marker = mounts.indexOf("\"Destination\":\"" + destination + "\"");
        if (marker < 0) return java.util.Optional.empty();
        int end = mounts.indexOf('}', marker);
        int start = mounts.lastIndexOf('{', marker);
        if (start < 0 || end < 0) return java.util.Optional.empty();
        return java.util.Optional.of(mounts.substring(start, end + 1));
    }

    private static int occurrenceCount(String value, String needle) {
        int count = 0;
        int offset = 0;
        while ((offset = value.indexOf(needle, offset)) >= 0) {
            count++;
            offset += needle.length();
        }
        return count;
    }

    private static CommandResult runAuxiliary(List<String> command, Duration timeout) throws IOException {
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        ByteArrayOutputStream captured = new ByteArrayOutputStream();
        Thread drain = new Thread(() -> drainLimited(process.getInputStream(), captured), "media-oci-supervisor-output");
        drain.setDaemon(true);
        drain.start();
        try {
            if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                process.destroyForcibly();
                process.waitFor(2, TimeUnit.SECONDS);
                throw new IOException("Trusted host OCI operation timed out");
            }
            drain.join(2_000);
            if (drain.isAlive()) throw new IOException("Trusted host OCI output did not close");
            synchronized (captured) {
                return new CommandResult(process.exitValue(), captured.toString(StandardCharsets.UTF_8));
            }
        } catch (InterruptedException interrupted) {
            process.destroyForcibly();
            Thread.currentThread().interrupt();
            throw new IOException("Trusted host OCI operation was interrupted", interrupted);
        }
    }

    private static void drainLimited(InputStream input, ByteArrayOutputStream captured) {
        byte[] buffer = new byte[1024];
        int total = 0;
        try (input) {
            int read;
            while ((read = input.read(buffer)) >= 0) {
                synchronized (captured) {
                    int remaining = AUXILIARY_OUTPUT_LIMIT - total;
                    if (remaining > 0) captured.write(buffer, 0, Math.min(read, remaining));
                    total += read;
                }
            }
        } catch (IOException ignored) { }
    }

    private static void removeContainer(String dockerCli, String containerId) throws IOException {
        CommandResult result = runAuxiliary(List.of(dockerCli, "rm", "--force", containerId), Duration.ofSeconds(5));
        if (result.exitCode() != 0) throw new IOException("Trusted host OCI worker cleanup failed");
    }

    private record CommandResult(int exitCode, String output) { }

    record LaunchPlan(String dockerCli, String containerName, List<String> createCommand,
            Path source, Path output, long uid, long gid, long memoryBytes,
            long cpuNanos, int pidLimit, String imageDigest) { }

    static final class Prepared implements AutoCloseable {
        private final LaunchPlan plan;
        private final String containerId;
        private boolean closed;

        private Prepared(LaunchPlan plan, String containerId) {
            this.plan = plan;
            this.containerId = containerId;
        }

        List<String> command() { return List.of(plan.dockerCli(), "start", "--attach", containerId); }

        /** Check the kernel-backed OOM observation before this one-shot container is removed. */
        boolean wasOomKilled() throws IOException {
            CommandResult result = runAuxiliary(List.of(plan.dockerCli(), "inspect",
                    "--format", "{{.State.OOMKilled}}", containerId), Duration.ofSeconds(10));
            if (result.exitCode() != 0 || (!result.output().trim().equals("true")
                    && !result.output().trim().equals("false"))) {
                throw new IOException("Vision OCI OOM observation is unavailable");
            }
            return result.output().trim().equals("true");
        }

        void killAll() {
            try { runAuxiliary(List.of(plan.dockerCli(), "kill", "--signal=KILL", containerId), Duration.ofSeconds(5)); }
            catch (IOException ignored) { }
        }

        @Override public void close() throws IOException {
            if (closed) return;
            removeContainer(plan.dockerCli(), containerId);
            closed = true;
        }
    }
}
