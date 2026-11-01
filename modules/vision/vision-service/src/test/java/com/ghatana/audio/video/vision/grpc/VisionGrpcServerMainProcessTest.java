package com.ghatana.audio.video.vision.grpc;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.net.ServerSocket;
import java.net.HttpURLConnection;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/** Process-boundary check of main/factory/bind/shutdown wiring only; it does not qualify OCR. */
class VisionGrpcServerMainProcessTest {
    @Test
    void mainDiscoversTestFactoryBindsRemainsNotServingAndClosesPortOnProcessShutdown(
            @TempDir Path tempDirectory) throws Exception {
        int port = freePort();
        int healthPort = freePort();
        Path serviceDirectory = tempDirectory.resolve("provider");
        Path serviceFile = serviceDirectory.resolve(
                "META-INF/services/com.ghatana.media.runtime.MediaRuntimePortFactory");
        Files.createDirectories(serviceFile.getParent());
        Files.writeString(serviceFile, StandaloneProcessTestRuntimePortFactory.class.getName() + "\n");
        Path closeMarker = tempDirectory.resolve("runtime-port-closed");

        ProcessBuilder builder = new ProcessBuilder(
                javaExecutable(),
                "-cp",
                System.getProperty("java.class.path") + System.getProperty("path.separator") + serviceDirectory,
                VisionGrpcServer.class.getName())
                .directory(tempDirectory.toFile())
                .redirectErrorStream(true)
                .redirectOutput(tempDirectory.resolve("vision-child.log").toFile());
        builder.environment().putAll(Map.ofEntries(
                Map.entry("VISION_CAPABILITY_PROFILE", "OCR_ONLY"),
                Map.entry("VISION_GRPC_PORT", Integer.toString(port)),
                Map.entry("AV_HEALTH_PORT", Integer.toString(healthPort)),
                Map.entry("DI_ENDPOINT", "http://127.0.0.1:9"),
                Map.entry("DI_PROVIDER_REF", "test-only-unadmitted-provider"),
                Map.entry("DI_PROVIDER_VERSION", "1"),
                Map.entry("DI_MODEL_REF", "test-only-unadmitted-model"),
                Map.entry("DI_MODEL_VERSION", "1"),
                Map.entry("DI_ACCEPTED_MEDIA_TYPES", "image/png"),
                Map.entry("DI_ACCEPTED_LANGUAGES", "en"),
                Map.entry("VISION_TEST_PORT_CLOSE_MARKER", closeMarker.toString()),
                Map.entry("AV_JWT_SECRET", "vision-main-process-test-secret")));

        Process process = builder.start();
        try {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
            String response = null;
            while (System.nanoTime() < deadline && process.isAlive()) {
                HttpURLConnection connection = null;
                try {
                    connection = (HttpURLConnection) java.net.URI.create(
                            "http://127.0.0.1:" + healthPort + "/health").toURL().openConnection();
                    connection.setConnectTimeout(250);
                    connection.setReadTimeout(500);
                    int status = connection.getResponseCode();
                    response = status + " " + new String(
                            (status < 400 ? connection.getInputStream() : connection.getErrorStream()).readAllBytes(),
                            java.nio.charset.StandardCharsets.UTF_8);
                    break;
                } catch (java.io.IOException notReadyYet) {
                    Thread.sleep(50);
                } finally {
                    if (connection != null) connection.disconnect();
                }
            }
            assertThat(process.isAlive()).as("Vision main child stays running after binding").isTrue();
            assertThat(response).as("health endpoint responds after main binds; child log: %s",
                    Files.readString(tempDirectory.resolve("vision-child.log"))).isNotNull();
            assertThat(response).as("unadmitted test factory keeps readiness down")
                    .contains("503", "\"status\":\"DOWN\"");
        } finally {
            process.destroy();
            if (!process.waitFor(10, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
            }
        }
        assertThat(process.exitValue()).as("child received process shutdown").isIn(0, 143);
        assertThat(Files.readString(closeMarker)).isEqualTo("closed");
    }

    private static int freePort() throws Exception {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    private static String javaExecutable() {
        return Path.of(System.getProperty("java.home"), "bin", "java").toString();
    }
}
