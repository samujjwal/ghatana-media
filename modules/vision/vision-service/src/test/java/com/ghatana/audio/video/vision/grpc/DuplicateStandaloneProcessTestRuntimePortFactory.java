package com.ghatana.audio.video.vision.grpc;

import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaRuntimePortFactory;

import java.util.Map;

/** Second test-only provider used to prove the standalone process rejects ambiguity. */
public final class DuplicateStandaloneProcessTestRuntimePortFactory implements MediaRuntimePortFactory {
    @Override
    public String factoryId() {
        return "vision-standalone-process-duplicate-test-only";
    }

    @Override
    public MediaProcessingRuntimePort compose(Map<String, String> environment) {
        throw new AssertionError("ambiguous factories must be rejected before composition");
    }
}
