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
 * Legacy adapter for the Data Cloud MediaProcessorPort Vision shape.
 *
 * <p>The current MediaProcessorPort does not bind immutable source version,
 * authenticated principal, source timebase, or live rights/disclosure
 * readback. This adapter therefore advertises no available Vision operation
 * until those source-owned inputs are provided. Document Intelligence owns
 * OCR execution; Media is only a consumer of its public contract.
 *
 * <p>The legacy interface's tenant argument is request scope, not authentication.
 * Callers must not infer rights or successful frame analysis from constructing
 * this adapter or from its compatibility methods.
 *
 * <p>The adapter has no:
 * <ul>
 *   <li>authenticated principal/delegation input</li>
 *   <li>immutable source-version, source-timebase or purpose/consent readback</li>
 *   <li>authority to publish events or Data Cloud records</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose Fail-closed legacy Vision adapter for Data Cloud MediaProcessorPort
 * @doc.layer product
 * @doc.pattern Adapter
 */
public class DataCloudVisionAdapter implements MediaProcessorPort {

    private static final Logger LOG = LoggerFactory.getLogger(DataCloudVisionAdapter.class);
    private static final String SOURCE_NOT_ADMITTED_MESSAGE =
            "VISION_SOURCE_AUTHORITY_NOT_ADMITTED: source version, timebase, principal, and disclosure bindings are required";

    private final PersistentVisionService visionService;

    public DataCloudVisionAdapter(PersistentVisionService visionService) {
        this.visionService = visionService;
    }

    @Override
    public Promise<String> transcribeAudio(String artifactId, String tenantId, String languageCode, Map<String, String> parameters) {
        // WS3: Vision adapter does not support transcription
        LOG.warn("[WS3] Transcription not supported by vision adapter");
        return Promise.of(null);
    }

    @Override
    public Promise<String> analyzeVision(String artifactId, String tenantId, String analysisType, Map<String, String> parameters) {
        if (!isAvailable("VISION")) {
            return Promise.ofException(new IllegalStateException(SOURCE_NOT_ADMITTED_MESSAGE));
        }

        LOG.info("[WS3] Analyzing vision artifact");
        return visionService.analyze(artifactId, tenantId, analysisType, parameters)
            .map(frameIndexId -> {
                LOG.info("[WS3] Vision analysis completed");
                return frameIndexId;
            })
            .whenException(ex -> {
                LOG.error("[WS3] Vision analysis failed ({})", ex.getClass().getSimpleName());
            });
    }

    @Override
    public Promise<String> indexMultimodal(String artifactId, String tenantId, String indexType, Map<String, String> parameters) {
        // WS3: Vision adapter does not support multimodal indexing
        LOG.warn("[WS3] Multimodal indexing not supported by vision adapter");
        return Promise.of(null);
    }

    @Override
    public boolean isAvailable(String operationType) {
        // PersistentVisionService.analyze has no trusted artifact/version reader and fails closed.
        // A constructed local detector does not admit an artifact-backed Data Cloud operation.
        return false;
    }

    @Override
    public String[] getSupportedLanguages() {
        // WS3: Vision adapter does not support transcription
        return new String[0];
    }

    @Override
    public String[] getSupportedAnalysisTypes() {
        // Do not advertise detector, biometric, or OCR operations without a source-bound public
        // contract and their respective rights/consent admission paths. OCR is owned by DI.
        return new String[0];
    }

    @Override
    public String[] getSupportedIndexTypes() {
        // WS3: Vision adapter does not support multimodal indexing
        return new String[0];
    }
}
