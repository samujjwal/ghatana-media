package com.ghatana.stt.testutil;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import io.grpc.Context;
import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import org.mockito.Mockito;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.concurrent.atomic.AtomicReference;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

/** Builds a context by sending a signed fixture JWT through the real interceptor. */
public final class VerifiedJwtContext {

    private static final String SECRET = "01234567890123456789012345678901";

    private VerifiedJwtContext() { }

    public static Context create(String tenantId, String subject) {
        String previousSecret = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", SECRET);
        try {
            SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), new JWTClaimsSet.Builder()
                    .subject(subject)
                    .expirationTime(Date.from(Instant.now().plusSeconds(300)))
                    .claim("tenantId", tenantId)
                    .build());
            jwt.sign(new MACSigner(SECRET.getBytes(StandardCharsets.UTF_8)));

            JwtServerInterceptor interceptor = new JwtServerInterceptor();
            Metadata headers = new Metadata();
            headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER),
                    "Bearer " + jwt.serialize());

            ServerCall<Object, Object> call = Mockito.mock(ServerCall.class);
            when(call.getMethodDescriptor()).thenReturn(methodDescriptor());
            @SuppressWarnings("unchecked")
            ServerCallHandler<Object, Object> handler = Mockito.mock(ServerCallHandler.class);
            AtomicReference<Context> authenticated = new AtomicReference<>();
            when(handler.startCall(any(), any())).thenAnswer(invocation -> {
                authenticated.set(Context.current());
                return Mockito.mock(ServerCall.Listener.class);
            });

            interceptor.interceptCall(call, headers, handler);
            Context result = authenticated.get();
            if (result == null) {
                throw new IllegalStateException("JWT fixture was not accepted by JwtServerInterceptor");
            }
            return result;
        } catch (Exception failure) {
            throw new IllegalStateException("Could not build verified JWT test context", failure);
        } finally {
            if (previousSecret == null) System.clearProperty("AV_JWT_SECRET");
            else System.setProperty("AV_JWT_SECRET", previousSecret);
        }
    }

    private static MethodDescriptor<Object, Object> methodDescriptor() {
        MethodDescriptor.Marshaller<Object> marshaller = new MethodDescriptor.Marshaller<>() {
            @Override
            public InputStream stream(Object value) {
                return new ByteArrayInputStream(new byte[0]);
            }

            @Override
            public Object parse(InputStream stream) {
                return new Object();
            }
        };
        return MethodDescriptor.<Object, Object>newBuilder()
                .setType(MethodDescriptor.MethodType.UNARY)
                .setFullMethodName("com.ghatana.stt.service.PersistentSttService/Transcribe")
                .setRequestMarshaller(marshaller)
                .setResponseMarshaller(marshaller)
                .build();
    }
}
