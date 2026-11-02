package com.ghatana.audio.video.common.resilience;

import com.ghatana.audio.video.common.GrpcInterceptorChain;
import com.google.protobuf.StringValue;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import io.grpc.CallOptions;
import io.grpc.Channel;
import io.grpc.ClientCall;
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
import org.junit.jupiter.api.Test;

import java.util.Date;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Exercises the production interceptor chain through a real in-process gRPC server. */
class RpcDeadlineGrpcStackIntegrationTest {
    private static final String SERVICE = "com.ghatana.audio.video.stt.grpc.STTService";
    private static final String METHOD = "Transcribe";
    private static final String FULL_METHOD = SERVICE + "/" + METHOD;
    private static final String TEST_JWT_SECRET = "jc03-deadline-stack-secret-0123456789";

    private String priorJwtSecret;
    private String priorMethodDeadline;

    @AfterEach
    void restoreSystemProperties() {
        restore("AV_JWT_SECRET", priorJwtSecret);
        restore(RpcDeadlineServerInterceptor.METHOD_MAX_DEADLINE_MILLIS_PROPERTY_PREFIX + FULL_METHOD,
                priorMethodDeadline);
    }

    @Test
    void shorterClientDeadlineInterruptsCooperativeChildWithoutLateSuccess() throws Exception {
        configure("5000");
        ThreadPoolExecutor workers = workerPool();
        CountDownLatch childStarted = new CountDownLatch(1);
        CountDownLatch childInterrupted = new CountDownLatch(1);
        AtomicReference<Status.Code> childOutcome = new AtomicReference<>();
        AtomicInteger successfulResponses = new AtomicInteger();
        var executor = new ContextAwareBoundedExecutor(workers);
        var service = service((request, response) -> {
            var submission = executor.submit(() -> {
                childStarted.countDown();
                try {
                    new CountDownLatch(1).await();
                    return "late";
                } catch (InterruptedException interrupted) {
                    childInterrupted.countDown();
                    return "late-after-interrupt";
                }
            }, false);
            capture(submission, response, childOutcome, successfulResponses);
        });

        try (RunningServer running = start(service)) {
            Channel authenticated = authenticated(running.channel(), token());
            assertThatThrownBy(() -> unary(authenticated, "cooperative", 500))
                    .isInstanceOf(StatusRuntimeException.class)
                    .extracting(error -> ((StatusRuntimeException) error).getStatus().getCode())
                    .isEqualTo(Status.Code.DEADLINE_EXCEEDED);
            assertThat(childStarted.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(childInterrupted.await(1, TimeUnit.SECONDS)).isTrue();
            awaitOutcome(childOutcome);
            assertThat(childOutcome.get()).isEqualTo(Status.Code.DEADLINE_EXCEEDED);
            assertThat(successfulResponses).hasValue(0);
        } finally {
            workers.shutdownNow();
            workers.awaitTermination(1, TimeUnit.SECONDS);
        }
    }

    @Test
    void explicitClientCancellationInterruptsEffectCapableChildAndReportsUnknownOutcome() throws Exception {
        configure("5000");
        ThreadPoolExecutor workers = workerPool();
        CountDownLatch childStarted = new CountDownLatch(1);
        CountDownLatch childInterrupted = new CountDownLatch(1);
        CountDownLatch clientClosed = new CountDownLatch(1);
        AtomicReference<Status.Code> childOutcome = new AtomicReference<>();
        AtomicReference<Status.Code> clientOutcome = new AtomicReference<>();
        AtomicInteger successfulResponses = new AtomicInteger();
        var executor = new ContextAwareBoundedExecutor(workers);
        var service = service((request, response) -> {
            var submission = executor.submit(() -> {
                childStarted.countDown();
                try {
                    new CountDownLatch(1).await();
                    return "late";
                } catch (InterruptedException interrupted) {
                    childInterrupted.countDown();
                    return "late-after-cancel";
                }
            });
            capture(submission, response, childOutcome, successfulResponses);
        });

        try (RunningServer running = start(service)) {
            Channel authenticated = authenticated(running.channel(), token());
            ClientCall<StringValue, StringValue> call = authenticated.newCall(method(),
                    CallOptions.DEFAULT.withDeadlineAfter(5, TimeUnit.SECONDS));
            call.start(new ClientCall.Listener<>() {
                @Override public void onMessage(StringValue value) {
                    successfulResponses.incrementAndGet();
                }

                @Override public void onClose(Status status, Metadata trailers) {
                    clientOutcome.set(status.getCode());
                    clientClosed.countDown();
                }
            }, new Metadata());
            call.request(1);
            call.sendMessage(StringValue.of("cancelled-effect-capable"));
            call.halfClose();

            assertThat(childStarted.await(1, TimeUnit.SECONDS)).isTrue();
            call.cancel("caller detached", null);

            assertThat(childInterrupted.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(clientClosed.await(1, TimeUnit.SECONDS)).isTrue();
            awaitOutcome(childOutcome);
            assertThat(clientOutcome.get()).isEqualTo(Status.Code.UNKNOWN);
            assertThat(childOutcome.get()).isEqualTo(Status.Code.UNKNOWN);
            assertThat(successfulResponses).hasValue(0);
        } finally {
            workers.shutdownNow();
            workers.awaitTermination(1, TimeUnit.SECONDS);
        }
    }

    @Test
    void serverDeadlineReportsUnknownAndNoncooperativeChildKeepsItsBoundedSlot() throws Exception {
        configure("250");
        ThreadPoolExecutor workers = workerPool();
        CountDownLatch firstStarted = new CountDownLatch(1);
        CountDownLatch releaseFirst = new CountDownLatch(1);
        CountDownLatch firstEffectCommitted = new CountDownLatch(1);
        CountDownLatch queuedReceived = new CountDownLatch(1);
        CountDownLatch queuedTerminal = new CountDownLatch(1);
        AtomicInteger firstDispatches = new AtomicInteger();
        AtomicInteger queuedDispatches = new AtomicInteger();
        AtomicReference<Status.Code> firstOutcome = new AtomicReference<>();
        AtomicReference<Status.Code> queuedOutcome = new AtomicReference<>();
        AtomicReference<Status.Code> overflowOutcome = new AtomicReference<>();
        AtomicInteger successfulResponses = new AtomicInteger();
        var executor = new ContextAwareBoundedExecutor(workers);
        var service = service((request, response) -> {
            if (request.getValue().equals("queued")) queuedReceived.countDown();
            var submission = executor.submit(() -> {
                if (request.getValue().equals("slow")) {
                    firstDispatches.incrementAndGet();
                    firstStarted.countDown();
                    while (true) {
                        try {
                            if (releaseFirst.await(10, TimeUnit.MILLISECONDS)) break;
                        } catch (InterruptedException ignored) {
                            // Models provider/native work that does not stop on Java interruption.
                        }
                    }
                    firstEffectCommitted.countDown();
                    return "late-effect";
                }
                if (request.getValue().equals("queued")) {
                    queuedDispatches.incrementAndGet();
                    return "must-not-dispatch-after-expiry";
                }
                return "overflow-must-not-dispatch";
            }, !request.getValue().equals("queued"));
            AtomicReference<Status.Code> target = switch (request.getValue()) {
                case "slow" -> firstOutcome;
                case "queued" -> queuedOutcome;
                default -> overflowOutcome;
            };
            submission.result().whenComplete((value, failure) -> {
                if (failure != null) target.set(Status.fromThrowable(failure).getCode());
                if (request.getValue().equals("queued")) queuedTerminal.countDown();
                if (failure == null) {
                    successfulResponses.incrementAndGet();
                    response.onNext(StringValue.of(value));
                    response.onCompleted();
                } else {
                    response.onError(failure);
                }
            });
        });

        try (RunningServer running = start(service)) {
            Channel authenticated = authenticated(running.channel(), token());
            assertThatThrownBy(() -> unary(authenticated, "slow", 2_000))
                    .isInstanceOf(StatusRuntimeException.class)
                    .extracting(error -> ((StatusRuntimeException) error).getStatus().getCode())
                    .isEqualTo(Status.Code.UNKNOWN);
            assertThat(firstStarted.await(1, TimeUnit.SECONDS)).isTrue();
            awaitOutcome(firstOutcome);
            assertThat(firstOutcome.get()).isEqualTo(Status.Code.UNKNOWN);

            CompletableFuture<Status.Code> queuedRpc = new CompletableFuture<>();
            ClientCalls.asyncUnaryCall(authenticated.newCall(method(), CallOptions.DEFAULT),
                    StringValue.of("queued"), new StreamObserver<>() {
                        @Override public void onNext(StringValue value) {
                            successfulResponses.incrementAndGet();
                            queuedRpc.complete(null);
                        }
                        @Override public void onError(Throwable error) {
                            queuedRpc.complete(Status.fromThrowable(error).getCode());
                        }
                        @Override public void onCompleted() { }
                    });
            assertThat(queuedReceived.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(workers.getQueue()).hasSize(1);

            assertThatThrownBy(() -> unary(authenticated, "overflow", 1_000))
                    .isInstanceOf(StatusRuntimeException.class)
                    .extracting(error -> ((StatusRuntimeException) error).getStatus().getCode())
                    .isEqualTo(Status.Code.RESOURCE_EXHAUSTED);
            assertThat(overflowOutcome.get()).isEqualTo(Status.Code.RESOURCE_EXHAUSTED);
            assertThat(firstDispatches).hasValue(1);
            assertThat(queuedDispatches).hasValue(0);

            assertThat(queuedTerminal.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(queuedOutcome.get()).isEqualTo(Status.Code.DEADLINE_EXCEEDED);
            assertThat(queuedRpc.get(1, TimeUnit.SECONDS)).isEqualTo(Status.Code.UNKNOWN);
            releaseFirst.countDown();
            assertThat(firstEffectCommitted.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(queuedDispatches).hasValue(0);
            assertThat(successfulResponses).hasValue(0);
        } finally {
            releaseFirst.countDown();
            workers.shutdownNow();
            workers.awaitTermination(1, TimeUnit.SECONDS);
        }
    }

    private void configure(String maximumMillis) {
        priorJwtSecret = System.getProperty("AV_JWT_SECRET");
        priorMethodDeadline = System.getProperty(
                RpcDeadlineServerInterceptor.METHOD_MAX_DEADLINE_MILLIS_PROPERTY_PREFIX + FULL_METHOD);
        System.setProperty("AV_JWT_SECRET", TEST_JWT_SECRET);
        System.setProperty(RpcDeadlineServerInterceptor.METHOD_MAX_DEADLINE_MILLIS_PROPERTY_PREFIX + FULL_METHOD,
                maximumMillis);
    }

    private static ThreadPoolExecutor workerPool() {
        return new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(1));
    }

    private static io.grpc.ServerServiceDefinition service(
            ServiceHandler handler) {
        return io.grpc.ServerServiceDefinition.builder(SERVICE)
                .addMethod(method(), ServerCalls.asyncUnaryCall(handler::invoke))
                .build();
    }

    private static RunningServer start(io.grpc.ServerServiceDefinition service) throws Exception {
        String serverName = InProcessServerBuilder.generateName();
        var builder = InProcessServerBuilder.forName(serverName).directExecutor().addService(service);
        GrpcInterceptorChain.build().forEach(builder::intercept);
        Server server = builder.build().start();
        ManagedChannel channel = InProcessChannelBuilder.forName(serverName).directExecutor().build();
        return new RunningServer(server, channel);
    }

    private static Channel authenticated(Channel channel, String jwt) {
        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), "Bearer " + jwt);
        headers.put(Metadata.Key.of("x-tenant-id", Metadata.ASCII_STRING_MARSHALLER), "tenant-a");
        return ClientInterceptors.intercept(channel, MetadataUtils.newAttachHeadersInterceptor(headers));
    }

    private static StringValue unary(Channel channel, String value, long deadlineMillis) {
        return ClientCalls.blockingUnaryCall(channel, method(),
                CallOptions.DEFAULT.withDeadlineAfter(deadlineMillis, TimeUnit.MILLISECONDS), StringValue.of(value));
    }

    private static MethodDescriptor<StringValue, StringValue> method() {
        return MethodDescriptor.<StringValue, StringValue>newBuilder()
                .setType(MethodDescriptor.MethodType.UNARY)
                .setFullMethodName(FULL_METHOD)
                .setRequestMarshaller(ProtoUtils.marshaller(StringValue.getDefaultInstance()))
                .setResponseMarshaller(ProtoUtils.marshaller(StringValue.getDefaultInstance()))
                .build();
    }

    private static String token() throws Exception {
        SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), new JWTClaimsSet.Builder()
                .subject("jc03-deadline-test-user")
                .claim("tenantId", "tenant-a")
                .claim("roles", List.of("av:user"))
                .expirationTime(new Date(System.currentTimeMillis() + 60_000))
                .build());
        jwt.sign(new MACSigner(TEST_JWT_SECRET));
        return jwt.serialize();
    }

    private static void capture(ContextAwareBoundedExecutor.Submission<String> submission,
            StreamObserver<StringValue> response, AtomicReference<Status.Code> outcome,
            AtomicInteger successfulResponses) {
        submission.result().whenComplete((value, failure) -> {
            if (failure != null) {
                outcome.set(Status.fromThrowable(failure).getCode());
                response.onError(failure);
            } else {
                successfulResponses.incrementAndGet();
                response.onNext(StringValue.of(value));
                response.onCompleted();
            }
        });
    }

    private static void awaitOutcome(AtomicReference<Status.Code> outcome) throws InterruptedException {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
        while (outcome.get() == null && System.nanoTime() < until) Thread.yield();
        assertThat(outcome.get()).isNotNull();
    }

    private static void restore(String property, String value) {
        if (value == null) System.clearProperty(property);
        else System.setProperty(property, value);
    }

    @FunctionalInterface
    private interface ServiceHandler {
        void invoke(StringValue request, StreamObserver<StringValue> response);
    }

    private record RunningServer(Server server, ManagedChannel channel) implements AutoCloseable {
        @Override public void close() {
            channel.shutdownNow();
            server.shutdownNow();
        }
    }
}
