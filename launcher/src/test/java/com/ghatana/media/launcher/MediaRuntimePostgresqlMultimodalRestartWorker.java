package com.ghatana.media.launcher;

import com.ghatana.media.provider.aws.PostgresqlMediaJobStore;
import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobLease;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSnapshot;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSpec;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingAttempt;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/** Separate JVMs seed and recover PostgreSQL state without sharing callbacks or runtime memory. */
public final class MediaRuntimePostgresqlMultimodalRestartWorker {
    private static final String JOB_FINGERPRINT =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    private static final String CHILD_FINGERPRINT =
            "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    private static final String SOURCE_SHA = "a".repeat(64);
    private static final String CHILD_SHA = "b".repeat(64);

    private MediaRuntimePostgresqlMultimodalRestartWorker() { }

    public static void main(String[] args) throws Exception {
        if (args.length != 6) throw new IllegalArgumentException("mode, marker, tenant, parent, child, request required");
        String mode = args[0];
        Path marker = Path.of(args[1]);
        String tenantId = args[2];
        String parentJobId = args[3];
        String childJobId = args[4];
        String parentRequestId = args[5];
        switch (mode) {
            case "seed" -> seedAndWait(marker, tenantId, parentJobId, childJobId, parentRequestId);
            case "recover" -> recoverWithEmptyProviderRegistry(
                    marker, tenantId, parentJobId, childJobId, parentRequestId);
            default -> throw new IllegalArgumentException("unsupported worker mode: " + mode);
        }
    }

    private static void seedAndWait(
            Path marker, String tenantId, String parentJobId, String childJobId, String parentRequestId)
            throws Exception {
        MultimodalOperationSpec spec = spec();
        String childRequestId = MultimodalOperationSpec.childRequestId(parentRequestId, "vision");
        Instant createdAt = Instant.ofEpochMilli(System.currentTimeMillis());
        ProcessingJob parent = new ProcessingJob(parentJobId, parentRequestId, tenantId,
                "principal-mm-runtime", "artifact-mm-source", JobType.MULTIMODAL,
                "provider-mm-fixture", JobStatus.ACCEPTED, createdAt, null, null, Map.of(), "", 1,
                "sha256:" + SOURCE_SHA, JOB_FINGERPRINT);
        ProcessingJob child = new ProcessingJob(childJobId, childRequestId, tenantId,
                parent.principalId(), "artifact-mm-vision", JobType.VISION,
                "provider-mm-child-fixture", JobStatus.ACCEPTED, createdAt, null, null, Map.of(), "", 1,
                "sha256:" + CHILD_SHA, CHILD_FINGERPRINT);
        MultimodalOperationSnapshot snapshot = new MultimodalOperationSnapshot(
                MultimodalOperationSnapshot.AUTHORIZED_VERSION, spec.toParametersValue(),
                "fixture-rights", "fixture-policy", "fixture-policy-v1", "fixture-consent",
                "fixture-clock-evidence", 0L);

        try (PostgresqlMediaJobStore store = new PostgresqlMediaJobStore()) {
            store.create(parent, JOB_FINGERPRINT, null, snapshot);
            JobLease parentLease = store.claim(parent, "mm-parent-fixture", Instant.now().plusSeconds(2));
            ProcessingJob runningParent = running(parent);
            store.startAttempt(parent, runningParent, parentLease, 1, JOB_FINGERPRINT);

            store.create(child, CHILD_FINGERPRINT);
            JobLease childLease = store.claim(child, "mm-child-fixture", Instant.now().plusSeconds(120));
            var childStart = store.startAttempt(child, running(child), childLease, 1, CHILD_FINGERPRINT);
            ProcessingAttempt withFixtureReceipt = store.recordProviderReceipt(
                    childStart.attempt(), childLease,
                    "fixture-operation-" + childJobId, "fixture-receipt-" + childJobId);
            Instant observedAt = Instant.ofEpochMilli(System.currentTimeMillis());
            ProcessingJob unknownChild = new ProcessingJob(
                    child.jobId(), child.requestId(), child.tenantId(), child.principalId(), child.artifactId(),
                    child.jobType(), child.providerId(), JobStatus.OUTCOME_UNKNOWN, child.createdAt(),
                    childStart.running().startedAt(), observedAt,
                    Map.of("fixture", "synthetic UNKNOWN; no provider effect asserted"),
                    "PROCESSING_OUTCOME_UNKNOWN", childStart.running().version() + 1,
                    child.expectedArtifactVersion(), child.requestFingerprint());
            MediaLifecycleEvent event = new MediaLifecycleEvent(
                    "media:mm-runtime-child:unknown:" + childJobId, "media.job.outcome_unknown", tenantId,
                    child.principalId(), child.requestId(), child.requestId(), "job", childJobId,
                    unknownChild.version(), "INTERNAL", observedAt,
                    Map.of("status", "OUTCOME_UNKNOWN", "fixture", "synthetic"));
            store.markOutcomeUnknown(childStart.running(), withFixtureReceipt, unknownChild,
                    Map.of("fixture", "synthetic child state"), event);
        }
        write(marker, "CHILD_UNKNOWN_COMMITTED");
        // Parent test kills this process after the durable child state transaction.
        while (true) Thread.sleep(60_000);
    }

