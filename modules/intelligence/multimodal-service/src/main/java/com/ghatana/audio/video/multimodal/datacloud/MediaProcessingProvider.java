/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.datacloud;

import java.util.List;

/**
 * Read-only projection interface for Data Cloud media experience integration.
 *
 * <p>Data Cloud consumes Media-owned lifecycle projections through this interface. It deliberately
 * cannot create jobs, accept raw media bytes, or own lifecycle transitions:
 * <ul>
 *   <li>Get job status</li>
 *   <li>Fetch transcript</li>
 *   <li>Fetch frame index</li>
 *   <li>Fetch extracted events</li>
 *   <li>Fetch embeddings/index metadata</li>
 * </ul>
 *
 * @doc.type interface
 * @doc.purpose Read-only Data Cloud projection boundary for Media-owned results
 * @doc.layer product
 * @doc.pattern Service Provider Interface
 */
public interface MediaProcessingProvider {

    /**
     * Get current status of a media processing job.
     *
     * @param jobId Job identifier
     * @param tenantId Tenant identifier
     * @return Job status or null if not found
     */
    MediaProcessingJob getJobStatus(String jobId, String tenantId);

    /**
     * Fetch transcript result for an audio artifact.
     *
     * @param artifactId Media artifact ID
     * @param tenantId Tenant identifier
     * @return Transcript result or null if not available
     */
    TranscriptResult fetchTranscript(String artifactId, String tenantId);

    /**
     * Fetch frame index result for an image/video artifact.
     *
     * @param artifactId Media artifact ID
     * @param tenantId Tenant identifier
     * @return Frame index result or null if not available
     */
    FrameIndexResult fetchFrameIndex(String artifactId, String tenantId);

    /**
     * Fetch extracted events from media analysis.
     *
     * @param artifactId Media artifact ID
     * @param tenantId Tenant identifier
     * @return List of extracted events
     */
    List<ExtractedEvent> fetchExtractedEvents(String artifactId, String tenantId);

    /**
     * Fetch embeddings and index metadata for the processed media.
     *
     * @param artifactId Media artifact ID
     * @param tenantId Tenant identifier
     * @return Embedding metadata or null if not available
     */
    EmbeddingMetadata fetchEmbeddings(String artifactId, String tenantId);

    /**
     * List all jobs for a given artifact.
     *
     * @param artifactId Media artifact ID
     * @param tenantId Tenant identifier
     * @return List of jobs for the artifact
     */
    List<MediaProcessingJob> listJobsForArtifact(String artifactId, String tenantId);
}
