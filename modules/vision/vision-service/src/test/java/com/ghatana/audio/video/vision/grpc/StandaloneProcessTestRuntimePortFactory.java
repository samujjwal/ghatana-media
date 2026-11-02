package com.ghatana.audio.video.vision.grpc;

import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaRuntimePortFactory;

import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Optional;

/** Test-only provider for the standalone Vision child-process lifecycle test. */
public final class StandaloneProcessTestRuntimePortFactory implements MediaRuntimePortFactory {
    @Override
    public String factoryId() {
        return "vision-standalone-process-test-only";
    }

    @Override
    public MediaProcessingRuntimePort compose(Map<String, String> environment) {
        String composedMarker = environment.get("VISION_TEST_PORT_COMPOSED_MARKER");
        if (composedMarker != null && !composedMarker.isBlank()) {
            try {
                Files.writeString(Path.of(composedMarker), "composed");
            } catch (java.io.IOException failure) {
                throw new IllegalStateException("could not record test runtime port composition", failure);
            }
        }
        String marker = environment.get("VISION_TEST_PORT_CLOSE_MARKER");
        if (marker == null || marker.isBlank()) {
            throw new IllegalStateException("test close marker is required");
        }
        return (MediaProcessingRuntimePort) Proxy.newProxyInstance(
                MediaProcessingRuntimePort.class.getClassLoader(),
                new Class<?>[] {MediaProcessingRuntimePort.class, AutoCloseable.class},
                (proxy, method, args) -> {
                    if (method.getDeclaringClass() == Object.class) {
                        return switch (method.getName()) {
                            case "toString" -> "unadmitted-vision-process-test-port";
                            case "hashCode" -> System.identityHashCode(proxy);
                            case "equals" -> proxy == args[0];
                            default -> null;
                        };
                    }
                    if (method.getName().equals("close")) {
                        Files.writeString(Path.of(marker), "closed");
                        return null;
                    }
                    if (method.getReturnType() == Optional.class) return Optional.empty();
                    if (method.getReturnType() == boolean.class) return false;
                    return null;
                });
    }
}
