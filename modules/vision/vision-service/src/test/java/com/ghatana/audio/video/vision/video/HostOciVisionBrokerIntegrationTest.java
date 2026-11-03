package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Duration;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** External-broker contract checks; enabled only with an explicitly provisioned broker fixture. */
@EnabledIf("brokerInputsConfigured")
class HostOciVisionBrokerIntegrationTest {

    private static final String TEST_WORKER_UID_ENV = "GHATANA_MEDIA_VISION_OCI_BROKER_TEST_WORKER_UID";
    private static final String TEST_WORKER_GID_ENV = "GHATANA_MEDIA_VISION_OCI_BROKER_TEST_WORKER_GID";
    private static final String TEST_BROKER_USER_ENV = "GHATANA_MEDIA_VISION_OCI_BROKER_TEST_BROKER_USER";
    private static final String TEST_BROKER_UID_ENV = "GHATANA_MEDIA_VISION_OCI_BROKER_TEST_BROKER_UID";
    private static final String TEST_PEER_USER_ENV = "GHATANA_MEDIA_VISION_OCI_BROKER_TEST_PEER_USER";
    private static final String TEST_PEER_GID_ENV = "GHATANA_MEDIA_VISION_OCI_BROKER_TEST_PEER_GID";
    private static final String TEST_STAGE_ROOT_ENV = "GHATANA_MEDIA_VISION_OCI_BROKER_TEST_STAGE_ROOT";
    private static final String TEST_EXTERNAL_ENV = "GHATANA_MEDIA_VISION_OCI_BROKER_TEST_EXTERNAL";
    private static final String TEST_SOURCE_ROOT_ENV = "GHATANA_MEDIA_VISION_OCI_BROKER_TEST_SOURCE_ROOT";
    private static final String TEST_OUTPUT_ROOT_ENV = "GHATANA_MEDIA_VISION_OCI_BROKER_TEST_OUTPUT_ROOT";

    private static Path socket;
    private static Path clientToken;
    private static Path sourceRoot;
    private static Path outputRoot;
    private static String image;
    private static long workerUid;
    private static long workerGid;

    @BeforeAll
    static void validateExternalBrokerInputs() throws Exception {
        assertThat(required(TEST_EXTERNAL_ENV)).isEqualTo("1");
        String peerUser = required(TEST_PEER_USER_ENV);
        String brokerUser = required(TEST_BROKER_USER_ENV);
        long brokerUid = positiveLong(TEST_BROKER_UID_ENV);
        long peerGid = positiveLong(TEST_PEER_GID_ENV);
        workerUid = positiveLong(TEST_WORKER_UID_ENV);
        workerGid = nonnegativeLong(TEST_WORKER_GID_ENV);
        assertThat(workerGid).as("the socket peer group is also the worker/shared group").isEqualTo(peerGid);
        assertThat(brokerUid).as("broker and peer must use distinct OS identities").isNotEqualTo(workerUid);
        sourceRoot = validateSharedDataRoot(required(TEST_SOURCE_ROOT_ENV), workerUid, workerGid, "broker source root");
        outputRoot = validateSharedDataRoot(required(TEST_OUTPUT_ROOT_ENV), workerUid, workerGid, "broker output root");
        assertThat(sourceRoot.startsWith(outputRoot)).as("broker source and output roots must be disjoint").isFalse();
        assertThat(outputRoot.startsWith(sourceRoot)).isFalse();

        clientToken = Path.of(System.getenv(HostOciVisionWorkerSupervisor.BROKER_TOKEN_ENV));
        assertThat(MediaOciBrokerPolicy.ownerOnlyFile(clientToken))
                .as("peer must receive a separate owner-only client-token copy").isTrue();
        assertThat(Files.getOwner(clientToken).getName()).isEqualTo(peerUser);
        assertThat(((Number) Files.getAttribute(clientToken, "unix:uid")).longValue()).isEqualTo(workerUid);
        assertThat(Files.size(clientToken)).as("client token must contain at least 32 bytes")
                .isGreaterThanOrEqualTo(32L);

        image = System.getenv(HostOciVisionWorkerSupervisor.IMAGE_ENV);
        assertThat(image).matches("(?:[^\\s,@]+@)?sha256:[a-f0-9]{64}");
        socket = Path.of(System.getenv(HostOciVisionWorkerSupervisor.BROKER_SOCKET_ENV))
                .toAbsolutePath().normalize();
        assertThat(MediaOciBrokerDaemon.validateSocketParent(socket, brokerUser, peerGid))
                .isEqualTo(socket.getParent().toRealPath());
        MediaOciBrokerDaemon.validateBoundSocket(socket, brokerUser, peerGid);
        assertThat(((Number) Files.getAttribute(socket, "unix:uid")).longValue()).isEqualTo(brokerUid);

        Path stageRoot = validateStageRootMetadata(required(TEST_STAGE_ROOT_ENV), brokerUser, brokerUid);
        Path socketParent = socket.getParent().toRealPath();
        assertThat(stageRoot.startsWith(socketParent)).isFalse();
        assertThat(socketParent.startsWith(stageRoot)).isFalse();
        assertThat(stageRoot.startsWith(sourceRoot)).isFalse();
        assertThat(sourceRoot.startsWith(stageRoot)).isFalse();
        assertThat(stageRoot.startsWith(outputRoot)).isFalse();
        assertThat(outputRoot.startsWith(stageRoot)).isFalse();
        assertThat(stageRoot.startsWith(clientToken.getParent().toRealPath())).isFalse();
        assertThat(clientToken.getParent().toRealPath().startsWith(stageRoot)).isFalse();
    }

