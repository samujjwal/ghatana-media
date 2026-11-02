package com.ghatana.media.runtime;

import org.junit.jupiter.api.Test;

import java.util.UUID;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WhisperComputeContractsTest {
    private static final UUID INVOCATION = UUID.fromString("d9b6aee5-8a33-4dca-bb04-95153e00c79a");
    private static final byte[] WAV_BYTES = {1, 2, 3};
    private static final String SOURCE_DIGEST = sha256(WAV_BYTES);
    private static final String MODEL_DIGEST = "b".repeat(64);

    @Test
    void requestPreservesComputeIdentityAndDefensivelyCopiesWavBytes() {
        byte[] original = {1, 2, 3};
        var request = request(original);
        original[0] = 9;

        assertThat(request.invocationId()).isEqualTo(INVOCATION);
        assertThat(request.profileId()).isEqualTo("whisper.en.v1");
        assertThat(request.locale()).isEqualTo("en-US");
        assertThat(request.sourceSha256()).isEqualTo(SOURCE_DIGEST);
        assertThat(request.remainingBudgetMillis()).isEqualTo(2_500);
        assertThat(request.wavPayload()).containsExactly(1, 2, 3);

        byte[] returned = request.wavPayload();
        returned[1] = 8;
        assertThat(request.wavPayload()).containsExactly(1, 2, 3);
    }

    @Test
    void requestRejectsMissingMalformedAndOutOfBoundFields() {
        assertThatThrownBy(() -> new WhisperComputeContracts.Request(
                null, "whisper.v1", "en", SOURCE_DIGEST, new byte[]{1}, 1))
                .isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new WhisperComputeContracts.Request(
                INVOCATION, " ../profile", "en", SOURCE_DIGEST, new byte[]{1}, 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new WhisperComputeContracts.Request(
                INVOCATION, "whisper.v1", "en_US", SOURCE_DIGEST, new byte[]{1}, 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new WhisperComputeContracts.Request(
                INVOCATION, "whisper.v1", "und", SOURCE_DIGEST, new byte[]{1}, 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new WhisperComputeContracts.Request(
                INVOCATION, "whisper.v1", "en", "A".repeat(64), new byte[]{1}, 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new WhisperComputeContracts.Request(
                INVOCATION, "whisper.v1", "en", SOURCE_DIGEST, new byte[]{4}, 1))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("must match the WAV payload");
        assertThatThrownBy(() -> new WhisperComputeContracts.Request(
                INVOCATION, "whisper.v1", "en", SOURCE_DIGEST, new byte[0], 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new WhisperComputeContracts.Request(
                INVOCATION, "whisper.v1", "en", SOURCE_DIGEST,
                new byte[WhisperComputeContracts.MAX_WAV_BYTES + 1], 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new WhisperComputeContracts.Request(
                INVOCATION, "whisper.v1", "en", SOURCE_DIGEST, new byte[]{1}, 0))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new WhisperComputeContracts.Request(
                INVOCATION, "whisper.v1", "en", SOURCE_DIGEST, new byte[]{1},
                WhisperComputeContracts.MAX_REMAINING_BUDGET_MILLIS + 1))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void resultBindsInvocationProfileInputAndPinnedModelAndAllowsSuccessFlags() {
        var result = success();
        assertThat(result.invocationId()).isEqualTo(INVOCATION);
        assertThat(result.profileId()).isEqualTo("whisper.en.v1");
        assertThat(result.inputSha256()).isEqualTo(SOURCE_DIGEST);
        assertThat(result.modelSha256()).isEqualTo(MODEL_DIGEST);
        assertThat(result.transcript()).isEqualTo("hello world");
        assertThat(result.status()).isEqualTo(WhisperComputeContracts.Status.SUCCESS);
        assertThat(result.complete()).isTrue();
        assertThat(result.endOfTask()).isTrue();
        assertThat(result.tokenLimitReached()).isFalse();
    }

    @Test
    void resultEnforcesBoundsAndNonSuccessHasNoTranscriptOrCompletionClaims() {
        assertThatThrownBy(() -> new WhisperComputeContracts.Result(
                INVOCATION, "whisper.en.v1", SOURCE_DIGEST, MODEL_DIGEST, "x".repeat(
                        WhisperComputeContracts.MAX_TRANSCRIPT_CHARS + 1),
                WhisperComputeContracts.Status.SUCCESS, true, true, false))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new WhisperComputeContracts.Result(
                INVOCATION, "whisper.en.v1", SOURCE_DIGEST, "not-a-digest", "",
                WhisperComputeContracts.Status.SUCCESS, true, false, false))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new WhisperComputeContracts.Result(
                INVOCATION, "whisper.en.v1", SOURCE_DIGEST, null, "",
                WhisperComputeContracts.Status.SUCCESS, true, true, false))
                .isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new WhisperComputeContracts.Result(
                INVOCATION, "whisper.en.v1", SOURCE_DIGEST, MODEL_DIGEST, "hello",
                WhisperComputeContracts.Status.SUCCESS, true, false, false))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new WhisperComputeContracts.Result(
                INVOCATION, "whisper.en.v1", SOURCE_DIGEST, MODEL_DIGEST, "hello",
                WhisperComputeContracts.Status.SUCCESS, true, true, true))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new WhisperComputeContracts.Result(
                INVOCATION, "whisper.en.v1", SOURCE_DIGEST, null, "partial",
                WhisperComputeContracts.Status.UNKNOWN_OUTCOME, false, false, false))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new WhisperComputeContracts.Result(
                INVOCATION, "whisper.en.v1", SOURCE_DIGEST, MODEL_DIGEST, "",
                WhisperComputeContracts.Status.DEADLINE_EXCEEDED, true, false, false))
                .isInstanceOf(IllegalArgumentException.class);

        for (var status : WhisperComputeContracts.Status.values()) {
            assertThat(status).isNotNull();
        }
        assertThat(WhisperComputeContracts.Status.values()).containsExactly(
                WhisperComputeContracts.Status.SUCCESS,
                WhisperComputeContracts.Status.DEADLINE_EXCEEDED,
                WhisperComputeContracts.Status.UNKNOWN_OUTCOME,
                WhisperComputeContracts.Status.NOT_ADMITTED,
                WhisperComputeContracts.Status.RESOURCE_EXHAUSTED,
                WhisperComputeContracts.Status.INVALID_REQUEST);

        var preAdmission = new WhisperComputeContracts.Result(
                INVOCATION, "whisper.en.v1", SOURCE_DIGEST, null, "",
                WhisperComputeContracts.Status.NOT_ADMITTED, false, false, false);
        assertThat(preAdmission.modelSha256()).isNull();
    }

    private static WhisperComputeContracts.Request request(byte[] wav) {
        return new WhisperComputeContracts.Request(
                INVOCATION, "whisper.en.v1", "en-us", sha256(wav), wav, 2_500);
    }

    private static WhisperComputeContracts.Result success() {
        return new WhisperComputeContracts.Result(
                INVOCATION, "whisper.en.v1", SOURCE_DIGEST, MODEL_DIGEST, "hello world",
                WhisperComputeContracts.Status.SUCCESS, true, true, false);
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException exception) {
            throw new AssertionError("SHA-256 is required by the Java runtime", exception);
        }
    }
}
