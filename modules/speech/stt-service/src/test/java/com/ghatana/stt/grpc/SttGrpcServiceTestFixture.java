package com.ghatana.stt.grpc;

import com.ghatana.media.AudioVideoLibrary;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.Objects;

/** Test-source-only factory for a service with an explicit fixture admission decision. */
public final class SttGrpcServiceTestFixture {
    private SttGrpcServiceTestFixture() { }

    public static SttGrpcService create(AudioVideoLibrary library, MeterRegistry metrics) {
        return new SttGrpcService(Objects.requireNonNull(library, "library"),
                Objects.requireNonNull(metrics, "metrics"),
                request -> SttRequestAuthorization.Decision.ADMITTED);
    }
}
