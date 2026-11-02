/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.media.integration;

import io.activej.promise.Promise;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.function.Supplier;
import java.io.IOException;
import java.nio.file.Path;

/**
 * @doc.type class
 * @doc.purpose Test harness for Media provider and job lifecycle
 * @doc.layer product
 * @doc.pattern TestFixture
 */
public class MediaTestHarness implements AutoCloseable {

    /**
     * Execution boundary for the repository's reusable integration-test fixtures.
     * A tier describes what a selected test can prove; it is not a qualification
     * or provider-admission status.
     */
    public enum TestTier {
        /** Local deterministic code paths, including explicitly simulated fixtures. */
        LOCAL_FIXTURE,
        /** Disposable local database, object-store, or Compose resources. */
        ISOLATED_INTEGRATION,
        /** Tests that need separately pinned images or rights-qualified model/source assets. */
        EXTERNAL_QUALIFICATION
    }

    /** Read-only, consumer-facing inventory of test selection and fixture boundaries. */
    public record TestProfile(
            String id,
            TestTier tier,
            List<String> selectors,
            List<String> sources,
            List<String> resources,
            List<String> prerequisites,
            String assets,
            String safety,
            String evidenceLimit) {

        public TestProfile {
            Objects.requireNonNull(id, "id");
            Objects.requireNonNull(tier, "tier");
            selectors = List.copyOf(selectors);
            sources = List.copyOf(sources);
            resources = List.copyOf(resources);
            prerequisites = List.copyOf(prerequisites);
            Objects.requireNonNull(assets, "assets");
            Objects.requireNonNull(safety, "safety");
            Objects.requireNonNull(evidenceLimit, "evidenceLimit");
        }

        /** Gradle selection arguments for this profile, usable from the repo root. */
        public List<String> gradleArguments() {
            List<String> arguments = new ArrayList<>(List.of(":services:media:integration-tests:test"));
            for (String selector : selectors) {
                arguments.add("--tests");
                arguments.add(selector);
            }
            return List.copyOf(arguments);
        }
    }

    /**
     * Loads the canonical repository census and projects its selection profiles
     * for integration-test consumers. The JSON census remains the single registry.
     */
    public static List<TestProfile> testProfiles(Path repositoryRoot) throws IOException {
        Path catalog = repositoryRoot.resolve("docs/implementation/media-integration-test-census.v1.json");
        JsonNode profiles = new ObjectMapper().readTree(catalog.toFile()).path("profiles");
        if (!profiles.isArray() || profiles.isEmpty()) {
            throw new IllegalArgumentException("test census profiles must be a non-empty array: " + catalog);
        }
        List<TestProfile> result = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        for (JsonNode profile : profiles) {
            if (!profile.isObject()) {
                throw new IllegalArgumentException("test census profile must be an object: " + catalog);
            }
            String id = requiredText(profile, "id", catalog);
            if (!ids.add(id)) {
                throw new IllegalArgumentException("duplicate test census profile id: " + id);
            }
            String tier = requiredText(profile, "tier", catalog);
            List<String> selectors = requiredStrings(profile, "selectors", catalog);
            List<String> sources = requiredStrings(profile, "sources", catalog);
            List<String> resources = requiredStrings(profile, "resources", catalog);
            List<String> prerequisites = requiredStrings(profile, "prerequisites", catalog);
            result.add(new TestProfile(
                    id,
                    parseTier(tier, id),
                    selectors,
                    sources,
                    resources,
                    prerequisites,
                    requiredText(profile, "assets", catalog),
                    requiredText(profile, "safety", catalog),
                    requiredText(profile, "evidenceLimit", catalog)));
        }
        return List.copyOf(result);
    }

    private static String requiredText(JsonNode object, String field, Path catalog) {
        JsonNode value = object.get(field);
        if (value == null || !value.isString() || value.asString().isBlank()) {
            throw new IllegalArgumentException("test census field " + field + " must be non-blank text: " + catalog);
        }
        return value.asString();
    }

