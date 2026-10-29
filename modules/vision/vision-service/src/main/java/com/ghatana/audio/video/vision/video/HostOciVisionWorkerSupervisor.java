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
import java.util.Map;
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
    private static final int FILE_DESCRIPTOR_LIMIT = 64;
    private static final long DEFAULT_OUTPUT_FILE_LIMIT = 512L * 1024 * 1024;
    private static final Pattern PINNED_IMAGE = Pattern.compile("(?:[^\\s,@]+@)?sha256:[a-f0-9]{64}");
    private static final Pattern CONTAINER_ID = Pattern.compile("[a-f0-9]{64}");
    private static final int AUXILIARY_OUTPUT_LIMIT = 8192;

    static final String BROKER_SOCKET_ENV = "GHATANA_MEDIA_VISION_OCI_BROKER_SOCKET";
    static final String BROKER_TOKEN_ENV = "GHATANA_MEDIA_VISION_OCI_BROKER_TOKEN_FILE";

    private HostOciVisionWorkerSupervisor() { }

    /**
     * True when the authenticated host/CRI broker is configured. Production Media
     * JVMs never touch the Docker socket or CLI directly — the broker owns the
     * engine relationship and enforces the sandbox server-side.
     */
    static boolean brokerConfigured() {
        String socket = System.getenv(BROKER_SOCKET_ENV);
        String token = System.getenv(BROKER_TOKEN_ENV);
        return socket != null && !socket.isBlank() && token != null && !token.isBlank();
    }

    /**
     * Runs one bounded codec worker entirely through the authenticated OCI broker.
     * The Media JVM neither invokes a Docker CLI nor holds an engine socket: it
     * describes the pinned-image worker launch and receives a truthful result.
     */
    static VideoFrameExtractor.ProcessResult runViaBroker(
            List<String> command, Path workspace, Path outputDirectory,
            Duration timeout, long maximumOutputBytes, int maxOutputChars) throws IOException {
        String image = System.getenv(IMAGE_ENV);
        if (image == null || image.isBlank()) {
            throw new IOException("Vision native media processing is unavailable: digest-pinned host OCI worker image is not configured");
        }
        LaunchPlan plan = plan(command, workspace, outputDirectory, image, "docker",
                null, null, UUID.randomUUID().toString(), Math.max(1L, Math.min(
                        maximumOutputBytes, DEFAULT_OUTPUT_FILE_LIMIT)));
        int imageIndex = plan.createCommand().indexOf(plan.imageDigest());
        List<String> workerArgs = imageIndex >= 0 && imageIndex + 1 < plan.createCommand().size()
                ? plan.createCommand().subList(imageIndex + 1, plan.createCommand().size())
                : List.of();
        String executable = Path.of(command.getFirst()).getFileName()
                .toString().toLowerCase(Locale.ROOT);
        MediaOciBrokerClient client = new MediaOciBrokerClient(
                Path.of(System.getenv(BROKER_SOCKET_ENV)),
                Path.of(System.getenv(BROKER_TOKEN_ENV)));
        MediaOciBroker.WorkerResult result = client.execute(new MediaOciBroker.WorkerLaunch(
                plan.imageDigest(), plan.containerName(), executable, workerArgs,
                plan.source() == null ? null : plan.source().toString(),
                plan.output() == null ? null : plan.output().toString(),
                plan.uid(), plan.gid(), plan.outputFileLimit(), timeout));
        String output = result.outputTail();
        if (maxOutputChars >= 0 && output.length() > maxOutputChars) {
            output = output.substring(output.length() - maxOutputChars);
        }
        return new VideoFrameExtractor.ProcessResult(
                result.timedOut() ? -1 : result.exitCode(), result.timedOut(),
                output, result.outputExceeded(), false);
    }

    static Prepared prepare(List<String> command, Path workspace, Path outputDirectory) throws IOException {
        return prepare(command, workspace, outputDirectory, DEFAULT_OUTPUT_FILE_LIMIT);
    }

    static Prepared prepare(
            List<String> command, Path workspace, Path outputDirectory, long maximumOutputBytes) throws IOException {
        String image = System.getenv(IMAGE_ENV);
        if (image == null || image.isBlank()) {
            throw new IOException("Vision native media processing is unavailable: digest-pinned host OCI worker image is not configured");
        }
        String docker = System.getenv(DOCKER_CLI_ENV);
        if (docker == null || docker.isBlank()) docker = "docker";
        long outputFileLimit = outputDirectory == null ? DEFAULT_OUTPUT_FILE_LIMIT
                : Math.max(1L, Math.min(maximumOutputBytes, DEFAULT_OUTPUT_FILE_LIMIT));
        LaunchPlan plan = plan(command, workspace, outputDirectory, image, docker,
                null, null, UUID.randomUUID().toString(), outputFileLimit);

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
                            plan.imageDigest(), plan.source(), plan.output(), plan.outputFileLimit())
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
        return plan(command, workspace, outputDirectory, image, dockerCli,
                expectedUid, expectedGid, invocationId, DEFAULT_OUTPUT_FILE_LIMIT);
    }

    static LaunchPlan plan(
            List<String> command,
            Path workspace,
            Path outputDirectory,
            String image,
            String dockerCli,
            Long expectedUid,
            Long expectedGid,
            String invocationId,
            long outputFileLimit) throws IOException {
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
        if (outputFileLimit <= 0) throw new IOException("Vision worker output file limit must be positive");
        if (output != null) {
            try (var entries = Files.list(output)) {
                if (entries.findAny().isPresent()) {
                    throw new IOException("Vision worker output directory must be empty before dispatch");
                }
            }
        }
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
                "--pids-limit=" + PID_LIMIT, "--ulimit=nofile=" + FILE_DESCRIPTOR_LIMIT + ":" + FILE_DESCRIPTOR_LIMIT,
                "--ulimit=fsize=" + outputFileLimit + ":" + outputFileLimit,
                "--network=none", "--read-only", "--cap-drop=ALL",
                "--security-opt=no-new-privileges:true", "--init", "--stop-timeout=2",
                "--tmpfs", "/tmp:rw,nosuid,nodev,exec,size=128m,nr_inodes=4096",
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
                MEMORY_BYTES, CPU_NANOS, PID_LIMIT, image, outputFileLimit);
    }

    private static Path locateSource(List<String> command, Path workspace, Path outputDirectory) throws IOException {
        if (isVersionProbe(command)) return null;
        if (workspace == null) throw new IOException("Vision worker source workspace is unavailable");
        if (Files.isSymbolicLink(workspace) || !Files.isDirectory(workspace, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Vision worker source workspace is unsafe");
        }
        Path root = workspace.toRealPath();
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
                    : outputDirectory.toRealPath();
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
        Path parent = absolute.getParent();
        // Resolve the parent chain so platform directory aliases (for example macOS
        // /var -> /private/var) compare equal to canonical workspace and output roots,
        // while an unresolvable or symlinked leaf keeps its own path identity.
        if (parent != null && Files.isDirectory(parent, LinkOption.NOFOLLOW_LINKS)) {
            return parent.toRealPath().resolve(absolute.getFileName()).normalize();
        }
        if (Files.exists(absolute, LinkOption.NOFOLLOW_LINKS)) {
            return absolute.toRealPath();
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
        Path real = absolute.toRealPath();
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
        return effectiveLimitsMatch(inspection, hasSourceMount, hasOutputMount, expectedUser,
                expectedEntrypoint, expectedImage, expectedSource, expectedOutput, DEFAULT_OUTPUT_FILE_LIMIT);
    }

    static boolean effectiveLimitsMatch(
            String inspection,
            boolean hasSourceMount,
            boolean hasOutputMount,
            String expectedUser,
            String expectedEntrypoint,
            String expectedImage,
            Path expectedSource,
            Path expectedOutput,
            long expectedOutputFileLimit) {
        return effectiveLimitMismatches(inspection, hasSourceMount, hasOutputMount, expectedUser,
                expectedEntrypoint, expectedImage, expectedSource, expectedOutput, expectedOutputFileLimit).isEmpty();
    }

    private static List<String> effectiveLimitMismatches(
            String inspection,
            boolean hasSourceMount,
            boolean hasOutputMount,
            String expectedUser,
            String expectedEntrypoint,
            String expectedImage,
            Path expectedSource,
            Path expectedOutput,
            long expectedOutputFileLimit) {
        if (inspection == null) return List.of("inspect");
        String[] inspected = inspection.split("\\|", 3);
        if (inspected.length != 3) return List.of("inspect-format");
        Map<String, Object> host;
        Map<String, Object> config;
        List<?> mounts;
        try {
            host = JsonObject.parse(inspected[0]);
            config = JsonObject.parse(inspected[1]);
            Object parsedMounts = JsonObject.parseValue(inspected[2]);
            mounts = parsedMounts instanceof List<?> list ? list : null;
        } catch (RuntimeException malformed) {
            return List.of("inspect-json");
        }
        if (host == null || config == null || mounts == null) return List.of("inspect-shape");
        java.util.ArrayList<String> mismatches = new java.util.ArrayList<>();
        requireMatch(mismatches, "memory", number(host, "Memory") == MEMORY_BYTES);
        requireMatch(mismatches, "swap", number(host, "MemorySwap") == MEMORY_BYTES);
        requireMatch(mismatches, "cpu", number(host, "NanoCpus") == CPU_NANOS);
        requireMatch(mismatches, "pids", number(host, "PidsLimit") == PID_LIMIT);
        requireMatch(mismatches, "resource-file-limits",
                ulimitsMatch(host.get("Ulimits"), expectedOutputFileLimit));
        requireMatch(mismatches, "network", "none".equals(string(host, "NetworkMode")));
        requireMatch(mismatches, "rootfs", Boolean.TRUE.equals(host.get("ReadonlyRootfs")));
        requireMatch(mismatches, "privileged", Boolean.FALSE.equals(host.get("Privileged")));
        requireMatch(mismatches, "capabilities", stringArrayEquals(host.get("CapDrop"), "ALL")
                && host.containsKey("CapAdd") && host.get("CapAdd") == null);
        requireMatch(mismatches, "devices", host.get("Devices") instanceof List<?> devices && devices.isEmpty()
                && host.containsKey("DeviceRequests") && host.get("DeviceRequests") == null);
        requireMatch(mismatches, "security-opt", stringArrayEquals(host.get("SecurityOpt"), "no-new-privileges:true"));
        Map<String, Object> tmpfs = object(host.get("Tmpfs"));
        requireMatch(mismatches, "tmpfs-temp", "rw,nosuid,nodev,exec,size=128m,nr_inodes=4096".equals(string(tmpfs, "/tmp")));
        requireMatch(mismatches, "tmpfs-output", !tmpfs.containsKey("/output"));
        requireMatch(mismatches, "ports", host.get("PortBindings") instanceof Map<?, ?> ports && ports.isEmpty()
                && Boolean.FALSE.equals(host.get("PublishAllPorts")));
        requireMatch(mismatches, "user", expectedUser.equals(string(config, "User")));
        requireMatch(mismatches, "entrypoint", stringArrayEquals(config.get("Entrypoint"), expectedEntrypoint));
        requireMatch(mismatches, "image", expectedImage.equals(string(config, "Image")));
        requireMatch(mismatches, "environment", workerEnvironmentMatches(config.get("Env")));
        requireMatch(mismatches, "socket", !mounts.toString().contains("/var/run/docker.sock"));
        int expectedMounts = (hasSourceMount ? 1 : 0) + (hasOutputMount ? 1 : 0);
        requireMatch(mismatches, "mount-count", mounts.size() == expectedMounts
                && host.get("Mounts") instanceof List<?> configuredMounts && configuredMounts.size() == expectedMounts);
        if (hasSourceMount) {
            requireMatch(mismatches, "source-readonly-config", configuredMountMatches(host.get("Mounts"),
                    "/source/input", expectedSource, true));
            requireMatch(mismatches, "source-readonly-runtime", runtimeMountMatches(mounts,
                    "/source/input", expectedSource, false));
        }
        if (hasOutputMount) {
            requireMatch(mismatches, "output-writable-config", configuredMountMatches(host.get("Mounts"),
                    "/output", expectedOutput, false));
            requireMatch(mismatches, "output-writable-runtime", runtimeMountMatches(mounts,
                    "/output", expectedOutput, true));
        }
        return List.copyOf(mismatches);
    }

    private static void requireMatch(List<String> mismatches, String name, boolean matches) {
        if (!matches) mismatches.add(name);
    }

    private static boolean workerEnvironmentMatches(Object environment) {
        if (!(environment instanceof List<?> values)) return false;
        java.util.Set<String> actual = new java.util.HashSet<>();
        values.forEach(value -> { if (value instanceof String text) actual.add(text); });
        return actual.equals(java.util.Set.of("HOME=/tmp", "TMPDIR=/tmp", "PATH=/usr/bin:/bin",
                "LANG=C.UTF-8", "LC_ALL=C.UTF-8"));
    }

    private static boolean stringArrayEquals(Object values, String expected) {
        return values instanceof List<?> list && list.size() == 1 && expected.equals(list.getFirst());
    }

    private static boolean ulimitsMatch(Object values, long expectedOutputFileLimit) {
        if (!(values instanceof List<?> list)) return false;
        boolean nofile = false;
        boolean fsize = false;
        for (Object entry : list) {
            Map<String, Object> value = object(entry);
            if ("nofile".equals(string(value, "Name"))) {
                nofile = number(value, "Soft") == FILE_DESCRIPTOR_LIMIT
                        && number(value, "Hard") == FILE_DESCRIPTOR_LIMIT;
            } else if ("fsize".equals(string(value, "Name"))) {
                fsize = number(value, "Soft") == expectedOutputFileLimit
                        && number(value, "Hard") == expectedOutputFileLimit;
            }
        }
        return nofile && fsize;
    }

    private static boolean configuredMountMatches(Object mounts, String destination, Path source, boolean readOnly) {
        if (!(mounts instanceof List<?> list)) return false;
        for (Object item : list) {
            Map<String, Object> mount = object(item);
            if (destination.equals(string(mount, "Target"))) {
                return "bind".equals(string(mount, "Type"))
                        && source.toString().equals(string(mount, "Source"))
                        // Docker omits HostConfig.Mounts[].ReadOnly for the default writable
                        // bind mount. Runtime .Mounts[].RW is checked separately and must be true.
                        && (readOnly ? Boolean.TRUE.equals(mount.get("ReadOnly"))
                                : !Boolean.TRUE.equals(mount.get("ReadOnly")));
            }
        }
        return false;
    }

    private static boolean runtimeMountMatches(List<?> mounts, String destination, Path source, boolean writable) {
        for (Object item : mounts) {
            Map<String, Object> mount = object(item);
            if (destination.equals(string(mount, "Destination"))) {
                return "bind".equals(string(mount, "Type"))
                        && source.toString().equals(string(mount, "Source"))
                        && Boolean.valueOf(writable).equals(mount.get("RW"));
            }
        }
        return false;
    }

    private static Map<String, Object> object(Object value) {
        if (!(value instanceof Map<?, ?> map)) return java.util.Map.of();
        java.util.Map<String, Object> result = new java.util.HashMap<>();
        map.forEach((key, item) -> { if (key instanceof String text) result.put(text, item); });
        return result;
    }

    private static String string(Map<String, Object> value, String key) {
        Object item = value.get(key);
        return item instanceof String text ? text : null;
    }

    private static long number(Map<String, Object> value, String key) {
        Object item = value.get(key);
        return item instanceof Number number ? number.longValue() : -1;
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

    /** Minimal strict JSON reader for trusted `docker inspect` values, retaining typed fields. */
    private static final class JsonObject {
        private final String source;
        private int offset;

        private JsonObject(String source) { this.source = source; }

        static Map<String, Object> parse(String source) {
            Object value = parseValue(source);
            if (!(value instanceof Map<?, ?> map)) throw new IllegalArgumentException("JSON object required");
            return object(map);
        }

        static Object parseValue(String source) {
            JsonObject parser = new JsonObject(source);
            Object value = parser.value();
            parser.space();
            if (parser.offset != source.length()) throw new IllegalArgumentException("Trailing JSON data");
            return value;
        }

        private Object value() {
            space();
            if (offset >= source.length()) throw new IllegalArgumentException("Missing JSON value");
            return switch (source.charAt(offset)) {
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
            space();
            Map<String, Object> result = new java.util.LinkedHashMap<>();
            if (take('}')) return result;
            do {
                space();
                String key = stringValue();
                space();
                require(':');
                if (result.containsKey(key)) throw new IllegalArgumentException("Duplicate JSON field");
                result.put(key, value());
                space();
                if (take('}')) return result;
                require(',');
            } while (true);
        }

        private List<Object> arrayValue() {
            offset++;
            space();
            List<Object> result = new ArrayList<>();
            if (take(']')) return result;
            do {
                result.add(value());
                space();
                if (take(']')) return result;
                require(',');
            } while (true);
        }

        private String stringValue() {
            require('"');
            StringBuilder result = new StringBuilder();
            while (offset < source.length()) {
                char value = source.charAt(offset++);
                if (value == '"') return result.toString();
                if (value < 0x20) throw new IllegalArgumentException("Control character in JSON string");
                if (value != '\\') {
                    result.append(value);
                    continue;
                }
                if (offset >= source.length()) throw new IllegalArgumentException("Invalid JSON escape");
                char escape = source.charAt(offset++);
                switch (escape) {
                    case '"', '\\', '/' -> result.append(escape);
                    case 'b' -> result.append('\b');
                    case 'f' -> result.append('\f');
                    case 'n' -> result.append('\n');
                    case 'r' -> result.append('\r');
                    case 't' -> result.append('\t');
                    case 'u' -> {
                        if (offset + 4 > source.length()) throw new IllegalArgumentException("Invalid unicode escape");
                        result.append((char) Integer.parseInt(source.substring(offset, offset + 4), 16));
                        offset += 4;
                    }
                    default -> throw new IllegalArgumentException("Invalid JSON escape");
                }
            }
            throw new IllegalArgumentException("Unclosed JSON string");
        }

        private Object numberValue() {
            int start = offset;
            while (offset < source.length() && "-+0123456789.eE".indexOf(source.charAt(offset)) >= 0) offset++;
            if (start == offset) throw new IllegalArgumentException("Invalid JSON number");
            String value = source.substring(start, offset);
            if (!value.matches("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?")) {
                throw new IllegalArgumentException("Invalid JSON number");
            }
            if (value.indexOf('.') >= 0 || value.indexOf('e') >= 0 || value.indexOf('E') >= 0) {
                return Double.parseDouble(value);
            }
            return Long.parseLong(value);
        }

        private Object literal(String text, Object value) {
            if (!source.startsWith(text, offset)) throw new IllegalArgumentException("Invalid JSON literal");
            offset += text.length();
            return value;
        }

        private void space() {
            while (offset < source.length() && Character.isWhitespace(source.charAt(offset))) offset++;
        }

        private boolean take(char expected) {
            if (offset < source.length() && source.charAt(offset) == expected) {
                offset++;
                return true;
            }
            return false;
        }

        private void require(char expected) {
            if (!take(expected)) throw new IllegalArgumentException("Malformed JSON structure");
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
            long cpuNanos, int pidLimit, String imageDigest, long outputFileLimit) { }

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
