package com.ghatana.stt.grpc;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.audiovideo.observability.AudioVideoHealthService;
import com.ghatana.stt.core.grpc.proto.STTServiceGrpc;
import com.ghatana.stt.core.grpc.proto.SttServiceProto;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import java.util.List;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.StreamObserver;
import com.ghatana.stt.core.grpc.proto.AdaptRequest;
import com.ghatana.stt.core.grpc.proto.AdaptResponse;
import com.ghatana.stt.core.grpc.proto.CorrectionRequest;
import com.ghatana.stt.core.grpc.proto.CorrectionResponse;
import com.ghatana.stt.core.grpc.proto.CreateProfileRequest;
import com.ghatana.stt.core.grpc.proto.GetProfileRequest;
import com.ghatana.stt.core.grpc.proto.ProfileResponse;
import com.ghatana.stt.core.grpc.proto.UnloadModelRequest;
import com.ghatana.stt.core.grpc.proto.UnloadModelResponse;
import com.ghatana.stt.core.grpc.proto.UpdateProfileRequest;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class ProductionSttGrpcServiceTest {

    @TempDir
    Path tempDir;

    @Test
    void providerModeMustBeExplicit() {
        assertThatThrownBy(() -> ProductionSttGrpcService.resolveProviderProfile(Map.of()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("STT_PROVIDER_MODE must explicitly select");
    }

    @Test
    void protoContractRetainsAllTwelveRpcNamesAndCoreFieldNumbers() {
        List<String> rpcNames = STTServiceGrpc.getServiceDescriptor().getMethods().stream()
                .map(method -> method.getBareMethodName())
                .collect(Collectors.toList());
        assertThat(rpcNames).containsExactly(
                "Transcribe", "StreamTranscribe", "LoadModel", "UnloadModel", "ListModels",
                "AdaptModel", "GetStatus", "HealthCheck", "CreateProfile", "GetProfile",
                "UpdateProfile", "SubmitCorrection");

        var transcribeRequest = SttServiceProto.getDescriptor().findMessageTypeByName("TranscribeRequest");
        assertThat(transcribeRequest.findFieldByName("audio_data").getNumber()).isEqualTo(1);
        assertThat(transcribeRequest.findFieldByName("tenant_id").getNumber()).isEqualTo(6);
        assertThat(transcribeRequest.findFieldByName("consent_status").getNumber()).isEqualTo(10);
    }

    @Test
    void packageCapabilityLedgerMatchesTheSixteenPlanMemberships() throws Exception {
        Path root = repositoryRoot();
        String plan = Files.readString(root.resolve(
                "docs/implementation/MEDIA-BACKEND-MODALITY-WAVE2-EXECUTION.md"));
        String readme = Files.readString(root.resolve("modules/speech/stt-service/README.md"));

        Set<String> planIntents = captureGroup(plan,
                "(?m)^\\| STT \\| `(media\\.speech\\.transcription\\.[^`]+)` \\|");
        Set<String> ledgerIntents = captureGroup(readme,
                "(?m)^\\| `(media\\.speech\\.transcription\\.[^`]+)` \\|");

        assertThat(planIntents).hasSize(16);
        assertThat(ledgerIntents).hasSize(16).containsExactlyInAnyOrderElementsOf(planIntents);
    }

    private static Path repositoryRoot() {
        Path current = Path.of("").toAbsolutePath();
        while (current != null && !Files.isDirectory(current.resolve(".product-experience"))) {
            current = current.getParent();
        }
        if (current == null) throw new IllegalStateException("Cannot locate Media repository root");
        return current;
    }

    private static Set<String> captureGroup(String source, String expression) {
        Matcher matcher = Pattern.compile(expression).matcher(source);
        Set<String> values = new LinkedHashSet<>();
        while (matcher.find()) values.add(matcher.group(1));
        return values;
    }

    @Test
    void productionCompositionKeepsUnsupportedRpcPathsExplicitlyUnavailable() {
        ProductionSttGrpcService service = new ProductionSttGrpcService(
                mock(AudioVideoLibrary.class), new SimpleMeterRegistry());

        ProductionSttGrpcServiceTest.<UnloadModelResponse>assertUnimplemented(
                observer -> service.unloadModel(UnloadModelRequest.getDefaultInstance(), observer));
        ProductionSttGrpcServiceTest.<AdaptResponse>assertFailedPrecondition(
                observer -> runWithTenantPrincipal(() -> service.adaptModel(AdaptRequest.getDefaultInstance(), observer)),
                "STT_ADAPTATION_NOT_ADMITTED:");
        ProductionSttGrpcServiceTest.<ProfileResponse>assertNotAdmitted(
                observer -> runWithTenantPrincipal(() -> service.createProfile(CreateProfileRequest.getDefaultInstance(), observer)));
        ProductionSttGrpcServiceTest.<ProfileResponse>assertNotAdmitted(
                observer -> runWithTenantPrincipal(() -> service.getProfile(GetProfileRequest.getDefaultInstance(), observer)));
        ProductionSttGrpcServiceTest.<ProfileResponse>assertNotAdmitted(
                observer -> runWithTenantPrincipal(() -> service.updateProfile(UpdateProfileRequest.getDefaultInstance(), observer)));
        ProductionSttGrpcServiceTest.<CorrectionResponse>assertFailedPrecondition(
                observer -> runWithTenantPrincipal(() -> service.submitCorrection(CorrectionRequest.getDefaultInstance(), observer)),
                "STT_CORRECTION_NOT_ADMITTED:");
    }

    @Test
    void sensitiveRpcRejectsMissingOrInvalidIdentityBeforeProviderAccess() {
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        ProductionSttGrpcService service = new ProductionSttGrpcService(library, new SimpleMeterRegistry());

        assertSensitiveRpcIdentityFailure(callSensitiveRpcs(service));

        io.grpc.Context.current()
                .withValue(com.ghatana.audio.video.common.security.JwtServerInterceptor.CTX_TENANT, "tenant-test")
                .withValue(com.ghatana.audio.video.common.security.JwtServerInterceptor.CTX_SUBJECT, "bad-subject")
                .run(() -> assertSensitiveRpcIdentityFailure(callSensitiveRpcs(service)));
        verifyNoInteractions(library);
    }

    @Test
    void healthyLocalEngineDoesNotPromoteUnadmittedProviderReadiness() {
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        ProductionSttGrpcService service = new ProductionSttGrpcService(library, new SimpleMeterRegistry());
        AudioVideoHealthService readiness = SttGrpcServer.readinessService(service);

        assertThat(readiness.isServing()).isFalse();

        var standard = new CapturingObserver<io.grpc.health.v1.HealthCheckResponse>();
        readiness.check(io.grpc.health.v1.HealthCheckRequest.getDefaultInstance(), standard);
        assertThat(standard.value.getStatus())
                .isEqualTo(io.grpc.health.v1.HealthCheckResponse.ServingStatus.NOT_SERVING);

        var application = new CapturingObserver<com.ghatana.stt.core.grpc.proto.HealthCheckResponse>();
        service.healthCheck(
                com.ghatana.stt.core.grpc.proto.HealthCheckRequest.getDefaultInstance(), application);
        assertThat(application.value.getStatus())
                .isEqualTo(com.ghatana.stt.core.grpc.proto.HealthStatus.HEALTH_STATUS_UNHEALTHY);
        assertThat(application.value.getMessage()).isEqualTo("STT_NOT_SERVING: provider readiness unavailable");
        verifyNoInteractions(library);
        readiness.close();
        service.close();
    }

    private static List<CapturingObserver<?>> callSensitiveRpcs(ProductionSttGrpcService service) {
        var adapt = new CapturingObserver<AdaptResponse>();
        var create = new CapturingObserver<ProfileResponse>();
        var get = new CapturingObserver<ProfileResponse>();
        var update = new CapturingObserver<ProfileResponse>();
        var correction = new CapturingObserver<CorrectionResponse>();
        service.adaptModel(AdaptRequest.getDefaultInstance(), adapt);
        service.createProfile(CreateProfileRequest.getDefaultInstance(), create);
        service.getProfile(GetProfileRequest.getDefaultInstance(), get);
        service.updateProfile(UpdateProfileRequest.getDefaultInstance(), update);
        service.submitCorrection(CorrectionRequest.getDefaultInstance(), correction);
        return List.of(adapt, create, get, update, correction);
    }

    private static void assertSensitiveRpcIdentityFailure(List<CapturingObserver<?>> observers) {
        for (CapturingObserver<?> observer : observers) assertUnauthenticated(observer);
    }

    private static void runWithTenantPrincipal(Runnable action) {
        io.grpc.Context.current()
                .withValue(com.ghatana.audio.video.common.security.JwtServerInterceptor.CTX_TENANT, "tenant-test")
                .withValue(com.ghatana.audio.video.common.security.JwtServerInterceptor.CTX_SUBJECT,
                        "00000000-0000-0000-0000-000000000001")
                .run(action);
    }

    private static void assertUnauthenticated(CapturingObserver<?> observer) {
        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.error).getStatus().getCode())
                .isEqualTo(Status.UNAUTHENTICATED.getCode());
    }

    @Test
    void unsupportedProviderModeFailsClosed() {
        assertThatThrownBy(() -> ProductionSttGrpcService.resolveProviderProfile(
                Map.of("STT_PROVIDER_MODE", "local-or-grpc")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Unsupported STT_PROVIDER_MODE");
    }

    @Test
    void grpcProviderProfileIsNotAdmittedWithoutAnUpstreamAdapter() {
        ProductionSttGrpcService.ProviderProfile profile =
                ProductionSttGrpcService.resolveProviderProfile(grpcProfile());

        assertThat(profile.mode()).isEqualTo(ProductionSttGrpcService.ProviderMode.GRPC);
        assertThat(profile.status()).isEqualTo("NOT_ADMITTED");
        assertThat(profile.modelId()).isEqualTo("whisper-base");
        assertThat(profile.modelVersion()).isEqualTo("2026.10");
        assertThat(profile.modelDigest()).isEqualTo("a".repeat(64));
        assertThat(profile.license()).isEqualTo("UNKNOWN_PENDING_OWNER_REVIEW");
        assertThat(profile.executionHardware()).isEqualTo("cpu");
        assertThat(profile.region()).isEqualTo("us-test-1");

        assertThatThrownBy(() -> ProductionSttGrpcService.createConfig(grpcProfile()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageStartingWith("STT_PROVIDER_NOT_ADMITTED:");
    }

    @Test
    void grpcModeRejectsLocalModelConfiguration() {
        assertThatThrownBy(() -> ProductionSttGrpcService.resolveProviderProfile(Map.of(
                        "STT_PROVIDER_MODE", "GRPC",
                        "STT_GRPC_HOST", "stt.internal",
                        "STT_MODEL_ID", "whisper-base")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Local model settings do not match GRPC");
    }

    @Test
    void grpcModeRequiresAnEndpointAndManifestDeclaresItsRuntimeProfileFields() throws Exception {
        Map<String, String> profile = new java.util.HashMap<>(grpcProfile());
        profile.remove("STT_GRPC_HOST");
        assertThatThrownBy(() -> ProductionSttGrpcService.resolveProviderProfile(profile))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("STT_GRPC_HOST is required");

        Path root = repositoryRoot();
        String manifest = Files.readString(root.resolve("config/provider-manifest.json"));
        Matcher grpcProfileMatcher = Pattern.compile(
                "(?s)\\\"mode\\\": \\\"GRPC\\\".*?\\\"requiredProfileFields\\\": \\[(.*?)\\]")
                .matcher(manifest);
        assertThat(grpcProfileMatcher.find()).isTrue();
        assertThat(grpcProfileMatcher.group(1))
                .contains("\"host\"")
                .contains("\"port\"")
                .contains("\"modelId\"")
                .contains("\"region\"");
    }

    @Test
    void localOnnxProviderVerifiesModelDigestButRemainsNotAdmitted() throws Exception {
        Path model = tempDir.resolve("model.onnx");
        byte[] contents = new byte[] {1, 2, 3, 4};
        Files.write(model, contents);
        String digest = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(contents));
        Map<String, String> profileValues = Map.of(
                "STT_PROVIDER_MODE", "LOCAL_ONNX",
                "STT_MODEL_PATH", model.toString(),
                "STT_MODEL_ID", "whisper-base",
                "STT_MODEL_VERSION", "2026.10",
                "STT_MODEL_SHA256", digest,
                "STT_MODEL_LICENSE", "UNKNOWN_PENDING_OWNER_REVIEW",
                "STT_EXECUTION_HARDWARE", "cpu",
                "STT_MODEL_REGION", "us-test-1");

        ProductionSttGrpcService.ProviderProfile profile =
                ProductionSttGrpcService.resolveProviderProfile(profileValues);
        assertThat(profile.mode()).isEqualTo(ProductionSttGrpcService.ProviderMode.LOCAL_ONNX);
        assertThat(profile.status()).isEqualTo("NOT_ADMITTED");
        assertThat(profile.modelDigest()).isEqualTo(digest);
        assertThat(profile.reason()).contains("qualification is admitted");
        assertThatThrownBy(() -> ProductionSttGrpcService.createConfig(profileValues))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageStartingWith("STT_PROVIDER_NOT_ADMITTED:");
    }

    @Test
    void localOnnxRejectsDigestMismatch() throws Exception {
        Path model = tempDir.resolve("model.onnx");
        Files.write(model, new byte[] {1, 2, 3, 4});

        assertThatThrownBy(() -> ProductionSttGrpcService.resolveProviderProfile(Map.of(
                        "STT_PROVIDER_MODE", "LOCAL_ONNX",
                        "STT_MODEL_PATH", model.toString(),
                        "STT_MODEL_ID", "whisper-base",
                        "STT_MODEL_VERSION", "2026.10",
                        "STT_MODEL_SHA256", "0".repeat(64),
                        "STT_MODEL_LICENSE", "UNKNOWN_PENDING_OWNER_REVIEW",
                        "STT_EXECUTION_HARDWARE", "cpu",
                        "STT_MODEL_REGION", "us-test-1")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("does not match");
    }

    @Test
    void nopIsExplicitlyUnavailableAndCannotCarryProviderSettings() {
        ProductionSttGrpcService.ProviderProfile profile =
                ProductionSttGrpcService.resolveProviderProfile(Map.of("STT_PROVIDER_MODE", "NOP"));
        assertThat(profile.status()).isEqualTo("NOT_ADMITTED");
        assertThatThrownBy(() -> ProductionSttGrpcService.createConfig(Map.of("STT_PROVIDER_MODE", "NOP")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("NOP intentionally disables transcription");

        assertThatThrownBy(() -> ProductionSttGrpcService.resolveProviderProfile(Map.of(
                        "STT_PROVIDER_MODE", "NOP",
                        "STT_GRPC_HOST", "stt.internal")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("do not match NOP mode");
    }

    private static Map<String, String> grpcProfile() {
        return Map.of(
                "STT_PROVIDER_MODE", "GRPC",
                "STT_GRPC_HOST", "stt.internal",
                "STT_GRPC_PORT", "50051",
                "STT_GRPC_TRANSPORT_MODE", "mtls",
                "STT_GRPC_MODEL_ID", "whisper-base",
                "STT_GRPC_MODEL_VERSION", "2026.10",
                "STT_GRPC_MODEL_SHA256", "a".repeat(64),
                "STT_GRPC_MODEL_LICENSE", "UNKNOWN_PENDING_OWNER_REVIEW",
                "STT_GRPC_EXECUTION_HARDWARE", "cpu",
                "STT_GRPC_MODEL_REGION", "us-test-1");
    }

    private static <T> void assertUnimplemented(java.util.function.Consumer<StreamObserver<T>> invoke) {
        CapturingObserver<T> observer = new CapturingObserver<>();
        invoke.accept(observer);
        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        assertThat(((StatusRuntimeException) observer.error).getStatus().getCode())
                .isEqualTo(Status.UNIMPLEMENTED.getCode());
    }

    private static <T> void assertNotAdmitted(java.util.function.Consumer<StreamObserver<T>> invoke) {
        assertFailedPrecondition(invoke, "STT_SPEAKER_PROFILE_NOT_ADMITTED:");
    }

    private static <T> void assertFailedPrecondition(
            java.util.function.Consumer<StreamObserver<T>> invoke,
            String descriptionPrefix) {
        CapturingObserver<T> observer = new CapturingObserver<>();
        invoke.accept(observer);
        assertThat(observer.error).isInstanceOf(StatusRuntimeException.class);
        StatusRuntimeException failure = (StatusRuntimeException) observer.error;
        assertThat(failure.getStatus().getCode()).isEqualTo(Status.FAILED_PRECONDITION.getCode());
        assertThat(failure.getStatus().getDescription()).startsWith(descriptionPrefix);
    }

    private static final class CapturingObserver<T> implements StreamObserver<T> {
        T value;
        Throwable error;

        @Override public void onNext(T next) { value = next; }
        @Override public void onError(Throwable failure) { error = failure; }
        @Override public void onCompleted() { }
    }
}