    private static List<String> requiredStrings(JsonNode object, String field, Path catalog) {
        JsonNode array = object.get(field);
        if (array == null || !array.isArray() || array.isEmpty()) {
            throw new IllegalArgumentException("test census field " + field + " must be a non-empty string array: " + catalog);
        }
        List<String> values = new ArrayList<>();
        for (JsonNode value : array) {
            if (!value.isString() || value.asString().isBlank()) {
                throw new IllegalArgumentException("test census field " + field + " entries must be non-blank text: " + catalog);
            }
            values.add(value.asString());
        }
        return List.copyOf(values);
    }

    private static TestTier parseTier(String tier, String id) {
        try {
            return TestTier.valueOf(tier);
        } catch (IllegalArgumentException exception) {
            throw new IllegalArgumentException("unknown test census tier " + tier + " for profile " + id, exception);
        }
    }

    private final String tenantId;
    private final AtomicReference<Consumer<String>> auditEventListener;
    private final ConcurrentHashMap<String, ProviderState> providers;
    private final ConcurrentHashMap<String, JobState> jobs;
    private final ConcurrentHashMap<String, ArtifactState> artifacts;
    private final AtomicInteger jobIdCounter;
    private final AtomicInteger artifactIdCounter;

    public MediaTestHarness(String tenantId) {
        this.tenantId = tenantId;
        this.auditEventListener = new AtomicReference<>(s -> {});
        this.providers = new ConcurrentHashMap<>();
        this.jobs = new ConcurrentHashMap<>();
        this.artifacts = new ConcurrentHashMap<>();
        this.jobIdCounter = new AtomicInteger(0);
        this.artifactIdCounter = new AtomicInteger(0);
    }

    public void onAuditEvent(Consumer<String> listener) {
        this.auditEventListener.set(listener);
    }

    public Promise<String> registerProvider(MediaProviderJobLifecycleE2ETest.MediaProviderDefinition def) {
        return promise(() -> {
            if (providers.containsKey(def.providerId)) {
                throw new IllegalStateException("Provider already registered: " + def.providerId);
            }
            
            ProviderState state = new ProviderState(def.providerId, def.name, def.capabilities);
            providers.put(def.providerId, state);
            
            emitAuditEvent("PROVIDER_REGISTERED, providerId:" + def.providerId + ", name:" + def.name);
            
            return def.providerId;
        });
    }

    public Promise<Boolean> isProviderRegistered(String providerId) {
        return promise(() -> providers.containsKey(providerId));
    }

    public Promise<MediaProviderJobLifecycleE2ETest.HealthStatus> probeProviderHealth(String providerId) {
        return promise(() -> {
            ProviderState state = providers.get(providerId);
            if (state == null) throw new IllegalStateException("Provider not found");
            
            return new MediaProviderJobLifecycleE2ETest.HealthStatus(!state.degraded, state.degraded);
        });
    }

    public Promise<String> createJob(String providerId, MediaProviderJobLifecycleE2ETest.MediaJobType type, String config) {
        return promise(() -> createJobState(providerId, type, config));
    }

    public Promise<String> createJobWithConsent(String providerId, MediaProviderJobLifecycleE2ETest.MediaJobType type, String config, String consent) {
        return promise(() -> {
            String jobId = createJobState(providerId, type, config);
            
            JobState jobState = jobs.get(jobId);
            jobState.consent = consent;
            
            emitAuditEvent("CONSENT_RECORDED, jobId:" + jobId + ", consent:" + consent);
            
            return jobId;
        });
    }

    public Promise<String> createJobWithContext(String providerId, MediaProviderJobLifecycleE2ETest.MediaJobType type, String config, String principalId, String correlationId) {
        return promise(() -> {
            String jobId = createJobState(providerId, type, config);
            
            JobState jobState = jobs.get(jobId);
            jobState.principalId = principalId;
            jobState.correlationId = correlationId;
            
            emitAuditEvent("JOB_CREATED, jobId:" + jobId + ", principalId:" + principalId + ", correlationId:" + correlationId);
            
            return jobId;
        });
    }

