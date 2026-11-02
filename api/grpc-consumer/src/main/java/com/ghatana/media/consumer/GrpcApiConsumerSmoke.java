package com.ghatana.media.consumer;

import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalServiceGrpc;
import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalServiceProto;
import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalRequest;
import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalResponse;
import com.ghatana.audio.video.vision.grpc.proto.VisionServiceGrpc;
import com.ghatana.audio.video.vision.grpc.proto.VisionServiceProto;
import com.ghatana.audio.video.vision.grpc.proto.DetectRequest;
import com.ghatana.audio.video.vision.grpc.proto.DetectResponse;
import com.ghatana.stt.core.grpc.proto.STTServiceGrpc;
import com.ghatana.stt.core.grpc.proto.SttServiceProto;
import com.ghatana.stt.core.grpc.proto.TranscribeRequest;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;
import com.ghatana.tts.core.grpc.proto.TTSServiceGrpc;
import com.ghatana.tts.core.grpc.proto.TtsServiceProto;
import com.ghatana.tts.core.grpc.proto.SynthesizeRequest;
import com.ghatana.tts.core.grpc.proto.SynthesizeResponse;
import io.grpc.ManagedChannel;
import io.grpc.Server;
import io.grpc.Context;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.Status;
import io.grpc.stub.StreamObserver;
import io.grpc.MethodDescriptor;
import io.grpc.ServiceDescriptor;
import com.google.protobuf.ByteString;

import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Collectors;

/** Compiles against the installed candidate artifact, with no Media source project on this build path. */
public final class GrpcApiConsumerSmoke {
    private GrpcApiConsumerSmoke() {}

    public static void main(String[] args) throws Exception {
        assertService(STTServiceGrpc.getServiceDescriptor(), "com.ghatana.audio.video.stt.grpc.STTService",
                Set.of("Transcribe", "StreamTranscribe", "LoadModel", "UnloadModel", "ListModels", "AdaptModel",
                        "GetStatus", "HealthCheck", "CreateProfile", "GetProfile", "UpdateProfile",
                        "SubmitCorrection"),
                Map.of("StreamTranscribe", MethodDescriptor.MethodType.BIDI_STREAMING));
        assertService(TTSServiceGrpc.getServiceDescriptor(), "com.ghatana.audio.video.tts.grpc.TTSService",
                Set.of("Synthesize", "StreamSynthesize", "GetStatus", "GetMetrics", "GetVoices", "LoadVoice",
                        "CreateProfile", "GetProfile", "UpdateProfile", "CloneVoice", "SubmitFeedback"),
                Map.of("StreamSynthesize", MethodDescriptor.MethodType.SERVER_STREAMING));
        assertService(VisionServiceGrpc.getServiceDescriptor(), "com.ghatana.audio.video.vision.grpc.VisionService",
                Set.of("DetectObjects", "AnalyzeImage", "ClassifyImage", "RecognizeSceneText", "AnalyzeVideoFile",
                        "ProcessVideo", "LoadModel", "UnloadModel", "ListModels", "GetStatus", "HealthCheck"),
                Map.of("ProcessVideo", MethodDescriptor.MethodType.BIDI_STREAMING));
        assertService(MultimodalServiceGrpc.getServiceDescriptor(),
                "com.ghatana.audio.video.multimodal.grpc.MultimodalService",
                Set.of("ProcessMultimodal", "AnalyzeVideoWithAudio", "GenerateDescription", "AnalyzeCrossModal",
                        "GetInsights", "LoadModel", "UnloadModel", "ListModels", "GetStatus", "HealthCheck"),
                Map.of());

        // Touch the canonical file descriptors too, proving message descriptors are present.
        require(SttServiceProto.getDescriptor().getServices().size() == 1, "STT proto descriptor missing");
        require(TtsServiceProto.getDescriptor().getServices().size() == 1, "TTS proto descriptor missing");
        require(VisionServiceProto.getDescriptor().getServices().size() == 1, "Vision proto descriptor missing");
        require(MultimodalServiceProto.getDescriptor().getServices().size() == 1, "Multimodal proto descriptor missing");

        assertInstalledArtifactRpcRoundTrips();
    }