    private static void recoverWithEmptyProviderRegistry(
            Path marker, String tenantId, String parentJobId, String childJobId, String parentRequestId)
            throws Exception {
        Path root = marker.getParent().resolve("media-runtime-root");
        Files.createDirectories(root);
        PostgresqlMediaJobStore store = new PostgresqlMediaJobStore();
        MediaRuntime runtime = null;
        try {
            long deadline = System.nanoTime() + Duration.ofSeconds(30).toNanos();
            while (System.nanoTime() < deadline && store.recoverableAfter(100, null).stream()
                    .noneMatch(job -> job.jobId().equals(parentJobId))) {
                Thread.sleep(25);
            }
            if (store.recoverableAfter(100, null).stream().noneMatch(job -> job.jobId().equals(parentJobId))) {
                throw new AssertionError("seeded MM parent lease did not expire for recovery");
            }

            // There are intentionally no processing providers/callbacks in this fresh runtime.
            // Startup must reconcile from PostgreSQL only and cannot redispatch the child.
            runtime = new MediaRuntime(
                    new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                            Duration.ofSeconds(30), 8, "", "", false, false, root),
                    new LocalMediaRuntimeSupport.FileArtifactStore(root),
                    store,
                    new LocalMediaRuntimeSupport.StreamStore(),
                    null,
                    List.of(),
                    List.of());
            ProcessingJob parent = runtime.job(tenantId, "principal-mm-runtime", parentJobId).orElseThrow();
            ProcessingJob child = store.find(tenantId, childJobId).orElseThrow();
            if (parent.status() != JobStatus.OUTCOME_UNKNOWN) {
                throw new AssertionError("ambiguous child must preserve parent OUTCOME_UNKNOWN; actual="
                        + parent.status());
            }
            if (!parent.requestId().equals(parentRequestId)
                    || !parent.artifactId().equals("artifact-mm-source")
                    || !parent.expectedArtifactVersion().equals("sha256:" + SOURCE_SHA)
                    || !parent.requestFingerprint().equals(JOB_FINGERPRINT)) {
                throw new AssertionError("recovered parent source/request binding changed across runtime restart");
            }
            if (!child.requestId().equals(MultimodalOperationSpec.childRequestId(parentRequestId, "vision"))
                    || child.status() != JobStatus.OUTCOME_UNKNOWN
                    || !child.artifactId().equals("artifact-mm-vision")
                    || !child.expectedArtifactVersion().equals("sha256:" + CHILD_SHA)
                    || !child.requestFingerprint().equals(CHILD_FINGERPRINT)) {
                throw new AssertionError("child durable request binding changed across runtime restart");
            }
            var parentAttempt = store.findProcessingAttempt(tenantId, parentJobId, 1).orElseThrow();
            var childAttempt = store.findProcessingAttempt(tenantId, childJobId, 1).orElseThrow();
            if (parentAttempt.finality() != AttemptFinality.UNKNOWN
                    || !parentAttempt.providerReceiptId().isBlank()) {
                throw new AssertionError("parent attempt finality was not preserved as ambiguous");
            }
            if (childAttempt.finality() != AttemptFinality.UNKNOWN
                    || !childAttempt.providerOperationId().equals("fixture-operation-" + childJobId)
                    || !childAttempt.providerReceiptId().equals("fixture-receipt-" + childJobId)
                    || !childAttempt.requestFingerprint().equals(CHILD_FINGERPRINT)) {
                throw new AssertionError("child attempt receipt/finality binding changed across restart");
            }
            if (store.findProcessingAttempt(tenantId, childJobId, 2).isPresent()) {
                throw new AssertionError("runtime recovery created a duplicate child attempt");
            }
            write(marker, "PARENT_OUTCOME_UNKNOWN");
        } finally {
            // Runtime owns the injected store after construction; otherwise close the
            // unattached store if preflight failed before runtime startup.
            if (runtime != null) runtime.close();
            else store.close();
        }
    }

    private static MultimodalOperationSpec spec() {
        return new MultimodalOperationSpec(
                MultimodalOperationSpec.SPEC_VERSION,
                "media.multimodal.observe.source-grounded",
                "media.operation.capability.media-multimodal-observe-source-grounded",
                1, "artifact-mm-source", "sha256:" + SOURCE_SHA, SOURCE_SHA,
                List.of(new MultimodalOperationSpec.ChildOperationSpec(
                        "vision", JobType.VISION, "artifact-mm-vision", "sha256:" + CHILD_SHA,
                        CHILD_SHA, "provider-mm-child-fixture", Map.of())),
                new MultimodalOperationSpec.SourceClockBinding(
                        "fixture-clock-evidence", 48_000, 0, "fixture-source-clock", 48_000),
                Map.of("purpose", "multimodal-restart-fixture"));
    }

    private static ProcessingJob running(ProcessingJob accepted) {
        return new ProcessingJob(accepted.jobId(), accepted.requestId(), accepted.tenantId(),
                accepted.principalId(), accepted.artifactId(), accepted.jobType(), accepted.providerId(),
                JobStatus.RUNNING, accepted.createdAt(), Instant.now(), null, Map.of(), "",
                accepted.version() + 1, accepted.expectedArtifactVersion(), accepted.requestFingerprint());
    }

    private static void write(Path marker, String value) throws Exception {
        Files.writeString(marker, value, StandardCharsets.UTF_8);
    }
}
