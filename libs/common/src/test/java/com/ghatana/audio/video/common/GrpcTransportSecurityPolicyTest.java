package com.ghatana.audio.video.common;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import io.grpc.Channel;
import io.grpc.ClientInterceptors;
import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.ManagedChannel;
import io.grpc.Server;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.stub.ClientCalls;
import io.grpc.stub.MetadataUtils;
import io.grpc.stub.ServerCalls;
import io.grpc.stub.StreamObserver;
import io.grpc.protobuf.ProtoUtils;
import com.google.protobuf.StringValue;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Proves one fail-closed TLS policy is shared by every standalone Media gRPC service. */
class GrpcTransportSecurityPolicyTest {

    private static final String TEST_JWT_SECRET = "jc04-in-process-transport-secret-0123456789";
    private static final List<ProviderMethod> PROVIDERS = List.of(
            new ProviderMethod("com.ghatana.audio.video.stt.grpc.STTService", "Transcribe"),
            new ProviderMethod("com.ghatana.audio.video.tts.grpc.TTSService", "Synthesize"),
            new ProviderMethod("com.ghatana.audio.video.vision.grpc.VisionService", "AnalyzeImage"),
            new ProviderMethod("com.ghatana.audio.video.multimodal.grpc.MultimodalService", "ProcessMultimodal"));
    private String previousJwtSecret;

    @BeforeEach
    void rememberJwtSecretProperty() {
        previousJwtSecret = System.getProperty("AV_JWT_SECRET");
    }

    @AfterEach
    void clearJwtSecretProperty() {
        if (previousJwtSecret == null) {
            System.clearProperty("AV_JWT_SECRET");
        } else {
            System.setProperty("AV_JWT_SECRET", previousJwtSecret);
        }
    }

    @Test
    void localWithoutTlsMaterialUsesPlaintext() {
        var security = GrpcTransportSecurityPolicy.resolve(
                Map.of("MEDIA_ENVIRONMENT", "local"), "TTS");
        assertThat(security.tlsEnabled()).isFalse();
    }

    @Test
    void documentedDevelopmentProfilesRemainPlaintextWithoutTlsMaterial() {
        for (String profile : new String[] {"local", "test", "development"}) {
            var security = GrpcTransportSecurityPolicy.resolve(
                    Map.of("STT_ENVIRONMENT", profile), "STT");
            assertThat(security.tlsEnabled()).as(profile).isFalse();
        }
    }

    @Test
    void everyServiceAllowsPlaintextForAllDevelopmentProfilesWithoutTlsMaterial() {
        for (String service : new String[] {"STT", "TTS", "VISION", "MULTIMODAL"}) {
            for (String profile : new String[] {"local", "test", "development"}) {
                var security = GrpcTransportSecurityPolicy.resolve(
                        Map.of(service + "_ENVIRONMENT", profile), service);
                assertThat(security.tlsEnabled()).as("%s profile %s", service, profile).isFalse();
            }
        }
    }

    @Test
    void absentOrNullProfilesDefaultToLocal() {
        assertThat(GrpcTransportSecurityPolicy.resolve(Map.of(), "STT").tlsEnabled()).isFalse();
        var environment = new java.util.HashMap<String, String>();
        environment.put("STT_ENVIRONMENT", null);
        environment.put("MEDIA_ENVIRONMENT", null);
        environment.put("GHATANA_DEPLOYMENT_PROFILE", null);
        assertThat(GrpcTransportSecurityPolicy.resolve(environment, "STT").tlsEnabled()).isFalse();
    }

