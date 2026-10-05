/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.media.integration;

import com.ghatana.testing.activej.EventloopTestBase;
import io.activej.promise.Promise;
import org.junit.jupiter.api.*;

import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.*;

/**
 * @doc.type class
 * @doc.purpose E2E test for Media provider and job lifecycle
 * @doc.layer product
 * @doc.pattern IntegrationTest
 */
@DisplayName("Media Provider and Job Lifecycle E2E Tests")
@Tag("integration")
@Tag("production")
class MediaProviderJobLifecycleE2ETest extends EventloopTestBase {

    private static final String MEDIA_TENANT = "media-provider-test";
    private static final String PRINCIPAL_ID = "media-test-principal";

    private MediaTestHarness mediaHarness;
    private List<String> capturedAuditEvents;

    @BeforeEach
    void setUp() {
        mediaHarness = new MediaTestHarness(MEDIA_TENANT);
        capturedAuditEvents = new CopyOnWriteArrayList<>();
        
        mediaHarness.onAuditEvent(capturedAuditEvents::add);
    }

    @AfterEach
    void tearDown() throws Exception {
        if (mediaHarness != null) {
            mediaHarness.close();
        }
    }

    @Test
    @DisplayName("Media provider registration with health probe")
    void testMediaProviderRegistration() throws Exception {
        String providerId = "audio-provider-v1";
        MediaProviderDefinition provider = createAudioProvider(providerId);
        
        // Register provider
        String registeredId = registerProvider(provider);
        assertThat(registeredId).isEqualTo(providerId);
        
        // Verify registered
        boolean registered = isProviderRegistered(providerId);
        assertThat(registered).isTrue();
        
        // Probe health
        HealthStatus health = probeProviderHealth(providerId);
        assertThat(health.healthy).isTrue();
        
        // Verify audit trail
        assertThat(capturedAuditEvents)
            .anySatisfy(a -> assertThat(a).contains("PROVIDER_REGISTERED").contains(providerId));
    }

    @Test
    @DisplayName("Audio streaming job lifecycle")
    void testAudioStreamingJobLifecycle() throws Exception {
        String providerId = registerProvider(createAudioProvider("audio-provider"));
        
        // Create audio streaming job
        String jobId = createJob(providerId, MediaJobType.AUDIO_STREAMING, "{\"format\": \"mp3\", \"bitrate\": 320}");
        
        // Verify job created
        JobStatus jobStatus = getJobStatus(jobId);
        assertThat(jobStatus.state).isEqualTo("PENDING");
        
        // Start job
        startJob(jobId);
        jobStatus = getJobStatus(jobId);
        assertThat(jobStatus.state).isEqualTo("RUNNING");
        
        // Simulate stream progress
        updateJobProgress(jobId, 50);
        jobStatus = getJobStatus(jobId);
        assertThat(jobStatus.progress).isEqualTo(50);
        
        // Complete job
        completeJob(jobId, "{\"url\": \"s3://bucket/audio.mp3\", \"duration\": 180}");
        jobStatus = getJobStatus(jobId);
        assertThat(jobStatus.state).isEqualTo("COMPLETED");
        
        // Verify audit trail
        assertThat(capturedAuditEvents)
            .anySatisfy(a -> assertThat(a).contains("JOB_CREATED").contains(jobId));
    }

    @Test
    @DisplayName("Video streaming job lifecycle")
    void testVideoStreamingJobLifecycle() throws Exception {
        String providerId = registerProvider(createVideoProvider("video-provider"));
        
        // Create video streaming job
        String jobId = createJob(providerId, MediaJobType.VIDEO_STREAMING, "{\"resolution\": \"1080p\", \"codec\": \"h264\"}");
        
        // Start and complete
        startJob(jobId);
        updateJobProgress(jobId, 100);
        completeJob(jobId, "{\"url\": \"s3://bucket/video.mp4\", \"duration\": 3600}");
        
        // Verify completion
        JobStatus status = getJobStatus(jobId);
        assertThat(status.state).isEqualTo("COMPLETED");
    }

    @Test
    @DisplayName("Speech-to-Text job with artifact storage")
    void testSpeechToTextJobWithArtifacts() throws Exception {
        String providerId = registerProvider(createSpeechProvider("stt-provider"));
        
        // Create STT job
        String jobId = createJob(providerId, MediaJobType.SPEECH_TO_TEXT, "{\"language\": \"en-US\", \"model\": \"default\"}");
        
        // Complete with transcript
        String transcriptArtifact = storeArtifact(jobId, "{\"text\": \"hello world\", \"confidence\": 0.95}");
        completeJob(jobId, "{\"artifactId\": \"" + transcriptArtifact + "\"}");
        
        // Retrieve artifact
        String artifact = retrieveArtifact(transcriptArtifact);
        assertThat(artifact).contains("hello world");
        
        // Verify retention policy applied
        long retentionSeconds = getArtifactRetention(transcriptArtifact);
        assertThat(retentionSeconds).isGreaterThan(0);
    }

