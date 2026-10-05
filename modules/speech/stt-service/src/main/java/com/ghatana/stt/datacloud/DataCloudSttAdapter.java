/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.stt.datacloud;

import com.ghatana.datacloud.memory.media.MediaProcessorPort;
import com.ghatana.stt.service.PersistentSttService;
import io.activej.promise.Promise;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;

/**
 * WS3: Adapter for STT service to implement Data Cloud MediaProcessorPort.
 *
 * <p>This adapter bridges the audio-video STT service with Data Cloud's media processing
 * port, enabling transcription through the canonical media processing interface.
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
 * @doc.purpose Adapter for STT service to implement Data Cloud MediaProcessorPort
 * @doc.layer product
 * @doc.pattern Adapter
 */
public class DataCloudSttAdapter implements MediaProcessorPort {

    private static final Logger LOG = LoggerFactory.getLogger(DataCloudSttAdapter.class);

    private final PersistentSttService sttService;

    public DataCloudSttAdapter(PersistentSttService sttService) {
        this.sttService = sttService;
    }

    @Override
    public Promise<String> transcribeAudio(String artifactId, String tenantId, String languageCode, Map<String, String> parameters) {
        LOG.info("[WS3] Transcribing audio artifactId={} tenantId={} languageCode={}", artifactId, tenantId, languageCode);
        
        // WS3: Delegate to STT service for transcription
        // The STT service should return a transcript ID that can be stored in Data Cloud
        return sttService.transcribe(artifactId, tenantId, languageCode, parameters)
            .map(transcriptId -> {
                LOG.info("[WS3] Transcription completed artifactId={} transcriptId={}", artifactId, transcriptId);
                return transcriptId;
            })
            .whenException(ex -> {
                LOG.error("[WS3] Transcription failed artifactId={} tenantId={}", artifactId, tenantId, ex);
            });
    }

    @Override
    public Promise<String> analyzeVision(String artifactId, String tenantId, String analysisType, Map<String, String> parameters) {
        // WS3: STT adapter does not support vision analysis
        LOG.warn("[WS3] Vision analysis not supported by STT adapter artifactId={} tenantId={}", artifactId, tenantId);
        return Promise.of(null);
    }

    @Override
    public Promise<String> indexMultimodal(String artifactId, String tenantId, String indexType, Map<String, String> parameters) {
        // WS3: STT adapter does not support multimodal indexing
        LOG.warn("[WS3] Multimodal indexing not supported by STT adapter artifactId={} tenantId={}", artifactId, tenantId);
        return Promise.of(null);
    }

    @Override
    public boolean isAvailable(String operationType) {
        // WS3: STT adapter only supports transcription
        return "TRANSCRIPTION".equalsIgnoreCase(operationType)
            && sttService != null
            && !sttService.isDegraded();
    }

    @Override
    public String[] getSupportedLanguages() {
        // WS3: Return supported languages from STT service
        // Default to common languages if service doesn't provide this
        return new String[]{"en-US", "es-ES", "fr-FR", "de-DE", "it-IT", "pt-BR", "ja-JP", "ko-KR", "zh-CN"};
    }

    @Override
    public String[] getSupportedAnalysisTypes() {
        // WS3: STT adapter does not support vision analysis
        return new String[0];
    }

    @Override
    public String[] getSupportedIndexTypes() {
        // WS3: STT adapter does not support multimodal indexing
        return new String[0];
    }
}
