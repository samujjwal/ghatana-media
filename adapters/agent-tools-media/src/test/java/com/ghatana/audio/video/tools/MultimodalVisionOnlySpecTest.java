/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolTransport;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MultimodalOperationSpec;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import com.ghatana.tools.testing.EventloopTestBase;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** A vision-only multimodal call carries a durable single-VISION-child spec bound to the exact source version. */
final class MultimodalVisionOnlySpecTest extends EventloopTestBase {
    private static final String VERSION = "sha256:" + "c".repeat(64);

    private static final class CapturingPort implements MediaJobSubmissionPort {
        final List<ProcessingJobRequest> submitted = new ArrayList<>();
        @Override public ProcessingJob submit(ProcessingJobRequest r, AuthenticatedPrincipal authenticated) {
            submitted.add(r);
            return new ProcessingJob("job-1", r.requestId(), r.tenantId(), r.principalId(), r.artifactId(), r.jobType(),
                    "", JobStatus.ACCEPTED, Instant.now(), null, null, Map.of(), "", 1, r.expectedArtifactVersion(), "");
        }
        @Override public Optional<ProcessingJob> findByRequestId(String tenantId, String requestId) { return Optional.empty(); }
    }

    private List<ProcessingJobRequest> call(Map<String, Object> input) {
        var port = new CapturingPort();
        var bridge = new MediaToolJobBridge(port, "dev");
        var envelope = ToolExecutionEnvelope.of("av.multimodal-inference", "1.0.0", "agent-1", null, "tenant-1",
                ToolActionClass.CALL_EXTERNAL, "1.0", input);
        var contract = new ToolContract(envelope.toolId(), envelope.toolVersion(), "test", "test", envelope.actionClass(),
                false, true, Map.of(), Map.of(), Set.of(), ToolTransport.IN_PROCESS, null, Map.of());
        runPromise(() -> new MultimodalInferenceToolHandler(bridge,
                new AuthenticatedPrincipal("tenant-1", "agent-1", Instant.now())).handle(envelope, contract));
        return port.submitted;
    }

    @Test
    void visionOnlyCallCarriesTheBoundSingleChildSpec() {
        var submitted = call(Map.of("mediaArtifactId", "art-1", "enableTranscription", false,
                "enableVisionAnalysis", true, "sourceArtifactVersion", VERSION));
        assertThat(submitted).hasSize(1);
        assertThat(submitted.get(0).jobType()).isEqualTo(JobType.MULTIMODAL);
        MultimodalOperationSpec spec = MultimodalOperationSpec.from(submitted.get(0));
        assertThat(spec.sourceArtifactId()).isEqualTo("art-1");
        assertThat(spec.sourceVersion()).isEqualTo(VERSION);
        assertThat(spec.sourceSha256()).isEqualTo("c".repeat(64));
        assertThat(spec.children()).hasSize(1);
        var child = spec.children().get(0);
        assertThat(child.jobType()).isEqualTo(JobType.VISION);
        assertThat(child.artifactId()).isEqualTo("art-1");
        assertThat(child.artifactVersion()).isEqualTo(VERSION);
    }

    @Test
    void callsThatNeedATranscriptionChildCarryNoSpecAndKeepTheRuntimeRefusal() {
        var submitted = call(Map.of("mediaArtifactId", "art-1", "sourceArtifactVersion", VERSION));
        assertThat(submitted).hasSize(1);
        assertThat(submitted.get(0).parameters()).doesNotContainKey(MultimodalOperationSpec.PARAMETERS_KEY);
    }
}