    @Test
    @DisplayName("Text-to-Speech job with streaming output")
    void testTextToSpeechJobWithStreaming() throws Exception {
        String providerId = registerProvider(createSpeechProvider("tts-provider"));
        
        // Create TTS job
        String jobId = createJob(providerId, MediaJobType.TEXT_TO_SPEECH, "{\"text\": \"hello world\", \"voice\": \"en-US-Neural2-A\"}");
        
        // Start and stream
        startJob(jobId);
        
        // Simulate streaming chunks
        long chunkId1 = streamChunk(jobId, "{\"audio\": \"base64encodedchunk1\", \"offset\": 0}");
        long chunkId2 = streamChunk(jobId, "{\"audio\": \"base64encodedchunk2\", \"offset\": 4096}");
        
        // Complete
        completeJob(jobId, "{\"totalChunks\": 2, \"duration\": 5}");
        
        // Verify chunks stored
        int chunkCount = getStreamedChunkCount(jobId);
        assertThat(chunkCount).isEqualTo(2);
    }

    @Test
    @DisplayName("Vision analysis job with image processing")
    void testVisionAnalysisJobWithImageProcessing() throws Exception {
        String providerId = registerProvider(createVisionProvider("vision-provider"));
        
        // Create vision job
        String jobId = createJob(providerId, MediaJobType.VISION_ANALYSIS, "{\"imageUrl\": \"s3://bucket/image.jpg\", \"features\": [\"labels\", \"objects\"]}");
        
        // Process
        startJob(jobId);
        
        // Store vision result artifact
        String resultsArtifact = storeArtifact(jobId, "{\"labels\": [{\"name\": \"cat\", \"confidence\": 0.92}], \"objects\": [{\"name\": \"car\"}]}");
        completeJob(jobId, "{\"artifactId\": \"" + resultsArtifact + "\"}");
        
        // Retrieve and verify
        String results = retrieveArtifact(resultsArtifact);
        assertThat(results).contains("cat").contains("car");
    }

    @Test
    @DisplayName("Multimodal indexing job combining audio, vision, and text")
    void testMultimodalIndexingJob() throws Exception {
        String providerId = registerProvider(createMultimodalProvider("multimodal-provider"));
        
        // Create multimodal job
        String jobId = createJob(providerId, MediaJobType.MULTIMODAL_INDEXING, 
            "{\"audioUrl\": \"s3://bucket/audio.mp3\", \"imageUrl\": \"s3://bucket/image.jpg\", \"textContent\": \"sample text\"}");
        
        // Process
        startJob(jobId);
        
        // Store indexed results
        String indexArtifact = storeArtifact(jobId, "{\"audioEmbedding\": [0.1, 0.2, ...], \"visualEmbedding\": [0.3, 0.4, ...], \"textEmbedding\": [0.5, 0.6, ...]}");
        completeJob(jobId, "{\"indexArtifactId\": \"" + indexArtifact + "\"}");
        
        // Verify indexing completed
        JobStatus status = getJobStatus(jobId);
        assertThat(status.state).isEqualTo("COMPLETED");
    }

    @Test
    @DisplayName("Job failure with error handling and retry")
    void testJobFailureWithErrorHandling() throws Exception {
        String providerId = registerProvider(createAudioProvider("audio-provider"));
        
        // Create job that will fail
        String jobId = createJob(providerId, MediaJobType.AUDIO_STREAMING, "{\"format\": \"invalid\"}");
        
        // Start and trigger failure
        startJob(jobId);
        failJob(jobId, "INVALID_FORMAT", "Unsupported audio format");
        
        // Verify error recorded
        JobStatus status = getJobStatus(jobId);
        assertThat(status.state).isEqualTo("FAILED");
        assertThat(status.errorCode).isEqualTo("INVALID_FORMAT");
        
        // Retry should be possible
        String retryJobId = retryJob(jobId);
        assertThat(retryJobId).isNotNull();
        
        // Verify audit trail
        assertThat(capturedAuditEvents)
            .anySatisfy(a -> assertThat(a).contains("JOB_FAILED"));
    }

    @Test
    @DisplayName("Tenant isolation prevents cross-tenant job access")
    void testTenantIsolationForJobs() throws Exception {
        String providerId = registerProvider(createAudioProvider("audio-provider"));
        
        // Create job under tenant1
        String jobId = createJob(providerId, MediaJobType.AUDIO_STREAMING, "{\"format\": \"mp3\"}");
        
        // Create different tenant harness
        MediaTestHarness otherTenantHarness = new MediaTestHarness("other-tenant");
        
        // Attempt to access job from different tenant - should fail
        assertThatThrownBy(() -> runPromise(() -> otherTenantHarness.getJobStatus(jobId)))
            .isInstanceOf(IllegalStateException.class)
            .satisfiesAnyOf(
                error -> assertThat(error).hasMessageContaining("not found"),
                error -> assertThat(error).hasMessageContaining("tenant")
            );
        
        otherTenantHarness.close();
    }

