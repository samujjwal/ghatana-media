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
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.stub.StreamObserver;
import io.grpc.MethodDescriptor;
import io.grpc.ServiceDescriptor;

import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;

/** Compiles against the installed candidate artifact, with no Media source project on this build path. */
public final class GrpcApiConsumerSmoke {
    private GrpcApiConsumerSmoke() {}

    public static void main(String[] args) throws Exception {
        assertService(STTServiceGrpc.getServiceDescriptor(), "com.ghatana.audio.video.stt.grpc.STTService", "Transcribe");
        assertService(TTSServiceGrpc.getServiceDescriptor(), "com.ghatana.audio.video.tts.grpc.TTSService", "Synthesize");
        assertService(VisionServiceGrpc.getServiceDescriptor(), "com.ghatana.audio.video.vision.grpc.VisionService", "DetectObjects");
        assertService(MultimodalServiceGrpc.getServiceDescriptor(), "com.ghatana.audio.video.multimodal.grpc.MultimodalService", "ProcessMultimodal");

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
    }

    private static void assertService(ServiceDescriptor descriptor, String fullName, String requiredMethod) {
        require(fullName.equals(descriptor.getName()), "Unexpected service descriptor: " + descriptor.getName());
        Set<String> methods = descriptor.getMethods().stream()
                .map(MethodDescriptor::getBareMethodName)
                .collect(Collectors.toSet());
        require(methods.contains(requiredMethod), "Missing method " + requiredMethod + " in " + fullName);
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new IllegalStateException(message);
        }
    }
}
