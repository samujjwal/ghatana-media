package com.ghatana.audio.video.vision.video;

import java.time.Duration;
import java.util.List;

/**
 * Narrow authenticated host/CRI worker broker contract. Production Media JVMs must
 * never hold Docker socket or CLI privileges: every OCI worker effect goes through
 * a broker that owns the container engine relationship. Requests are bounded —
 * image must be an immutable digest, the command is a fixed single-executable
 * worker shape, mounts are exactly one read-only source and one private output
 * directory, and the sandbox profile is enforced server-side, not caller-set.
 */
public interface MediaOciBroker {

    record WorkerLaunch(
            String imageDigest,
            String containerName,
            String executable,
            List<String> workerArgs,
            String sourceFile,
            String sourceSha256,
            String outputDirectory,
            long uid,
            long gid,
            long maximumOutputBytes,
            Duration timeout) { }

    record WorkerResult(boolean completed, int exitCode, boolean timedOut, boolean oomKilled,
            boolean outputExceeded, String outputTail) { }

    /**
     * Creates, verifies effective sandbox limits, starts, awaits and destroys one
     * isolated worker. The broker owns docker CLI/socket access; callers only
     * describe one bounded worker invocation.
     */
    WorkerResult execute(WorkerLaunch launch) throws java.io.IOException;
}
