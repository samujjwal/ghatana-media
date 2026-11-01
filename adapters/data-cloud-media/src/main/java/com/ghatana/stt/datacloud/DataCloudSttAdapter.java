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
 * Legacy adapter for the Data Cloud MediaProcessorPort STT shape.
 *
 * <p>The current MediaProcessorPort does not bind immutable source version,
 * authenticated principal, purpose, or live rights/disclosure readback. This
 * adapter therefore advertises no available transcription operation until
 * those source-owned inputs are provided; it is not publication authority.
 *
 * <p>The legacy interface's tenant argument is request scope, not authentication.
 * Callers must not infer rights or successful transcription from constructing
 * this adapter or from its compatibility methods.
 *
 * <p>The adapter has no:
 * <ul>
 *   <li>authenticated principal/delegation input</li>
 *   <li>immutable source-version or purpose/consent readback</li>
 *   <li>authority to publish events or Data Cloud records</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose Fail-closed legacy STT adapter for Data Cloud MediaProcessorPort
 * @doc.layer product
 * @doc.pattern Adapter
 */
public class DataCloudSttAdapter implements MediaProcessorPort {

    private static final Logger LOG = LoggerFactory.getLogger(DataCloudSttAdapter.class);
    private static final String SOURCE_NOT_ADMITTED_MESSAGE =
            "STT_SOURCE_AUTHORITY_NOT_ADMITTED: source, principal, purpose, and disclosure bindings are required";

    private final PersistentSttService sttService;

    public DataCloudSttAdapter(PersistentSttService sttService) {
        this.sttService = sttService;
    }

    @Override
    public Promise<String> transcribeAudio(String artifactId, String tenantId, String languageCode, Map<String, String> parameters) {
        if (!isAvailable("TRANSCRIPTION")) {
            return Promise.ofException(new IllegalStateException(SOURCE_NOT_ADMITTED_MESSAGE));
        }

        LOG.info("[WS3] Transcribing audio");
        return sttService.transcribe(artifactId, tenantId, languageCode, parameters)
            .map(transcriptId -> {
                LOG.info("[WS3] Transcription completed");
                return transcriptId;
            })
            .whenException(ex -> {
                LOG.error("[WS3] Transcription failed failureType={}", ex.getClass().getSimpleName());
            });
    }

    @Override
    public Promise<String> analyzeVision(String artifactId, String tenantId, String analysisType, Map<String, String> parameters) {
        // WS3: STT adapter does not support vision analysis
        LOG.warn("[WS3] Vision analysis not supported by STT adapter");
        return Promise.of(null);
    }

    @Override
    public Promise<String> indexMultimodal(String artifactId, String tenantId, String indexType, Map<String, String> parameters) {
        // WS3: STT adapter does not support multimodal indexing
        LOG.warn("[WS3] Multimodal indexing not supported by STT adapter");
        return Promise.of(null);
    }

    @Override
    public boolean isAvailable(String operationType) {
        // The current artifact-backed PersistentSttService has no admitted source/version,
        // purpose, and rights path. A constructed service or healthy local engine does not
        // make this Data Cloud operation available.
        return false;
    }

    @Override
    public String[] getSupportedLanguages() {
        // No locale is advertised until a source-authorized, qualified model profile is admitted.
        return new String[0];
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
