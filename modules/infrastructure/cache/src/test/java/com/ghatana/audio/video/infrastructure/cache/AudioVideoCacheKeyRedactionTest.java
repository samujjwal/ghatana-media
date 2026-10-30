package com.ghatana.audio.video.infrastructure.cache;

import com.ghatana.cache.DistributedCachePort;
import com.ghatana.cache.DistributedCacheService;
import com.ghatana.core.async.AsyncOperation;
import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.LoggerContext;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.config.Property;
import org.junit.jupiter.api.Test;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Cache keys can embed tenant, principal, artifact or transcript identity.
 * Diagnostics must expose only a bounded, correlatable reference — never the
 * raw key material or a secret marker.
 */
class AudioVideoCacheKeyRedactionTest {

    @Test
    void keyReferenceIsBoundedDeterministicAndDisclosesNoKeyMaterial() {
        String tenantKey = "media-cache:tenant-987-secret:transcript-654-private";

        String reference = AudioVideoCache.keyReference(tenantKey);
        assertThat(reference).matches("sha256:[0-9a-f]{12}");
        assertThat(reference).isEqualTo(AudioVideoCache.keyReference(tenantKey));
        assertThat(reference).doesNotContain("tenant-987-secret", "transcript-654-private",
                "tenant", "secret");
        assertThat(AudioVideoCache.keyReference(
                        "media-cache:tenant-987-secret:other-id"))
                .isNotEqualTo(reference);
        assertThat(AudioVideoCache.keyReference(12345)).matches("sha256:[0-9a-f]{12}");
    }

    @Test
    void backendFailureLogsNeverRenderRawKeyOrThrowableMessage() {
        String key = "media-cache:tenant-987-secret:transcript-654-private";
        String exceptionMarker = "backend failure for " + key + " secret-cache-material";
        IllegalStateException failure = new IllegalStateException(exceptionMarker);
        DistributedCachePort<String, String> port = mock(DistributedCachePort.class);
        when(port.get(key)).thenReturn(
                AsyncOperation.failure(failure), AsyncOperation.failure(failure));
        when(port.put(key, "value", Duration.ofMinutes(30)))
                .thenReturn(AsyncOperation.failure(failure));
        when(port.invalidateAll()).thenReturn(AsyncOperation.failure(failure));
        DistributedCacheService service = mock(DistributedCacheService.class);
        when(service.invalidateAsync(key)).thenReturn(AsyncOperation.failure(failure));

        AudioVideoCache<String, String> cache = new AudioVideoCache<>(port, "transcription");
        AudioVideoCache<String, String> serviceCache =
                new AudioVideoCache<>(service, "transcription");
        try (LogCapture logs = capture(AudioVideoCache.class)) {
            assertOperationFails(() -> cache.get(key));
            assertOperationFails(() -> cache.getOrLoad(key,
                    ignored -> AsyncOperation.success("unused")));
            assertOperationFails(() -> cache.put(key, "value"));
            assertOperationFails(cache::invalidateAll);
            assertOperationFails(() -> serviceCache.invalidate(key));

            String output = logs.output();
            assertThat(logs.entries).hasSize(5);
            assertThat(output).contains("causeType=IllegalStateException", "keyRef="
                    + AudioVideoCache.keyReference(key), "namespace=transcription");
            assertThat(output).doesNotContain(key, exceptionMarker, "secret-cache-material");
            assertThat(logs.entries).allSatisfy(entry ->
                    assertThat(entry).doesNotContain("java.lang.IllegalStateException:"));
        }
    }

    private static void assertOperationFails(
            java.util.function.Supplier<AsyncOperation<?>> operation) {
        assertThatThrownBy(() -> {
            AsyncOperation<?> result = operation.get();
            java.util.concurrent.CompletableFuture<Object> completion =
                    new java.util.concurrent.CompletableFuture<>();
            result.whenComplete((value, error) -> {
                if (error == null) completion.complete(value);
                else completion.completeExceptionally(error);
            });
            completion.join();
        }).hasRootCauseInstanceOf(IllegalStateException.class);
    }

    private static LogCapture capture(Class<?> loggerClass) {
        LoggerContext context = (LoggerContext) org.apache.logging.log4j.LogManager.getContext(false);
        org.apache.logging.log4j.core.Logger logger = context.getLogger(loggerClass.getName());
        LogCapture appender = new LogCapture("cache-redaction", logger, logger.getLevel());
        appender.start();
        logger.addAppender(appender);
        logger.setLevel(Level.DEBUG);
        return appender;
    }

    private static final class LogCapture extends AbstractAppender implements AutoCloseable {
        private final List<String> entries = new ArrayList<>();
        private final org.apache.logging.log4j.core.Logger logger;
        private final Level previousLevel;

        LogCapture(String name, org.apache.logging.log4j.core.Logger logger, Level previousLevel) {
            super(name, null, null, true, Property.EMPTY_ARRAY);
            this.logger = logger;
            this.previousLevel = previousLevel;
        }

        @Override public void append(LogEvent event) {
            StringBuilder entry = new StringBuilder(event.getMessage().getFormattedMessage());
            if (event.getThrown() != null) {
                StringWriter stack = new StringWriter();
                event.getThrown().printStackTrace(new PrintWriter(stack));
                entry.append(' ').append(stack);
            }
            entries.add(entry.toString());
        }

        String output() { return String.join("\n", entries); }

        @Override public void close() {
            logger.removeAppender(this);
            logger.setLevel(previousLevel);
            stop();
        }
    }
}