    static boolean brokerInputsConfigured() {
        return List.of(HostOciVisionWorkerSupervisor.BROKER_SOCKET_ENV,
                HostOciVisionWorkerSupervisor.BROKER_TOKEN_ENV,
                HostOciVisionWorkerSupervisor.IMAGE_ENV,
                TEST_WORKER_UID_ENV, TEST_WORKER_GID_ENV,
                TEST_BROKER_USER_ENV, TEST_BROKER_UID_ENV,
                TEST_PEER_USER_ENV, TEST_PEER_GID_ENV,
                TEST_STAGE_ROOT_ENV, TEST_EXTERNAL_ENV, TEST_SOURCE_ROOT_ENV, TEST_OUTPUT_ROOT_ENV)
                .stream().allMatch(name -> System.getenv(name) != null && !System.getenv(name).isBlank());
    }

    private static String required(String environmentName) {
        String value = System.getenv(environmentName);
        assertThat(value).as("%s must be configured", environmentName).isNotBlank();
        return value;
    }

    private static long positiveLong(String environmentName) {
        long value = nonnegativeLong(environmentName);
        assertThat(value).as("%s must be positive", environmentName).isPositive();
        return value;
    }

    private static long nonnegativeLong(String environmentName) {
        String text = System.getenv(environmentName);
        assertThat(text).as("%s must be numeric", environmentName).matches("[0-9]+");
        return Long.parseLong(text);
    }

    private static Path validateStageRootMetadata(String value, String brokerUser, long brokerUid) throws IOException {
        Path configured = Path.of(value).toAbsolutePath().normalize();
        assertThat(Files.isSymbolicLink(configured)).as("broker stage root cannot be a symlink").isFalse();
        assertThat(Files.isDirectory(configured, java.nio.file.LinkOption.NOFOLLOW_LINKS))
                .as("broker stage root must be a real directory").isTrue();
        Path real = configured.toRealPath();
        assertThat(Files.getOwner(real, java.nio.file.LinkOption.NOFOLLOW_LINKS).getName()).isEqualTo(brokerUser);
        assertThat(((Number) Files.getAttribute(real, "unix:uid")).longValue()).isEqualTo(brokerUid);
        assertThat(Files.getPosixFilePermissions(real))
                .containsExactlyInAnyOrder(PosixFilePermission.OWNER_READ,
                        PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE);
        return real;
    }

    private static Path validateSharedDataRoot(String value, long uid, long gid, String description)
            throws IOException {
        Path configured = Path.of(value).toAbsolutePath().normalize();
        assertThat(Files.isSymbolicLink(configured)).as("%s cannot be a symlink", description).isFalse();
        assertThat(Files.isDirectory(configured, java.nio.file.LinkOption.NOFOLLOW_LINKS))
                .as("%s must be a preprovisioned directory", description).isTrue();
        Path real = configured.toRealPath();
        assertThat(((Number) Files.getAttribute(real, "unix:uid")).longValue()).as(description + " owner UID").isEqualTo(uid);
        assertThat(((Number) Files.getAttribute(real, "unix:gid")).longValue()).as(description + " shared GID").isEqualTo(gid);
        assertThat(((Number) Files.getAttribute(real, "unix:mode")).intValue() & 07777)
                .as(description + " must be peer-owned, setgid, and mode 02750")
                .isEqualTo(02750);
        return real;
    }

