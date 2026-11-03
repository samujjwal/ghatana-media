package com.ghatana.audio.video.common.security;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.jwk.source.ImmutableSecret;
import com.nimbusds.jose.proc.JWSVerificationKeySelector;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.nimbusds.jwt.proc.ConfigurableJWTProcessor;
import com.nimbusds.jwt.proc.DefaultJWTClaimsVerifier;
import com.nimbusds.jwt.proc.DefaultJWTProcessor;
import io.grpc.CallOptions;
import io.grpc.Channel;
import io.grpc.ManagedChannel;
import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.Server;
import io.grpc.ServerServiceDefinition;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.ClientInterceptors;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.stub.ClientCalls;
import io.grpc.stub.MetadataUtils;
import io.grpc.stub.ServerCalls;
import io.grpc.stub.StreamObserver;
import io.grpc.ServerInterceptors;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** In-process coverage of the shared auth/RBAC chain at provider dispatch boundaries. */
class AudioVideoSecurityInProcessTest {

    private static final byte[] SECRET = "in-process-test-secret-key-32bytes".getBytes(StandardCharsets.UTF_8);
    private static final Metadata.Key<String> AUTHORIZATION =
            Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER);
    private static final List<String> PROVIDER_METHODS = List.of(
            "com.ghatana.audio.video.stt.grpc.STTService/Transcribe",
            "com.ghatana.audio.video.tts.grpc.TTSService/Synthesize",
            "com.ghatana.audio.video.vision.grpc.VisionService/AnalyzeImage",
            "com.ghatana.audio.video.multimodal.grpc.MultimodalService/ProcessMultimodal");

    @Test
    void forgedTenantScopeIsDeniedBeforeEachProviderBackendEffect() throws Exception {
        AtomicInteger backendEffects = new AtomicInteger();
        String serverName = InProcessServerBuilder.generateName();
        JwtServerInterceptor jwt = new JwtServerInterceptor(realProcessor(), disabledTokenValidator());
        AudioVideoRequestContextInterceptor rbac = AudioVideoRequestContextInterceptor.loggingOnly();
        Server server = InProcessServerBuilder.forName(serverName)
                .directExecutor()
                .addServices(PROVIDER_METHODS.stream()
                        .map(method -> interceptedProvider(method, jwt, rbac, backendEffects))
                        .toList())
                .build()
                .start();
        ManagedChannel channel = InProcessChannelBuilder.forName(serverName).directExecutor().build();

        try {
            for (String method : PROVIDER_METHODS) {
                Metadata headers = new Metadata();
                headers.put(AUTHORIZATION, "Bearer " + signedToken("trusted-user", "tenant-a"));
                headers.put(Metadata.Key.of("x-user-id", Metadata.ASCII_STRING_MARSHALLER), "forged-user");
                headers.put(Metadata.Key.of("x-roles", Metadata.ASCII_STRING_MARSHALLER), "av:admin");
                headers.put(com.ghatana.security.tenant.TenantGrpcInterceptor.TENANT_ID_KEY, "tenant-b");
                Channel requestChannel = ClientInterceptors.intercept(
                        channel, MetadataUtils.newAttachHeadersInterceptor(headers));

                assertThatThrownBy(() -> ClientCalls.blockingUnaryCall(requestChannel,
                        methodDescriptor(method), CallOptions.DEFAULT, "request"))
                        .as(method)
                        .isInstanceOf(StatusRuntimeException.class)
                        .extracting(failure -> ((StatusRuntimeException) failure).getStatus().getCode())
                        .isEqualTo(Status.Code.PERMISSION_DENIED);
                assertThat(backendEffects).as(method).hasValue(0);
            }
        } finally {
            channel.shutdownNow();
            server.shutdownNow();
        }
    }

    @Test
    void forgedAdminRoleCannotReachAdminOnlyProviderOperation() throws Exception {
        AtomicInteger backendEffects = new AtomicInteger();
        String method = "com.ghatana.audio.video.stt.grpc.STTService/LoadModel";
        String serverName = InProcessServerBuilder.generateName();
        JwtServerInterceptor jwt = new JwtServerInterceptor(realProcessor(), disabledTokenValidator());
        AudioVideoRequestContextInterceptor rbac = AudioVideoRequestContextInterceptor.loggingOnly();
        Server server = InProcessServerBuilder.forName(serverName)
                .directExecutor()
                .addService(interceptedProvider(method, jwt, rbac, backendEffects))
                .build()
                .start();
        ManagedChannel channel = InProcessChannelBuilder.forName(serverName).directExecutor().build();

        try {
            Metadata headers = new Metadata();
            headers.put(AUTHORIZATION, "Bearer " + signedToken("trusted-user", "tenant-a"));
            headers.put(Metadata.Key.of("x-user-id", Metadata.ASCII_STRING_MARSHALLER), "forged-admin");
            headers.put(Metadata.Key.of("x-roles", Metadata.ASCII_STRING_MARSHALLER), "av:admin");
            Channel requestChannel = ClientInterceptors.intercept(
                    channel, MetadataUtils.newAttachHeadersInterceptor(headers));

            assertThatThrownBy(() -> ClientCalls.blockingUnaryCall(requestChannel,
                    methodDescriptor(method), CallOptions.DEFAULT, "request"))
                    .isInstanceOf(StatusRuntimeException.class)
                    .extracting(failure -> ((StatusRuntimeException) failure).getStatus().getCode())
                    .isEqualTo(Status.Code.PERMISSION_DENIED);
            assertThat(backendEffects).hasValue(0);
        } finally {
            channel.shutdownNow();
            server.shutdownNow();
        }
    }

    private static ServerServiceDefinition interceptedProvider(
            String fullMethod,
            JwtServerInterceptor jwt,
            AudioVideoRequestContextInterceptor rbac,
            AtomicInteger backendEffects) {
        String serviceName = fullMethod.substring(0, fullMethod.indexOf('/'));
        MethodDescriptor<String, String> method = methodDescriptor(fullMethod);
        ServerServiceDefinition service = ServerServiceDefinition.builder(serviceName)
                .addMethod(method, ServerCalls.asyncUnaryCall((request, observer) -> {
                    backendEffects.incrementAndGet();
                    observer.onNext("backend-effect");
                    observer.onCompleted();
                }))
                .build();
        return ServerInterceptors.interceptForward(service, jwt, rbac);
    }

    private static MethodDescriptor<String, String> methodDescriptor(String fullMethod) {
        return MethodDescriptor.<String, String>newBuilder()
                .setType(MethodDescriptor.MethodType.UNARY)
                .setFullMethodName(fullMethod)
                .setRequestMarshaller(STRING_MARSHALLER)
                .setResponseMarshaller(STRING_MARSHALLER)
                .build();
    }

    private static final MethodDescriptor.Marshaller<String> STRING_MARSHALLER = new MethodDescriptor.Marshaller<>() {
        @Override
        public InputStream stream(String value) {
            return new ByteArrayInputStream(value.getBytes(StandardCharsets.UTF_8));
        }

        @Override
        public String parse(InputStream stream) {
            try {
                return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
            } catch (java.io.IOException failure) {
                throw new IllegalStateException(failure);
            }
        }
    };

    private static ConfigurableJWTProcessor<SecurityContext> realProcessor() {
        ConfigurableJWTProcessor<SecurityContext> processor = new DefaultJWTProcessor<>();
        processor.setJWSKeySelector(new JWSVerificationKeySelector<>(
                JWSAlgorithm.HS256, new ImmutableSecret<>(SECRET)));
        processor.setJWTClaimsSetVerifier(new DefaultJWTClaimsVerifier<>(
                new JWTClaimsSet.Builder().build(), Set.of("sub", "exp")));
        return processor;
    }

    private static String signedToken(String subject, String tenant) throws Exception {
        JWTClaimsSet claims = new JWTClaimsSet.Builder()
                .subject(subject)
                .claim("tenantId", tenant)
                .claim("roles", List.of("av:user"))
                .issueTime(Date.from(Instant.now()))
                .expirationTime(Date.from(Instant.now().plusSeconds(300)))
                .build();
        SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims);
        jwt.sign(new MACSigner(SECRET));
        return jwt.serialize();
    }

    private static JwtServerInterceptor.TokenValidator disabledTokenValidator() {
        return new JwtServerInterceptor.TokenValidator() {
            @Override public boolean isEnabled() { return false; }
            @Override public com.ghatana.audio.video.common.platform.AuthGatewayClient.ValidationResult validate(
                    String token, String tenantId) {
                return new com.ghatana.audio.video.common.platform.AuthGatewayClient.ValidationResult(
                        false, null, null, null);
            }
        };
    }
}