    public Promise<MediaProviderJobLifecycleE2ETest.JobStatus> getJobStatus(String jobId) {
        return promise(() -> {
            JobState job = jobs.get(jobId);
            if (job == null || !job.tenantId.equals(tenantId)) {
                throw new IllegalStateException("Job not found or tenant mismatch");
            }
            
            return new MediaProviderJobLifecycleE2ETest.JobStatus(jobId, job.state, job.progress, job.errorCode, job.errorMessage);
        });
    }

    public Promise<Void> startJob(String jobId) {
        return promise(() -> {
            JobState job = jobs.get(jobId);
            if (job == null) throw new IllegalStateException("Job not found");
            
            job.state = "RUNNING";
            
            emitAuditEvent("JOB_STARTED, jobId:" + jobId);
            
            return null;
        });
    }

    public Promise<Void> updateJobProgress(String jobId, int progress) {
        return promise(() -> {
            JobState job = jobs.get(jobId);
            if (job == null) throw new IllegalStateException("Job not found");
            
            job.progress = progress;
            
            return null;
        });
    }

    public Promise<Void> completeJob(String jobId, String result) {
        return promise(() -> {
            JobState job = jobs.get(jobId);
            if (job == null) throw new IllegalStateException("Job not found");
            
            job.state = "COMPLETED";
            job.result = result;
            
            emitAuditEvent("JOB_COMPLETED, jobId:" + jobId);
            
            return null;
        });
    }

    public Promise<Void> failJob(String jobId, String errorCode, String errorMessage) {
        return promise(() -> {
            JobState job = jobs.get(jobId);
            if (job == null) throw new IllegalStateException("Job not found");
            
            job.state = "FAILED";
            job.errorCode = errorCode;
            job.errorMessage = errorMessage;
            
            emitAuditEvent("JOB_FAILED, jobId:" + jobId + ", errorCode:" + errorCode);
            
            return null;
        });
    }

    public Promise<String> retryJob(String jobId) {
        return promise(() -> {
            JobState originalJob = jobs.get(jobId);
            if (originalJob == null) throw new IllegalStateException("Job not found");
            
            // Create new job with same parameters
            String newJobId = createJobState(originalJob.providerId, originalJob.type, originalJob.config);
            
            return newJobId;
        });
    }

    public Promise<String> storeArtifact(String jobId, String artifactData) {
        return promise(() -> {
            JobState job = jobs.get(jobId);
            if (job == null) throw new IllegalStateException("Job not found");
            
            String artifactId = "artifact-" + tenantId + "-" + artifactIdCounter.incrementAndGet();
            ArtifactState artifact = new ArtifactState(artifactId, jobId, artifactData, tenantId);
            artifacts.put(artifactId, artifact);
            
            emitAuditEvent("ARTIFACT_STORED, artifactId:" + artifactId + ", jobId:" + jobId);
            
            return artifactId;
        });
    }

    public Promise<String> retrieveArtifact(String artifactId) {
        return promise(() -> {
            ArtifactState artifact = artifacts.get(artifactId);
            if (artifact == null || !artifact.tenantId.equals(tenantId)) {
                throw new IllegalStateException("Artifact not found or tenant mismatch");
            }
            
            return artifact.data;
        });
    }

    public Promise<Long> getArtifactRetention(String artifactId) {
        return promise(() -> {
            ArtifactState artifact = artifacts.get(artifactId);
            if (artifact == null) throw new IllegalStateException("Artifact not found");
            
            return artifact.retentionSeconds;
        });
    }

    public Promise<Void> setArtifactRetention(String artifactId, long retentionSeconds) {
        return promise(() -> {
            ArtifactState artifact = artifacts.get(artifactId);
            if (artifact == null) throw new IllegalStateException("Artifact not found");
            
            artifact.retentionSeconds = retentionSeconds;
            
            emitAuditEvent("RETENTION_POLICY_SET, artifactId:" + artifactId + ", retentionSeconds:" + retentionSeconds);
            
            return null;
        });
    }