    private static void assertInstalledArtifactRpcRoundTrips() throws Exception {
        AtomicInteger sttCalls = new AtomicInteger();
        AtomicInteger ttsCalls = new AtomicInteger();
        AtomicInteger visionCalls = new AtomicInteger();
        AtomicInteger multimodalCalls = new AtomicInteger();
        String serverName = "media-grpc-api-consumer-" + UUID.randomUUID();

        Server server = InProcessServerBuilder.forName(serverName)
                .directExecutor()
                .addService(new STTServiceGrpc.STTServiceImplBase() {
                    @Override public void transcribe(TranscribeRequest request,
                            StreamObserver<TranscribeResponse> observer) {
                        sttCalls.incrementAndGet();
                        observer.onNext(TranscribeResponse.getDefaultInstance());
                        observer.onCompleted();
                    }
                })
                .addService(new TTSServiceGrpc.TTSServiceImplBase() {
                    @Override public void synthesize(SynthesizeRequest request,
                            StreamObserver<SynthesizeResponse> observer) {
                        ttsCalls.incrementAndGet();
                        observer.onNext(SynthesizeResponse.getDefaultInstance());
                        observer.onCompleted();
                    }
                })
                .addService(new VisionServiceGrpc.VisionServiceImplBase() {
                    @Override public void detectObjects(DetectRequest request,
                            StreamObserver<DetectResponse> observer) {
                        visionCalls.incrementAndGet();
                        observer.onNext(DetectResponse.getDefaultInstance());
                        observer.onCompleted();
                    }
                })
                .addService(new MultimodalServiceGrpc.MultimodalServiceImplBase() {
                    @Override public void processMultimodal(MultimodalRequest request,
                            StreamObserver<MultimodalResponse> observer) {
                        multimodalCalls.incrementAndGet();
                        observer.onNext(MultimodalResponse.getDefaultInstance());
                        observer.onCompleted();
                    }
                })
                .build()
                .start();
        ManagedChannel channel = InProcessChannelBuilder.forName(serverName).directExecutor().build();
        try {
            require(STTServiceGrpc.newBlockingStub(channel).transcribe(TranscribeRequest.getDefaultInstance())
                            .equals(TranscribeResponse.getDefaultInstance()),
                    "Installed STT Transcribe RPC did not round-trip");
            require(TTSServiceGrpc.newBlockingStub(channel).synthesize(SynthesizeRequest.getDefaultInstance())
                            .equals(SynthesizeResponse.getDefaultInstance()),
                    "Installed TTS Synthesize RPC did not round-trip");
            require(VisionServiceGrpc.newBlockingStub(channel).detectObjects(DetectRequest.getDefaultInstance())
                            .equals(DetectResponse.getDefaultInstance()),
                    "Installed Vision DetectObjects RPC did not round-trip");
            require(MultimodalServiceGrpc.newBlockingStub(channel)
                            .processMultimodal(MultimodalRequest.getDefaultInstance())
                            .equals(MultimodalResponse.getDefaultInstance()),
                    "Installed Multimodal ProcessMultimodal RPC did not round-trip");
            require(sttCalls.get() == 1 && ttsCalls.get() == 1
                            && visionCalls.get() == 1 && multimodalCalls.get() == 1,
                    "Expected exactly one server dispatch for each installed service stub");
        } finally {
            channel.shutdownNow();
            server.shutdownNow();
        }

        assertInstalledArtifactStreamingRoundTrips();
        assertInstalledStubDeadlineAndCancellation();
    }

