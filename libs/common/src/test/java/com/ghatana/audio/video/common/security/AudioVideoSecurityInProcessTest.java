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
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

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
    void gatewayRejectedTokenIsDeniedBeforeEachProviderBackendEffect() throws Exception {
        AtomicInteger backendEffects = new AtomicInteger();
        AtomicInteger gatewayValidations = new AtomicInteger();
        List<String> validatedTokens = new ArrayList<>();
        List<String> validatedTenants = new ArrayList<>();
        String serverName = InProcessServerBuilder.generateName();
        ConfigurableJWTProcessor<SecurityContext> processor = new DefaultJWTProcessor<>();
        JwtServerInterceptor.TokenValidator rejectingGateway = new JwtServerInterceptor.TokenValidator() {
            @Override public boolean isEnabled() { return true; }
            @Override public com.ghatana.audio.video.common.platform.AuthGatewayClient.ValidationResult validate(
                    String token, String tenantId) {
                gatewayValidations.incrementAndGet();
                validatedTokens.add(token);
                validatedTenants.add(tenantId);
                return new com.ghatana.audio.video.common.platform.AuthGatewayClient.ValidationResult(
                        false, null, null, null);
            }
        };
        JwtServerInterceptor jwt = new JwtServerInterceptor(processor, rejectingGateway);
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
                int validationCountBefore = gatewayValidations.get();
                Metadata headers = new Metadata();
                String token = signedToken("gateway-rejected-user", "tenant-a");
                headers.put(AUTHORIZATION, "Bearer " + token);
                Channel requestChannel = ClientInterceptors.intercept(
                        channel, MetadataUtils.newAttachHeadersInterceptor(headers));

                assertThatThrownBy(() -> ClientCalls.blockingUnaryCall(requestChannel,
                        methodDescriptor(method), CallOptions.DEFAULT, "request"))
                        .as(method)
                        .isInstanceOf(StatusRuntimeException.class)
                        .extracting(failure -> ((StatusRuntimeException) failure).getStatus().getCode())
                        .isEqualTo(Status.Code.UNAUTHENTICATED);
                assertThat(gatewayValidations).as(method + " gateway validation count")
                        .hasValue(validationCountBefore + 1);
                assertThat(validatedTokens).as(method + " validated tokens").hasSize(validationCountBefore + 1);
                assertThat(validatedTenants).as(method + " validated tenants").hasSize(validationCountBefore + 1);
                assertThat(validatedTokens.get(validationCountBefore)).as(method + " gateway token").isEqualTo(token);
                assertThat(validatedTenants.get(validatedTenants.size() - 1))
                        .as(method + " gateway tenant").isEqualTo("tenant-a");
                assertThat(backendEffects).as(method).hasValue(0);
            }
        } finally {
            channel.shutdownNow();
            server.shutdownNow();
        }
    }

    @Test
    void missingPrincipalIsDeniedBeforeEachProviderBackendEffect() throws Exception {
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
                headers.put(Metadata.Key.of("x-user-id", Metadata.ASCII_STRING_MARSHALLER), "forged-user");
                headers.put(Metadata.Key.of("x-tenant-id", Metadata.ASCII_STRING_MARSHALLER), "tenant-a");
                headers.put(Metadata.Key.of("x-roles", Metadata.ASCII_STRING_MARSHALLER), "av:user");
                Channel requestChannel = ClientInterceptors.intercept(
                        channel, MetadataUtils.newAttachHeadersInterceptor(headers));

                assertThatThrownBy(() -> ClientCalls.blockingUnaryCall(requestChannel,
                        methodDescriptor(method), CallOptions.DEFAULT, "request"))
                        .as(method)
                        .isInstanceOf(StatusRuntimeException.class)
                        .extracting(failure -> ((StatusRuntimeException) failure).getStatus().getCode())
                        .isEqualTo(Status.Code.UNAUTHENTICATED);
                assertThat(backendEffects).as(method).hasValue(0);
            }
        } finally {
            channel.shutdownNow();
            server.shutdownNow();
        }
    }

    @Test
    void gatewayRejectedIdentityIsDeniedBeforeStreamingProviderDispatch() throws Exception {
        AtomicInteger backendEffects = new AtomicInteger();
        AtomicInteger gatewayValidations = new AtomicInteger();
        String method = "com.ghatana.audio.video.stt.grpc.STTService/StreamTranscribe";
        String serverName = InProcessServerBuilder.generateName();
        ConfigurableJWTProcessor<SecurityContext> processor = new DefaultJWTProcessor<>();
        JwtServerInterceptor.TokenValidator revokedGateway = new JwtServerInterceptor.TokenValidator() {
            @Override public boolean isEnabled() { return true; }
            @Override public com.ghatana.audio.video.common.platform.AuthGatewayClient.ValidationResult validate(
                    String token, String tenantId) {
                gatewayValidations.incrementAndGet();
                return new com.ghatana.audio.video.common.platform.AuthGatewayClient.ValidationResult(
                        false, null, null, null);
            }
        };
        JwtServerInterceptor jwt = new JwtServerInterceptor(processor, revokedGateway);
        AudioVideoRequestContextInterceptor rbac = AudioVideoRequestContextInterceptor.loggingOnly();
        MethodDescriptor<String, String> streamMethod = streamMethodDescriptor(method);
        ServerServiceDefinition service = ServerServiceDefinition.builder(
                        method.substring(0, method.indexOf('/')))
                .addMethod(streamMethod, ServerCalls.asyncBidiStreamingCall(requests ->
                        new StreamObserver<>() {
                            @Override public void onNext(String request) { backendEffects.incrementAndGet(); }
                            @Override public void onError(Throwable failure) { }
                            @Override public void onCompleted() { }
                        }))
                .build();
        Server server = InProcessServerBuilder.forName(serverName)
                .directExecutor()
                .addService(ServerInterceptors.interceptForward(service, jwt, rbac))
                .build()
                .start();
        ManagedChannel channel = InProcessChannelBuilder.forName(serverName).directExecutor().build();

        try {
            Metadata headers = new Metadata();
            String token = signedToken("revoked-user", "tenant-a");
            headers.put(AUTHORIZATION, "Bearer " + token);
            Channel requestChannel = ClientInterceptors.intercept(
                    channel, MetadataUtils.newAttachHeadersInterceptor(headers));
            CountDownLatch denied = new CountDownLatch(1);
            AtomicReference<Status.Code> status = new AtomicReference<>();
            @SuppressWarnings("unchecked")
            StreamObserver<String> requests = ClientCalls.asyncBidiStreamingCall(
                    requestChannel.newCall(streamMethod, CallOptions.DEFAULT), new StreamObserver<>() {
                        @Override public void onNext(String response) { }
                        @Override public void onError(Throwable failure) {
                            if (failure instanceof StatusRuntimeException statusFailure) {
                                status.set(statusFailure.getStatus().getCode());
                            }
                            denied.countDown();
                        }
                        @Override public void onCompleted() { }
                    });

            requests.onNext("first-frame");
            assertThat(gatewayValidations).hasValue(1);
            assertThat(denied.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(status).hasValue(Status.Code.UNAUTHENTICATED);
            assertThat(backendEffects).hasValue(0);
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

    private static MethodDescriptor<String, String> streamMethodDescriptor(String fullMethod) {
        return MethodDescriptor.<String, String>newBuilder()
                .setType(MethodDescriptor.MethodType.BIDI_STREAMING)
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
