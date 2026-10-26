/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.datacloud;

import com.ghatana.audio.video.multimodal.service.PersistentMultimodalService;
import com.ghatana.datacloud.memory.media.MediaProcessorPort;
import io.activej.promise.Promise;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;

/**
 * WS3: Adapter for multimodal service to implement Data Cloud MediaProcessorPort.
 *
 * <p>This adapter bridges the audio-video multimodal service with Data Cloud's media processing
 * port, enabling multimodal indexing (audio-visual, scene understanding) through the canonical
 * media processing interface.
 *
 * <p>All operations are:
 * <ul>
 *   <li>Tenant-scoped via tenantId parameter</li>
 *   <li>Consent-aware - caller must check consent before processing</li>
 *   <li>Retention-aware - caller must check retention before processing</li>
 *   <li>Event-emitting - results should be emitted via MediaArtifactEventEmitter</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose Adapter for multimodal service to implement Data Cloud MediaProcessorPort
 * @doc.layer product
 * @doc.pattern Adapter
 */
public class DataCloudMultimodalAdapter implements MediaProcessorPort {

    private static final Logger LOG = LoggerFactory.getLogger(DataCloudMultimodalAdapter.class);

    private final PersistentMultimodalService multimodalService;

    public DataCloudMultimodalAdapter(PersistentMultimodalService multimodalService) {
        this.multimodalService = multimodalService;
    }

    @Override
    public Promise<String> transcribeAudio(String artifactId, String tenantId, String languageCode, Map<String, String> parameters) {
        // WS3: Multimodal adapter does not support standalone transcription
        LOG.warn("Standalone transcription is unavailable through the multimodal adapter");
        return Promise.ofException(new UnsupportedOperationException(
                "Standalone transcription is unavailable through the multimodal adapter"));
    }

    @Override
    public Promise<String> analyzeVision(String artifactId, String tenantId, String analysisType, Map<String, String> parameters) {
        // WS3: Multimodal adapter does not support standalone vision analysis
        LOG.warn("Standalone vision analysis is unavailable through the multimodal adapter");
        return Promise.ofException(new UnsupportedOperationException(
                "Standalone vision analysis is unavailable through the multimodal adapter"));
    }

    @Override
    public Promise<String> indexMultimodal(String artifactId, String tenantId, String indexType,
                                           Map<String, String> parameters) {
        if (artifactId == null || artifactId.isBlank() || tenantId == null || tenantId.isBlank()
                || indexType == null || indexType.isBlank()) {
            return Promise.ofException(new IllegalArgumentException(
                    "Artifact, tenant, and index type are required for multimodal indexing"));
        }
        if (multimodalService == null) {
            return Promise.ofException(new IllegalStateException(
                    "Data Cloud multimodal integration is unavailable"));
        }

        // PersistentMultimodalService.index currently fails closed until a trusted Data Cloud
        // artifact/version reader and rights/consent admission path are wired.
        return multimodalService.index(artifactId, tenantId, indexType, parameters)
                .mapException(ex -> {
                    // Provider and source exceptions can contain artifact text, tenant identifiers,
                    // or other scoped values. Keep this boundary's failure explicit but opaque.
                    LOG.warn("Multimodal indexing unavailable failureType={}",
                            ex.getClass().getSimpleName());
                    return new IllegalStateException("Data Cloud multimodal integration is unavailable");
                });
    }

    @Override
    public boolean isAvailable(String operationType) {
        // PersistentMultimodalService.index has no trusted artifact/version reader yet, so the
        // integration must remain unavailable even when the service object is constructed.
        return false;
    }

    @Override
    public String[] getSupportedLanguages() {
        // WS3: Multimodal adapter does not support standalone transcription
        return new String[0];
    }

    @Override
    public String[] getSupportedAnalysisTypes() {
        // WS3: Multimodal adapter does not support standalone vision analysis
        return new String[0];
    }

    @Override
    public String[] getSupportedIndexTypes() {
        // No indexing type is available before the governed artifact/version boundary is wired.
        return new String[0];
    }
}
