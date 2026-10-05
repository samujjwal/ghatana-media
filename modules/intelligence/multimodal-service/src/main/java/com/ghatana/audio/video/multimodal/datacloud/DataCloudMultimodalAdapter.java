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
        LOG.warn("[WS3] Standalone transcription not supported by multimodal adapter artifactId={} tenantId={}", artifactId, tenantId);
        return Promise.of(null);
    }

    @Override
    public Promise<String> analyzeVision(String artifactId, String tenantId, String analysisType, Map<String, String> parameters) {
        // WS3: Multimodal adapter does not support standalone vision analysis
        LOG.warn("[WS3] Standalone vision analysis not supported by multimodal adapter artifactId={} tenantId={}", artifactId, tenantId);
        return Promise.of(null);
    }

    @Override
    public Promise<String> indexMultimodal(String artifactId, String tenantId, String indexType, Map<String, String> parameters) {
        LOG.info("[WS3] Indexing multimodal artifactId={} tenantId={} indexType={}", artifactId, tenantId, indexType);
        
        // WS3: Delegate to multimodal service for indexing
        // The multimodal service should return a multimodal index ID that can be stored in Data Cloud
        return multimodalService.index(artifactId, tenantId, indexType, parameters)
            .map(indexId -> {
                LOG.info("[WS3] Multimodal indexing completed artifactId={} indexId={}", artifactId, indexId);
                return indexId;
            })
            .whenException(ex -> {
                LOG.error("[WS3] Multimodal indexing failed artifactId={} tenantId={}", artifactId, tenantId, ex);
            });
    }

    @Override
    public boolean isAvailable(String operationType) {
        // WS3: Multimodal adapter only supports multimodal indexing
        return "MULTIMODAL".equalsIgnoreCase(operationType) && multimodalService != null;
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
        // WS3: Return supported index types from multimodal service
        return new String[]{
            "AUDIO_VISUAL",
            "SCENE_UNDERSTANDING",
            "EMOTION_RECOGNITION",
            "ACTIVITY_DETECTION"
        };
    }
}