    public Promise<Long> streamChunk(String jobId, String chunkData) {
        return promise(() -> {
            JobState job = jobs.get(jobId);
            if (job == null) throw new IllegalStateException("Job not found");
            
            long chunkId = job.streamedChunks.incrementAndGet();
            job.streamedChunkData.add(chunkData);
            
            return chunkId;
        });
    }

    public Promise<Integer> getStreamedChunkCount(String jobId) {
        return promise(() -> {
            JobState job = jobs.get(jobId);
            if (job == null) throw new IllegalStateException("Job not found");
            
            return (int) job.streamedChunks.get();
        });
    }

    public Promise<String> getJobConsent(String jobId) {
        return promise(() -> {
            JobState job = jobs.get(jobId);
            if (job == null) throw new IllegalStateException("Job not found");
            
            return job.consent != null ? job.consent : "";
        });
    }

    public Promise<Void> simulateProviderTimeout(String providerId, long timeoutMs) {
        return promise(() -> {
            ProviderState provider = providers.get(providerId);
            if (provider == null) throw new IllegalStateException("Provider not found");
            
            provider.degraded = true;
            
            // Mark all running jobs as timed out
            for (JobState job : jobs.values()) {
                if (job.providerId.equals(providerId) && job.state.equals("RUNNING")) {
                    job.state = "TIMEOUT";
                }
            }
            
            emitAuditEvent("PROVIDER_DEGRADED, providerId:" + providerId);
            
            return null;
        });
    }

    @Override
    public void close() throws Exception {
        providers.clear();
        jobs.clear();
        artifacts.clear();
    }

    // ========== Private Helper Methods ==========

    private void emitAuditEvent(String event) {
        Consumer<String> listener = auditEventListener.get();
        if (listener != null) {
            listener.accept(event);
        }
    }

    private <T> Promise<T> promise(Supplier<T> supplier) {
        try {
            return Promise.of(supplier.get());
        } catch (Exception exception) {
            return Promise.ofException(exception);
        }
    }

    private String createJobState(String providerId, MediaProviderJobLifecycleE2ETest.MediaJobType type, String config) {
        ProviderState provider = providers.get(providerId);
        if (provider == null) throw new IllegalStateException("Provider not found");

        String jobId = "job-" + tenantId + "-" + jobIdCounter.incrementAndGet();
        JobState jobState = new JobState(jobId, providerId, type, config, "PENDING", tenantId);
        jobs.put(jobId, jobState);

        emitAuditEvent("JOB_CREATED, jobId:" + jobId + ", type:" + type + ", providerId:" + providerId);

        return jobId;
    }

    // ========== Inner State Classes ==========

    private static class ProviderState {
        final String providerId;
        final String name;
        final String[] capabilities;
        boolean degraded;

        ProviderState(String providerId, String name, String[] capabilities) {
            this.providerId = providerId;
            this.name = name;
            this.capabilities = capabilities;
            this.degraded = false;
        }
    }

    private static class JobState {
        final String jobId;
        final String providerId;
        final MediaProviderJobLifecycleE2ETest.MediaJobType type;
        final String config;
        final String tenantId;
        final AtomicInteger streamedChunks;
        final CopyOnWriteArrayList<String> streamedChunkData;
        String state;
        int progress;
        String errorCode;
        String errorMessage;
        String result;
        String consent;
        String principalId;
        String correlationId;

        JobState(String jobId, String providerId, MediaProviderJobLifecycleE2ETest.MediaJobType type, String config, String state, String tenantId) {
            this.jobId = jobId;
            this.providerId = providerId;
            this.type = type;
            this.config = config;
            this.state = state;
            this.tenantId = tenantId;
            this.progress = 0;
            this.streamedChunks = new AtomicInteger(0);
            this.streamedChunkData = new CopyOnWriteArrayList<>();
        }
    }

    private static class ArtifactState {
        final String artifactId;
        final String jobId;
        final String data;
        final String tenantId;
        long retentionSeconds;

        ArtifactState(String artifactId, String jobId, String data, String tenantId) {
            this.artifactId = artifactId;
            this.jobId = jobId;
            this.data = data;
            this.tenantId = tenantId;
            this.retentionSeconds = 86400; // Default 1 day retention
        }
    }
}
