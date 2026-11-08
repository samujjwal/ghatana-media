package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import jdk.net.ExtendedSocketOptions;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Server-side broker policy negatives; no Docker required. */
class MediaOciBrokerPolicyTest {

    @TempDir Path root;

    private MediaOciBrokerPolicy.Policy policy() throws Exception {
        Path real = root.toRealPath();
        return new MediaOciBrokerPolicy.Policy(
                Set.of("worker@sha256:" + "a".repeat(64)),
                uidOf(root), gidOf(root), real, real);
    }

    private static long uidOf(Path path) throws Exception {
        return ((Number) Files.getAttribute(path, "unix:uid")).longValue();
    }

    private static long gidOf(Path path) throws Exception {
        return ((Number) Files.getAttribute(path, "unix:gid")).longValue();
    }

    @Test
    void imageMustBeOnTheServerAllowlist() throws Exception {
        var policy = policy();
        assertThat(MediaOciBrokerPolicy.imageAllowed(policy, "worker@sha256:" + "a".repeat(64))).isTrue();
        assertThat(MediaOciBrokerPolicy.imageAllowed(policy, "worker@sha256:" + "b".repeat(64))).isFalse();
        assertThat(MediaOciBrokerPolicy.imageAllowed(policy, "evil:latest")).isFalse();
        assertThat(MediaOciBrokerPolicy.imageAllowed(policy, null)).isFalse();
    }

    @Test
    void workerIdentityMustEqualThePinnedUidGid() throws Exception {
        var policy = policy();
        assertThat(MediaOciBrokerPolicy.workerIdentityAllowed(
                policy, policy.workerUid(), policy.workerGid())).isTrue();
        assertThat(MediaOciBrokerPolicy.workerIdentityAllowed(policy, 0, 0)).isFalse();
        assertThat(MediaOciBrokerPolicy.workerIdentityAllowed(
                policy, policy.workerUid() + 1, policy.workerGid())).isFalse();
    }

    @Test
    void whisperProfileLoaderRequiresServerPinnedImmutableIdentitiesAndAllowedImage() {
        String image = "worker@sha256:" + "a".repeat(64);
        String model = "b".repeat(64);
        var allowedImages = Set.of(image);
        var environment = new java.util.HashMap<String, String>();
        environment.put("MEDIA_OCI_BROKER_WHISPER_PROFILE_ID", "whisper.en.reference.v1");
        environment.put("MEDIA_OCI_BROKER_WHISPER_IMAGE", image);
        environment.put("MEDIA_OCI_BROKER_WHISPER_MODEL_SHA256", model);
        environment.put("MEDIA_OCI_BROKER_WHISPER_LOCALES", "en,en-US");

        var profile = MediaOciBrokerPolicy.loadWhisperProfile(environment, allowedImages);
        assertThat(profile).isPresent().get().satisfies(p -> {
            assertThat(p.profileId()).isEqualTo("whisper.en.reference.v1");
            assertThat(p.imageDigest()).isEqualTo(image);
            assertThat(p.modelSha256()).isEqualTo(model);
            assertThat(p.locales()).containsExactlyInAnyOrder("en", "en-US");
        });
        environment.put("MEDIA_OCI_BROKER_WHISPER_IMAGE", "worker:latest");
        assertThat(MediaOciBrokerPolicy.loadWhisperProfile(environment, allowedImages)).isEmpty();
        environment.put("MEDIA_OCI_BROKER_WHISPER_IMAGE", image);
        environment.remove("MEDIA_OCI_BROKER_WHISPER_MODEL_SHA256");
        assertThat(MediaOciBrokerPolicy.loadWhisperProfile(environment, allowedImages)).isEmpty();
    }

    @Test
    void visionProfileLoaderBindsImageAndToolchainVersionToBrokerConfiguration() {
        String image = "worker@sha256:" + "a".repeat(64);
        var environment = new java.util.HashMap<String, String>();
        environment.put("MEDIA_OCI_BROKER_VISION_PROFILE_ID", "vision.ffmpeg.reference.v1");
        environment.put("MEDIA_OCI_BROKER_VISION_IMAGE", image);
        environment.put("MEDIA_OCI_BROKER_VISION_TOOLCHAIN_VERSION", "ffmpeg-8.1.2+sha256.abc123");

        var profile = MediaOciBrokerPolicy.loadVisionProfile(environment, Set.of(image));
        assertThat(profile).isPresent().get().satisfies(p -> {
            assertThat(p.profileId()).isEqualTo("vision.ffmpeg.reference.v1");
            assertThat(p.imageDigest()).isEqualTo(image);
            assertThat(p.toolchainVersion()).isEqualTo("ffmpeg-8.1.2+sha256.abc123");
        });
        assertThat(MediaOciBrokerPolicy.loadVisionProfile(environment, Set.of())).isEmpty();
        environment.put("MEDIA_OCI_BROKER_VISION_IMAGE", "worker:latest");
        assertThat(MediaOciBrokerPolicy.loadVisionProfile(environment, Set.of(image))).isEmpty();
        environment.put("MEDIA_OCI_BROKER_VISION_IMAGE", image);
        environment.put("MEDIA_OCI_BROKER_VISION_TOOLCHAIN_VERSION", " ");
        assertThat(MediaOciBrokerPolicy.loadVisionProfile(environment, Set.of(image))).isEmpty();
    }

