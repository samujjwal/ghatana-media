package com.ghatana.media.runtime;

import java.util.Locale;
import java.util.Objects;
import java.util.UUID;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * Typed compute-only boundary for a brokered Whisper invocation.
 *
 * <p>The request contains only the input and bounded compute intent. It deliberately has no
 * executable, argv, filesystem path, identity, or resource-control fields. Source authorization
 * and rights decisions remain outside this compute contract.</p>
 */
public final class WhisperComputeContracts {
    public static final int MAX_WAV_BYTES = 4 * 1024 * 1024;
    public static final int MAX_TRANSCRIPT_CHARS = 128 * 1024;
    public static final long MAX_REMAINING_BUDGET_MILLIS = 10 * 60 * 1_000L;

    private WhisperComputeContracts() { }

    /** A single immutable audio input and the caller's remaining wall-clock budget. */
    public record Request(
            UUID invocationId,
            String profileId,
            String locale,
            String sourceSha256,
            byte[] wavPayload,
            long remainingBudgetMillis) {
        public Request {
            invocationId = Objects.requireNonNull(invocationId, "invocationId");
            profileId = identifier(profileId, "profileId");
            locale = validatedLocale(locale);
            sourceSha256 = digest(sourceSha256, "sourceSha256");
            Objects.requireNonNull(wavPayload, "wavPayload");
            if (wavPayload.length == 0 || wavPayload.length > MAX_WAV_BYTES) {
                throw new IllegalArgumentException("wavPayload must be between 1 and " + MAX_WAV_BYTES + " bytes");
            }
            wavPayload = wavPayload.clone();
            if (!sourceSha256.equals(sha256(wavPayload))) {
                throw new IllegalArgumentException("sourceSha256 must match the WAV payload bytes");
            }
            if (remainingBudgetMillis < 1 || remainingBudgetMillis > MAX_REMAINING_BUDGET_MILLIS) {
                throw new IllegalArgumentException("remainingBudgetMillis is outside the supported range");
            }
        }

        /** Returns a copy so callers cannot mutate the validated payload after construction. */
        @Override
        public byte[] wavPayload() {
            return wavPayload.clone();
        }
    }

    /**
     * Final broker response bound to the exact invocation, profile, input and pinned model.
     * Non-success responses carry no transcript and cannot claim completion or task-finality.
     */
    public record Result(
            UUID invocationId,
            String profileId,
            String inputSha256,
            String modelSha256,
            String transcript,
            Status status,
            boolean complete,
            boolean endOfTask,
            boolean tokenLimitReached) {
        public Result {
            invocationId = Objects.requireNonNull(invocationId, "invocationId");
            profileId = identifier(profileId, "profileId");
            inputSha256 = digest(inputSha256, "inputSha256");
            transcript = Objects.requireNonNull(transcript, "transcript");
            if (transcript.length() > MAX_TRANSCRIPT_CHARS) {
                throw new IllegalArgumentException("transcript exceeds the supported length");
            }
            status = Objects.requireNonNull(status, "status");
            if (status == Status.SUCCESS) {
                modelSha256 = digest(modelSha256, "modelSha256");
                if (!complete || !endOfTask || tokenLimitReached) {
                    throw new IllegalArgumentException(
                            "successful result must be complete and end-of-task without reaching the token limit");
                }
            } else if (complete || endOfTask || tokenLimitReached || !transcript.isEmpty()) {
                throw new IllegalArgumentException("non-success result cannot contain transcript completion flags or text");
            } else if (modelSha256 != null) {
                modelSha256 = digest(modelSha256, "modelSha256");
            }
        }
    }

    /** Explicit outcome, including cases where the provider effect may have occurred. */
    public enum Status {
        SUCCESS,
        DEADLINE_EXCEEDED,
        UNKNOWN_OUTCOME,
        NOT_ADMITTED,
        RESOURCE_EXHAUSTED,
        INVALID_REQUEST
    }

    private static String identifier(String value, String name) {
        Objects.requireNonNull(value, name);
        if (value.length() > 128 || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]*")) {
            throw new IllegalArgumentException(name + " must be a bounded identifier");
        }
        return value;
    }

    private static String digest(String value, String name) {
        Objects.requireNonNull(value, name);
        if (!value.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException(name + " must be a lowercase SHA-256 hex digest");
        }
        return value;
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is not available", exception);
        }
    }

    private static String validatedLocale(String value) {
        Objects.requireNonNull(value, "locale");
        if (value.isBlank() || value.length() > 35 || !value.equals(value.trim())) {
            throw new IllegalArgumentException("locale must be a valid BCP-47 language tag");
        }
        try {
            Locale locale = new Locale.Builder().setLanguageTag(value).build();
            String canonical = locale.toLanguageTag();
            if (locale.getLanguage().isBlank() || "und".equals(canonical)) {
                throw new IllegalArgumentException("locale must include a language subtag");
            }
            return canonical;
        } catch (java.util.IllformedLocaleException exception) {
            throw new IllegalArgumentException("locale must be a valid BCP-47 language tag", exception);
        }
    }
}