    @Test
    @DisplayName("Consent tracking for media processing")
    void testConsentTracking() throws Exception {
        String providerId = registerProvider(createAudioProvider("audio-provider"));
        
        // Create job with consent tracking
        String jobId = createJobWithConsent(providerId, MediaJobType.AUDIO_STREAMING, 
            "{\"format\": \"mp3\"}", "storage,analytics");
        
        // Verify consent recorded
        String consentGiven = getJobConsent(jobId);
        assertThat(consentGiven).contains("storage").contains("analytics");
        
        // Verify audit trail
        assertThat(capturedAuditEvents)
            .anySatisfy(a -> assertThat(a).contains("CONSENT_RECORDED"));
    }

    @Test
    @DisplayName("Retention policy enforcement for artifacts")
    void testRetentionPolicyEnforcement() throws Exception {
        String providerId = registerProvider(createAudioProvider("audio-provider"));
        
        // Create job and artifact
        String jobId = createJob(providerId, MediaJobType.AUDIO_STREAMING, "{\"format\": \"mp3\"}");
        startJob(jobId);
        
        String artifactId = storeArtifact(jobId, "{\"url\": \"s3://bucket/audio.mp3\"}");
        completeJob(jobId, "{\"artifactId\": \"" + artifactId + "\"}");
        
        // Set retention to 30 days
        setArtifactRetention(artifactId, 30 * 24 * 3600);
        
        // Verify retention set
        long retentionSeconds = getArtifactRetention(artifactId);
        assertThat(retentionSeconds).isEqualTo(30 * 24 * 3600);
        
        // Verify audit trail
        assertThat(capturedAuditEvents)
            .anySatisfy(a -> assertThat(a).contains("RETENTION_POLICY_SET"));
    }

    @Test
    @DisplayName("Provider timeout and degraded state handling")
    void testProviderTimeoutAndDegradation() throws Exception {
        String providerId = registerProvider(createAudioProvider("audio-provider"));
        
        // Create job
        String jobId = createJob(providerId, MediaJobType.AUDIO_STREAMING, "{\"format\": \"mp3\"}");
        
        // Start and simulate provider timeout
        startJob(jobId);
        simulateProviderTimeout(providerId, 5000);
        
        // Job should transition to degraded/timeout
        JobStatus status = getJobStatus(jobId);
        assertThat(status.state).isEqualTo("TIMEOUT");
        
        // Provider should be marked degraded
        HealthStatus health = probeProviderHealth(providerId);
        assertThat(health.degraded).isTrue();
        
        // Verify audit trail
        assertThat(capturedAuditEvents)
            .anySatisfy(a -> assertThat(a).contains("PROVIDER_DEGRADED"));
    }

    @Test
    @DisplayName("Comprehensive audit trail for media operations")
    void testComprehensiveAuditTrail() throws Exception {
        String providerId = registerProvider(createAudioProvider("audio-provider"));
        String correlationId = "corr-media-" + UUID.randomUUID().toString();
        
        // Create and complete job with context
        String jobId = createJobWithContext(providerId, MediaJobType.AUDIO_STREAMING, 
            "{\"format\": \"mp3\"}", PRINCIPAL_ID, correlationId);
        
        startJob(jobId);
        String artifactId = storeArtifact(jobId, "{\"url\": \"s3://bucket/audio.mp3\"}");
        completeJob(jobId, "{\"artifactId\": \"" + artifactId + "\"}");
        
        // Verify audit trail includes full context
        assertThat(capturedAuditEvents)
            .anySatisfy(a -> assertThat(a)
                .contains("principalId:" + PRINCIPAL_ID)
                .contains("correlationId:" + correlationId)
                .contains("JOB_CREATED"));
    }

    // ========== Helper Methods ==========

    private String registerProvider(MediaProviderDefinition provider) throws Exception {
        return runPromise(() -> mediaHarness.registerProvider(provider));
    }

    private boolean isProviderRegistered(String providerId) throws Exception {
        return runPromise(() -> mediaHarness.isProviderRegistered(providerId));
    }

    private HealthStatus probeProviderHealth(String providerId) throws Exception {
        return runPromise(() -> mediaHarness.probeProviderHealth(providerId));
    }

    private String createJob(String providerId, MediaJobType type, String config) throws Exception {
        return runPromise(() -> mediaHarness.createJob(providerId, type, config));
    }

