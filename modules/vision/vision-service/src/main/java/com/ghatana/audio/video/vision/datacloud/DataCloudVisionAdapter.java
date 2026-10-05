/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.vision.datacloud;

import com.ghatana.audio.video.vision.service.PersistentVisionService;
import com.ghatana.datacloud.memory.media.MediaProcessorPort;
import io.activej.promise.Promise;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;

/**
 * WS3: Adapter for vision service to implement Data Cloud MediaProcessorPort.
 *
 * <p>This adapter bridges the audio-video vision service with Data Cloud's media processing
 * port, enabling vision analysis (object detection, face recognition, scene understanding)
 * through the canonical media processing interface.
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
 * @doc.purpose Adapter for vision service to implement Data Cloud MediaProcessorPort
 * @doc.layer product
 * @doc.pattern Adapter
 */
public class DataCloudVisionAdapter implements MediaProcessorPort {

    private static final Logger LOG = LoggerFactory.getLogger(DataCloudVisionAdapter.class);

    private final PersistentVisionService visionService;

    public DataCloudVisionAdapter(PersistentVisionService visionService) {
        this.visionService = visionService;
    }

    @Override
    public Promise<String> transcribeAudio(String artifactId, String tenantId, String languageCode, Map<String, String> parameters) {
        // WS3: Vision adapter does not support transcription
        LOG.warn("[WS3] Transcription not supported by vision adapter artifactId={} tenantId={}", artifactId, tenantId);
        return Promise.of(null);
    }

    @Override
    public Promise<String> analyzeVision(String artifactId, String tenantId, String analysisType, Map<String, String> parameters) {
        LOG.info("[WS3] Analyzing vision artifactId={} tenantId={} analysisType={}", artifactId, tenantId, analysisType);
        
        // WS3: Delegate to vision service for analysis
        // The vision service should return a frame index ID that can be stored in Data Cloud
        return visionService.analyze(artifactId, tenantId, analysisType, parameters)
            .map(frameIndexId -> {
                LOG.info("[WS3] Vision analysis completed artifactId={} frameIndexId={}", artifactId, frameIndexId);
                return frameIndexId;
            })
            .whenException(ex -> {
                LOG.error("[WS3] Vision analysis failed artifactId={} tenantId={}", artifactId, tenantId, ex);
            });
    }

    @Override
    public Promise<String> indexMultimodal(String artifactId, String tenantId, String indexType, Map<String, String> parameters) {
        // WS3: Vision adapter does not support multimodal indexing
        LOG.warn("[WS3] Multimodal indexing not supported by vision adapter artifactId={} tenantId={}", artifactId, tenantId);
        return Promise.of(null);
    }

    @Override
    public boolean isAvailable(String operationType) {
        // WS3: Vision adapter only supports vision analysis
        return "VISION".equalsIgnoreCase(operationType) && visionService != null;
    }

    @Override
    public String[] getSupportedLanguages() {
        // WS3: Vision adapter does not support transcription
        return new String[0];
    }

    @Override
    public String[] getSupportedAnalysisTypes() {
        // WS3: Return supported analysis types from vision service
        return new String[]{
            "OBJECT_DETECTION",
            "FACE_RECOGNITION",
            "SCENE_UNDERSTANDING",
            "OCR",
            "CLASSIFICATION"
        };
    }

    @Override
    public String[] getSupportedIndexTypes() {
        // WS3: Vision adapter does not support multimodal indexing
        return new String[0];
    }
}
