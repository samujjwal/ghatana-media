package com.ghatana.audio.video.common.security;

import com.ghatana.audio.video.common.GrpcInterceptorChain;
import com.ghatana.audio.video.common.platform.AuthGatewayClient;
import com.google.protobuf.StringValue;
import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.nimbusds.jwt.proc.ConfigurableJWTProcessor;
import com.nimbusds.jose.proc.SecurityContext;
import io.grpc.ClientInterceptors;
import io.grpc.ManagedChannel;
import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.Server;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.protobuf.ProtoUtils;
import io.grpc.stub.ClientCalls;
import io.grpc.stub.MetadataUtils;
import io.grpc.stub.ServerCalls;
import io.grpc.stub.StreamObserver;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** Exercises gateway-revoked identities through the full in-process interceptor chain. */
class JwtServerInterceptorInProcessRevocationTest {

    private String previousJwtSecret;

    private static final byte[] SIGNING_KEY =
            "in-process-revocation-test-key-012345".getBytes(StandardCharsets.UTF_8);
    private static final List<ProviderMethod> PROVIDERS = List.of(
            new ProviderMethod("com.ghatana.audio.video.stt.grpc.STTService", "Transcribe"),
            new ProviderMethod("com.ghatana.audio.video.tts.grpc.TTSService", "Synthesize"),
            new ProviderMethod("com.ghatana.audio.video.vision.grpc.VisionService", "AnalyzeImage"),
            new ProviderMethod("com.ghatana.audio.video.multimodal.grpc.MultimodalService", "ProcessMultimodal"));

    @BeforeEach
    void configureTheStandardInterceptorChain() {
        previousJwtSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", "jc02-chain-construction-test-secret-012345");
    }

    @AfterEach
    void restoreJwtSecretProperty() {
        if (previousJwtSecret == null) {
            System.clearProperty("AV_JWT_SECRET");
        } else {
            System.setProperty("AV_JWT_SECRET", previousJwtSecret);
        }
    }

    @Test
    void revokedGatewayIdentityCannotReachAnyProvider() throws Exception {
        ConfigurableJWTProcessor<SecurityContext> processor = mockProcessor();
        when(processor.process(any(SignedJWT.class), eq((SecurityContext) null)))
                .thenThrow(new JOSEException("test gateway token"));
        AtomicInteger validations = new AtomicInteger();
        JwtServerInterceptor.TokenValidator revokedIdentity = new JwtServerInterceptor.TokenValidator() {
            @Override
            public boolean isEnabled() {
                return true;
            }

            @Override
            public AuthGatewayClient.ValidationResult validate(String token, String tenantId) {
                assertThat(token).isNotBlank();
                assertThat(tenantId).isEqualTo("tenant-a");
                validations.incrementAndGet();
                return new AuthGatewayClient.ValidationResult(false, null, null, null);
            }
        };
        List<io.grpc.ServerInterceptor> interceptors = new ArrayList<>(GrpcInterceptorChain.build());
        int jwtIndex = -1;
        for (int index = 0; index < interceptors.size(); index++) {
            if (interceptors.get(index) instanceof JwtServerInterceptor) {
                jwtIndex = index;
                break;
            }
        }
        assertThat(jwtIndex).isNotNegative();
        interceptors.set(jwtIndex, new JwtServerInterceptor(processor, revokedIdentity));
        String token = signedGatewayToken();

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
            InProcessServerBuilder serverBuilder = InProcessServerBuilder.forName(serverName)
                    .directExecutor().addService(service);
            interceptors.forEach(serverBuilder::intercept);
            Server server = serverBuilder.build().start();
            ManagedChannel transport = InProcessChannelBuilder.forName(serverName).directExecutor().build();
            try {
                assertThatThrownBy(() -> call(transport, method, bearer(token)))
                        .as("revoked identity %s/%s", provider.serviceName(), provider.methodName())
                        .isInstanceOf(StatusRuntimeException.class)
                        .extracting(failure -> ((StatusRuntimeException) failure).getStatus().getCode())
                        .isEqualTo(Status.Code.UNAUTHENTICATED);
                assertThat(backendEffects).as("revoked request must not reach %s", provider.serviceName())
                        .hasValue(0);
            } finally {
                transport.shutdownNow();
                server.shutdownNow();
            }
        }

        assertThat(validations).hasValue(PROVIDERS.size());
    }

    private static String signedGatewayToken() throws Exception {
        SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), new JWTClaimsSet.Builder()
                .subject("jc02-revoked-principal")
                .claim("tenantId", "tenant-a")
                .expirationTime(new Date(System.currentTimeMillis() + 60_000))
                .build());
        jwt.sign(new MACSigner(SIGNING_KEY));
        return jwt.serialize();
    }

    @SuppressWarnings("unchecked")
    private static ConfigurableJWTProcessor<SecurityContext> mockProcessor() {
        return mock(ConfigurableJWTProcessor.class);
    }

    private static Metadata bearer(String token) {
        Metadata metadata = new Metadata();
        metadata.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), "Bearer " + token);
        return metadata;
    }

    private static StringValue call(
            ManagedChannel transport, MethodDescriptor<StringValue, StringValue> method, Metadata headers) {
        var authenticated = ClientInterceptors.intercept(
                transport, MetadataUtils.newAttachHeadersInterceptor(headers));
        return ClientCalls.blockingUnaryCall(authenticated, method, io.grpc.CallOptions.DEFAULT,
                StringValue.of("request"));
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
