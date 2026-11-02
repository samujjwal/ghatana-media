package com.ghatana.media.launcher;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaJobFinalizationDeadlineExceededException;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext.MonotonicDeadline;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.Test;

class LocalMediaJobFinalizationDeadlineTest {
    @Test
    void expiredDeadlineFailsClosedUnderJobLockWithoutChangingState() {
        String fingerprint = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        Instant created = Instant.now();
        ProcessingJob running = new ProcessingJob("job-a", "request-a", "tenant-a", "principal-a",
                "artifact-a", JobType.TRANSCODE, "provider-a", JobStatus.RUNNING, created,
                created, null, Map.of(), "", 2, "", fingerprint);
        ProcessingJob completed = new ProcessingJob("job-a", "request-a", "tenant-a", "principal-a",
                "artifact-a", JobType.TRANSCODE, "provider-a", JobStatus.COMPLETED, created,
                created, Instant.now(), Map.of("ok", true), "", 3, "", fingerprint);
        try (LocalMediaRuntimeSupport.JobStore store = new LocalMediaRuntimeSupport.JobStore()) {
            store.create(new ProcessingJob("job-a", "request-a", "tenant-a", "principal-a",
                    "artifact-a", JobType.TRANSCODE, "provider-a", JobStatus.ACCEPTED, created,
                    null, null, Map.of(), "", 1, "", fingerprint));
            store.update(store.find("tenant-a", "job-a").orElseThrow(), running);

            assertThatThrownBy(() -> store.commitFinalOutcome(
                    running, null, completed, null, null, MonotonicDeadline.after(Duration.ZERO)))
                    .isInstanceOf(MediaJobFinalizationDeadlineExceededException.class);

            assertThat(store.find("tenant-a", "job-a").orElseThrow()).isEqualTo(running);
        }
    }
}
