package com.ghatana.media.provider.aws;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;

/** Child JVM for the isolated IP-06 S3/PostgreSQL split crash test. */
public final class MediaPostgresqlS3ProcessCrashWorker {
    private MediaPostgresqlS3ProcessCrashWorker() { }

    public static void main(String[] args) throws Exception {
        if (args.length != 6) throw new IllegalArgumentException("operation, marker, payload, tenant, principal, upload are required");
        String operation = args[0];
        Path marker = Path.of(args[1]);
        byte[] payload = Files.readAllBytes(Path.of(args[2]));
        String tenant = args[3];
        String principal = args[4];
        String uploadId = args[5];
        try (S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore()) {
            write(marker, "READY");
            switch (operation) {
                case "append" -> store.append(tenant, principal, uploadId, 0, payload);
                case "complete" -> store.complete(tenant, principal, uploadId);
                default -> throw new IllegalArgumentException("unsupported operation: " + operation);
            }
            write(marker, "COMMITTED");
            // Parent kills the child after the durable method returns to model process loss before
            // a caller receives its acknowledgement. There is deliberately no graceful close.
            while (true) Thread.sleep(60_000);
        }
    }

    private static void write(Path marker, String value) throws Exception {
        Files.writeString(marker, value, StandardCharsets.UTF_8);
    }
}
