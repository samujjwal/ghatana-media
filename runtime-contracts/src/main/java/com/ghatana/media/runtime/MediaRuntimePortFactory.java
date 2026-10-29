package com.ghatana.media.runtime;

import java.util.Map;

/**
 * ServiceLoader-discovered composition factory for the canonical Media runtime port.
 *
 * <p>Modality gRPC entrypoints cannot depend on the launcher's runtime module
 * (the launcher already depends on them), so they discover the real runtime through
 * this SPI instead. An implementation composes the production runtime — artifact/job/
 * stream stores, providers, consent and source-rights authorities — and returns it as
 * the typed service-facing port. When no factory is installed the modality server
 * must remain fail-closed; when composition fails the factory must throw rather than
 * return a half-initialized port.</p>
 *
 * @doc.type interface
 * @doc.purpose Runtime port composition SPI for standalone modality servers
 * @doc.layer product
 * @doc.pattern SPI, ServiceLoader
 */
public interface MediaRuntimePortFactory {

    /** Stable factory identity used for diagnostics; must be unique on the classpath. */
    String factoryId();

    /**
     * Composes the canonical runtime port for the environment. Implementations apply the
     * same store/provider/rights readiness and production-eligibility gates as the owning
     * runtime and throw on unmet requirements. The returned port may implement
     * {@link AutoCloseable}; callers that composed it own its lifecycle.
     */
    MediaProcessingRuntimePort compose(Map<String, String> environment);
}