    private static void assertInstalledArtifactStreamingRoundTrips() throws Exception {
        AtomicInteger sttStreamCalls = new AtomicInteger();
        AtomicInteger sttMessages = new AtomicInteger();
        AtomicInteger ttsStreamCalls = new AtomicInteger();
        AtomicInteger visionStreamCalls = new AtomicInteger();
        AtomicInteger visionMessages = new AtomicInteger();
        CountDownLatch sttServerCompleted = new CountDownLatch(1);
        CountDownLatch sttClientCompleted = new CountDownLatch(1);
        CountDownLatch ttsClientCompleted = new CountDownLatch(1);
        CountDownLatch visionServerCompleted = new CountDownLatch(1);
        CountDownLatch visionClientCompleted = new CountDownLatch(1);
        AtomicReference<Throwable> sttFailure = new AtomicReference<>();
        AtomicReference<Throwable> ttsFailure = new AtomicReference<>();
        AtomicReference<Throwable> visionFailure = new AtomicReference<>();
        List<com.ghatana.stt.core.grpc.proto.Transcription> sttResponses = new CopyOnWriteArrayList<>();
        List<com.ghatana.tts.core.grpc.proto.AudioChunk> ttsResponses = new CopyOnWriteArrayList<>();
        List<com.ghatana.audio.video.vision.grpc.proto.VideoFrameResponse> visionResponses =
                new CopyOnWriteArrayList<>();
        String serverName = "media-grpc-api-streaming-consumer-" + UUID.randomUUID();

        Server server = InProcessServerBuilder.forName(serverName)
                .directExecutor()
                .addService(new STTServiceGrpc.STTServiceImplBase() {
                    @Override public StreamObserver<com.ghatana.stt.core.grpc.proto.AudioChunk> streamTranscribe(
                            StreamObserver<com.ghatana.stt.core.grpc.proto.Transcription> observer) {
                        sttStreamCalls.incrementAndGet();
                        return new StreamObserver<>() {
                            @Override public void onNext(com.ghatana.stt.core.grpc.proto.AudioChunk chunk) {
                                require(chunk.getAudioData().equals(ByteString.copyFromUtf8("stt-frame"))
                                                && chunk.getSequence() == 7,
                                        "Installed STT stream request did not preserve its synthetic payload");
                                sttMessages.incrementAndGet();
                                observer.onNext(com.ghatana.stt.core.grpc.proto.Transcription.newBuilder()
                                        .setText("stt-stream-result")
                                        .setIsFinal(true)
                                        .setAcceptedSequenceSnapshot(7)
                                        .build());
                            }

                            @Override public void onError(Throwable failure) {
                                sttFailure.compareAndSet(null, failure);
                                sttServerCompleted.countDown();
                            }

                            @Override public void onCompleted() {
                                observer.onCompleted();
                                sttServerCompleted.countDown();
                            }
                        };
                    }
                })
                .addService(new TTSServiceGrpc.TTSServiceImplBase() {
                    @Override public void streamSynthesize(SynthesizeRequest request,
                            StreamObserver<com.ghatana.tts.core.grpc.proto.AudioChunk> observer) {
                        ttsStreamCalls.incrementAndGet();
                        require(request.getText().equals("synthetic speech"),
                                "Installed TTS stream request did not preserve its synthetic text");
                        observer.onNext(com.ghatana.tts.core.grpc.proto.AudioChunk.newBuilder()
                                .setAudioData(ByteString.copyFromUtf8("tts-part-1"))
                                .setSampleRate(24_000)
                                .setTimestampMs(0)
                                .build());
                        observer.onNext(com.ghatana.tts.core.grpc.proto.AudioChunk.newBuilder()
                                .setAudioData(ByteString.copyFromUtf8("tts-part-2"))
                                .setSampleRate(24_000)
                                .setTimestampMs(10)
                                .setIsFinal(true)
                                .build());
                        observer.onCompleted();
                    }
                })
                .addService(new VisionServiceGrpc.VisionServiceImplBase() {
                    @Override public StreamObserver<com.ghatana.audio.video.vision.grpc.proto.VideoFrameRequest>
                            processVideo(StreamObserver<com.ghatana.audio.video.vision.grpc.proto.VideoFrameResponse>
                                    observer) {
                        visionStreamCalls.incrementAndGet();
                        return new StreamObserver<>() {
                            @Override public void onNext(
                                    com.ghatana.audio.video.vision.grpc.proto.VideoFrameRequest frame) {
                                require(frame.getFrameData().equals(ByteString.copyFromUtf8(
                                                "vision-frame-" + frame.getFrameNumber())),
                                        "Installed Vision stream request payload did not match its frame number");
                                visionMessages.incrementAndGet();
                                observer.onNext(com.ghatana.audio.video.vision.grpc.proto.VideoFrameResponse
                                        .newBuilder()
                                        .setFrameNumber(frame.getFrameNumber())
                                        .setTimestampMs(frame.getTimestampMs())
                                        .build());
                            }

                            @Override public void onError(Throwable failure) {
                                visionFailure.compareAndSet(null, failure);
                                visionServerCompleted.countDown();
                            }

                            @Override public void onCompleted() {
                                observer.onCompleted();
                                visionServerCompleted.countDown();
                            }
                        };
                    }
                })
                .build()
                .start();
        ManagedChannel channel = InProcessChannelBuilder.forName(serverName).directExecutor().build();
        try {
            StreamObserver<com.ghatana.stt.core.grpc.proto.AudioChunk> sttRequest =
                    STTServiceGrpc.newStub(channel).streamTranscribe(new StreamObserver<>() {
                        @Override public void onNext(com.ghatana.stt.core.grpc.proto.Transcription value) {
                            sttResponses.add(value);
                        }

                        @Override public void onError(Throwable failure) {
                            sttFailure.compareAndSet(null, failure);
                            sttClientCompleted.countDown();
                        }

                        @Override public void onCompleted() {
                            sttClientCompleted.countDown();
                        }
                    });
            sttRequest.onNext(com.ghatana.stt.core.grpc.proto.AudioChunk.newBuilder()
                    .setAudioData(ByteString.copyFromUtf8("stt-frame"))
                    .setSampleRate(16_000)
                    .setSequence(7)
                    .build());
            sttRequest.onCompleted();

            TTSServiceGrpc.newStub(channel).streamSynthesize(
                    SynthesizeRequest.newBuilder().setText("synthetic speech").build(), new StreamObserver<>() {
                        @Override public void onNext(com.ghatana.tts.core.grpc.proto.AudioChunk value) {
                            ttsResponses.add(value);
                        }

                        @Override public void onError(Throwable failure) {
                            ttsFailure.compareAndSet(null, failure);
                            ttsClientCompleted.countDown();
                        }

                        @Override public void onCompleted() {
                            ttsClientCompleted.countDown();
                        }
                    });

            StreamObserver<com.ghatana.audio.video.vision.grpc.proto.VideoFrameRequest> visionRequest =
                    VisionServiceGrpc.newStub(channel).processVideo(new StreamObserver<>() {
                        @Override public void onNext(
                                com.ghatana.audio.video.vision.grpc.proto.VideoFrameResponse value) {
                            visionResponses.add(value);
                        }

                        @Override public void onError(Throwable failure) {
                            visionFailure.compareAndSet(null, failure);
                            visionClientCompleted.countDown();
                        }

                        @Override public void onCompleted() {
                            visionClientCompleted.countDown();
                        }
                    });
            for (int frame = 1; frame <= 2; frame++) {
                visionRequest.onNext(com.ghatana.audio.video.vision.grpc.proto.VideoFrameRequest.newBuilder()
                        .setFrameData(ByteString.copyFromUtf8("vision-frame-" + frame))
                        .setFrameNumber(frame)
                        .setTimestampMs(frame * 40L)
                        .build());
            }
            visionRequest.onCompleted();

            await(sttServerCompleted, "STT streaming server did not complete");
            await(sttClientCompleted, "STT streaming client did not complete");
            await(ttsClientCompleted, "TTS streaming client did not complete");
            await(visionServerCompleted, "Vision streaming server did not complete");
            await(visionClientCompleted, "Vision streaming client did not complete");
            require(sttFailure.get() == null, "Installed STT streaming failed: " + sttFailure.get());
            require(ttsFailure.get() == null, "Installed TTS streaming failed: " + ttsFailure.get());
            require(visionFailure.get() == null, "Installed Vision streaming failed: " + visionFailure.get());
            require(sttStreamCalls.get() == 1 && sttMessages.get() == 1 && sttResponses.size() == 1
                            && sttResponses.get(0).getText().equals("stt-stream-result")
                            && sttResponses.get(0).getIsFinal()
                            && sttResponses.get(0).getAcceptedSequenceSnapshot() == 7,
                    "Installed STT bidi stream did not dispatch and return its exact response");
            require(ttsStreamCalls.get() == 1 && ttsResponses.size() == 2
                            && ttsResponses.get(0).getAudioData().equals(ByteString.copyFromUtf8("tts-part-1"))
                            && ttsResponses.get(0).getTimestampMs() == 0
                            && !ttsResponses.get(0).getIsFinal()
                            && ttsResponses.get(1).getAudioData().equals(ByteString.copyFromUtf8("tts-part-2"))
                            && ttsResponses.get(1).getTimestampMs() == 10
                            && ttsResponses.get(1).getIsFinal(),
                    "Installed TTS server stream did not return both ordered chunks exactly");
            require(visionStreamCalls.get() == 1 && visionMessages.get() == 2 && visionResponses.size() == 2
                            && visionResponses.get(0).getFrameNumber() == 1
                            && visionResponses.get(0).getTimestampMs() == 40
                            && visionResponses.get(1).getFrameNumber() == 2
                            && visionResponses.get(1).getTimestampMs() == 80,
                    "Installed Vision bidi stream did not echo both ordered frame identities exactly");
        } finally {
            channel.shutdownNow();
            server.shutdownNow();
        }
    }

