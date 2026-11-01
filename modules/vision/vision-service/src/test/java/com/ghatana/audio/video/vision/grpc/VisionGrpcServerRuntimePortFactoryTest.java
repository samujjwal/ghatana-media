package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.AudioVideoGrpcServerBase;
import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.vision.model.VisionModelProfile;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.audio.video.vision.yolo.YoloV8Adapter;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaRuntimePortFactory;
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
    void missingFactoryLeavesRuntimeNotAdmittedAndAmbiguousFactoriesFailClosed() {
        assertThat(VisionGrpcServer.composeRuntimePort(Map.of(), List.of())).isNull();
        MediaRuntimePortFactory first = factory("first", mock(MediaProcessingRuntimePort.class));
        MediaRuntimePortFactory second = factory("second", mock(MediaProcessingRuntimePort.class));
        assertThatThrownBy(() -> VisionGrpcServer.composeRuntimePort(Map.of(), List.of(first, second)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Multiple MediaRuntimePortFactory");
    }

    @Test
    void standaloneOcrOnlyServerDiscoversFactoryStartsAndClosesComposedPort(@org.junit.jupiter.api.io.TempDir Path temp)
            throws Exception {
        MediaProcessingRuntimePort port = mock(MediaProcessingRuntimePort.class,
                org.mockito.Mockito.withSettings().extraInterfaces(AutoCloseable.class));
        RegisteredTestFactory.runtimePort = port;
        Path serviceFile = temp.resolve("META-INF/services/" + MediaRuntimePortFactory.class.getName());
        Files.createDirectories(serviceFile.getParent());
        Files.writeString(serviceFile, RegisteredTestFactory.class.getName() + "\n");
        MediaProcessingRuntimePort composed;
        try (URLClassLoader serviceLoaderClassLoader = new URLClassLoader(
                new URL[] {temp.toUri().toURL()}, getClass().getClassLoader())) {
            composed = VisionGrpcServer.composeRuntimePort(ocrEnvironment(), serviceLoaderClassLoader);
        }
        assertThat(composed).isSameAs(port);

        var environment = ocrEnvironment();
        var service = new ProductionVisionGrpcService(
                ProductionVisionGrpcService.compose(environment, composed), MediaProcessingMetrics.create(),
                new SimpleMeterRegistry(), composed);
        service.ownRuntimePort(composed);
        var readiness = VisionGrpcServer.createReadinessLifecycle(new SimpleMeterRegistry(), service::isProviderReady);
        service.setReadinessProbe(readiness::isServing);
        var server = new VisionGrpcServer(freePort(), AudioVideoGrpcServerBase.TransportSecurity.plaintext(),
                service, readiness);
        try {
            server.start();
            assertThat(server.isShutdown()).isFalse();
            assertThat(server.isReady()).isFalse();
        } finally {
            server.close();
        }
        assertThat(server.isShutdown()).isTrue();
        verify((AutoCloseable) port).close();
        RegisteredTestFactory.runtimePort = null;
    }

    @Test
    void failedStandaloneBindClosesFactoryOwnedPort() throws Exception {
        try (ServerSocket occupied = new ServerSocket(0)) {
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
            var server = new VisionGrpcServer(occupied.getLocalPort(),
                    AudioVideoGrpcServerBase.TransportSecurity.plaintext(), service, readiness);
            assertThatThrownBy(server::start).isInstanceOf(java.io.IOException.class);
            assertThat(server.isShutdown()).isTrue();
            verify((AutoCloseable) port).close();
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
                "VISION_CAPABILITY_PROFILE", "OCR_ONLY",
                "DI_ENDPOINT", "http://127.0.0.1:9000",
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