    @Test
    void visionLaunchMustUseTheSingleBrokerOwnedImage() throws Exception {
        String pinned = "worker@sha256:" + "a".repeat(64);
        var base = policy();
        var profile = new MediaOciBrokerPolicy.VisionProfile(
                "vision.ffmpeg.reference.v1", pinned, "ffmpeg-8.1.2");
        var configured = new MediaOciBrokerPolicy.Policy(base.allowedImageDigests(), base.workerUid(),
                base.workerGid(), base.sourceRoot(), base.outputRoot(), null, null, profile);
        assertThat(MediaOciBrokerPolicy.visionImageAllowed(configured, pinned)).isTrue();
        assertThat(MediaOciBrokerPolicy.visionImageAllowed(configured,
                "worker@sha256:" + "b".repeat(64))).isFalse();
        assertThat(MediaOciBrokerPolicy.visionImageAllowed(base, pinned)).isFalse();
    }

    @Test
    void whisperProfileAndLocaleMustMatchExactServerPin() throws Exception {
        String image = "worker@sha256:" + "a".repeat(64);
        var profile = new MediaOciBrokerPolicy.WhisperProfile(
                "whisper.en.v1", image, "b".repeat(64), Set.of("en", "en-US"));
        var base = policy();
        var withProfile = new MediaOciBrokerPolicy.Policy(base.allowedImageDigests(), base.workerUid(),
                base.workerGid(), base.sourceRoot(), base.outputRoot(), profile);
        assertThat(MediaOciBrokerPolicy.whisperProfileAllowed(withProfile, "whisper.en.v1", "en")).isTrue();
        assertThat(MediaOciBrokerPolicy.whisperProfileAllowed(withProfile, "whisper.other", "en")).isFalse();
        assertThat(MediaOciBrokerPolicy.whisperProfileAllowed(withProfile, "whisper.en.v1", "fr")).isFalse();
        assertThat(MediaOciBrokerPolicy.whisperImageAllowed(withProfile, image)).isTrue();
        assertThat(MediaOciBrokerPolicy.whisperImageAllowed(withProfile, "worker@sha256:" + "c".repeat(64))).isFalse();
    }

