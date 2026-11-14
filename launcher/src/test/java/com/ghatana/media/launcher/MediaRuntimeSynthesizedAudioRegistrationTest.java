package com.ghatana.media.launcher;

import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import com.ghatana.media.runtime.MediaTranscriptContracts;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;

/**
 * A TEXT_TO_SPEECH provider result that carries inline audio is registered by the runtime as an immutable artifact
 * version through the canonical upload path; the job result carries the artifact reference and lineage, never the
 * bytes. The provider below is a FIXTURE that returns fixed bytes: it proves the registration and failure wiring, not
 * any synthesis.
 */
final class MediaRuntimeSynthesizedAudioRegistrationTest {
    private static final String TENANT = "tenant-tts";
    private static final String PRINCIPAL = "principal-tts";
    private static final byte[] AUDIO = "FIXTURE-ONLY synthesized audio bytes".getBytes(StandardCharsets.UTF_8);

    /** FIXTURE provider returning inline audio on the map channel (the runtime's non-durable development path). */
    private static final class FixtureTtsProvider implements MediaProcessingProvider {
        private final String contentType;
        FixtureTtsProvider(String contentType) { this.contentType = contentType; }
        @Override public String providerId() { return "fixture-only-tts"; }
        @Override public String providerVersion() { return "fixture-1"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.TEXT_TO_SPEECH); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 1; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("audioBytes", AUDIO.clone());
            result.put("audioContentType", contentType);
            result.put("audioEncoding", "MP3");
            result.put("audioSha256", sha(AUDIO));
            result.put("voice", "af_heart");
            result.put("modelId", "hexgrad/Kokoro-82M");
            result.put("modelKey", "kokoro-82m");
            result.put("modelSha256", "a".repeat(64));
            result.put("textSha256", sha("hello".getBytes(StandardCharsets.UTF_8)));
            result.put("sampleRate", 24_000);
            result.put("durationMillis", 1_000);
            return CompletableFuture.completedFuture(result);
        }
    }

    private static String sha(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static MediaRuntime runtime(Path root, MediaProcessingProvider provider) {
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_048_576, 262_144, 1_048_576, Duration.ofMinutes(5), 8,
                        "", "", false, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root), new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                MediaSemanticRedactionRuntime.disabled(Duration.ofSeconds(10)), MediaLifecyclePublisher.disabled(),
                List.of(provider), List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()), List.of(), null,
                new MediaTranscriptContracts.MediaTranscriptStore() {
                    @Override public MediaTranscriptContracts.TranscriptRevision append(
                            MediaTranscriptContracts.TranscriptDraft draft) {
                        throw new UnsupportedOperationException();
                    }
                    @Override public List<MediaTranscriptContracts.TranscriptRevision> revisions(
                            String tenantId, String transcriptId) { return List.of(); }
                    @Override public boolean ready() { return true; }
                    @Override public boolean productionEligible() { return false; }
                    @Override public void close() { }
                }, Clock.systemUTC());
    }

    private static MediaArtifact upload(MediaRuntime runtime) {
        byte[] source = "source artifact the synthesis ran against".getBytes(StandardCharsets.UTF_8);
        var session = runtime.beginUpload(new UploadRequest(TENANT, PRINCIPAL, "source.txt", "text/plain",
                source.length, sha(source), "CONFIDENTIAL", Duration.ofMinutes(30), Map.of()), "key-source");
        runtime.appendChunk(TENANT, PRINCIPAL, session.uploadId(), 0, source);
        return runtime.completeUpload(TENANT, PRINCIPAL, session.uploadId());
    }

    private static ProcessingJob run(MediaRuntime runtime, MediaArtifact source, String requestId) throws Exception {
        ProcessingJobRequest request = new ProcessingJobRequest(requestId, TENANT, PRINCIPAL, "corr-" + requestId,
                source.artifactId(), source.version().value(), JobType.TEXT_TO_SPEECH, "",
                Map.of("text", "hello", "voice", "af_heart", "audioEncoding", "MP3"));
        ProcessingJob accepted = runtime.submit(request, new AuthenticatedPrincipal(TENANT, PRINCIPAL, Instant.now()));
        for (int i = 0; i < 200; i++) {
            ProcessingJob latest = runtime.job(TENANT, PRINCIPAL, accepted.jobId()).orElseThrow();
            if (Set.of(JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.OUTCOME_UNKNOWN, JobStatus.CANCELLED)
                    .contains(latest.status())) return latest;
            Thread.sleep(50);
        }
        throw new AssertionError("job did not reach a terminal state");
    }

    @Test
    void inlineAudioBecomesAnImmutableArtifactVersionWithLineageAndTheJobCarriesOnlyItsReference() throws Exception {
        Path root = Files.createTempDirectory("media-tts-register-");
        try (MediaRuntime runtime = runtime(root, new FixtureTtsProvider("audio/mpeg"))) {
            MediaArtifact source = upload(runtime);
            ProcessingJob job = run(runtime, source, "req-tts-1");

            assertThat(job.status()).as("failure=%s result=%s", job.failureCode(), job.result())
                    .isEqualTo(JobStatus.COMPLETED);
            assertThat(job.result()).doesNotContainKey("audioBytes");
            String audioId = (String) job.result().get("audioArtifactId");
            assertThat(audioId).isNotBlank().isNotEqualTo(source.artifactId());
            assertThat(job.result()).containsEntry("audioArtifactRef", "urn:ghatana:media-artifact:" + audioId)
                    .containsEntry("audioArtifactVersion", "sha256:" + sha(AUDIO))
                    .containsEntry("audioArtifactSha256", sha(AUDIO)).containsEntry("audioSha256", sha(AUDIO));

            MediaArtifact audio = runtime.artifact(TENANT, PRINCIPAL, audioId).orElseThrow();
            assertThat(audio.contentType()).isEqualTo("audio/mpeg");
            assertThat(audio.fileName()).endsWith(".mp3");
            assertThat(audio.classification()).isEqualTo("CONFIDENTIAL");
            assertThat(audio.expiresAt()).isBeforeOrEqualTo(source.expiresAt());
            assertThat(audio.metadata()).containsEntry("derivation", "TEXT_TO_SPEECH")
                    .containsEntry("derivedFromArtifactId", source.artifactId())
                    .containsEntry("derivedFromArtifactVersion", source.version().value())
                    .containsEntry("jobId", job.jobId()).containsEntry("providerId", "fixture-only-tts")
                    .containsEntry("voice", "af_heart").containsEntry("modelKey", "kokoro-82m")
                    .containsEntry("modelId", "hexgrad/Kokoro-82M").containsEntry("modelSha256", "a".repeat(64))
                    .containsEntry("textSha256", sha("hello".getBytes(StandardCharsets.UTF_8)));
            ByteArrayOutputStream readBack = new ByteArrayOutputStream();
            runtime.copyArtifactContent(TENANT, PRINCIPAL, audioId, audio.version(), readBack, 1_048_576)
                    .orElseThrow();
            assertThat(readBack.toByteArray()).isEqualTo(AUDIO);
        }
    }

    @Test
    void audioThatCannotBeRegisteredFailsTheJobTypedInsteadOfReportingSuccess() throws Exception {
        Path root = Files.createTempDirectory("media-tts-register-bad-");
        try (MediaRuntime runtime = runtime(root, new FixtureTtsProvider("application/x-not-audio"))) {
            MediaArtifact source = upload(runtime);
            ProcessingJob job = run(runtime, source, "req-tts-2");
            assertThat(job.status()).isEqualTo(JobStatus.FAILED);
            assertThat(job.failureCode()).isEqualTo(MediaRuntime.TTS_OUTPUT_REGISTRATION_FAILED);
            assertThat(job.result()).doesNotContainKeys("audioBytes", "audioArtifactId");
        }
    }
}
