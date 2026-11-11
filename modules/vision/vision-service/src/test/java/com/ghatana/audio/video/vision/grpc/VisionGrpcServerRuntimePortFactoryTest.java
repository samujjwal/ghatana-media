package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.AudioVideoGrpcServerBase;
import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.vision.model.VisionModelProfile;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.audio.video.vision.yolo.YoloV8Adapter;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaRuntimePortFactory;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;

import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

public class VisionGrpcServerRuntimePortFactoryTest {
    public static final class RegisteredTestFactory implements MediaRuntimePortFactory {
        static MediaProcessingRuntimePort runtimePort;
        @Override public String factoryId() { return "vision-service-loader-test"; }
        @Override public MediaProcessingRuntimePort compose(Map<String, String> environment) {
            return runtimePort;
        }
    }
    public static final class FailingTestFactory implements MediaRuntimePortFactory {
        @Override public String factoryId() { return "vision-service-loader-failure-test"; }
        @Override public MediaProcessingRuntimePort compose(Map<String, String> environment) {
            throw new IllegalStateException("test runtime provider failure");
        }
    }
    private String previousSecret;

    @BeforeEach void configureLocalAuth() {
        previousSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", "vision-runtime-port-test-secret");
    }

    @AfterEach void restoreLocalAuth() {
        if (previousSecret == null) System.clearProperty("AV_JWT_SECRET");
        else System.setProperty("AV_JWT_SECRET", previousSecret);
    }

