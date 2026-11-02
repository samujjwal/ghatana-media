package com.ghatana.media.provider.aws;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.util.Map;
import software.amazon.awssdk.services.s3.S3Client;

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
        if (operation.equals("complete-after-s3-finalize")) {
            try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(
                         Map.copyOf(System.getenv()), delegate -> pauseAfterSuccessfulFinalize(delegate, marker));
                 S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore()) {
                write(marker, "READY");
                store.complete(tenant, principal, uploadId);
            }
        } else {
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
    }

    private static S3Client pauseAfterSuccessfulFinalize(S3Client delegate, Path marker) {
        return (S3Client) Proxy.newProxyInstance(S3Client.class.getClassLoader(), new Class<?>[] {S3Client.class},
                (proxy, method, arguments) -> {
                    try {
                        Object result = method.invoke(delegate, arguments);
                        if (method.getName().equals("completeMultipartUpload")) {
                            write(marker, "S3_FINALIZED");
                            // Hold inside the SDK boundary after the real S3 success response. The
                            // parent uses destroyForcibly(), so no finally/rollback can run here.
                            while (true) Thread.sleep(60_000);
                        }
                        return result;
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
    }

    private static void write(Path marker, String value) throws Exception {
        Files.writeString(marker, value, StandardCharsets.UTF_8);
    }
}
