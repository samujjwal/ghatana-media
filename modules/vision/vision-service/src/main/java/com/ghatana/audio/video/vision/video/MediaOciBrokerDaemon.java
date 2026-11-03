package com.ghatana.audio.video.vision.video;

import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardOpenOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.function.LongSupplier;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.Semaphore;
import java.util.regex.Pattern;
import jdk.net.ExtendedSocketOptions;
import jdk.net.UnixDomainPrincipal;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Narrow authenticated host/CRI broker for production OCI vision workers.
 *
 * <p>This is a separate privileged helper process — the Media JVM never holds the
 * Docker socket or CLI. It listens on a broker-owned, peer-group-only Unix domain socket and
 * accepts a single bounded operation: launch one sandboxed worker against a
 * digest-pinned image. Every request must carry an HMAC-SHA256 proof over the
 * request body under a shared broker token supplied via a 0600 file; the token
 * itself never crosses the socket.
 *
 * <p>The broker enforces the sandbox server-side: network=none, read-only root
 * fs, no capabilities, unprivileged uid, cgroup memory/CPU/PID/fd ceilings,
 * exactly one read-only source snapshot mount and a read-only probe path, entrypoint
 * restricted to ffmpeg/ffprobe inside the pinned image. Writable output mounts are
 * rejected until an authenticated bounded return path preserves Media ownership.
 * Callers cannot widen any admitted operation — only the executable name, bounded
 * arguments, bounded output ceiling and source file are request fields.
 */
public final class MediaOciBrokerDaemon {

    private static final Pattern IMAGE = Pattern.compile("(?:[^\\s,@]+@)?sha256:[a-f0-9]{64}");
    private static final Pattern NAME = Pattern.compile("[a-z0-9][a-z0-9_.-]{0,127}");
    private static final Pattern EXECUTABLE = Pattern.compile("ffmpeg|ffprobe");
    private static final Pattern CONTAINER_ID = Pattern.compile("[a-f0-9]{64}");
    private static final long MEMORY_BYTES = 1_610_612_736L;
    private static final long CPU_NANOS = 2_000_000_000L;
    private static final int PID_LIMIT = 32;
    private static final int FD_LIMIT = 64;
    private static final long OUTPUT_FILE_LIMIT = 512L * 1024 * 1024;
    private static final int MAX_ARGS = 64;
    private static final int MAX_FFMPEG_REQUEST_BYTES = 64 * 1024;
    private static final int MAX_REQUEST_BYTES = 8 * 1024 * 1024;
    private static final Duration READ_DEADLINE = Duration.ofSeconds(10);
    private static final int OUTPUT_TAIL = 8192;
    private static final int MAX_CAPTURED_OUTPUT_CHARS = 1_000_000;
    /** Preserve the broker's previous serialized native-worker admission across modalities. */
    private static final Semaphore WORKER_ADMISSION = new Semaphore(1);

    private MediaOciBrokerDaemon() { }

