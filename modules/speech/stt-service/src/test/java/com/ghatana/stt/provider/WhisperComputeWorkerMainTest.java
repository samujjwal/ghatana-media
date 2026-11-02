package com.ghatana.stt.provider;

import tools.jackson.databind.ObjectMapper;
import com.ghatana.media.runtime.WhisperComputeContracts.Request;
import com.ghatana.media.runtime.WhisperComputeContracts.Result;
import com.ghatana.media.runtime.WhisperComputeContracts.Status;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;

class WhisperComputeWorkerMainTest {
    private static final String MODEL = "a".repeat(64);

    @Test
    void absentServerProfileReturnsNotAdmittedWithoutOpeningEngine() throws Exception {
        Request request = request();
        AtomicBoolean invoked = new AtomicBoolean();

        Result response = WhisperComputeWorkerMain.handle(json(request), Map.of(), (input, profile) -> {
            invoked.set(true);
            throw new AssertionError("unconfigured profile must not initialize an engine");
        });

        assertThat(response.status()).isEqualTo(Status.NOT_ADMITTED);
        assertThat(response.transcript()).isEmpty();
        assertThat(invoked).isFalse();
    }

    @Test
    void boundedProtocolUsesOnlyServerOwnedProfileAndReturnsExactTypedResult() throws Exception {
        Request request = request();
        Map<String, String> serverProfile = Map.of(
                "MEDIA_WHISPER_WORKER_PROFILE_ID", "profile.en",
                "MEDIA_WHISPER_WORKER_MODEL_REVISION", "whisper-r1",
                "MEDIA_WHISPER_WORKER_MODEL_SHA256", MODEL,
                "MEDIA_WHISPER_WORKER_MODEL_PATH", "/worker/models/encoder_model_quantized.onnx");

        Result response = WhisperComputeWorkerMain.handle(json(request), serverProfile, (input, profile) -> {
            assertThat(profile.modelPath().toString()).isEqualTo("/worker/models/encoder_model_quantized.onnx");
            assertThat(profile.profileId()).isEqualTo("profile.en");
            return new Result(input.invocationId(), profile.profileId(), input.sourceSha256(),
                    profile.modelSha256(), "grounded transcript", Status.SUCCESS, true, true, false);
        });

        assertThat(response.status()).isEqualTo(Status.SUCCESS);
        assertThat(response.transcript()).isEqualTo("grounded transcript");
        assertThat(response.modelSha256()).isEqualTo(MODEL);
    }

    @Test
    void callerCannotSelectWorkerModelPathOrChangeResponseIdentity() throws Exception {
        Request request = request();
        Map<String, String> serverProfile = Map.of(
                "MEDIA_WHISPER_WORKER_PROFILE_ID", "profile.en",
                "MEDIA_WHISPER_WORKER_MODEL_REVISION", "whisper-r1",
                "MEDIA_WHISPER_WORKER_MODEL_SHA256", MODEL,
                "MEDIA_WHISPER_WORKER_MODEL_PATH", "/worker/models/encoder_model_quantized.onnx");

        Result mismatched = WhisperComputeWorkerMain.handle(json(request), serverProfile,
                (input, profile) -> new Result(UUID.randomUUID(), profile.profileId(), input.sourceSha256(),
                        profile.modelSha256(), "wrong identity", Status.SUCCESS, true, true, false));

        assertThat(mismatched.status()).isEqualTo(Status.UNKNOWN_OUTCOME);
        assertThat(mismatched.transcript()).isEmpty();
    }

    @Test
    void absentModelAssetReturnsNotAdmittedWithoutNetworkOrLoaderFallback() throws Exception {
        Request request = request();
        Map<String, String> serverProfile = Map.of(
                "MEDIA_WHISPER_WORKER_PROFILE_ID", "profile.en",
                "MEDIA_WHISPER_WORKER_MODEL_REVISION", "whisper-r1",
                "MEDIA_WHISPER_WORKER_MODEL_SHA256", MODEL,
                "MEDIA_WHISPER_WORKER_MODEL_PATH", "/media-test-missing/encoder_model_quantized.onnx");

        Result response = WhisperComputeWorkerMain.handle(json(request), serverProfile,
                WhisperComputeWorkerMain::runPinnedEngine);

        assertThat(response.status()).isEqualTo(Status.NOT_ADMITTED);
        assertThat(response.transcript()).isEmpty();
    }

    private static Request request() throws Exception {
        byte[] wav = new byte[]{1, 2, 3};
        return new Request(UUID.randomUUID(), "profile.en", "en", sha256(wav), wav, 1_000);
    }

    private static byte[] json(Request request) throws Exception {
        return new ObjectMapper().writeValueAsBytes(Map.of(
                "invocationId", request.invocationId().toString(),
                "profileId", request.profileId(),
                "locale", request.locale(),
                "sourceSha256", request.sourceSha256(),
                "wavBase64", Base64.getEncoder().encodeToString(request.wavPayload()),
                "remainingBudgetMillis", request.remainingBudgetMillis()));
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}
