package com.ghatana.media.provider.aws;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** Child process that commits a lifecycle receipt and remains alive until the parent drops its acknowledgement. */
public final class MediaLifecycleProjectionCrashWorker {
    private MediaLifecycleProjectionCrashWorker() { }

    public static void main(String[] args) throws Exception {
        if (args.length != 5) {
            throw new IllegalArgumentException("marker, tenant, aggregate, event and fingerprint are required");
        }
        Path marker = Path.of(args[0]);
        try (PostgresqlMediaLifecycleProjectionStore store = new PostgresqlMediaLifecycleProjectionStore()) {
            var disposition = store.apply(args[1], "job", args[2], 7, args[3], args[4]);
            if (disposition != com.ghatana.audio.video.infrastructure.messaging.MediaLifecycleEventConsumer
                    .ProjectionDisposition.APPLIED) {
                throw new IllegalStateException("expected first apply to commit, got " + disposition);
            }
            Files.writeString(marker, "COMMITTED", StandardCharsets.UTF_8);
            while (true) Thread.sleep(60_000);
        }
    }
}