    @Test
    void unknownExplicitProfileFailsClosedEvenWhenTlsPathsAreConfigured() {
        assertThatThrownBy(() -> GrpcTransportSecurityPolicy.resolve(Map.of(
                        "STT_ENVIRONMENT", "prod",
                        "STT_GRPC_TLS_CERT_CHAIN_PATH", "/run/secrets/cert.pem",
                        "STT_GRPC_TLS_PRIVATE_KEY_PATH", "/run/secrets/key.pem"), "STT"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Unsupported STT gRPC environment profile")
                .hasMessageNotContaining("prod");
    }

    @Test
    void productionLikeProfilesRequireCompleteTlsPair() {
        for (String profile : new String[] {"production", "staging", "sovereign"}) {
            assertThatThrownBy(() -> GrpcTransportSecurityPolicy.resolve(
                            Map.of("GHATANA_DEPLOYMENT_PROFILE", profile), "VISION"))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("Production-like VISION gRPC requires TLS");
        }
    }

    @Test
    void everyServiceRejectsProductionLikeProfilesWithoutTlsMaterial() {
        for (String service : new String[] {"STT", "TTS", "VISION", "MULTIMODAL"}) {
            for (String profile : new String[] {"production", "staging", "sovereign"}) {
                assertThatThrownBy(() -> GrpcTransportSecurityPolicy.resolve(
                                Map.of(service + "_ENVIRONMENT", profile), service))
                        .isInstanceOf(IllegalStateException.class)
                        .hasMessageContaining("Production-like " + service + " gRPC requires TLS");
            }
        }
    }

    @Test
    void sharedMediaTlsPairCanSecureEveryService() {
        var security = GrpcTransportSecurityPolicy.resolve(Map.of(
                "MEDIA_ENVIRONMENT", "production",
                "MEDIA_GRPC_TLS_CERT_CHAIN_PATH", "/run/secrets/media-cert.pem",
                "MEDIA_GRPC_TLS_PRIVATE_KEY_PATH", "/run/secrets/media-key.pem"), "MULTIMODAL");

        assertThat(security.tlsEnabled()).isTrue();
        assertThat(security.certificateChain().toString()).endsWith("media-cert.pem");
        assertThat(security.privateKey().toString()).endsWith("media-key.pem");
    }

    @Test
    void serviceSpecificPairOverridesSharedPair() {
        var security = GrpcTransportSecurityPolicy.resolve(Map.of(
                "MEDIA_ENVIRONMENT", "production",
                "MEDIA_GRPC_TLS_CERT_CHAIN_PATH", "/run/secrets/media-cert.pem",
                "MEDIA_GRPC_TLS_PRIVATE_KEY_PATH", "/run/secrets/media-key.pem",
                "TTS_GRPC_TLS_CERT_CHAIN_PATH", "/run/secrets/tts-cert.pem",
                "TTS_GRPC_TLS_PRIVATE_KEY_PATH", "/run/secrets/tts-key.pem"), "TTS");

        assertThat(security.certificateChain().toString()).endsWith("tts-cert.pem");
        assertThat(security.privateKey().toString()).endsWith("tts-key.pem");
    }

    @Test
    void partialServicePairCannotBorrowFromSharedPair() {
        assertThatThrownBy(() -> GrpcTransportSecurityPolicy.resolve(Map.of(
                        "MEDIA_ENVIRONMENT", "production",
                        "MEDIA_GRPC_TLS_CERT_CHAIN_PATH", "/run/secrets/media-cert.pem",
                        "MEDIA_GRPC_TLS_PRIVATE_KEY_PATH", "/run/secrets/media-key.pem",
                        "TTS_GRPC_TLS_CERT_CHAIN_PATH", "/run/secrets/tts-cert.pem"), "TTS"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("TTS_GRPC_TLS_CERT_CHAIN_PATH")
                .hasMessageContaining("TTS_GRPC_TLS_PRIVATE_KEY_PATH");
    }

    @Test
    void noServiceCanCompletePartialServiceTlsPairFromSharedPair() {
        for (String service : new String[] {"STT", "TTS", "VISION", "MULTIMODAL"}) {
            assertThatThrownBy(() -> GrpcTransportSecurityPolicy.resolve(Map.of(
                            "MEDIA_ENVIRONMENT", "production",
                            "MEDIA_GRPC_TLS_CERT_CHAIN_PATH", "/run/secrets/media-cert.pem",
                            "MEDIA_GRPC_TLS_PRIVATE_KEY_PATH", "/run/secrets/media-key.pem",
                            service + "_GRPC_TLS_CERT_CHAIN_PATH", "/run/secrets/service-cert.pem"),
                            service))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining(service + "_GRPC_TLS_CERT_CHAIN_PATH")
                    .hasMessageContaining(service + "_GRPC_TLS_PRIVATE_KEY_PATH");
        }
    }

    @Test
    void serviceProfileOverridesSharedAndDeploymentProfiles() {
        var security = GrpcTransportSecurityPolicy.resolve(Map.of(
                "GHATANA_DEPLOYMENT_PROFILE", "production",
                "MEDIA_ENVIRONMENT", "staging",
                "STT_ENVIRONMENT", "local"), "STT");
        assertThat(security.tlsEnabled()).isFalse();
    }

    @Test
    void invalidPrefixIsRejected() {
        assertThatThrownBy(() -> GrpcTransportSecurityPolicy.resolve(Map.of(), "bad-prefix"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("servicePrefix");
    }

    @Test
    void sharedInterceptorChainProtectsAllFourCurrentProviderMethodsInProcess() throws Exception {
        System.setProperty("AV_JWT_SECRET", TEST_JWT_SECRET);
        String token = signedUserToken();

        for (ProviderMethod provider : PROVIDERS) {
            AtomicInteger backendEffects = new AtomicInteger();
            MethodDescriptor<StringValue, StringValue> method = method(provider);
            var service = io.grpc.ServerServiceDefinition.builder(provider.serviceName())
                    .addMethod(method, ServerCalls.asyncUnaryCall(
                            (StringValue request, StreamObserver<StringValue> response) -> {
                                backendEffects.incrementAndGet();
                                response.onNext(StringValue.of("accepted"));
                                response.onCompleted();
                            }))
                    .build();
            String serverName = InProcessServerBuilder.generateName();
            var serverBuilder = InProcessServerBuilder.forName(serverName).directExecutor().addService(service);
            GrpcInterceptorChain.build().forEach(serverBuilder::intercept);
            Server server = serverBuilder.build().start();
            ManagedChannel transport = InProcessChannelBuilder.forName(serverName).directExecutor().build();
            try {
                assertThat(call(transport, method, bearer(token, "tenant-a")))
                        .as("authorized %s/%s call", provider.serviceName(), provider.methodName())
                        .isEqualTo(StringValue.of("accepted"));
                assertThat(backendEffects).hasValue(1);

                assertThatThrownBy(() -> call(transport, method, bearer(token, "tenant-b")))
                        .as("cross-tenant %s/%s call", provider.serviceName(), provider.methodName())
                        .isInstanceOf(StatusRuntimeException.class)
                        .extracting(failure -> ((StatusRuntimeException) failure).getStatus().getCode())
                        .isEqualTo(Status.Code.PERMISSION_DENIED);
                assertThat(backendEffects).as("denied request must not reach %s", provider.serviceName())
                        .hasValue(1);

                assertThatThrownBy(() -> call(transport, method, new Metadata()))
                        .as("unauthenticated %s/%s call", provider.serviceName(), provider.methodName())
                        .isInstanceOf(StatusRuntimeException.class)
                        .extracting(failure -> ((StatusRuntimeException) failure).getStatus().getCode())
                        .isEqualTo(Status.Code.UNAUTHENTICATED);
                assertThat(backendEffects).as("unauthenticated request must not reach %s", provider.serviceName())
                        .hasValue(1);
            } finally {
                transport.shutdownNow();
                server.shutdownNow();
            }
        }
    }

    private static StringValue call(
            Channel transport, MethodDescriptor<StringValue, StringValue> method, Metadata headers) {
        Channel authenticated = ClientInterceptors.intercept(
                transport, MetadataUtils.newAttachHeadersInterceptor(headers));
        return ClientCalls.blockingUnaryCall(authenticated, method, io.grpc.CallOptions.DEFAULT,
                StringValue.of("request"));
    }

    private static Metadata bearer(String token, String tenant) {
        Metadata metadata = new Metadata();
        metadata.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), "Bearer " + token);
        metadata.put(Metadata.Key.of("x-tenant-id", Metadata.ASCII_STRING_MARSHALLER), tenant);
        return metadata;
    }

    private static String signedUserToken() throws Exception {
        SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), new JWTClaimsSet.Builder()
                .subject("jc04-test-user")
                .claim("tenantId", "tenant-a")
                .claim("roles", List.of("av:user"))
                .expirationTime(new Date(System.currentTimeMillis() + 60_000))
                .build());
        jwt.sign(new MACSigner(TEST_JWT_SECRET));
        return jwt.serialize();
    }

    private static MethodDescriptor<StringValue, StringValue> method(ProviderMethod provider) {
        return MethodDescriptor.<StringValue, StringValue>newBuilder()
                .setType(MethodDescriptor.MethodType.UNARY)
                .setFullMethodName(MethodDescriptor.generateFullMethodName(
                        provider.serviceName(), provider.methodName()))
                .setRequestMarshaller(ProtoUtils.marshaller(StringValue.getDefaultInstance()))
                .setResponseMarshaller(ProtoUtils.marshaller(StringValue.getDefaultInstance()))
                .build();
    }

    private record ProviderMethod(String serviceName, String methodName) { }
}