    private static void await(CountDownLatch latch, String failureMessage) throws InterruptedException {
        require(latch.await(3, TimeUnit.SECONDS), failureMessage);
    }

    private static void assertInstalledStubDeadlineAndCancellation() throws Exception {
        AtomicInteger sttCalls = new AtomicInteger();
        AtomicInteger ttsCalls = new AtomicInteger();
        AtomicInteger visionCalls = new AtomicInteger();
        AtomicInteger multimodalCalls = new AtomicInteger();
        CountDownLatch sttEntered = new CountDownLatch(1);
        CountDownLatch sttCancelled = new CountDownLatch(1);
        CountDownLatch ttsEntered = new CountDownLatch(1);
        CountDownLatch ttsCancelled = new CountDownLatch(1);
        CountDownLatch visionEntered = new CountDownLatch(1);
        CountDownLatch visionCancelled = new CountDownLatch(1);
        CountDownLatch multimodalEntered = new CountDownLatch(1);
        CountDownLatch multimodalCancelled = new CountDownLatch(1);
        CountDownLatch sttLateAttempted = new CountDownLatch(1);
        CountDownLatch ttsLateAttempted = new CountDownLatch(1);
        CountDownLatch visionLateAttempted = new CountDownLatch(1);
        CountDownLatch multimodalLateAttempted = new CountDownLatch(1);
        AtomicInteger sttLateAttempts = new AtomicInteger();
        AtomicInteger ttsLateAttempts = new AtomicInteger();
        AtomicInteger visionLateAttempts = new AtomicInteger();
        AtomicInteger multimodalLateAttempts = new AtomicInteger();
        String serverName = "media-grpc-api-deadline-" + UUID.randomUUID();

        Server server = InProcessServerBuilder.forName(serverName)
                .addService(new STTServiceGrpc.STTServiceImplBase() {
                    @Override public void transcribe(TranscribeRequest request,
                            StreamObserver<TranscribeResponse> observer) {
                        sttCalls.incrementAndGet();
                        awaitCancellationThenRespond(sttEntered, sttCancelled, sttLateAttempted, sttLateAttempts,
                                observer,
                                TranscribeResponse.getDefaultInstance());
                    }
                })
                .addService(new TTSServiceGrpc.TTSServiceImplBase() {
                    @Override public void synthesize(SynthesizeRequest request,
                            StreamObserver<SynthesizeResponse> observer) {
                        ttsCalls.incrementAndGet();
                        awaitCancellationThenRespond(ttsEntered, ttsCancelled, ttsLateAttempted, ttsLateAttempts,
                                observer,
                                SynthesizeResponse.getDefaultInstance());
                    }
                })
                .addService(new VisionServiceGrpc.VisionServiceImplBase() {
                    @Override public void detectObjects(DetectRequest request,
                            StreamObserver<DetectResponse> observer) {
                        visionCalls.incrementAndGet();
                        awaitCancellationThenRespond(visionEntered, visionCancelled, visionLateAttempted,
                                visionLateAttempts, observer,
                                DetectResponse.getDefaultInstance());
                    }
                })
                .addService(new MultimodalServiceGrpc.MultimodalServiceImplBase() {
                    @Override public void processMultimodal(MultimodalRequest request,
                            StreamObserver<MultimodalResponse> observer) {
                        multimodalCalls.incrementAndGet();
                        awaitCancellationThenRespond(multimodalEntered, multimodalCancelled,
                                multimodalLateAttempted, multimodalLateAttempts, observer,
                                MultimodalResponse.getDefaultInstance());
                    }
                })
                .build()
                .start();
        ManagedChannel channel = InProcessChannelBuilder.forName(serverName).build();
        ExecutorService caller = Executors.newSingleThreadExecutor();
        try {
            assertDeadline("STT", caller,
                    () -> STTServiceGrpc.newBlockingStub(channel).withDeadlineAfter(150, TimeUnit.MILLISECONDS)
                            .transcribe(TranscribeRequest.getDefaultInstance()), sttEntered, sttCancelled,
                    sttLateAttempted);
            assertDeadline("TTS", caller,
                    () -> TTSServiceGrpc.newBlockingStub(channel).withDeadlineAfter(150, TimeUnit.MILLISECONDS)
                            .synthesize(SynthesizeRequest.getDefaultInstance()), ttsEntered, ttsCancelled,
                    ttsLateAttempted);
            assertDeadline("Vision", caller,
                    () -> VisionServiceGrpc.newBlockingStub(channel).withDeadlineAfter(150, TimeUnit.MILLISECONDS)
                            .detectObjects(DetectRequest.getDefaultInstance()), visionEntered, visionCancelled,
                    visionLateAttempted);
            assertDeadline("Multimodal", caller,
                    () -> MultimodalServiceGrpc.newBlockingStub(channel).withDeadlineAfter(150, TimeUnit.MILLISECONDS)
                            .processMultimodal(MultimodalRequest.getDefaultInstance()),
                    multimodalEntered, multimodalCancelled, multimodalLateAttempted);
            require(sttCalls.get() == 1 && ttsCalls.get() == 1
                            && visionCalls.get() == 1 && multimodalCalls.get() == 1,
                    "Deadline calls must dispatch exactly once to each installed service");
            require(sttLateAttempts.get() == 1 && ttsLateAttempts.get() == 1
                            && visionLateAttempts.get() == 1 && multimodalLateAttempts.get() == 1,
                    "Each installed service must attempt exactly one late response after cancellation");
        } finally {
            caller.shutdownNow();
            channel.shutdownNow();
            server.shutdownNow();
        }
    }

