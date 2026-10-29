package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaRuntimePortFactory;

import java.util.Map;

/**
 * Canonical Media runtime composition exposed to standalone modality gRPC servers.
 *
 * <p>Delegates to {@link MediaRuntime#compose(Map)} so store/provider/rights readiness,
 * production eligibility, durability, and resource limits cannot be bypassed by a
 * modality entrypoint. Composition failures propagate so a server cannot start against
 * a half-initialized runtime; the returned port is the {@link MediaRuntime} itself and
 * is {@link AutoCloseable} by the composing caller.</p>
 *
 * @doc.type class
 * @doc.purpose ServiceLoader factory that composes the real Media runtime port
 * @doc.layer product
 * @doc.pattern SPI, ServiceLoader
 */
public final class ComposedMediaRuntimePortFactory implements MediaRuntimePortFactory {

    @Override
    public String factoryId() {
        return "media-runtime";
    }

    @Override
    public MediaProcessingRuntimePort compose(Map<String, String> environment) {
        return MediaRuntime.compose(environment);
    }
}