    @Test
    void whisperInputMustBeWithinFourMiBAndMatchExactDigest() throws Exception {
        byte[] input = new byte[] {1, 2, 3};
        String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(input));
        assertThat(MediaOciBrokerPolicy.whisperInputAllowed(input, digest)).isTrue();
        assertThat(MediaOciBrokerPolicy.whisperInputAllowed(input, "0".repeat(64))).isFalse();
        assertThat(MediaOciBrokerPolicy.whisperInputAllowed(input, null)).isFalse();
        assertThat(MediaOciBrokerPolicy.whisperInputAllowed(
                new byte[MediaOciBrokerPolicy.MAX_WHISPER_INPUT_BYTES + 1], "0".repeat(64))).isFalse();
        assertThat(MediaOciBrokerPolicy.whisperInputAllowed(new byte[0], "0".repeat(64))).isFalse();
    }

    @Test
    void whisperPayloadRejectsCallerSuppliedWorkerAuthorityAndDuplicateKeys() {
        Set<String> executeFields = Set.of("op", "invocationId", "profileId", "locale",
                "sourceSha256", "remainingBudgetMillis", "wavBase64");
        String valid = "{\"op\":\"WHISPER_EXECUTE\",\"invocationId\":\"id\","
                + "\"profileId\":\"profile\",\"locale\":\"en\",\"sourceSha256\":\""
                + "0".repeat(64) + "\",\"remainingBudgetMillis\":1000,\"wavBase64\":\"AQID\"}";
        assertThat(MediaOciBrokerDaemon.payloadHasOnlyFields(valid, executeFields)).isTrue();
        for (String forbidden : List.of("image", "executable", "uid", "gid", "args", "source", "output", "timeoutMs")) {
            String forged = valid.substring(0, valid.length() - 1) + ",\"" + forbidden + "\":\"caller\"}";
            assertThat(MediaOciBrokerDaemon.payloadHasOnlyFields(forged, executeFields))
                    .as("caller cannot supply %s", forbidden).isFalse();
        }
        String duplicate = valid.replace("\"op\":\"WHISPER_EXECUTE\"",
                "\"op\":\"WHISPER_EXECUTE\",\"op\":\"WHISPER_EXECUTE\"");
        assertThat(MediaOciBrokerDaemon.payloadHasOnlyFields(duplicate, executeFields)).isFalse();
    }

    @Test
    void brokerPeerUserGateRequiresExactConfiguredPrincipalAndFailsClosedWhenUnreadable() throws Exception {
        assertThat(MediaOciBrokerDaemon.validPeerUsername("media-client")).isTrue();
        assertThat(MediaOciBrokerDaemon.validPeerUsername(null)).isFalse();
        assertThat(MediaOciBrokerDaemon.validPeerUsername(" ")).isFalse();
        try (var channel = java.nio.channels.SocketChannel.open()) {
            assertThat(MediaOciBrokerDaemon.peerUserAllowed(channel, "media-client", ignored -> "media-client")).isTrue();
            assertThat(MediaOciBrokerDaemon.peerUserAllowed(channel, "media-client", ignored -> "other-user")).isFalse();
            assertThat(MediaOciBrokerDaemon.peerUserAllowed(channel, null, ignored -> "media-client")).isFalse();
            assertThat(MediaOciBrokerDaemon.peerUserAllowed(channel, "media-client", ignored -> {
                throw new java.io.IOException("SO_PEERCRED unavailable");
            })).isFalse();
        }
    }

    @Test
    void brokerPeerGateReadsActualUnixSocketCredentialsAndRejectsMismatchedOrUnconnectedPeers() throws Exception {
        try (SocketChannel probe = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            Assumptions.assumeTrue(probe.supportedOptions().contains(ExtendedSocketOptions.SO_PEERCRED),
                    "SO_PEERCRED is unavailable on this host/JDK");
        } catch (UnsupportedOperationException unsupported) {
            Assumptions.assumeTrue(false, "Unix domain sockets are unavailable on this host/JDK");
        }

        Path socketPath = root.resolve("p.sock");
        String actualUser;
        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(socketPath));
            try (SocketChannel client = SocketChannel.open(StandardProtocolFamily.UNIX)) {
                client.connect(UnixDomainSocketAddress.of(socketPath));
                try (SocketChannel accepted = server.accept()) {
                    var peerCredentials = accepted.getOption(ExtendedSocketOptions.SO_PEERCRED);
                    assertThat(peerCredentials).isNotNull();
                    actualUser = peerCredentials.user().getName();
                    assertThat(actualUser).isNotBlank();
                    assertThat(MediaOciBrokerDaemon.peerUserAllowed(accepted, actualUser))
                            .as("the accepted socket's kernel peer credential must match the authorized peer")
                            .isTrue();
                    assertThat(MediaOciBrokerDaemon.peerUserAllowed(accepted, actualUser + "-other"))
                            .as("a caller-supplied or mismatched username must not authorize the peer")
                            .isFalse();
                }
            }
        }
        try (SocketChannel unconnected = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            assertThat(MediaOciBrokerDaemon.peerUserAllowed(unconnected, actualUser))
                    .as("an unconnected socket without kernel peer credentials must fail closed")
                    .isFalse();
        }
    }

    @Test
    void stalledBrokerResponsePeerCannotPinTheSerializedSocketHandler() throws Exception {
        Path socketPath = root.resolve("stalled-response.sock");
        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(socketPath));
            try (SocketChannel client = SocketChannel.open(StandardProtocolFamily.UNIX)) {
                client.connect(UnixDomainSocketAddress.of(socketPath));
                try (SocketChannel accepted = server.accept()) {
                    accepted.configureBlocking(false);
                    // Leave the client unread and exceed the tiny receive window. The production
                    // handler uses the same nonblocking channel state after reading a request.
                    assertThatThrownBy(() -> MediaOciBrokerDaemon.writeJsonFrame(
                            accepted, "x".repeat(4 * 1024 * 1024), 4 * 1024 * 1024,
                            Duration.ofMillis(50)))
                            .isInstanceOf(java.io.IOException.class)
                            .hasMessageContaining("write deadline");
                }
            }
        }
    }

    @Test
    void stalledBrokerRequestBodyExpiresAtTheFixedReadDeadline() throws Exception {
        Path socketPath = root.resolve("stalled-request.sock");
        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(socketPath));
            try (SocketChannel peer = SocketChannel.open(StandardProtocolFamily.UNIX)) {
                peer.connect(UnixDomainSocketAddress.of(socketPath));
                try (SocketChannel accepted = server.accept()) {
                    ByteBuffer partialFrame = ByteBuffer.allocate(Integer.BYTES + 1);
                    partialFrame.putInt(4).put((byte) '{').flip();
                    while (partialFrame.hasRemaining()) peer.write(partialFrame);

                    long started = System.nanoTime();
                    byte[] request = MediaOciBrokerDaemon.readFrame(accepted, 1024,
                            started + Duration.ofMillis(50).toNanos());
                    long elapsedMillis = Duration.ofNanos(System.nanoTime() - started).toMillis();

                    assertThat(request).as("partial authenticated request must be discarded").isNull();
                    assertThat(elapsedMillis).as("stalled peer must not hold the handler beyond its deadline")
                            .isLessThan(1_000);
                }
            }
        }
    }

    @Test
    void brokerSocketRequiresOwnedSetgidParentAndExactPeerGroupMode() throws Exception {
        Path parent = Files.createDirectory(root.resolve("broker-socket"));
        long peerGid = gidOf(parent);
        String brokerUser = Files.getOwner(parent).getName();
        Files.setAttribute(parent, "unix:mode", 02710);
        Path socket = parent.resolve("broker.sock");

        assertThat(MediaOciBrokerDaemon.parseAllowedPeerGid(Long.toString(peerGid))).isEqualTo(peerGid);
        assertThat(MediaOciBrokerDaemon.workerUsesPeerGroup(peerGid, peerGid)).isTrue();
        assertThat(MediaOciBrokerDaemon.workerUsesPeerGroup(peerGid + 1, peerGid)).isFalse();
        assertThat(MediaOciBrokerDaemon.workerUsesPeerGroup(0, peerGid)).isFalse();
        assertThatThrownBy(() -> MediaOciBrokerDaemon.parseAllowedPeerGid("0"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MediaOciBrokerDaemon.parseAllowedPeerGid("peer"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(MediaOciBrokerDaemon.validateSocketParent(socket, brokerUser, peerGid))
                .isEqualTo(parent.toRealPath());
        assertThatThrownBy(() -> MediaOciBrokerDaemon.validateSocketParent(socket, brokerUser, peerGid + 1))
                .isInstanceOf(java.io.IOException.class)
                .hasMessageContaining("peer-group-owned");
        assertThatThrownBy(() -> MediaOciBrokerDaemon.validateSocketParent(socket, "unrelated-broker", peerGid))
                .isInstanceOf(java.io.IOException.class)
                .hasMessageContaining("owned by the broker");

        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(socket));
            Files.setPosixFilePermissions(socket, PosixFilePermissions.fromString("rw-rw----"));
            MediaOciBrokerDaemon.validateBoundSocket(socket, brokerUser, peerGid);
            assertThatThrownBy(() -> MediaOciBrokerDaemon.validateBoundSocket(socket, brokerUser, peerGid + 1))
                    .isInstanceOf(java.io.IOException.class)
                    .hasMessageContaining("configured peer group");
            Files.setPosixFilePermissions(socket, PosixFilePermissions.fromString("rw-------"));
            assertThatThrownBy(() -> MediaOciBrokerDaemon.validateBoundSocket(socket, brokerUser, peerGid))
                    .isInstanceOf(java.io.IOException.class)
                    .hasMessageContaining("mode 0660");
        }

        Files.setPosixFilePermissions(parent, PosixFilePermissions.fromString("rwx--x---"));
        assertThatThrownBy(() -> MediaOciBrokerDaemon.validateSocketParent(socket, brokerUser, peerGid))
                .isInstanceOf(java.io.IOException.class)
                .hasMessageContaining("mode 02710");
    }

    @Test
    void workerArgsAllowOnlyCurrentExtractorAndBrokerFixtureLaunchPlans() {
        List<String> sourceProbe = List.of("-nostdin", "-protocol_whitelist", "file", "-i",
                "/source/input", "-f", "null", "-");
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("ffmpeg", sourceProbe)).isTrue();
        assertThat(MediaOciBrokerDaemon.sourceProbePairValid("/tmp/source", sourceProbe)).isTrue();
        assertThat(MediaOciBrokerDaemon.sourceProbePairValid(null, sourceProbe)).isFalse();
        assertThat(MediaOciBrokerDaemon.sourceProbePairValid("/tmp/source", List.of("-version"))).isFalse();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("ffmpeg", List.of(
                "-nostdin", "-protocol_whitelist", "file,https", "-i", "/source/input", "-f", "null", "-")))
                .isFalse();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("ffmpeg", List.of(
                "-nostdin", "-hide_banner", "-loglevel", "error", "-i", "/source/input",
                "-y", "/output/frame.png"))).isTrue();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("ffmpeg", List.of(
                "-nostdin", "-v", "info", "-copyts", "-protocol_whitelist", "file",
                "-max_alloc", "268435456", "-max_pixels", "16000000", "-threads", "2",
                "-filter_threads", "1", "-f", "mov", "-i", "/source/input",
                "-threads", "2", "-vf",
                "select='isnan(prev_selected_t)+gte(t-prev_selected_t,1/2)',showinfo,scale='min(4096,iw)':'min(4096,ih)':force_original_aspect_ratio=decrease",
                "-fps_mode", "passthrough", "-enc_time_base", "demux", "-frames:v", "120",
                "-q:v", "2", "/output/frame_%04d.jpg", "-n"))).isTrue();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("ffprobe", List.of(
                "-v", "error", "-protocol_whitelist", "file", "-f", "mov",
                "-max_alloc", "268435456", "-select_streams", "v:0", "-show_entries",
                "stream=width,height,duration,nb_frames,r_frame_rate,time_base", "-of",
                "default=noprint_wrappers=1", "/source/input"))).isTrue();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("ffprobe", List.of(
                "-v", "error", "-protocol_whitelist", "file", "-f", "mov",
                "-max_alloc", "268435456", "-select_streams", "a:0", "-show_entries",
                "stream=index,time_base,start_pts,sample_rate,channels,duration_ts", "-of",
                "default=noprint_wrappers=1", "/source/input"))).isTrue();
    }

    @Test
    void generatedExtractorCommandSurvivesBrokerPathRewriteAndMatchesGrammar() throws Exception {
        Path source = root.resolve("input.mp4");
        Path output = root.resolve("frames");
        List<String> generated = new VideoFrameExtractor().buildFFmpegCommand(source, output,
                VideoFrameExtractor.ExtractionConfig.builder().fps(3).maxFrames(25)
                        .resolution(640, 480).format("png").build());
        List<String> workerArgs = generated.subList(1, generated.size()).stream()
                .map(argument -> argument.equals(source.toString()) ? "/source/input"
                        : argument.startsWith(output.toString() + "/")
                                ? argument.replace(output.toString() + "/", "/output/") : argument)
                .toList();

        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("ffmpeg", workerArgs)).isTrue();
        java.util.ArrayList<String> alteredFilter = new java.util.ArrayList<>(workerArgs);
        int filterArgumentIndex = alteredFilter.indexOf("-vf") + 1;
        alteredFilter.set(filterArgumentIndex, alteredFilter.get(filterArgumentIndex)
                .replace(",showinfo,scale=", ",volume=1,showinfo,scale="));
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("ffmpeg", alteredFilter)).isFalse();
    }

    @Test
    void workerArgsRejectAnythingOutsideTheExactGrammarBeforeWorkerLaunch() {
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("ffmpeg", List.of(
                "-nostdin", "-hide_banner", "-loglevel", "error", "-i", "http://evil/x",
                "-y", "/output/result.out"))).isFalse();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("ffmpeg", List.of(
                "-nostdin", "-hide_banner", "-loglevel", "error", "-i", "s3://bucket/x",
                "-y", "/output/result.out"))).isFalse();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("ffmpeg", List.of(
                "-nostdin", "-hide_banner", "-loglevel", "error", "-i", "/source/input",
                "-y", "/output/result.out", ";", "sh", "-c", "id"))).isFalse();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("ffmpeg", List.of(
                "-nostdin", "-hide_banner", "-loglevel", "error", "-i", "/source/input",
                "-y", "/tmp/extra-output"))).isFalse();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("ffmpeg", List.of(
                "-nostdin", "-hide_banner", "-loglevel", "error", "-i", "/source/input",
                "-filter_complex", "movie=/source/input", "/output/result.out"))).isFalse();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("ffmpeg", List.of(
                "-nostdin", "-hide_banner", "-loglevel", "error", "-i", "/source/input",
                "-y", "/output/result.out", "-protocol_whitelist", "file,https"))).isFalse();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("sh", List.of("-c", "ffmpeg"))).isFalse();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("ffmpeg", List.of(
                "-nostdin", "-hide_banner", "-loglevel", "error", "-i", "/source/../../etc/passwd",
                "-y", "/output/result.out"))).isFalse();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("ffmpeg", List.of(
                "-nostdin", "-hide_banner", "-loglevel", "error", "-i", "/source/input",
                "-filter_script", "/tmp/x"))).isFalse();
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("ffmpeg", List.of(
                "-nostdin", "-hide_banner", "-loglevel", "error", "-i", "/source/input",
                "-y", "/output/result.out", "x".repeat(600)))).isFalse();
    }

    @Test
    void codecFrameAndOutputBudgetsRejectMalformedValuesAtTheBrokerBoundary() {
        List<String> validFrames = List.of(
                "-nostdin", "-v", "info", "-copyts", "-protocol_whitelist", "file",
                "-max_alloc", "268435456", "-max_pixels", "16000000", "-threads", "2",
                "-filter_threads", "1", "-f", "mov", "-i", "/source/input", "-threads", "2",
                "-vf", "select='isnan(prev_selected_t)+gte(t-prev_selected_t,1/2)',showinfo,"
                        + "scale='min(4096,iw)':'min(4096,ih)':force_original_aspect_ratio=decrease",
                "-fps_mode", "passthrough", "-enc_time_base", "demux", "-frames:v", "10000",
                "-q:v", "31", "/output/frame_%04d.jpg", "-n");
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("ffmpeg", validFrames))
                .as("the declared frame-count and quality ceilings are accepted").isTrue();
        java.util.ArrayList<String> excessiveFrames = new java.util.ArrayList<>(validFrames);
        excessiveFrames.set(27, "10001");
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("ffmpeg", excessiveFrames))
                .as("a codec request cannot exceed the declared frame count").isFalse();
        java.util.ArrayList<String> excessiveQuality = new java.util.ArrayList<>(validFrames);
        excessiveQuality.set(29, "32");
        assertThat(MediaOciBrokerPolicy.workerArgsAllowed("ffmpeg", excessiveQuality))
                .as("a codec request cannot exceed the declared quality range").isFalse();

        assertThat(MediaOciBrokerPolicy.outputLimitAllowed("ffmpeg", List.of("/output/frame.png"),
                MediaOciBrokerPolicy.MAX_VISION_FRAME_BYTES)).isTrue();
        assertThat(MediaOciBrokerPolicy.outputLimitAllowed("ffmpeg", List.of("/output/frame.png"),
                MediaOciBrokerPolicy.MAX_VISION_FRAME_BYTES + 1)).isFalse();
        assertThat(MediaOciBrokerPolicy.outputLimitAllowed("ffmpeg", List.of("/output/audio.pcm"),
                MediaOciBrokerPolicy.MAX_VISION_AUDIO_BYTES)).isTrue();
        assertThat(MediaOciBrokerPolicy.outputLimitAllowed("ffmpeg", List.of("/output/audio.pcm"),
                MediaOciBrokerPolicy.MAX_VISION_AUDIO_BYTES + 1)).isFalse();
    }

    @Test
    void nonceReplayIsRejectedAndTimestampMustBeCurrent() throws Exception {
        var guard = new MediaOciBrokerPolicy.NonceReplayGuard();
        long now = System.currentTimeMillis();
        assertThat(guard.admit("nonce-a-16-bytes-long", now, now)).isTrue();
        assertThat(guard.admit("nonce-a-16-bytes-long", now, now)).as("replay").isFalse();
        assertThat(guard.admit("nonce-b-16-bytes-long", now, now)).isTrue();
        assertThat(guard.admit("nonce-c-16-bytes-long",
                now + MediaOciBrokerPolicy.MAX_REQUEST_SKEW_MS + 1, now)).isFalse();
        assertThat(guard.admit("short", now, now)).isFalse();
    }

    @Test
    void nonceWindowFailsClosedAtCapacityAndReleasesOnlyAfterTimestampExpiry() throws Exception {
        var guard = new MediaOciBrokerPolicy.NonceReplayGuard();
        long now = System.currentTimeMillis();
        String firstNonce = "nonce-replay-window-0";
        for (int i = 0; i < MediaOciBrokerPolicy.MAX_NONCE_CACHE; i++) {
            String nonce = "nonce-replay-window-" + i;
            if (!guard.admit(nonce, now, now)) throw new AssertionError("valid unique nonce was not admitted");
        }

        assertThat(guard.admit("nonce-replay-window-extra", now, now))
                .as("capacity must fail closed rather than evict a live nonce")
                .isFalse();
        assertThat(guard.admit(firstNonce, now, now)).as("oldest nonce remains a replay").isFalse();

        long expiredNow = now + MediaOciBrokerPolicy.MAX_REQUEST_SKEW_MS + 1;
        assertThat(guard.admit("nonce-replay-window-after-expiry", expiredNow, expiredNow))
                .as("expired entries free bounded capacity")
                .isTrue();
    }

    @Test
    void sourceRequiresOwnershipInsideRootAndMatchingDigest() throws Exception {
        var policy = policy();
        Files.setAttribute(root, "unix:mode", 02750);
        Path source = root.resolve("input.bin");
        byte[] bytes = "verify".getBytes();
        Files.write(source, bytes);
        Files.setPosixFilePermissions(source, PosixFilePermissions.fromString("r--r-----"));
        assertThat(((Number) Files.getAttribute(root, "unix:mode")).intValue() & 07777).isEqualTo(02750);
        assertThat(((Number) Files.getAttribute(source, "unix:mode")).intValue() & 0777).isEqualTo(0440);
        String sha = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(bytes));

        assertThat(MediaOciBrokerPolicy.sourceAllowed(policy, source.toString(), sha)).isTrue();
        assertThat(MediaOciBrokerPolicy.sourceAllowed(policy, source.toString(), null)).isFalse();
        assertThat(MediaOciBrokerPolicy.sourceAllowed(policy, source.toString(),
                "b".repeat(64))).as("digest mismatch").isFalse();
        assertThat(MediaOciBrokerPolicy.sourceAllowed(policy, "/etc/hosts", sha))
                .as("outside source root").isFalse();
        Path link = root.resolve("link.bin");
        Files.createSymbolicLink(link, source);
        assertThat(MediaOciBrokerPolicy.sourceAllowed(policy, link.toString(), sha))
                .as("symlink").isFalse();
        Path realDirectory = Files.createDirectory(root.resolve("real-dir"));
        Files.setAttribute(realDirectory, "unix:mode", 02750);
        Path nestedSource = realDirectory.resolve("nested.bin");
        Files.write(nestedSource, bytes);
        Files.setPosixFilePermissions(nestedSource, PosixFilePermissions.fromString("r--r-----"));
        Path parentAlias = root.resolve("aliased-dir");
        Files.createSymbolicLink(parentAlias, realDirectory);
        assertThat(MediaOciBrokerPolicy.sourceAllowed(policy,
                parentAlias.resolve("nested.bin").toString(), sha))
                .as("parent-directory symlink must not alias an admitted source path").isFalse();
        assertThat(MediaOciBrokerPolicy.sourceAllowed(policy, null, null)).isTrue();
        assertThat(MediaOciBrokerPolicy.sourceAllowed(policy, null, "a".repeat(64)))
                .as("source-free probes cannot carry a detached source digest").isFalse();
    }

    @Test
    void outputRejectsNestedParentDirectorySymlink() throws Exception {
        var policy = policy();
        Path realOutput = Files.createDirectory(root.resolve("media-vision-output-" + java.util.UUID.randomUUID()));
        Files.setAttribute(realOutput, "unix:mode", 02770);
        Path alias = root.resolve("output-alias");
        Files.createSymbolicLink(alias, realOutput);

        assertThat(MediaOciBrokerPolicy.outputAllowed(policy, realOutput.toString())).isTrue();
        assertThat(MediaOciBrokerPolicy.outputAllowed(policy, alias.toString()))
                .as("parent-directory symlink must not alias an admitted output directory")
                .isFalse();
    }

    @Test
    void outputRootAndPerInvocationDirectoryRequirePinnedOwnerAndModes() throws Exception {
        long uid = uidOf(root);
        long gid = gidOf(root);
        Files.setAttribute(root, "unix:mode", 02750);
        Path outputRoot = MediaOciBrokerPolicy.validateSharedOutputRoot(root, uid, gid);
        assertThat(outputRoot).isEqualTo(root.toRealPath());
        Path output = Files.createDirectory(root.resolve("media-vision-output-" + java.util.UUID.randomUUID()));
        Files.setAttribute(output, "unix:mode", 02770);
        assertThat(output.toRealPath().getParent()).isEqualTo(root.toRealPath());
        assertThat(uidOf(output)).isEqualTo(uid);
        assertThat(gidOf(output)).isEqualTo(gid);
        assertThat(((Number) Files.getAttribute(output, "unix:mode")).intValue() & 07777).isEqualTo(02770);
        assertThat(output.getFileName().toString()).matches("media-vision-output-[a-f0-9-]{36}");
        assertThat(MediaOciBrokerPolicy.outputAllowed(
                new MediaOciBrokerPolicy.Policy(Set.of(), uid, gid, outputRoot, outputRoot), output.toString())).isTrue();
        assertThat(MediaOciBrokerPolicy.outputAllowed(
                new MediaOciBrokerPolicy.Policy(Set.of(), uid + 1, gid, outputRoot, outputRoot), output.toString())).isFalse();
        assertThat(MediaOciBrokerPolicy.outputAllowed(
                new MediaOciBrokerPolicy.Policy(Set.of(), uid, gid + 1, outputRoot, outputRoot), output.toString())).isFalse();
        Files.setPosixFilePermissions(output, PosixFilePermissions.fromString("rwxr-x---"));
        assertThat(MediaOciBrokerPolicy.outputAllowed(
                new MediaOciBrokerPolicy.Policy(Set.of(), uid, gid, outputRoot, outputRoot), output.toString())).isFalse();
        Files.setAttribute(output, "unix:mode", 02770);
        Files.writeString(output.resolve("unexpected"), "x");
        assertThat(MediaOciBrokerPolicy.outputAllowed(
                new MediaOciBrokerPolicy.Policy(Set.of(), uid, gid, outputRoot, outputRoot), output.toString())).isFalse();
        Files.delete(output.resolve("unexpected"));
        Files.setPosixFilePermissions(output, PosixFilePermissions.fromString("rwx------"));
        assertThat(MediaOciBrokerPolicy.outputAllowed(
                new MediaOciBrokerPolicy.Policy(Set.of(), uid, gid, outputRoot, outputRoot), output.toString())).isFalse();
    }

    @Test
    void credentialFileMustBeOwnerOnly() throws Exception {
        Path token = root.resolve("token");
        Files.writeString(token, "x".repeat(64));
        Files.setPosixFilePermissions(token, java.util.Set.of(
                java.nio.file.attribute.PosixFilePermission.OWNER_READ,
                java.nio.file.attribute.PosixFilePermission.OWNER_WRITE));
        assertThat(MediaOciBrokerPolicy.ownerOnlyFile(token)).isTrue();
        Files.setPosixFilePermissions(token, java.util.Set.of(
                java.nio.file.attribute.PosixFilePermission.OWNER_READ,
                java.nio.file.attribute.PosixFilePermission.OWNER_WRITE,
                java.nio.file.attribute.PosixFilePermission.GROUP_READ));
        assertThat(MediaOciBrokerPolicy.ownerOnlyFile(token)).isFalse();
    }

    @Test
    void brokerDoesNotTreatFailedForceRemovalAsSuccessfulCleanup() throws Exception {
        Path dockerStub = root.resolve("docker-rm-fails");
        Files.writeString(dockerStub, "#!/bin/sh\nexit 7\n");
        Files.setPosixFilePermissions(dockerStub, Set.of(
                java.nio.file.attribute.PosixFilePermission.OWNER_READ,
                java.nio.file.attribute.PosixFilePermission.OWNER_WRITE,
                java.nio.file.attribute.PosixFilePermission.OWNER_EXECUTE));

        assertThatThrownBy(() -> MediaOciBrokerDaemon.remove(dockerStub.toString(), "a".repeat(64)))
                .isInstanceOf(java.io.IOException.class)
                .hasMessageContaining("could not confirm worker container cleanup");
    }

    @Test
    void brokerRequiresSuccessfulExactOomStateReadback() throws Exception {
        assertThat(MediaOciBrokerDaemon.parseOomKilledState(0, "true\n", false)).isTrue();
        assertThat(MediaOciBrokerDaemon.parseOomKilledState(0, "false\n", false)).isFalse();

        assertThatThrownBy(() -> MediaOciBrokerDaemon.parseOomKilledState(9, "false", false))
                .isInstanceOf(java.io.IOException.class)
                .hasMessageContaining("could not confirm worker OOM state");
        assertThatThrownBy(() -> MediaOciBrokerDaemon.parseOomKilledState(0, "false", true))
                .isInstanceOf(java.io.IOException.class)
                .hasMessageContaining("could not confirm worker OOM state");
        assertThatThrownBy(() -> MediaOciBrokerDaemon.parseOomKilledState(0, "", false))
                .isInstanceOf(java.io.IOException.class)
                .hasMessageContaining("invalid worker OOM state");
    }

    @Test
    void processOutputCaptureBoundsLongUnbrokenDiagnosticAndDrainsThePipe() throws Exception {
        int captureLimit = 64;
        ByteArrayInputStream output = new ByteArrayInputStream("x".repeat(64 * 1024)
                .getBytes(java.nio.charset.StandardCharsets.UTF_8));
        StringBuffer captured = new StringBuffer();

        MediaOciBrokerDaemon.drainBoundedOutput(output, captured, captureLimit);

        assertThat(captured).hasSize(captureLimit);
        assertThat(captured.toString()).isEqualTo("x".repeat(captureLimit));
        assertThat(output.read()).isEqualTo(-1);
    }
}