    @Test
    void externalBrokerRunsAuthenticatedReadOnlySourceProbe() throws Exception {
        byte[] sentinel = "broker-source-probe-sentinel".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Path source = sourceRoot.resolve("broker-probe-" + UUID.randomUUID());
        Files.write(source, sentinel);
        Files.setPosixFilePermissions(source, java.nio.file.attribute.PosixFilePermissions.fromString("r--r-----"));
        assertThat(((Number) Files.getAttribute(source, "unix:uid")).longValue()).isEqualTo(workerUid);
        assertThat(((Number) Files.getAttribute(source, "unix:gid")).longValue()).isEqualTo(workerGid);
        assertThat(((Number) Files.getAttribute(source, "unix:mode")).intValue() & 0777).isEqualTo(0440);
        String sha = java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(sentinel));
        try {
            MediaOciBroker.WorkerResult result = client().execute(new MediaOciBroker.WorkerLaunch(
                    image, "source-probe-" + UUID.randomUUID(), "ffmpeg",
                    List.of("-nostdin", "-protocol_whitelist", "file", "-i", "/source/input", "-f", "null", "-"),
                    source.toString(), sha, null, workerUid, workerGid, 65_536L, Duration.ofSeconds(30)));

            assertThat(result.completed()).isTrue();
            assertThat(result.exitCode()).isZero();
            assertThat(result.timedOut()).isFalse();
            assertThat(result.oomKilled()).isFalse();
            assertThat(result.outputExceeded()).isFalse();
            assertThat(result.outputTail()).contains("broker-source-probe-read-ok");
        } finally {
            Files.deleteIfExists(source);
        }
    }

    @Test
    void externalBrokerReturnsBoundedFrameWithAuthenticatedManifest() throws Exception {
        byte[] ppm = new byte[] {'P', '6', '\n', '1', ' ', '1', '\n', '2', '5', '5', '\n',
                (byte) 255, 0, 0};
        Path source = sourceRoot.resolve("broker-frame-probe-" + UUID.randomUUID());
        Path output = HostOciVisionWorkerSupervisor.createBrokerOutputDirectory(outputRoot, workerUid, workerGid);
        boolean preserveForReconciliation = false;
        try {
            Files.write(source, ppm);
            Files.setPosixFilePermissions(source, java.nio.file.attribute.PosixFilePermissions.fromString("r--r-----"));
            assertThat(((Number) Files.getAttribute(source, "unix:uid")).longValue()).isEqualTo(workerUid);
            assertThat(((Number) Files.getAttribute(source, "unix:gid")).longValue()).isEqualTo(workerGid);
            String sha = java.util.HexFormat.of().formatHex(
                    java.security.MessageDigest.getInstance("SHA-256").digest(ppm));

            MediaOciBroker.WorkerResult result = client().execute(new MediaOciBroker.WorkerLaunch(
                    image, "frame-probe-" + UUID.randomUUID(), "ffmpeg",
                    List.of("-nostdin", "-hide_banner", "-loglevel", "error", "-i", "/source/input",
                            "-y", "/output/frame.png"),
                    source.toString(), sha, output.toString(), workerUid, workerGid,
                    MediaOciBrokerPolicy.MAX_VISION_FRAME_BYTES, Duration.ofSeconds(30)));

            assertThat(result.completed()).isTrue();
            assertThat(result.exitCode()).isZero();
            assertThat(result.outputRejected()).isFalse();
            assertThat(result.outputExceeded()).isFalse();
            assertThat(result.outputFiles()).hasSize(1);
            MediaOciBroker.OutputFile frame = result.outputFiles().getFirst();
            assertThat(frame.name()).isEqualTo("frame.png");
            assertThat(frame.size()).isPositive().isEqualTo(Files.size(output.resolve(frame.name())));
            String actualSha = java.util.HexFormat.of().formatHex(
                    java.security.MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(output.resolve(frame.name()))));
            assertThat(frame.sha256()).isEqualTo(actualSha);
        } catch (MediaOciBrokerClient.UnknownOutcomeException unknown) {
            preserveForReconciliation = true;
            throw unknown;
        } finally {
            if (!preserveForReconciliation) {
                Files.deleteIfExists(source);
                try (var files = Files.list(output)) {
                    for (Path file : files.toList()) Files.deleteIfExists(file);
                }
                Files.deleteIfExists(output);
            } else {
                System.err.println("Vision broker frame probe retained for reconciliation: "
                        + output.getFileName());
            }
        }
    }

    @Test
    void externalBrokerRejectsOutputOutsideThePinnedWorkerRootBeforeDispatch() {
        assertThatThrownBy(() -> client().execute(new MediaOciBroker.WorkerLaunch(
                image, "output-reject-" + UUID.randomUUID(), "ffmpeg", List.of("-version"),
                null, null, outputRoot.getParent().toString(), workerUid, workerGid,
                65_536L, Duration.ofSeconds(30))))
                .isInstanceOf(IOException.class)
                .hasMessageContaining("rejected");
    }

    private static MediaOciBrokerClient client() {
        return new MediaOciBrokerClient(socket, clientToken);
    }
}
