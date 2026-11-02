package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Map;

/** Child JVM for the create lost-ACK process-crash test. */
public final class MediaPostgresqlCreateLostAckWorker {
    private MediaPostgresqlCreateLostAckWorker() { }

    public static void main(String[] args) throws Exception {
        if (args.length != 3) throw new IllegalArgumentException("marker, fingerprint, and job identity are required");
        String[] identity = args[2].split("\n", -1);
        if (identity.length != 6) throw new IllegalArgumentException("six job identity fields are required");
        ProcessingJob submission = new ProcessingJob(identity[1], identity[2], identity[0], identity[3], identity[4],
                JobType.TRANSCODE, "provider-ip06", JobStatus.ACCEPTED,
                Instant.ofEpochMilli(Long.parseLong(identity[5])), null, null, Map.of(), "", 1, "", args[1]);
        try (PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
            store.create(submission);
            Files.writeString(Path.of(args[0]), "COMMITTED", StandardCharsets.UTF_8);
            // Stay alive without emitting an acknowledgement; the parent kills this process abruptly.
            while (true) Thread.sleep(60_000);
        }
    }
}