    private static void assertDeadline(String service, ExecutorService caller, RpcCall call,
            CountDownLatch entered, CountDownLatch cancelled, CountDownLatch lateAttempted) throws Exception {
        Future<?> result = caller.submit(call::invoke);
        require(entered.await(2, TimeUnit.SECONDS), service + " deadline call did not reach the server");
        try {
            result.get(3, TimeUnit.SECONDS);
            throw new IllegalStateException(service + " installed stub returned success after its deadline");
        } catch (ExecutionException failure) {
            require(Status.fromThrowable(failure.getCause()).getCode() == Status.Code.DEADLINE_EXCEEDED,
                    service + " installed stub did not report DEADLINE_EXCEEDED: " + failure.getCause());
        }
        require(cancelled.await(2, TimeUnit.SECONDS),
                service + " server Context did not observe installed-client deadline cancellation");
        require(lateAttempted.await(2, TimeUnit.SECONDS),
                service + " synthetic handler did not attempt its late response after cancellation");
    }

    private static <T> void awaitCancellationThenRespond(CountDownLatch entered, CountDownLatch cancelled,
            CountDownLatch lateAttempted, AtomicInteger lateAttempts, StreamObserver<T> observer, T lateResponse) {
        Context.current().addListener(ignored -> cancelled.countDown(), Runnable::run);
        entered.countDown();
        try {
            if (!cancelled.await(3, TimeUnit.SECONDS)) {
                observer.onError(Status.DEADLINE_EXCEEDED.withDescription("synthetic deadline wait expired")
                        .asRuntimeException());
                return;
            }
            // Simulate a late handler result after transport cancellation; gRPC must suppress delivery.
            observer.onNext(lateResponse);
            observer.onCompleted();
            lateAttempts.incrementAndGet();
            lateAttempted.countDown();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            observer.onError(Status.CANCELLED.withCause(interrupted).asRuntimeException());
        }
    }

    @FunctionalInterface
    private interface RpcCall {
        Object invoke();
    }

    private static void assertService(ServiceDescriptor descriptor, String fullName, Set<String> expectedMethods,
            Map<String, MethodDescriptor.MethodType> expectedStreamingMethods) {
        require(fullName.equals(descriptor.getName()), "Unexpected service descriptor: " + descriptor.getName());
        Map<String, MethodDescriptor.MethodType> methods = descriptor.getMethods().stream()
                .collect(Collectors.toMap(MethodDescriptor::getBareMethodName, MethodDescriptor::getType));
        require(methods.keySet().equals(expectedMethods),
                "RPC inventory drift in " + fullName + ": expected " + expectedMethods + " but got "
                        + methods.keySet());
        Map<String, MethodDescriptor.MethodType> actualStreamingMethods = methods.entrySet().stream()
                .filter(entry -> entry.getValue() != MethodDescriptor.MethodType.UNARY)
                .collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue));
        require(actualStreamingMethods.equals(expectedStreamingMethods),
                "Streaming shape drift in " + fullName + ": expected " + expectedStreamingMethods + " but got "
                        + actualStreamingMethods);
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new IllegalStateException(message);
        }
    }
}
