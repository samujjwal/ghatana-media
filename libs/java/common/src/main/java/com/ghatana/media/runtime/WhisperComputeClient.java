package com.ghatana.media.runtime;

import com.ghatana.media.runtime.WhisperComputeContracts.Request;
import com.ghatana.media.runtime.WhisperComputeContracts.Result;
import java.io.IOException;
import java.util.UUID;

/** Platform-neutral boundary for an authenticated Whisper compute transport. */
public interface WhisperComputeClient {
    Result execute(Request request) throws IOException;
    /** Deadline-aware overload; legacy implementations retain behavior through this adapter. */
    default Result execute(Request request, MediaRuntimeContracts.ProcessingContext.MonotonicDeadline deadline)
            throws IOException {
        if (deadline.expired()) return new Result(request.invocationId(), request.profileId(),
                request.sourceSha256(), null, "", WhisperComputeContracts.Status.DEADLINE_EXCEEDED,
                false, false, false);
        return execute(request);
    }
    Result status(UUID invocationId, String profileId, String locale, String sourceSha256) throws IOException;
    Result cancel(UUID invocationId, String profileId, String locale, String sourceSha256) throws IOException;
}