    public static void main(String[] args) throws Exception {
        String socketPath = System.getenv("MEDIA_OCI_BROKER_SOCKET");
        String tokenFile = System.getenv("MEDIA_OCI_BROKER_TOKEN_FILE");
        String sourceRoot = System.getenv("MEDIA_OCI_BROKER_SOURCE_ROOT");
        String outputRoot = System.getenv("MEDIA_OCI_BROKER_OUTPUT_ROOT");
        String stageRoot = System.getenv("MEDIA_OCI_BROKER_STAGE_ROOT");
        String allowlist = System.getenv("MEDIA_OCI_BROKER_IMAGE_ALLOWLIST");
        String workerUid = System.getenv("MEDIA_OCI_BROKER_WORKER_UID");
        String workerGid = System.getenv("MEDIA_OCI_BROKER_WORKER_GID");
        String allowedPeerUser = System.getenv("MEDIA_OCI_BROKER_ALLOWED_PEER_USER");
        String allowedPeerGidText = System.getenv("MEDIA_OCI_BROKER_ALLOWED_PEER_GID");
        String docker = System.getenv().getOrDefault("MEDIA_OCI_BROKER_DOCKER_CLI", "docker");
        if (blank(socketPath) || blank(tokenFile) || blank(sourceRoot) || blank(outputRoot) || blank(stageRoot)
                || blank(allowlist) || blank(workerUid) || blank(workerGid) || !validPeerUsername(allowedPeerUser)
                || blank(allowedPeerGidText)) {
            System.err.println("MEDIA_OCI_BROKER_SOCKET, _TOKEN_FILE, _SOURCE_ROOT, _OUTPUT_ROOT, _STAGE_ROOT,"
                    + " _IMAGE_ALLOWLIST, _WORKER_UID, _WORKER_GID, _ALLOWED_PEER_USER and _ALLOWED_PEER_GID are required");
            System.exit(2);
        }
        long allowedPeerGid;
        try {
            allowedPeerGid = parseAllowedPeerGid(allowedPeerGidText);
        } catch (IllegalArgumentException invalid) {
            System.err.println(invalid.getMessage());
            System.exit(2);
            return;
        }
        Path socket = Path.of(socketPath).toAbsolutePath().normalize();
        Path tokenPath = Path.of(tokenFile);
        // The credential file must be owner-only; group/other readers make the HMAC
        // proof forgeable, so the broker refuses to start.
        if (!MediaOciBrokerPolicy.ownerOnlyFile(tokenPath)
                || Files.isSymbolicLink(tokenPath)
                || !Files.isRegularFile(tokenPath, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            System.err.println("Broker token file must have 0600 owner-only permissions");
            System.exit(2);
        }
        String token = Files.readString(tokenPath).trim();
        if (token.length() < 32) {
            System.err.println("Broker token must be at least 32 bytes");
            System.exit(2);
        }
        String brokerOsUser = currentOsUserName();
        if (!Files.getOwner(tokenPath, java.nio.file.LinkOption.NOFOLLOW_LINKS).getName().equals(brokerOsUser)) {
            System.err.println("Broker token file must be owned by the broker OS identity");
            System.exit(2);
        }
        if (!distinctOsUsers(brokerOsUser, allowedPeerUser)) {
            System.err.println("Broker OS identity must differ from the allowed Media peer identity");
            System.exit(2);
        }
        Path socketParent = validateSocketParent(socket, brokerOsUser, allowedPeerGid);
        java.util.Set<String> images = new java.util.HashSet<>();
        for (String entry : allowlist.split(",")) {
            String digest = entry.trim();
            if (IMAGE.matcher(digest).matches()) images.add(digest);
        }
        if (images.isEmpty()) {
            System.err.println("Broker image allowlist must contain at least one digest-pinned image");
            System.exit(2);
        }
        long uid;
        long gid;
        try {
            uid = Long.parseLong(workerUid);
            gid = Long.parseLong(workerGid);
        } catch (NumberFormatException invalid) {
            System.err.println("Broker worker uid/gid must be numeric");
            System.exit(2);
            return;
        }
        if (uid <= 0 || gid < 0 || uid > Integer.MAX_VALUE || gid > Integer.MAX_VALUE) {
            System.err.println("Broker worker uid must be positive and unprivileged");
            System.exit(2);
        }
        if (!workerUsesPeerGroup(gid, allowedPeerGid)) {
            System.err.println("MEDIA_OCI_BROKER_WORKER_GID must equal the configured allowed peer/shared GID");
            System.exit(2);
        }
        Path sourceReal = Path.of(sourceRoot).toRealPath();
        Path outputReal = Path.of(outputRoot).toRealPath();
        Path stageReal = validateStageRoot(Path.of(stageRoot), sourceReal, outputReal, brokerOsUser, allowedPeerUser);
        if (!stageOwnerDistinctFromPeer(stageReal, allowedPeerUser)) {
            System.err.println("Broker OS identity must differ from the allowed Media peer identity");
            System.exit(2);
        }
        Path nonceStateRoot = MediaOciBrokerNonceJournal.validateStateDirectory(
                tokenPath.toAbsolutePath().getParent(), brokerOsUser, allowedPeerUser,
                sourceReal, outputReal, stageReal);
        requireDisjointSocketParent(socketParent, nonceStateRoot, sourceReal, outputReal, stageReal);
        MediaOciBrokerNonceJournal nonceJournal = MediaOciBrokerNonceJournal.open(
                nonceStateRoot, token, brokerOsUser, allowedPeerUser,
                sourceReal, outputReal, stageReal);
        MediaOciBrokerPolicy.Policy policy = new MediaOciBrokerPolicy.Policy(
                java.util.Set.copyOf(images), uid, gid,
                sourceReal, outputReal, stageReal,
                MediaOciBrokerPolicy.loadWhisperProfile(System.getenv(), java.util.Set.copyOf(images)).orElse(null),
                WhisperWorkerServerConfig.load(System.getenv(), java.util.Set.copyOf(images)).orElse(null),
                MediaOciBrokerPolicy.loadVisionProfile(System.getenv(), java.util.Set.copyOf(images)).orElse(null));
        WhisperOciWorkerSupervisor whisperSupervisor = null;
        MediaOciBrokerWhisperJournal whisperJournal = null;
        if (policy.whisperWorkerConfig() != null) {
            WhisperOciWorkerSupervisor.Startup whisperStartup = WhisperOciWorkerSupervisor.start(
                    docker, uid, gid, policy.whisperWorkerConfig(), token,
                    new WhisperOciWorkerSupervisor.ProcessBuilderCommandRunner());
            if (whisperStartup.admitted()) {
                whisperJournal = whisperStartup.journal();
                whisperSupervisor = whisperStartup.supervisor();
            } else {
                System.err.println("Whisper worker not admitted: orphan cleanup or journal recovery unavailable");
            }
        }
        MediaOciBrokerPolicy.NonceReplayGuard nonces =
                new MediaOciBrokerPolicy.NonceReplayGuard(nonceJournal);
        removeStaleSocket(socket, brokerOsUser, allowedPeerGid);
        ThreadPoolExecutor requests = new ThreadPoolExecutor(8, 8, 0, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(32), task -> {
                    Thread thread = new Thread(task, "media-oci-broker-request");
                    thread.setDaemon(true);
                    return thread;
                }, new ThreadPoolExecutor.AbortPolicy());
        WhisperOciWorkerSupervisor finalWhisperSupervisor = whisperSupervisor;
        MediaOciBrokerWhisperJournal finalWhisperJournal = whisperJournal;
        MediaOciBrokerNonceJournal finalNonceJournal = nonceJournal;
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            requests.shutdown();
            if (finalWhisperSupervisor != null) {
                try { finalWhisperSupervisor.close(); }
                catch (IOException shutdownFailure) {
                    System.err.println("Whisper worker shutdown cleanup remains unknown");
                }
            }
            try {
                if (!requests.awaitTermination(20, TimeUnit.SECONDS)) requests.shutdownNow();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                requests.shutdownNow();
            }
            if (finalWhisperJournal != null) {
                try { finalWhisperJournal.close(); } catch (IOException ignored) { }
            }
            try { finalNonceJournal.close(); }
            catch (IOException ignored) { System.err.println("Broker nonce replay journal close failed"); }
        }, "media-oci-broker-shutdown"));
        try (ServerSocketChannel server = ServerSocketChannel.open(
                java.net.StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(socket));
            Files.setPosixFilePermissions(socket, PosixFilePermissions.fromString("rw-rw----"));
            validateBoundSocket(socket, brokerOsUser, allowedPeerGid);
            System.err.println("Media OCI broker listening on " + socket);
            while (true) {
                SocketChannel accepted = server.accept();
                try {
                    requests.execute(() -> {
                        try (SocketChannel client = accepted) {
                            handle(client, token, docker, policy, nonces, allowedPeerUser,
                                    MediaOciBrokerDaemon::readPeerUsername, finalWhisperSupervisor);
                        } catch (Exception failure) {
                            System.err.println("broker request failed: " + failure.getClass().getSimpleName());
                        }
                    });
                } catch (RejectedExecutionException saturated) {
                    accepted.close();
                }
            }
        }
    }

    static void handle(SocketChannel client, String token, String docker,
            MediaOciBrokerPolicy.Policy policy, MediaOciBrokerPolicy.NonceReplayGuard nonces,
            String allowedPeerUser)
            throws Exception {
        handle(client, token, docker, policy, nonces, allowedPeerUser,
                MediaOciBrokerDaemon::readPeerUsername, null);
    }

    static void handle(SocketChannel client, String token, String docker,
            MediaOciBrokerPolicy.Policy policy, MediaOciBrokerPolicy.NonceReplayGuard nonces,
            String allowedPeerUser, PeerCredentialsReader credentialsReader)
            throws Exception {
        handle(client, token, docker, policy, nonces, allowedPeerUser, credentialsReader, null);
    }

    static void handle(SocketChannel client, String token, String docker,
            MediaOciBrokerPolicy.Policy policy, MediaOciBrokerPolicy.NonceReplayGuard nonces,
            String allowedPeerUser, PeerCredentialsReader credentialsReader,
            WhisperOciWorkerSupervisor whisperSupervisor) throws Exception {
        handle(client, token, docker, policy, nonces, allowedPeerUser, credentialsReader,
                whisperSupervisor, System::currentTimeMillis);
    }

    static void handle(SocketChannel client, String token, String docker,
            MediaOciBrokerPolicy.Policy policy, MediaOciBrokerPolicy.NonceReplayGuard nonces,
            String allowedPeerUser, PeerCredentialsReader credentialsReader,
            WhisperOciWorkerSupervisor whisperSupervisor, LongSupplier wallClockMillis) throws Exception {
        if (!peerUserAllowed(client, allowedPeerUser, credentialsReader)) {
            writeResult(client, -1, "unauthenticated");
            return;
        }
        byte[] body = readFrame(client, MAX_REQUEST_BYTES,
                System.nanoTime() + READ_DEADLINE.toNanos());
        if (body == null) { writeResult(client, -1, "unauthenticated"); return; }
        String request = new String(body, StandardCharsets.UTF_8);
        String expected = field(request, "proof");
        String nonce = field(request, "nonce");
        long issuedAt = number(request, "ts", -1, -1, Long.MAX_VALUE);
        String payload = object(request, "payload");
        if (expected == null || nonce == null || payload == null || issuedAt < 0
                || nonce.length() < 16 || nonce.length() > 128) {
            writeResult(client, -1, "unauthenticated"); return;
        }
        if (!MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                hmac(token, nonce + "\n" + issuedAt + "\n" + payload)
                        .getBytes(StandardCharsets.UTF_8))) {
            writeResult(client, -1, "unauthenticated"); return;
        }
        if (!nonces.admit(nonce, issuedAt, wallClockMillis.getAsLong())) {
            writeResult(client, -1, "unauthenticated"); return;
        }
        String operation = field(payload, "op");
        if (operation != null && operation.startsWith("WHISPER_")) {
            handleWhisper(client, token, nonce, issuedAt, operation, payload, policy,
                    whisperSupervisor, wallClockMillis);
            return;
        }
        if (body.length > MAX_FFMPEG_REQUEST_BYTES) {
            writeResult(client, -2, "rejected");
            return;
        }
        String image = field(payload, "image");
        String name = field(payload, "name");
        String executable = field(payload, "executable");
        String source = field(payload, "source");
        String sourceSha256 = field(payload, "sourceSha256");
        String output = field(payload, "output");
        List<String> workerArgs = array(payload, "args");
        long timeout = number(payload, "timeoutMs", 60_000, 1_000, 900_000);
        long outLimit = number(payload, "outputLimit", OUTPUT_FILE_LIMIT, 1, OUTPUT_FILE_LIMIT);
        long uid = number(payload, "uid", 0, 1, Integer.MAX_VALUE);
        long gid = number(payload, "gid", 0, 0, Integer.MAX_VALUE);
        if (!writableOutputTransferAdmitted(output)) {
            writeResult(client, -2, "writable output transfer is not admitted");
            return;
        }
        if (image == null || !IMAGE.matcher(image).matches()
                || !MediaOciBrokerPolicy.visionImageAllowed(policy, image)
                || name == null || !NAME.matcher(name).matches()
                || executable == null || !EXECUTABLE.matcher(executable).matches()
                || uid <= 0 || workerArgs.size() > MAX_ARGS
                || !MediaOciBrokerPolicy.workerIdentityAllowed(policy, uid, gid)
                || !MediaOciBrokerPolicy.sourceAllowed(policy, source, sourceSha256)
                || !MediaOciBrokerPolicy.outputAllowed(policy, output)) {
            writeResult(client, -2, "rejected"); return;
        }
        boolean versionProbe = isVersionProbe(workerArgs);
        if (!sourceProbePairValid(source, workerArgs)
                || (!MediaOciBrokerPolicy.workerArgsAllowed(executable, workerArgs) && !versionProbe)) {
            writeResult(client, -2, "rejected"); return;
        }
        Path sourcePath = source == null ? null : Path.of(source).toRealPath();
        Path outputPath = output == null ? null : Path.of(output).toRealPath();
        if (!WORKER_ADMISSION.tryAcquire()) {
            writeResult(client, -2, "worker capacity exhausted");
            return;
        }
        try {
            String result;
            if (sourcePath == null) result = runWorker(docker, image, name, executable, workerArgs,
                    null, outputPath, policy.workerUid(), policy.workerGid(), Duration.ofMillis(timeout), outLimit);
            else result = runWorkerWithSnapshot(docker, image, name, executable, workerArgs,
                    sourcePath, sourceSha256, policy.stageRoot(), outputPath, policy.workerUid(), policy.workerGid(),
                    Duration.ofMillis(timeout), outLimit);
            writeResult(client, 0, result);
        } finally {
            WORKER_ADMISSION.release();
        }
    }

    static boolean isVersionProbe(List<String> args) {
        return args != null && args.equals(List.of("-version"));
    }

    static boolean sourceProbePairValid(String source, List<String> args) {
        return source == null ? isVersionProbe(args) : isSourceReadProbe(args);
    }

    static boolean isSourceReadProbe(List<String> args) {
        return args != null && args.equals(List.of("-nostdin", "-protocol_whitelist", "file", "-i",
                "/source/input", "-f", "null", "-"));
    }

    /** The current bounded JSON reply cannot return worker output under Media ownership. */
    static boolean writableOutputTransferAdmitted(String output) {
        return output == null;
    }

    static Path validateStageRoot(Path configured, Path sourceRoot, Path outputRoot) throws IOException {
        return validateStageRoot(configured, sourceRoot, outputRoot, currentOsUserName(), null);
    }

    static Path validateStageRoot(Path configured, Path sourceRoot, Path outputRoot,
            String brokerOsUser, String allowedPeerUser) throws IOException {
        if (Files.isSymbolicLink(configured) || !Files.isDirectory(configured, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Broker snapshot stage root must be a real directory");
        }
        Path stage = configured.toRealPath();
        if (!safeDockerPath(stage)) throw new IOException("Broker stage root path is not Docker-mount safe");
        if (!Files.getOwner(stage).getName().equals(brokerOsUser)) {
            throw new IOException("Broker snapshot stage root must be owned by the broker OS identity");
        }
        if (stage.startsWith(sourceRoot) || sourceRoot.startsWith(stage)
                || stage.startsWith(outputRoot) || outputRoot.startsWith(stage)) {
            throw new IOException("Broker snapshot stage root must not overlap source/output roots");
        }
        try {
            var permissions = Files.getPosixFilePermissions(stage);
            if (!permissions.equals(PosixFilePermissions.fromString("rwx------"))) {
                throw new IOException("Broker snapshot stage root must be owner-only (0700)");
            }
        } catch (UnsupportedOperationException unsupported) {
            throw new IOException("Broker snapshot stage root requires POSIX owner-only permissions", unsupported);
        }
        validateStageAncestors(stage, brokerOsUser, allowedPeerUser);
        requireEmptyStageRoot(stage);
        return stage;
    }

    static String currentOsUserName() {
        return ProcessHandle.current().info().user().orElse("");
    }

    static long parseAllowedPeerGid(String value) {
        if (value == null || !value.matches("[1-9][0-9]{0,9}")) {
            throw new IllegalArgumentException("Allowed peer GID must be a positive numeric group ID");
        }
        long gid;
        try {
            gid = Long.parseLong(value);
        } catch (NumberFormatException invalid) {
            throw new IllegalArgumentException("Allowed peer GID is outside the supported range", invalid);
        }
        if (gid > Integer.MAX_VALUE) {
            throw new IllegalArgumentException("Allowed peer GID is outside the supported range");
        }
        return gid;
    }

    static boolean workerUsesPeerGroup(long workerGid, long allowedPeerGid) {
        return workerGid > 0 && workerGid <= Integer.MAX_VALUE && workerGid == allowedPeerGid;
    }

    static Path validateSocketParent(Path socket, String brokerOsUser, long allowedPeerGid) throws IOException {
        if (socket == null || brokerOsUser == null || brokerOsUser.isBlank()
                || allowedPeerGid <= 0 || allowedPeerGid > Integer.MAX_VALUE) {
            throw new IOException("Broker socket parent identity configuration is invalid");
        }
        Path absolute = socket.toAbsolutePath().normalize();
        Path parent = absolute.getParent();
        if (parent == null || Files.isSymbolicLink(parent)
                || !Files.isDirectory(parent, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Broker socket parent must be an existing real directory");
        }
        // Resolve safe host aliases such as macOS /var -> /private/var after
        // rejecting a symlink at the configured parent itself.
        Path canonical = parent.toRealPath();
        if (!Files.getOwner(canonical, java.nio.file.LinkOption.NOFOLLOW_LINKS).getName().equals(brokerOsUser)) {
            throw new IOException("Broker socket parent must be owned by the broker OS identity");
        }
        long groupId = unixId(canonical, "gid");
        int mode = unixMode(canonical);
        if (groupId != allowedPeerGid || (mode & 07777) != 02710) {
            throw new IOException("Broker socket parent must be broker-owned, peer-group-owned, and mode 02710");
        }
        return canonical;
    }

    static void validateBoundSocket(Path socket, String brokerOsUser, long allowedPeerGid) throws IOException {
        if (socket == null || brokerOsUser == null || brokerOsUser.isBlank()
                || allowedPeerGid <= 0 || allowedPeerGid > Integer.MAX_VALUE) {
            throw new IOException("Broker socket identity configuration is invalid");
        }
        if (Files.isSymbolicLink(socket) || (unixMode(socket) & 0170000) != 0140000) {
            throw new IOException("Broker endpoint must be a Unix domain socket");
        }
        if (!Files.getOwner(socket, java.nio.file.LinkOption.NOFOLLOW_LINKS).getName().equals(brokerOsUser)
                || unixId(socket, "gid") != allowedPeerGid || (unixMode(socket) & 0777) != 0660) {
            throw new IOException("Broker socket must be broker-owned, use the configured peer group, and have mode 0660");
        }
    }

    private static void removeStaleSocket(Path socket, String brokerOsUser, long allowedPeerGid) throws IOException {
        if (!Files.exists(socket, java.nio.file.LinkOption.NOFOLLOW_LINKS)) return;
        // Never clear an unexpected path in the broker-owned socket directory. An
        // operator must reconcile stale sockets whose identity/permissions drifted.
        validateBoundSocket(socket, brokerOsUser, allowedPeerGid);
        Files.delete(socket);
    }

    private static void requireDisjointSocketParent(Path socketParent, Path... protectedRoots) throws IOException {
        for (Path protectedRoot : protectedRoots) {
            Path real = protectedRoot.toRealPath(java.nio.file.LinkOption.NOFOLLOW_LINKS);
            if (socketParent.startsWith(real) || real.startsWith(socketParent)) {
                throw new IOException("Broker socket parent must be separate from token, source, output and stage roots");
            }
        }
    }

    private static long unixId(Path path, String attribute) throws IOException {
        Object value = Files.getAttribute(path, "unix:" + attribute, java.nio.file.LinkOption.NOFOLLOW_LINKS);
        if (!(value instanceof Number number)) throw new IOException("Broker host requires POSIX unix:" + attribute);
        return number.longValue();
    }

    private static int unixMode(Path path) throws IOException {
        Object value = Files.getAttribute(path, "unix:mode", java.nio.file.LinkOption.NOFOLLOW_LINKS);
        if (!(value instanceof Number number)) throw new IOException("Broker host requires POSIX unix:mode");
        return number.intValue();
    }

    static boolean distinctOsUsers(String brokerOsUser, String allowedPeerUser) {
        return brokerOsUser != null && !brokerOsUser.isBlank()
                && allowedPeerUser != null && !allowedPeerUser.isBlank()
                && !brokerOsUser.equals(allowedPeerUser);
    }

    /** Compare filesystem principals (which preserve Unix UID identity), not caller-set JVM labels. */
    static boolean stageOwnerDistinctFromPeer(Path stageRoot, String allowedPeerUser) throws IOException {
        var brokerPrincipal = Files.getOwner(stageRoot, java.nio.file.LinkOption.NOFOLLOW_LINKS);
        var lookup = stageRoot.getFileSystem().getUserPrincipalLookupService();
        var peerPrincipal = lookup.lookupPrincipalByName(allowedPeerUser);
        var rootPrincipal = lookup.lookupPrincipalByName("root");
        return !brokerPrincipal.equals(peerPrincipal) && !peerPrincipal.equals(rootPrincipal);
    }

    private static void validateStageAncestors(Path stage, String brokerOsUser, String allowedPeerUser)
            throws IOException {
        for (Path ancestor = stage.getParent(); ancestor != null; ancestor = ancestor.getParent()) {
            String owner = Files.getOwner(ancestor, java.nio.file.LinkOption.NOFOLLOW_LINKS).getName();
            if (!owner.equals(brokerOsUser) && !owner.equals("root")) {
                throw new IOException("Broker stage-root ancestors must be owned by the broker or root");
            }
            java.util.Set<java.nio.file.attribute.PosixFilePermission> permissions;
            try {
                permissions = Files.getPosixFilePermissions(ancestor, java.nio.file.LinkOption.NOFOLLOW_LINKS);
            } catch (UnsupportedOperationException unsupported) {
                throw new IOException("Broker stage-root ancestors require POSIX permissions", unsupported);
            }
            boolean sharedWrite = permissions.contains(java.nio.file.attribute.PosixFilePermission.GROUP_WRITE)
                    || permissions.contains(java.nio.file.attribute.PosixFilePermission.OTHERS_WRITE);
            boolean sticky = false;
            if (sharedWrite) {
                try {
                    Object mode = Files.getAttribute(ancestor, "unix:mode", java.nio.file.LinkOption.NOFOLLOW_LINKS);
                    sticky = mode instanceof Number numeric && (numeric.intValue() & 01000) != 0;
                } catch (UnsupportedOperationException | IllegalArgumentException unsupported) {
                    throw new IOException("Cannot verify sticky bit on a writable stage-root ancestor", unsupported);
                }
            }
            if (sharedWrite && !sticky) {
                throw new IOException("Writable broker stage-root ancestors must be sticky directories");
            }
            if (allowedPeerUser != null && owner.equals(allowedPeerUser)
                    && permissions.contains(java.nio.file.attribute.PosixFilePermission.OWNER_WRITE)) {
                throw new IOException("Allowed peer must not be able to rename the broker stage root");
            }
        }
    }

    private static void requireEmptyStageRoot(Path stageRoot) throws IOException {
        try (var entries = Files.list(stageRoot)) {
            if (entries.findAny().isPresent()) {
                throw new IOException("Broker stage root contains retained snapshots; reconcile them before reuse");
            }
        }
    }

    static Path stageSnapshot(Path source, String expectedSha256, Path stageRoot) throws IOException {
        return stageSnapshot(source, expectedSha256, stageRoot, MediaOciBrokerPolicy::sha256File);
    }

    @FunctionalInterface
    interface SnapshotDigestReader {
        String digest(Path path) throws IOException;
    }

    static Path stageSnapshot(Path source, String expectedSha256, Path stageRoot,
            SnapshotDigestReader digestReader) throws IOException {
        requireEmptyStageRoot(stageRoot);
        Path destination = stageRoot.resolve(UUID.randomUUID() + ".media");
        try {
            long copied = 0;
            try (InputStream input = Files.newInputStream(source);
                 var output = Files.newOutputStream(destination, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                Files.setPosixFilePermissions(destination, PosixFilePermissions.fromString("r--r--r--"));
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    copied += count;
                    if (copied > MediaOciBrokerPolicy.MAX_VISION_SOURCE_BYTES)
                        throw new IOException("Vision source exceeds snapshot byte limit");
                    output.write(buffer, 0, count);
                }
            }
            String actual = digestReader.digest(destination);
            if (copied == 0 || !MessageDigest.isEqual(actual.getBytes(StandardCharsets.US_ASCII),
                    expectedSha256.getBytes(StandardCharsets.US_ASCII))) {
                throw new IOException("Vision source snapshot digest mismatch");
            }
            return destination;
        } catch (IOException | RuntimeException | Error failure) {
            try {
                Files.deleteIfExists(destination);
            } catch (IOException | RuntimeException | Error cleanupFailure) {
                failure.addSuppressed(cleanupFailure);
            }
            throw failure;
        }
    }

    static String runWorkerWithSnapshot(String docker, String image, String name, String executable,
            List<String> workerArgs, Path source, String sourceSha256, Path stageRoot, Path output,
            long uid, long gid, Duration timeout, long outputLimit) throws IOException {
        return runWorkerWithSnapshot(docker, image, name, executable, workerArgs, source, sourceSha256,
                stageRoot, output, uid, gid, timeout, outputLimit, MediaOciBrokerDaemon::run);
    }

    static String runWorkerWithSnapshot(String docker, String image, String name, String executable,
            List<String> workerArgs, Path source, String sourceSha256, Path stageRoot, Path output,
            long uid, long gid, Duration timeout, long outputLimit, WorkerCommandRunner runner) throws IOException {
        Path snapshot = stageSnapshot(source, sourceSha256, stageRoot);
        boolean[] removalConfirmed = {false};
        WorkerCommandRunner trackingRunner = (command, commandTimeout) -> {
            CommandResult result = runner.run(command, commandTimeout);
            if (command.size() > 2 && command.get(1).equals("rm")
                    && !result.timedOut() && result.exitCode() == 0) removalConfirmed[0] = true;
            return result;
        };
        try {
            String result = runWorker(docker, image, name, executable, workerArgs, snapshot, output,
                    uid, gid, timeout, outputLimit, trackingRunner);
            Files.delete(snapshot); // runWorker returns only after a confirmed container removal.
            return result;
        } catch (IOException unknownCleanupOrWorkerFailure) {
            if (removalConfirmed[0]) Files.deleteIfExists(snapshot);
            else System.err.println("Vision snapshot retained for operator reconciliation because worker removal is unknown: "
                    + snapshot.getFileName());
            throw unknownCleanupOrWorkerFailure;
        }
    }


    @FunctionalInterface
    interface PeerCredentialsReader {
        String username(SocketChannel channel) throws IOException;
    }

    static boolean peerUserAllowed(SocketChannel channel, String expectedUsername) {
        return peerUserAllowed(channel, expectedUsername, MediaOciBrokerDaemon::readPeerUsername);
    }

    static boolean peerUserAllowed(SocketChannel channel, String expectedUsername,
                                   PeerCredentialsReader credentialsReader) {
        if (channel == null || !validPeerUsername(expectedUsername)
                || credentialsReader == null) return false;
        try {
            String actual = credentialsReader.username(channel);
            return actual != null && expectedUsername.equals(actual);
        } catch (IOException | UnsupportedOperationException | SecurityException unavailable) {
            return false;
        }
    }

    private static String readPeerUsername(SocketChannel channel) throws IOException {
        UnixDomainPrincipal peer = channel.getOption(ExtendedSocketOptions.SO_PEERCRED);
        return peer == null || peer.user() == null ? null : peer.user().getName();
    }

    static boolean validPeerUsername(String username) {
        return username != null && username.length() <= 128 && !username.isBlank()
                && username.chars().noneMatch(Character::isWhitespace);
    }

    /**
     * Authenticated protocol seam for the shared Whisper compute client. The fixed
     * image build and server-owned model configuration are validated independently.
     * Dispatch remains gated on the supervisor and durable journal being present;
     * the supervisor owns the fixed container shape and cleanup state machine.
     */
    private static void handleWhisper(SocketChannel client, String token, String nonce, long timestamp,
            String operation, String payload, MediaOciBrokerPolicy.Policy policy,
            WhisperOciWorkerSupervisor whisperSupervisor, LongSupplier wallClockMillis) throws Exception {
        String invocationText = field(payload, "invocationId");
        String profileId = field(payload, "profileId");
        String locale = field(payload, "locale");
        String sourceSha256 = field(payload, "sourceSha256");
        UUID invocationId;
        try {
            invocationId = UUID.fromString(invocationText);
        } catch (RuntimeException invalidIdentity) {
            writeResult(client, -2, "rejected");
            return;
        }
        if (profileId == null || !profileId.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
                || locale == null || locale.length() > 35 || sourceSha256 == null
                || !sourceSha256.matches("[0-9a-f]{64}")) {
            writeResult(client, -2, "rejected");
            return;
        }
        String canonicalLocale;
        try {
            Locale parsedLocale = new Locale.Builder().setLanguageTag(locale).build();
            canonicalLocale = parsedLocale.toLanguageTag();
            if (parsedLocale.getLanguage().isBlank() || "und".equals(canonicalLocale)) {
                throw new IllegalArgumentException("locale requires a language subtag");
            }
        } catch (RuntimeException invalidLocale) {
            writeWhisperResponse(client, token, nonce, timestamp, "INVALID_REQUEST", invocationId,
                    profileId, sourceSha256, null, null);
            return;
        }
        if (!canonicalLocale.equals(locale)) {
            writeWhisperResponse(client, token, nonce, timestamp, "INVALID_REQUEST", invocationId,
                    profileId, sourceSha256, null, null);
            return;
        }

        com.ghatana.media.runtime.WhisperComputeContracts.Result protocolResult = null;
        if ("WHISPER_EXECUTE".equals(operation)) {
            if (!payloadHasOnlyFields(payload, java.util.Set.of("op", "invocationId", "profileId", "locale",
                    "sourceSha256", "remainingBudgetMillis", "wavBase64"))) {
                writeWhisperResponse(client, token, nonce, timestamp, "INVALID_REQUEST", invocationId,
                        profileId, sourceSha256, null, null);
                return;
            }
            String encoded = field(payload, "wavBase64");
            long budget = strictNumber(payload, "remainingBudgetMillis", 1,
                    com.ghatana.media.runtime.WhisperComputeContracts.MAX_REMAINING_BUDGET_MILLIS);
            byte[] wav;
            try {
                if (encoded == null || encoded.length() > 6 * 1024 * 1024 || budget < 1) throw new IllegalArgumentException();
                wav = Base64.getDecoder().decode(encoded);
            } catch (RuntimeException invalidPayload) {
                writeWhisperResponse(client, token, nonce, timestamp, "INVALID_REQUEST", invocationId,
                        profileId, sourceSha256, null, null);
                return;
            }
            if (!MediaOciBrokerPolicy.whisperInputAllowed(wav, sourceSha256)) {
                writeWhisperResponse(client, token, nonce, timestamp, "INVALID_REQUEST", invocationId,
                        profileId, sourceSha256, null, null);
                return;
            }
            WhisperWorkerServerConfig config = policy.whisperWorkerConfig();
            if (whisperSupervisor != null && config != null
                    && MediaOciBrokerPolicy.whisperProfileAllowed(policy, profileId, locale)
                    && MediaOciBrokerPolicy.whisperImageAllowed(policy, config.imageDigest())) {
                long remainingBudget = remainingAuthenticatedBudget(timestamp, budget, wallClockMillis.getAsLong());
                if (remainingBudget <= 0) {
                    // This signed exact-identity deadline is emitted only before supervisor.execute,
                    // hence before durable STARTED reservation or any worker/container dispatch.
                    protocolResult = new com.ghatana.media.runtime.WhisperComputeContracts.Result(
                            invocationId, profileId, sourceSha256, null, "",
                            com.ghatana.media.runtime.WhisperComputeContracts.Status.DEADLINE_EXCEEDED,
                            false, false, false);
                } else if (!WORKER_ADMISSION.tryAcquire()) {
                    protocolResult = new com.ghatana.media.runtime.WhisperComputeContracts.Result(
                            invocationId, profileId, sourceSha256, null, "",
                            com.ghatana.media.runtime.WhisperComputeContracts.Status.RESOURCE_EXHAUSTED,
                            false, false, false);
                } else {
                    try {
                        protocolResult = whisperSupervisor.execute(invocationId, profileId, locale,
                                sourceSha256, wav, remainingBudget);
                    } finally {
                        WORKER_ADMISSION.release();
                    }
                }
            }
        } else if (!"WHISPER_STATUS".equals(operation) && !"WHISPER_CANCEL".equals(operation)) {
            writeWhisperResponse(client, token, nonce, timestamp, "INVALID_REQUEST", invocationId,
                    profileId, sourceSha256, null, null);
            return;
        } else if (!payloadHasOnlyFields(payload, java.util.Set.of("op", "invocationId", "profileId", "locale",
                "sourceSha256"))) {
            writeWhisperResponse(client, token, nonce, timestamp, "INVALID_REQUEST", invocationId,
                    profileId, sourceSha256, null, null);
            return;
        }
        if (protocolResult == null && whisperSupervisor != null
                && policy.whisperWorkerConfig() != null
                && MediaOciBrokerPolicy.whisperProfileAllowed(policy, profileId, locale)
                && MediaOciBrokerPolicy.whisperImageAllowed(policy,
                        policy.whisperWorkerConfig().imageDigest())) {
            protocolResult = "WHISPER_STATUS".equals(operation)
                    ? whisperSupervisor.status(invocationId, profileId, locale, sourceSha256)
                    : whisperSupervisor.cancel(invocationId, profileId, locale, sourceSha256);
        }
        if (protocolResult != null) {
            writeWhisperResponse(client, token, nonce, timestamp, protocolResult);
        } else {
            writeWhisperResponse(client, token, nonce, timestamp, "NOT_ADMITTED", invocationId,
                    profileId, sourceSha256, null, null);
        }
    }

    private static void writeWhisperResponse(SocketChannel client, String token, String nonce, long timestamp,
            com.ghatana.media.runtime.WhisperComputeContracts.Result result) throws Exception {
        StringBuilder body = new StringBuilder("{\"status\":").append(json(result.status().name()))
                .append(",\"invocationId\":").append(json(result.invocationId().toString()))
                .append(",\"profileId\":").append(json(result.profileId()))
                .append(",\"inputSha256\":").append(json(result.inputSha256()));
        if (result.modelSha256() != null) body.append(",\"modelSha256\":").append(json(result.modelSha256()));
        if (result.status() == com.ghatana.media.runtime.WhisperComputeContracts.Status.SUCCESS) {
            body.append(",\"transcriptBase64\":")
                    .append(json(Base64.getEncoder().encodeToString(result.transcript().getBytes(StandardCharsets.UTF_8))));
        }
        body.append(",\"complete\":").append(result.complete())
                .append(",\"endOfTask\":").append(result.endOfTask())
                .append(",\"tokenLimitReached\":").append(result.tokenLimitReached()).append('}');
        String unsignedBody = body.toString();
        String proof = hmac(token, "response\n" + nonce + "\n" + timestamp + "\n" + unsignedBody);
        String signedBody = unsignedBody.substring(0, unsignedBody.length() - 1)
                + ",\"proof\":" + json(proof) + "}";
        writeWhisperFrame(client, "{\"status\":0,\"body\":" + signedBody + "}");
    }

    private static void writeWhisperResponse(SocketChannel client, String token, String nonce, long timestamp,
            String status, UUID invocationId, String profileId, String inputSha256,
            String modelSha256, String transcript) throws Exception {
        StringBuilder body = new StringBuilder("{\"status\":").append(json(status))
                .append(",\"invocationId\":").append(json(invocationId.toString()))
                .append(",\"profileId\":").append(json(profileId))
                .append(",\"inputSha256\":").append(json(inputSha256));
        if (modelSha256 != null) body.append(",\"modelSha256\":").append(json(modelSha256));
        if (transcript != null) body.append(",\"transcriptBase64\":").append(json(transcript));
        body.append(",\"complete\":false,\"endOfTask\":false,\"tokenLimitReached\":false}");
        String unsignedBody = body.toString();
        String proof = hmac(token, "response\n" + nonce + "\n" + timestamp + "\n" + unsignedBody);
        String signedBody = unsignedBody.substring(0, unsignedBody.length() - 1)
                + ",\"proof\":" + json(proof) + "}";
        writeWhisperFrame(client, "{\"status\":0,\"body\":" + signedBody + "}");
    }

    private static void writeWhisperFrame(SocketChannel client, String response) throws IOException {
        byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MediaOciBrokerPolicy.MAX_WHISPER_RESPONSE_BYTES) {
            writeResult(client, -2, "rejected");
            return;
        }
        ByteBuffer frame = ByteBuffer.allocate(bytes.length + 4).putInt(bytes.length).put(bytes);
        frame.flip();
        while (frame.hasRemaining()) client.write(frame);
    }

    /** Fail closed on caller-supplied OCI authority, paths, worker commands, or resource limits. */
    static boolean payloadHasOnlyFields(String json, java.util.Set<String> allowed) {
        java.util.Set<String> fields = topLevelStringKeys(json);
        return fields != null && fields.equals(allowed);
    }

    private static java.util.Set<String> topLevelStringKeys(String json) {
        if (json == null) return null;
        String trimmed = json.trim();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
        java.util.Set<String> result = new java.util.HashSet<>();
        int cursor = 1;
        int end = trimmed.length() - 1;
        while (cursor < end) {
            cursor = skipWhitespace(trimmed, cursor);
            if (cursor >= end) break;
            if (trimmed.charAt(cursor) != '"') return null;
            int keyEnd = stringEnd(trimmed, cursor);
            if (keyEnd < 0) return null;
            String key = unescape(trimmed.substring(cursor + 1, keyEnd));
            if (!result.add(key)) return null;
            cursor = skipWhitespace(trimmed, keyEnd + 1);
            if (cursor >= end || trimmed.charAt(cursor++) != ':') return null;
            cursor = skipWhitespace(trimmed, cursor);
            int valueEnd = valueEnd(trimmed, cursor);
            if (valueEnd < cursor) return null;
            cursor = skipWhitespace(trimmed, valueEnd);
            if (cursor < end) {
                if (trimmed.charAt(cursor++) != ',') return null;
            }
        }
        return cursor == end ? result : null;
    }

    private static int valueEnd(String text, int start) {
        if (start >= text.length()) return -1;
        char first = text.charAt(start);
        if (first == '"') {
            int end = stringEnd(text, start);
            return end < 0 ? -1 : end + 1;
        }
        if (first == '{' || first == '[') {
            char close = first == '{' ? '}' : ']';
            int depth = 0;
            boolean quoted = false;
            boolean escaped = false;
            for (int i = start; i < text.length(); i++) {
                char c = text.charAt(i);
                if (escaped) { escaped = false; continue; }
                if (quoted) {
                    if (c == '\\') escaped = true;
                    else if (c == '"') quoted = false;
                    continue;
                }
                if (c == '"') quoted = true;
                else if (c == first) depth++;
                else if (c == close && --depth == 0) return i + 1;
            }
            return -1;
        }
        int cursor = start;
        while (cursor < text.length() && text.charAt(cursor) != ',' && text.charAt(cursor) != '}') cursor++;
        while (cursor > start && Character.isWhitespace(text.charAt(cursor - 1))) cursor--;
        return cursor;
    }

    private static int stringEnd(String text, int start) {
        boolean escaped = false;
        for (int i = start + 1; i < text.length(); i++) {
            char c = text.charAt(i);
            if (escaped) { escaped = false; continue; }
            if (c == '\\') escaped = true;
            else if (c == '"') return i;
        }
        return -1;
    }

    private static int skipWhitespace(String text, int cursor) {
        while (cursor < text.length() && Character.isWhitespace(text.charAt(cursor))) cursor++;
        return cursor;
    }

    @FunctionalInterface
    interface WorkerCommandRunner {
        CommandResult run(List<String> command, Duration timeout) throws IOException;
    }

    static String runWorker(String docker, String image, String name,
            String executable, List<String> workerArgs, Path source, Path output,
            long uid, long gid, Duration timeout, long outputLimit) throws IOException {
        return runWorker(docker, image, name, executable, workerArgs, source, output,
                uid, gid, timeout, outputLimit, MediaOciBrokerDaemon::run);
    }

    static String runWorker(String docker, String image, String name,
            String executable, List<String> workerArgs, Path source, Path output,
            long uid, long gid, Duration timeout, long outputLimit,
            WorkerCommandRunner runner) throws IOException {
        if (source != null && !safeDockerPath(source))
            throw new IOException("Vision source snapshot path is not safe for Docker mount syntax");
        if (output != null && !safeDockerPath(output))
            throw new IOException("Vision output path is not safe for Docker mount syntax");
        List<String> create = new ArrayList<>(List.of(docker, "create", "--name", name,
                "--pull=never", "--platform=linux/arm64",
                "--label", "com.ghatana.media.vision.worker=true",
                "--memory=" + MEMORY_BYTES, "--memory-swap=" + MEMORY_BYTES, "--cpus=2",
                "--pids-limit=" + PID_LIMIT, "--ulimit=nofile=" + FD_LIMIT + ":" + FD_LIMIT,
                "--ulimit=fsize=" + outputLimit + ":" + outputLimit,
                "--network=none", "--read-only", "--cap-drop=ALL",
                "--security-opt=no-new-privileges:true", "--init", "--stop-timeout=2",
                "--tmpfs", "/tmp:rw,nosuid,nodev,exec,size=128m,nr_inodes=4096",
                "--user=" + uid + ":" + gid, "--workdir=/tmp",
                "--env=HOME=/tmp", "--env=TMPDIR=/tmp", "--env=PATH=/usr/bin:/bin",
                "--env=LANG=C.UTF-8", "--env=LC_ALL=C.UTF-8"));
        if (source != null) {
            create.addAll(List.of("--mount",
                    "type=bind,source=" + source + ",target=/source/input,readonly"));
        }
        if (output != null) {
            create.addAll(List.of("--mount", "type=bind,source=" + output + ",target=/output"));
        }
        create.add("--entrypoint=/usr/bin/" + executable);
        create.add(image);
        create.addAll(workerArgs);
        try {
            CommandResult created = runner.run(create, Duration.ofSeconds(15));
            String id = created.output().trim();
            if (created.exitCode() != 0 || !CONTAINER_ID.matcher(id).matches()) {
                remove(docker, name, runner);
                return "create-failed";
            }
            CommandResult started = runner.run(List.of(docker, "start", "--attach", id), timeout);
            boolean timedOut = started.timedOut();
            if (timedOut) kill(docker, id, runner);
            CommandResult oom = runner.run(List.of(docker, "inspect",
                    "--format", "{{.State.OOMKilled}}", id), Duration.ofSeconds(10));
            boolean oomKilled = parseOomKilledState(oom.exitCode(), oom.output(), oom.timedOut());
            long outputBytes = output != null && Files.exists(output)
                    ? Files.walk(output).filter(Files::isRegularFile)
                            .mapToLong(p -> { try { return Files.size(p); } catch (IOException e) { return 0L; } })
                            .sum() : 0L;
            remove(docker, id, runner);
            String tail = started.output().length() > OUTPUT_TAIL
                    ? started.output().substring(started.output().length() - OUTPUT_TAIL)
                    : started.output();
            return "{\"exitCode\":" + (timedOut ? -1 : started.exitCode())
                    + ",\"timedOut\":" + timedOut
                    + ",\"oomKilled\":" + oomKilled
                    + ",\"outputBytes\":" + outputBytes
                    + ",\"outputExceeded\":" + (outputBytes > outputLimit)
                    + ",\"tail\":" + json(tail) + "}";
        } catch (IOException failure) {
            remove(docker, name, runner);
            throw failure;
        }
    }

    static boolean safeDockerPath(Path path) {
        String value = path.toString();
        return value.startsWith("/") && value.matches("/[A-Za-z0-9_./-]+")
                && !value.contains("..") && !value.contains("//");
    }

    private static CommandResult run(List<String> command, Duration timeout) throws IOException {
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        StringBuffer captured = new StringBuffer();
        Thread drain = new Thread(() -> {
            try {
                drainBoundedOutput(process.getInputStream(), captured, MAX_CAPTURED_OUTPUT_CHARS);
            } catch (IOException ignored) { }
        });
        drain.setDaemon(true);
        drain.start();
        try {
            if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                process.destroyForcibly();
                process.waitFor(2, TimeUnit.SECONDS);
                return new CommandResult(-1, captured.toString(), true);
            }
            return new CommandResult(process.exitValue(), captured.toString(), false);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            process.destroyForcibly();
            return new CommandResult(-1, captured.toString(), true);
        }
    }

    static void drainBoundedOutput(InputStream input, StringBuffer captured, int maximumChars)
            throws IOException {
        if (input == null || captured == null || maximumChars < 0) {
            throw new IllegalArgumentException("Process output capture arguments are invalid");
        }
        try (InputStreamReader reader = new InputStreamReader(input, StandardCharsets.UTF_8)) {
            char[] buffer = new char[8192];
            int read;
            while ((read = reader.read(buffer)) != -1) {
                int remaining = maximumChars - captured.length();
                if (remaining > 0) captured.append(buffer, 0, Math.min(read, remaining));
            }
        }
    }

    static void remove(String docker, String id) throws IOException {
        CommandResult result = run(List.of(docker, "rm", "--force", id), Duration.ofSeconds(5));
        if (result.timedOut() || result.exitCode() != 0) {
            throw new IOException("Vision OCI broker could not confirm worker container cleanup");
        }
    }

    private static void remove(String docker, String id, WorkerCommandRunner runner) throws IOException {
        CommandResult result = runner.run(List.of(docker, "rm", "--force", id), Duration.ofSeconds(5));
        if (result.timedOut() || result.exitCode() != 0) {
            throw new IOException("Vision OCI broker could not confirm worker container cleanup");
        }
    }

    static boolean parseOomKilledState(int exitCode, String output, boolean timedOut) throws IOException {
        if (timedOut || exitCode != 0 || output == null) {
            throw new IOException("Vision OCI broker could not confirm worker OOM state");
        }
        return switch (output.trim()) {
            case "true" -> true;
            case "false" -> false;
            default -> throw new IOException("Vision OCI broker returned an invalid worker OOM state");
        };
    }

    private static void kill(String docker, String id) throws IOException {
        run(List.of(docker, "kill", "--signal=KILL", id), Duration.ofSeconds(5));
    }

    private static void kill(String docker, String id, WorkerCommandRunner runner) throws IOException {
        CommandResult result = runner.run(List.of(docker, "kill", "--signal=KILL", id), Duration.ofSeconds(5));
        if (result.timedOut() || result.exitCode() != 0) {
            throw new IOException("Vision OCI broker could not confirm worker termination");
        }
    }

    private static byte[] readFrame(SocketChannel channel, int limit, long deadlineNanos)
            throws IOException {
        // The request read is wall-time bounded so a stalled peer cannot pin the
        // single serialized broker loop forever.
        channel.configureBlocking(false);
        ByteBuffer header = ByteBuffer.allocate(4);
        if (!fill(channel, header, deadlineNanos)) return null;
        header.flip();
        int length = header.getInt();
        if (length < 0 || length > limit) return null;
        ByteBuffer body = ByteBuffer.allocate(length);
        if (!fill(channel, body, deadlineNanos)) return null;
        return body.array();
    }

    /** Returns zero when the signed request timestamp is from the future or its budget elapsed. */
    static long remainingAuthenticatedBudget(long signedTimestampMillis, long requestedBudgetMillis,
            long serverNowMillis) {
        if (signedTimestampMillis < 0 || requestedBudgetMillis < 1 || serverNowMillis < signedTimestampMillis) {
            return 0;
        }
        long elapsed = serverNowMillis - signedTimestampMillis;
        return elapsed >= requestedBudgetMillis ? 0 : requestedBudgetMillis - elapsed;
    }

    private static boolean fill(SocketChannel channel, ByteBuffer buffer, long deadlineNanos)
            throws IOException {
        while (buffer.hasRemaining()) {
            if (System.nanoTime() > deadlineNanos) return false;
            int n = channel.read(buffer);
            if (n < 0) return false;
            if (n == 0) {
                try {
                    Thread.sleep(2);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return false;
                }
            }
        }
        return true;
    }

    private static void writeResult(SocketChannel channel, int status, String jsonBody)
            throws IOException {
        String frame = "{\"status\":" + status + ",\"body\":" + json(jsonBody) + "}";
        byte[] bytes = frame.getBytes(StandardCharsets.UTF_8);
        ByteBuffer out = ByteBuffer.allocate(4 + bytes.length);
        out.putInt(bytes.length);
        out.put(bytes);
        out.flip();
        while (out.hasRemaining()) channel.write(out);
    }

    /** Extracts a raw nested object value ({...}) with balanced braces. */
    private static String object(String json, String name) {
        String key = "\"" + name + "\":";
        int start = json.indexOf(key);
        if (start < 0) return null;
        int open = start + key.length();
        if (open >= json.length() || json.charAt(open) != '{') return null;
        int depth = 0;
        boolean inString = false;
        boolean escaped = false;
        for (int i = open; i < json.length(); i++) {
            char c = json.charAt(i);
            if (escaped) { escaped = false; continue; }
            if (inString) {
                if (c == '\\') escaped = true;
                else if (c == '"') inString = false;
                continue;
            }
            if (c == '"') inString = true;
            else if (c == '{') depth++;
            else if (c == '}') {
                depth--;
                if (depth == 0) return json.substring(open, i + 1);
            }
        }
        return null;
    }

    private static String hmac(String token, String message) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(token.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return HexFormat.of().formatHex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
    }

    private static String field(String json, String name) {
        String key = "\"" + name + "\":\"";
        int start = json.indexOf(key);
        if (start < 0) return null;
        int cursor = start + key.length();
        boolean escaped = false;
        for (int i = cursor; i < json.length(); i++) {
            char c = json.charAt(i);
            if (escaped) { escaped = false; continue; }
            if (c == '\\') { escaped = true; continue; }
            if (c == '"') return unescape(json.substring(cursor, i));
        }
        return null;
    }

    private static List<String> array(String json, String name) {
        String key = "\"" + name + "\":[";
        int start = json.indexOf(key);
        if (start < 0) return List.of();
        int end = json.indexOf(']', start + key.length());
        if (end < 0) return List.of();
        String inside = json.substring(start + key.length(), end).trim();
        List<String> values = new ArrayList<>();
        if (inside.isEmpty()) return values;
        int cursor = 0;
        while (cursor < inside.length()) {
            int open = inside.indexOf('"', cursor);
            if (open < 0) break;
            int close = inside.indexOf('"', open + 1);
            if (close < 0) break;
            values.add(unescape(inside.substring(open + 1, close)));
            cursor = close + 1;
        }
        return values;
    }

    private static long number(String json, String name, long fallback, long min, long max) {
        String key = "\"" + name + "\":";
        int start = json.indexOf(key);
        if (start < 0) return fallback;
        int end = start + key.length();
        int cursor = end;
        while (cursor < json.length() && (Character.isDigit(json.charAt(cursor)) || json.charAt(cursor) == '-')) cursor++;
        try {
            long value = Long.parseLong(json.substring(end, cursor));
            return Math.max(min, Math.min(value, max));
        } catch (NumberFormatException ignored) {
            return fallback;
        }
    }

    private static long strictNumber(String json, String name, long min, long max) {
        String key = "\"" + name + "\":";
        int start = json.indexOf(key);
        if (start < 0) return -1;
        int cursor = start + key.length();
        while (cursor < json.length() && Character.isWhitespace(json.charAt(cursor))) cursor++;
        int end = cursor;
        while (end < json.length() && Character.isDigit(json.charAt(end))) end++;
        if (end == cursor) return -1;
        int delimiter = end;
        while (delimiter < json.length() && Character.isWhitespace(json.charAt(delimiter))) delimiter++;
        if (delimiter < json.length() && json.charAt(delimiter) != ',' && json.charAt(delimiter) != '}') return -1;
        try {
            long parsed = Long.parseLong(json.substring(cursor, end));
            return parsed >= min && parsed <= max ? parsed : -1;
        } catch (NumberFormatException invalid) {
            return -1;
        }
    }

    private static String json(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (char c : value.toCharArray()) {
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> out.append(c < 0x20 ? String.format("\\u%04x", (int) c) : c);
            }
        }
        return out.append('"').toString();
    }

    private static String unescape(String value) {
        return value.replace("\\n", "\n").replace("\\r", "\r")
                .replace("\\t", "\t").replace("\\\"", "\"").replace("\\\\", "\\");
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }

    record CommandResult(int exitCode, String output, boolean timedOut) { }
}