    private String createJobWithConsent(String providerId, MediaJobType type, String config, String consent) throws Exception {
        return runPromise(() -> mediaHarness.createJobWithConsent(providerId, type, config, consent));
    }

    private String createJobWithContext(String providerId, MediaJobType type, String config, String principalId, String correlationId) throws Exception {
        return runPromise(() -> mediaHarness.createJobWithContext(providerId, type, config, principalId, correlationId));
    }

    private JobStatus getJobStatus(String jobId) throws Exception {
        return runPromise(() -> mediaHarness.getJobStatus(jobId));
    }

    private void startJob(String jobId) throws Exception {
        runPromise(() -> mediaHarness.startJob(jobId));
    }

    private void updateJobProgress(String jobId, int progress) throws Exception {
        runPromise(() -> mediaHarness.updateJobProgress(jobId, progress));
    }

    private void completeJob(String jobId, String result) throws Exception {
        runPromise(() -> mediaHarness.completeJob(jobId, result));
    }

    private void failJob(String jobId, String errorCode, String errorMessage) throws Exception {
        runPromise(() -> mediaHarness.failJob(jobId, errorCode, errorMessage));
    }

    private String retryJob(String jobId) throws Exception {
        return runPromise(() -> mediaHarness.retryJob(jobId));
    }

    private String storeArtifact(String jobId, String artifactData) throws Exception {
        return runPromise(() -> mediaHarness.storeArtifact(jobId, artifactData));
    }

    private String retrieveArtifact(String artifactId) throws Exception {
        return runPromise(() -> mediaHarness.retrieveArtifact(artifactId));
    }

    private long getArtifactRetention(String artifactId) throws Exception {
        return runPromise(() -> mediaHarness.getArtifactRetention(artifactId));
    }

    private void setArtifactRetention(String artifactId, long retentionSeconds) throws Exception {
        runPromise(() -> mediaHarness.setArtifactRetention(artifactId, retentionSeconds));
    }

    private long streamChunk(String jobId, String chunkData) throws Exception {
        return runPromise(() -> mediaHarness.streamChunk(jobId, chunkData));
    }

    private int getStreamedChunkCount(String jobId) throws Exception {
        return runPromise(() -> mediaHarness.getStreamedChunkCount(jobId));
    }

    private String getJobConsent(String jobId) throws Exception {
        return runPromise(() -> mediaHarness.getJobConsent(jobId));
    }

    private void simulateProviderTimeout(String providerId, long timeoutMs) throws Exception {
        runPromise(() -> mediaHarness.simulateProviderTimeout(providerId, timeoutMs));
    }

    // ========== Helper Factory Methods ==========

    private MediaProviderDefinition createAudioProvider(String providerId) {
        return new MediaProviderDefinition(providerId, "Audio Provider", new String[]{"audio-streaming"});
    }

    private MediaProviderDefinition createVideoProvider(String providerId) {
        return new MediaProviderDefinition(providerId, "Video Provider", new String[]{"video-streaming"});
    }

    private MediaProviderDefinition createSpeechProvider(String providerId) {
        return new MediaProviderDefinition(providerId, "Speech Provider", new String[]{"speech-to-text", "text-to-speech"});
    }

    private MediaProviderDefinition createVisionProvider(String providerId) {
        return new MediaProviderDefinition(providerId, "Vision Provider", new String[]{"vision-analysis"});
    }

    private MediaProviderDefinition createMultimodalProvider(String providerId) {
        return new MediaProviderDefinition(providerId, "Multimodal Provider", new String[]{"multimodal-indexing"});
    }

    // ========== Support Classes ==========

    enum MediaJobType {
        AUDIO_STREAMING,
        VIDEO_STREAMING,
        SPEECH_TO_TEXT,
        TEXT_TO_SPEECH,
        VISION_ANALYSIS,
        MULTIMODAL_INDEXING
    }

    static class MediaProviderDefinition {
        final String providerId;
        final String name;
        final String[] capabilities;

        MediaProviderDefinition(String providerId, String name, String[] capabilities) {
            this.providerId = providerId;
            this.name = name;
            this.capabilities = capabilities;
        }
    }

    static class HealthStatus {
        final boolean healthy;
        final boolean degraded;

        HealthStatus(boolean healthy, boolean degraded) {
            this.healthy = healthy;
            this.degraded = degraded;
        }
    }

    static class JobStatus {
        final String jobId;
        final String state;
        final int progress;
        final String errorCode;
        final String errorMessage;

        JobStatus(String jobId, String state, int progress, String errorCode, String errorMessage) {
            this.jobId = jobId;
            this.state = state;
            this.progress = progress;
            this.errorCode = errorCode;
            this.errorMessage = errorMessage;
        }
    }
}