    @Test
    void missingFactoryAndAmbiguousFactoriesFailClosed() {
        assertThatThrownBy(() -> VisionGrpcServer.composeRuntimePort(Map.of(), List.of()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("exactly one MediaRuntimePortFactory")
                .hasMessageContaining("none is installed");
        MediaRuntimePortFactory first = factory("first", mock(MediaProcessingRuntimePort.class));
        MediaRuntimePortFactory second = factory("second", mock(MediaProcessingRuntimePort.class));
        assertThatThrownBy(() -> VisionGrpcServer.composeRuntimePort(Map.of(), List.of(first, second)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Multiple MediaRuntimePortFactory");
    }

    @Test
    void fullVisionMayOmitSceneTextRuntimeWhileOcrOnlyRequiresSourceAuthority() {
        assertThat(VisionGrpcServer.composeRuntimePortForProfile(
                Map.of("VISION_CAPABILITY_PROFILE", "FULL_VISION"), List.of())).isNull();
        assertThatThrownBy(() -> VisionGrpcServer.composeRuntimePortForProfile(
                Map.of("VISION_CAPABILITY_PROFILE", "OCR_ONLY"), List.of()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("exactly one MediaRuntimePortFactory");
    }

    @Test
    void standaloneOcrOnlyServerDiscoversFactoryStartsAndClosesComposedPort(@org.junit.jupiter.api.io.TempDir Path temp)
            throws Exception {
        MediaProcessingRuntimePort port = mock(MediaProcessingRuntimePort.class,
                org.mockito.Mockito.withSettings().extraInterfaces(AutoCloseable.class));
        when(port.processingReady(JobType.VISION)).thenReturn(false);
        RegisteredTestFactory.runtimePort = port;
        Path serviceFile = temp.resolve("META-INF/services/" + MediaRuntimePortFactory.class.getName());
        Files.createDirectories(serviceFile.getParent());
        Files.writeString(serviceFile, RegisteredTestFactory.class.getName() + "\n");
        var environment = new java.util.HashMap<>(ocrEnvironment());
        int portNumber = freePort();
        environment.put("VISION_GRPC_PORT", Integer.toString(portNumber));
        VisionGrpcServer server;
        try (URLClassLoader serviceLoaderClassLoader = new URLClassLoader(
                new URL[] {temp.toUri().toURL()}, getClass().getClassLoader())) {
            server = VisionGrpcServer.createStandaloneServer(environment, serviceLoaderClassLoader);
        }
        try {
            server.start();
            assertThat(server.isShutdown()).isFalse();
            assertThat(server.isReady()).isFalse();
            assertThat(server.getPort()).isEqualTo(portNumber);
        } finally {
            server.close();
        }
        assertThat(server.isShutdown()).isTrue();
        verify((AutoCloseable) port).close();
        verify(port, times(0)).processingReady(JobType.VISION);
        RegisteredTestFactory.runtimePort = null;
    }

    @Test
    void standaloneOcrOnlyWithoutFactoryFailsBeforeBinding() throws Exception {
        var environment = new java.util.HashMap<>(ocrEnvironment());
        int portNumber = freePort();
        environment.put("VISION_GRPC_PORT", Integer.toString(portNumber));
        try (URLClassLoader withoutFactory = new URLClassLoader(new URL[0], null)) {
            assertThatThrownBy(() -> VisionGrpcServer.createStandaloneServer(environment, withoutFactory))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("exactly one MediaRuntimePortFactory");
        }
        try (Socket ignored = new Socket("127.0.0.1", portNumber)) {
            throw new AssertionError("server unexpectedly bound without the canonical runtime factory");
        } catch (java.io.IOException expected) {
            // A failed standalone composition must not expose a listener.
        }
    }

    @Test
    void standaloneOcrOnlyProviderFailurePropagatesBeforeBinding(@org.junit.jupiter.api.io.TempDir Path temp)
            throws Exception {
        writeFactoryService(temp, FailingTestFactory.class);
        var environment = new java.util.HashMap<>(ocrEnvironment());
        try (URLClassLoader loader = new URLClassLoader(new URL[] {temp.toUri().toURL()}, getClass().getClassLoader())) {
            assertThatThrownBy(() -> VisionGrpcServer.createStandaloneServer(environment, loader))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessage("test runtime provider failure");
        }
    }

    @Test
    void startupCompositionFailureClosesFactoryOwnedRuntimePort(@org.junit.jupiter.api.io.TempDir Path temp)
            throws Exception {
        MediaProcessingRuntimePort port = mock(MediaProcessingRuntimePort.class,
                org.mockito.Mockito.withSettings().extraInterfaces(AutoCloseable.class));
        RegisteredTestFactory.runtimePort = port;
        writeFactoryService(temp, RegisteredTestFactory.class);
        var environment = new java.util.HashMap<>(ocrEnvironment());
        environment.remove("DI_ENDPOINT");
        try (URLClassLoader loader = new URLClassLoader(new URL[] {temp.toUri().toURL()}, getClass().getClassLoader())) {
            assertThatThrownBy(() -> VisionGrpcServer.createStandaloneServer(environment, loader))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("DI_ENDPOINT");
        } finally {
            RegisteredTestFactory.runtimePort = null;
        }
        verify((AutoCloseable) port).close();
    }

    @Test
    void failedStandaloneBindClosesFactoryOwnedPort() throws Exception {
        int occupiedPort = freePort();
        io.grpc.Server occupied = io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder.forAddress(
                        new java.net.InetSocketAddress(
                                java.net.InetAddress.getByAddress(new byte[] {127, 0, 0, 1}), occupiedPort))
                .addService(io.grpc.ServerServiceDefinition.builder("test.PortOccupier").build())
                .build()
                .start();
        try {
            MediaProcessingRuntimePort port = mock(MediaProcessingRuntimePort.class,
                    org.mockito.Mockito.withSettings().extraInterfaces(AutoCloseable.class));
            MediaProcessingRuntimePort composed = VisionGrpcServer.composeRuntimePort(Map.of(),
                    List.of(factory("vision-bind-failure", port)));
            YoloV8Adapter detector = mock(YoloV8Adapter.class);
            var profile = new VisionModelProfile("fixture", "test", Path.of("/unused"),
                    Path.of("/unused/model.onnx"), "a".repeat(64), "test-only", List.of("object"),
                    VisionModelProfile.Device.CPU, 1L);
            var service = new ProductionVisionGrpcService(
                    new ProductionVisionGrpcService.Composition(detector, new VideoFrameExtractor(), profile),
                    MediaProcessingMetrics.create(), new SimpleMeterRegistry(), composed);
            service.ownRuntimePort(composed);
            var readiness = VisionGrpcServer.createReadinessLifecycle(new SimpleMeterRegistry(), service::isProviderReady);
            service.setReadinessProbe(readiness::isServing);
            var server = new VisionGrpcServer(occupiedPort,
                    AudioVideoGrpcServerBase.TransportSecurity.plaintext(), service, readiness);
            assertThatThrownBy(server::start).isInstanceOf(java.io.IOException.class);
            assertThat(server.isShutdown()).isTrue();
            verify((AutoCloseable) port).close();
        } finally {
            occupied.shutdownNow();
            occupied.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS);
        }
    }

    @Test
    void interruptedAwaitClosesServerAndOwnedRuntimePortOnce() throws Exception {
        MediaProcessingRuntimePort port = mock(MediaProcessingRuntimePort.class,
                org.mockito.Mockito.withSettings().extraInterfaces(AutoCloseable.class));
        YoloV8Adapter detector = mock(YoloV8Adapter.class);
        var profile = new VisionModelProfile("fixture", "test", Path.of("/unused"),
                Path.of("/unused/model.onnx"), "a".repeat(64), "test-only", List.of("object"),
                VisionModelProfile.Device.CPU, 1L);
        var service = new ProductionVisionGrpcService(
                new ProductionVisionGrpcService.Composition(detector, new VideoFrameExtractor(), profile),
                MediaProcessingMetrics.create(), new SimpleMeterRegistry(), port);
        service.ownRuntimePort(port);
        var readiness = VisionGrpcServer.createReadinessLifecycle(new SimpleMeterRegistry(), service::isProviderReady);
        service.setReadinessProbe(readiness::isServing);
        int portNumber = freePort();
        var server = new VisionGrpcServer(portNumber, AudioVideoGrpcServerBase.TransportSecurity.plaintext(),
                service, readiness);
        AtomicReference<Throwable> awaitResult = new AtomicReference<>();
        Thread awaiter = new Thread(() -> {
            try { VisionGrpcServer.startAndAwaitShutdown(server); }
            catch (Throwable failure) { awaitResult.set(failure); }
        }, "vision-interrupted-await-test");
        awaiter.start();
        waitForListener(portNumber);
        awaiter.interrupt();
        awaiter.join(5_000);
        assertThat(awaiter.isAlive()).isFalse();
        assertThat(awaitResult.get()).isInstanceOf(InterruptedException.class);
        assertThat(server.isShutdown()).isTrue();
        verify((AutoCloseable) port, times(1)).close();
    }

    @Test
    void ownedRuntimePortClosesEvenWhenDetectorCloseThrows() throws Exception {
        MediaProcessingRuntimePort port = mock(MediaProcessingRuntimePort.class,
                org.mockito.Mockito.withSettings().extraInterfaces(AutoCloseable.class));
        YoloV8Adapter detector = mock(YoloV8Adapter.class);
        org.mockito.Mockito.doThrow(new IllegalStateException("detector close failed"))
                .when(detector).close();
        var profile = new VisionModelProfile("fixture", "test", Path.of("/unused"),
                Path.of("/unused/model.onnx"), "a".repeat(64), "test-only", List.of("object"),
                VisionModelProfile.Device.CPU, 1L);
        var service = new ProductionVisionGrpcService(
                new ProductionVisionGrpcService.Composition(detector, new VideoFrameExtractor(), profile),
                MediaProcessingMetrics.create(), new SimpleMeterRegistry(), port);
        service.ownRuntimePort(port);
        assertThatThrownBy(service::close).isInstanceOf(IllegalStateException.class)
                .hasMessage("detector close failed");
        verify((AutoCloseable) port).close();
    }

    @Test
    void ownedRuntimePortClosesEvenWhenSceneTextCloseThrows() throws Exception {
        MediaProcessingRuntimePort port = mock(MediaProcessingRuntimePort.class,
                org.mockito.Mockito.withSettings().extraInterfaces(AutoCloseable.class));
        var sceneText = mock(ProductionVisionGrpcService.SceneTextBinding.class);
        when(sceneText.service()).thenReturn(mock(
                com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.class));
        when(sceneText.workers()).thenReturn(mock(java.util.concurrent.ExecutorService.class));
        org.mockito.Mockito.doThrow(new IllegalStateException("scene text close failed"))
                .when(sceneText).close();
        var composition = new ProductionVisionGrpcService.Composition(null, new VideoFrameExtractor(), null,
                com.ghatana.audio.video.vision.model.VisionCapabilityProfile.OCR_ONLY, sceneText);
        var service = new ProductionVisionGrpcService(composition, MediaProcessingMetrics.create(),
                new SimpleMeterRegistry(), port);
        service.ownRuntimePort(port);
        assertThatThrownBy(service::close).isInstanceOf(IllegalStateException.class)
                .hasMessage("scene text close failed");
        verify((AutoCloseable) port).close();
    }

    private static Map<String, String> ocrEnvironment() {
        return Map.of(
                "VISION_ENVIRONMENT", "local",
                "VISION_CAPABILITY_PROFILE", "OCR_ONLY",
                "DI_ENDPOINT", "http://127.0.0.1:9000",
                "DI_ALLOWED_HOSTS", "127.0.0.1",
                "DI_PROVIDER_REF", "fixture-provider",
                "DI_PROVIDER_VERSION", "1",
                "DI_MODEL_REF", "fixture-model",
                "DI_MODEL_VERSION", "1",
                "DI_ACCEPTED_MEDIA_TYPES", "image/png",
                "DI_ACCEPTED_LANGUAGES", "en");
    }

    private static MediaRuntimePortFactory factory(String id, MediaProcessingRuntimePort port) {
        return new MediaRuntimePortFactory() {
            @Override public String factoryId() { return id; }
            @Override public MediaProcessingRuntimePort compose(Map<String, String> environment) { return port; }
        };
    }

    private static Path writeFactoryService(Path root, Class<? extends MediaRuntimePortFactory> factory)
            throws Exception {
        Path serviceFile = root.resolve("META-INF/services/" + MediaRuntimePortFactory.class.getName());
        Files.createDirectories(serviceFile.getParent());
        Files.writeString(serviceFile, factory.getName() + "\n");
        return serviceFile;
    }

    private static int freePort() throws Exception {
        try (ServerSocket socket = new ServerSocket(0)) { return socket.getLocalPort(); }
    }

    private static void waitForListener(int port) throws Exception {
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            try (Socket ignored = new Socket("127.0.0.1", port)) { return; }
            catch (java.io.IOException unavailable) { Thread.sleep(25); }
        }
        throw new AssertionError("Vision gRPC listener did not start on port " + port);
    }
}
