package com.ghatana.audio.video.common.observability;

import io.grpc.CallOptions;
import io.grpc.Channel;
import io.grpc.ClientCall;
import io.grpc.ClientInterceptor;
import io.grpc.ClientInterceptors;
import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.Server;
import io.grpc.Status;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.ServerCall;
import io.grpc.ServerInterceptor;
import io.grpc.ServerServiceDefinition;
import io.grpc.stub.ClientCalls;
import io.grpc.stub.ServerCalls;
import io.grpc.stub.StreamObserver;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.baggage.Baggage;
import io.opentelemetry.api.baggage.propagation.W3CBaggagePropagator;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.context.propagation.ContextPropagators;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class TracingClientInterceptorInProcessTest {
    private static final String SERVICE = "com.ghatana.audio.video.stt.grpc.STTService";
    private static final String METHOD_NAME = "Transcribe";
    private static final String FULL_METHOD = SERVICE + "/" + METHOD_NAME;
    private static final Metadata.Key<String> TRACEPARENT =
            Metadata.Key.of("traceparent", Metadata.ASCII_STRING_MARSHALLER);
    private static final Metadata.Key<String> TRACESTATE =
            Metadata.Key.of("tracestate", Metadata.ASCII_STRING_MARSHALLER);
    private static final Metadata.Key<String> BAGGAGE_HEADER =
            Metadata.Key.of("baggage", Metadata.ASCII_STRING_MARSHALLER);
    private static final Metadata.Key<String> TENANT_HEADER =
            Metadata.Key.of("x-tenant-id", Metadata.ASCII_STRING_MARSHALLER);

    private final InMemorySpanExporter exporter = InMemorySpanExporter.create();
    private final SdkTracerProvider tracerProvider = SdkTracerProvider.builder()
            .addSpanProcessor(SimpleSpanProcessor.create(exporter))
            .build();
    private final OpenTelemetry telemetry = OpenTelemetrySdk.builder()
            .setTracerProvider(tracerProvider)
            .setPropagators(ContextPropagators.create(io.opentelemetry.context.propagation.TextMapPropagator.composite(
                    W3CTraceContextPropagator.getInstance(), W3CBaggagePropagator.getInstance())))
            .build();
    private Server server;
    private Channel channel;
    private io.grpc.ManagedChannel transportChannel;
    private final AtomicReference<String> inboundTraceparent = new AtomicReference<>();
    private final AtomicReference<String> inboundTracestate = new AtomicReference<>();
    private final AtomicReference<String> inboundBaggage = new AtomicReference<>();
    private final AtomicReference<String> inboundTenant = new AtomicReference<>();

    @AfterEach
    void cleanup() {
        if (transportChannel != null) transportChannel.shutdownNow();
        if (server != null) server.shutdownNow();
        tracerProvider.close();
        exporter.close();
    }

    @Test
    void createsClientParentAndServerChildAndWrapsAsyncCallbackContextWithoutBaggage() throws Exception {
        inboundTraceparent.set(null);
        inboundTracestate.set(null);
        inboundBaggage.set(null);
        inboundTenant.set(null);
        AtomicReference<String> serverSpanId = new AtomicReference<>();
        AtomicReference<String> serverParentSpanId = new AtomicReference<>();
        AtomicReference<String> wrappedClientSpanId = new AtomicReference<>();
        AtomicReference<Runnable> delayedContextWork = new AtomicReference<>();
        AtomicReference<Status> closeStatus = new AtomicReference<>();
        CountDownLatch completed = new CountDownLatch(1);
        CountDownLatch requestReceived = new CountDownLatch(1);

        ServerServiceDefinition service = ServerServiceDefinition.builder(SERVICE)
                .addMethod(method(), ServerCalls.asyncUnaryCall((String request, StreamObserver<String> response) -> {
                    serverSpanId.set(Span.current().getSpanContext().getSpanId());
                    serverParentSpanId.set(Span.current().getSpanContext().getTraceId());
                    requestReceived.countDown();
                    response.onNext("reply");
                    response.onCompleted();
                }))
                .build();
        start(service);

        Span root = telemetry.getTracer("test").spanBuilder("caller.root").startSpan();
        AtomicReference<String> outboundClientSpanId = new AtomicReference<>();
        Baggage baggage = Baggage.builder()
                .put("tenant", "private-tenant")
                .put("secret", "private-token")
                .build();
        Context caller = Context.current().with(root).with(baggage);
        try (Scope ignored = caller.makeCurrent()) {
            Channel baggageChannel = ClientInterceptors.intercept(channel, new ClientInterceptor() {
                @Override
                public <ReqT, RespT> ClientCall<ReqT, RespT> interceptCall(
                        MethodDescriptor<ReqT, RespT> descriptor, CallOptions options, Channel next) {
                    return new io.grpc.ForwardingClientCall.SimpleForwardingClientCall<>(next.newCall(descriptor, options)) {
                        @Override
                        public void start(Listener<RespT> listener, Metadata headers) {
                            headers.put(BAGGAGE_HEADER, "tenant=private-tenant,secret=private-token");
                            super.start(listener, headers);
                        }
                    };
                }
            });
            ClientCalls.asyncUnaryCall(baggageChannel.newCall(method(), CallOptions.DEFAULT),
                    "private transcript content", new io.grpc.stub.StreamObserver<>() {
                @Override
                public void onNext(String message) {
                    assertThat(message).isEqualTo("reply");
                    outboundClientSpanId.set(Span.current().getSpanContext().getSpanId());
                    delayedContextWork.set(Context.current().wrap(() ->
                            wrappedClientSpanId.set(Span.current().getSpanContext().getSpanId())));
                }

                @Override
                public void onError(Throwable error) {
                    closeStatus.set(Status.fromThrowable(error));
                    completed.countDown();
                }

                @Override
                public void onCompleted() {
                    closeStatus.set(Status.OK);
                    completed.countDown();
                }
            });
        }

        assertThat(requestReceived.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(completed.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(closeStatus.get()).as("client close status").isEqualTo(Status.OK);
        assertThat(serverSpanId.get()).isNotBlank();
        assertThat(serverParentSpanId.get()).isEqualTo(root.getSpanContext().getTraceId());
        assertThat(inboundTraceparent.get()).matches("00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}");
        assertThat(inboundTracestate.get()).isNull();
        assertThat(inboundBaggage.get()).isNull();
        assertThat(inboundTenant.get()).isNull();
        assertThat(delayedContextWork.get()).isNotNull();
        root.end();

        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            executor.submit(delayedContextWork.get()).get(5, TimeUnit.SECONDS);
        } finally {
            executor.shutdownNow();
        }

        assertThat(outboundClientSpanId.get()).isNotBlank();
        assertThat(wrappedClientSpanId.get()).isEqualTo(outboundClientSpanId.get());
        SpanData client = finishedSpan("CLIENT");
        SpanData serverSpan = finishedSpan("SERVER");
        assertThat(client.getTraceId()).isEqualTo(root.getSpanContext().getTraceId());
        assertThat(client.getParentSpanId()).isEqualTo(root.getSpanContext().getSpanId());
        assertThat(serverSpan.getTraceId()).isEqualTo(client.getTraceId());
        assertThat(serverSpan.getParentSpanId()).isEqualTo(client.getSpanId());
        assertThat(client.getAttributes().get(AttributeKey.stringKey("rpc.service"))).isEqualTo(SERVICE);
        assertThat(client.getAttributes().get(AttributeKey.stringKey("rpc.method"))).isEqualTo(METHOD_NAME);
        assertThat(client.getAttributes().asMap().values())
                .doesNotContain("private transcript content", "private-tenant", "private-token");
        assertThat(exporter.getFinishedSpanItems()).hasSize(3);
    }

    @Test
    void endsClientSpanOnRemoteFailureAndCancellation() throws Exception {
        CountDownLatch completed = new CountDownLatch(1);
        ServerServiceDefinition failedService = ServerServiceDefinition.builder(SERVICE)
                .addMethod(method(), ServerCalls.asyncUnaryCall((String request, StreamObserver<String> response) ->
                        response.onError(Status.UNAVAILABLE.asRuntimeException())))
                .build();
        start(failedService);

        ClientCalls.asyncUnaryCall(channel.newCall(method(), CallOptions.DEFAULT), "input", new StreamObserver<>() {
            @Override public void onNext(String value) {}
            @Override public void onError(Throwable failure) { completed.countDown(); }
            @Override public void onCompleted() { completed.countDown(); }
        });
        assertThat(completed.await(5, TimeUnit.SECONDS)).isTrue();
        SpanData failed = finishedSpan("CLIENT");
        assertThat(failed.getAttributes().get(AttributeKey.stringKey("rpc.grpc.status_code")))
                .isEqualTo("UNAVAILABLE");
        assertThat(failed.getStatus().getStatusCode()).isEqualTo(StatusCode.ERROR);

        exporter.reset();
        CountDownLatch cancelStarted = new CountDownLatch(1);
        ServerServiceDefinition hangingService = ServerServiceDefinition.builder(SERVICE)
                .addMethod(method(), ServerCalls.asyncUnaryCall((String request, StreamObserver<String> response) ->
                        cancelStarted.countDown()))
                .build();
        transportChannel.shutdownNow();
        server.shutdownNow();
        start(hangingService);
        ClientCall<String, String> cancelledCall = channel.newCall(method(), CallOptions.DEFAULT);
        cancelledCall.start(new ClientCall.Listener<>() {}, new Metadata());
        cancelledCall.request(1);
        cancelledCall.sendMessage("input");
        cancelledCall.halfClose();
        assertThat(cancelStarted.await(5, TimeUnit.SECONDS)).isTrue();
        cancelledCall.cancel("cancel test", null);
        assertThat(exporter.getFinishedSpanItems()).hasSize(2);
        assertThat(exporter.getFinishedSpanItems().stream().filter(span -> span.getKind().name().equals("CLIENT")))
                .hasSize(1);
        SpanData cancelled = finishedSpan("CLIENT");
        assertThat(cancelled.getAttributes().get(AttributeKey.stringKey("rpc.grpc.status_code")))
                .isEqualTo("CANCELLED");
        assertThat(cancelled.getStatus().getStatusCode()).isEqualTo(StatusCode.ERROR);
    }

    @Test
    void endsSpanWhenTheUnderlyingClientCallThrowsDuringStart() {
        ClientInterceptor interceptor = new TracingClientInterceptor(telemetry);
        Channel brokenChannel = new Channel() {
            @Override
            public String authority() {
                return "in-process-test";
            }

            @Override
            public <ReqT, RespT> ClientCall<ReqT, RespT> newCall(
                    MethodDescriptor<ReqT, RespT> method, CallOptions callOptions) {
                return new ClientCall<>() {
                    @Override public void start(Listener<RespT> listener, Metadata headers) {
                        throw new IllegalStateException("test-only call startup failure");
                    }
                    @Override public void request(int numMessages) {}
                    @Override public void cancel(String message, Throwable cause) {}
                    @Override public void halfClose() {}
                    @Override public void sendMessage(ReqT message) {}
                };
            }
        };

        ClientCall<String, String> call = interceptor.interceptCall(method(), CallOptions.DEFAULT, brokenChannel);
        assertThatThrownBy(() -> call.start(new ClientCall.Listener<>() {}, new Metadata()))
                .isInstanceOf(IllegalStateException.class);
        assertThat(Span.current().getSpanContext().isValid()).isFalse();
        assertThat(exporter.getFinishedSpanItems()).hasSize(1);
        SpanData failed = finishedSpan("CLIENT");
        assertThat(failed.getStatus().getStatusCode()).isEqualTo(StatusCode.ERROR);
        assertThat(failed.getAttributes().get(AttributeKey.stringKey("rpc.grpc.status_code")))
                .isEqualTo("INTERNAL");
    }

    @Test
    void restoresContextAndEndsOnceWhenClientCallbackThrows() {
        Channel synchronousChannel = new Channel() {
            @Override public String authority() { return "in-process-test"; }
            @Override public <ReqT, RespT> ClientCall<ReqT, RespT> newCall(
                    MethodDescriptor<ReqT, RespT> method, CallOptions callOptions) {
                return new ClientCall<>() {
                    @Override
                    public void start(Listener<RespT> listener, Metadata headers) {
                        @SuppressWarnings("unchecked")
                        RespT response = (RespT) "response";
                        listener.onMessage(response);
                    }
                    @Override public void request(int numMessages) {}
                    @Override public void cancel(String message, Throwable cause) {}
                    @Override public void halfClose() {}
                    @Override public void sendMessage(ReqT message) {}
                };
            }
        };
        ClientCall<String, String> call = new TracingClientInterceptor(telemetry)
                .interceptCall(method(), CallOptions.DEFAULT, synchronousChannel);
        AtomicReference<String> callbackSpanId = new AtomicReference<>();

        assertThatThrownBy(() -> call.start(new ClientCall.Listener<>() {
            @Override
            public void onMessage(String message) {
                callbackSpanId.set(Span.current().getSpanContext().getSpanId());
                throw new IllegalStateException("test-only callback failure");
            }
        }, new Metadata())).isInstanceOf(IllegalStateException.class);

        assertThat(callbackSpanId.get()).isNotBlank();
        assertThat(Span.current().getSpanContext().isValid()).isFalse();
        assertThat(exporter.getFinishedSpanItems()).hasSize(1);
        SpanData span = finishedSpan("CLIENT");
        assertThat(span.getStatus().getStatusCode()).isEqualTo(StatusCode.ERROR);
        assertThat(span.getAttributes().get(AttributeKey.stringKey("rpc.grpc.status_code"))).isEqualTo("INTERNAL");
    }

    @Test
    void repeatedStartDoesNotEndOriginalCallBeforeItsClose() {
        AtomicReference<ClientCall.Listener<String>> retainedListener = new AtomicReference<>();
        Channel retainingChannel = new Channel() {
            @Override public String authority() { return "in-process-test"; }
            @Override public <ReqT, RespT> ClientCall<ReqT, RespT> newCall(
                    MethodDescriptor<ReqT, RespT> method, CallOptions callOptions) {
                return new ClientCall<>() {
                    @SuppressWarnings("unchecked")
                    @Override
                    public void start(Listener<RespT> listener, Metadata headers) {
                        retainedListener.set((Listener<String>) listener);
                    }
                    @Override public void request(int numMessages) {}
                    @Override public void cancel(String message, Throwable cause) {}
                    @Override public void halfClose() {}
                    @Override public void sendMessage(ReqT message) {}
                };
            }
        };
        ClientCall<String, String> call = new TracingClientInterceptor(telemetry)
                .interceptCall(method(), CallOptions.DEFAULT, retainingChannel);
        call.start(new ClientCall.Listener<>() {}, new Metadata());

        assertThat(retainedListener.get()).isNotNull();
        assertThatThrownBy(() -> call.start(new ClientCall.Listener<>() {}, new Metadata()))
                .isInstanceOf(IllegalStateException.class);
        assertThat(exporter.getFinishedSpanItems()).isEmpty();

        retainedListener.get().onClose(Status.OK, new Metadata());

        assertThat(exporter.getFinishedSpanItems()).hasSize(1);
        SpanData span = finishedSpan("CLIENT");
        assertThat(span.getStatus().getStatusCode()).isEqualTo(StatusCode.OK);
        assertThat(span.getAttributes().get(AttributeKey.stringKey("rpc.grpc.status_code"))).isEqualTo("OK");
    }

    @Test
    void doesNotCreateSpanForCallThatIsNeverStarted() throws Exception {
        ServerServiceDefinition service = ServerServiceDefinition.builder(SERVICE)
                .addMethod(method(), ServerCalls.asyncUnaryCall((String request, StreamObserver<String> response) -> {
                    response.onNext("unused");
                    response.onCompleted();
                }))
                .build();
        start(service);

        ClientCall<String, String> call = channel.newCall(method(), CallOptions.DEFAULT);
        assertThat(exporter.getFinishedSpanItems()).isEmpty();
        call.cancel("never started", null);
        assertThat(exporter.getFinishedSpanItems()).isEmpty();
    }

    @Test
    void unknownDescriptorUsesOnlyFixedUnknownRpcAttributes() throws Exception {
        ServerServiceDefinition service = ServerServiceDefinition.builder(SERVICE)
                .addMethod(method(), ServerCalls.asyncUnaryCall((String request, StreamObserver<String> response) -> {
                    response.onNext("unused");
                    response.onCompleted();
                }))
                .build();
        start(service);
        CountDownLatch completed = new CountDownLatch(1);
        MethodDescriptor<String, String> unknown = method("com.attacker.private.Service/RevealSecret");

        ClientCalls.asyncUnaryCall(channel.newCall(unknown, CallOptions.DEFAULT), "secret payload", new StreamObserver<>() {
            @Override public void onNext(String value) {}
            @Override public void onError(Throwable failure) { completed.countDown(); }
            @Override public void onCompleted() { completed.countDown(); }
        });

        assertThat(completed.await(5, TimeUnit.SECONDS)).isTrue();
        SpanData span = finishedSpan("CLIENT");
        assertThat(span.getName()).isEqualTo("grpc.unknown");
        assertThat(span.getAttributes().get(AttributeKey.stringKey("rpc.service"))).isEqualTo("grpc.unknown");
        assertThat(span.getAttributes().get(AttributeKey.stringKey("rpc.method"))).isEqualTo("grpc.unknown");
        assertThat(span.getAttributes().asMap().values())
                .doesNotContain("com.attacker.private.Service", "RevealSecret", "secret payload");
    }

    @Test
    void endsSpanWhenOutgoingHeaderInjectionFails() {
        Channel localChannel = new Channel() {
            @Override public String authority() { return "in-process-test"; }
            @Override public <ReqT, RespT> ClientCall<ReqT, RespT> newCall(
                    MethodDescriptor<ReqT, RespT> method, CallOptions callOptions) {
                return new ClientCall<>() {
                    @Override public void start(Listener<RespT> listener, Metadata headers) {}
                    @Override public void request(int numMessages) {}
                    @Override public void cancel(String message, Throwable cause) {}
                    @Override public void halfClose() {}
                    @Override public void sendMessage(ReqT message) {}
                };
            }
        };
        ClientCall<String, String> call = new TracingClientInterceptor(telemetry)
                .interceptCall(method(), CallOptions.DEFAULT, localChannel);

        assertThatThrownBy(() -> call.start(new ClientCall.Listener<>() {}, null))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(exporter.getFinishedSpanItems()).hasSize(1);
        SpanData span = finishedSpan("CLIENT");
        assertThat(span.getAttributes().get(AttributeKey.stringKey("rpc.grpc.status_code"))).isEqualTo("INTERNAL");
    }

    private void start(ServerServiceDefinition service) throws Exception {
        String name = InProcessServerBuilder.generateName();
        ServerInterceptor capture = new ServerInterceptor() {
            @Override
            public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
                    ServerCall<ReqT, RespT> call, Metadata headers, io.grpc.ServerCallHandler<ReqT, RespT> next) {
                inboundTraceparent.set(headers.get(TRACEPARENT));
                inboundTracestate.set(headers.get(TRACESTATE));
                inboundBaggage.set(headers.get(BAGGAGE_HEADER));
                inboundTenant.set(headers.get(TENANT_HEADER));
                return next.startCall(call, headers);
            }
        };
        server = InProcessServerBuilder.forName(name)
                .directExecutor()
                .addService(service)
                .intercept(capture)
                .intercept(new TracingServerInterceptor(telemetry))
                .build()
                .start();
        transportChannel = InProcessChannelBuilder.forName(name)
                .directExecutor()
                .build();
        channel = ClientInterceptors.intercept(transportChannel, new TracingClientInterceptor(telemetry));
    }

    private SpanData finishedSpan(String kind) {
        return exporter.getFinishedSpanItems().stream()
                .filter(span -> span.getKind().name().equals(kind))
                .findFirst()
                .orElseThrow(() -> new AssertionError("missing " + kind + " span"));
    }

    private static MethodDescriptor<String, String> method() {
        return method(FULL_METHOD);
    }

    private static MethodDescriptor<String, String> method(String fullMethodName) {
        return MethodDescriptor.<String, String>newBuilder()
                .setType(MethodDescriptor.MethodType.UNARY)
                .setFullMethodName(fullMethodName)
                .setRequestMarshaller(new StringMarshaller())
                .setResponseMarshaller(new StringMarshaller())
                .build();
    }

    private static final class StringMarshaller implements MethodDescriptor.Marshaller<String> {
        @Override
        public InputStream stream(String value) {
            return new ByteArrayInputStream(value.getBytes(StandardCharsets.UTF_8));
        }

        @Override
        public String parse(InputStream stream) {
            try {
                return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
            } catch (java.io.IOException failure) {
                throw new IllegalStateException("test marshalling failed", failure);
            }
        }
    }
}
