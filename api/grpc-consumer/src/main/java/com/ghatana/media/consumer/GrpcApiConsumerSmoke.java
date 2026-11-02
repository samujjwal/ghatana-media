package com.ghatana.media.consumer;

import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalServiceGrpc;
import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalServiceProto;
import com.ghatana.audio.video.vision.grpc.proto.VisionServiceGrpc;
import com.ghatana.audio.video.vision.grpc.proto.VisionServiceProto;
import com.ghatana.stt.core.grpc.proto.STTServiceGrpc;
import com.ghatana.stt.core.grpc.proto.SttServiceProto;
import com.ghatana.tts.core.grpc.proto.TTSServiceGrpc;
import com.ghatana.tts.core.grpc.proto.TtsServiceProto;
import io.grpc.MethodDescriptor;
import io.grpc.ServiceDescriptor;

import java.util.Set;
import java.util.stream.Collectors;

/** Compiles against the installed candidate artifact, with no Media source project on this build path. */
public final class GrpcApiConsumerSmoke {
    private GrpcApiConsumerSmoke() {}

    public static void main(String[] args) {
        assertService(STTServiceGrpc.getServiceDescriptor(), "com.ghatana.audio.video.stt.grpc.STTService", "Transcribe");
        assertService(TTSServiceGrpc.getServiceDescriptor(), "com.ghatana.audio.video.tts.grpc.TTSService", "Synthesize");
        assertService(VisionServiceGrpc.getServiceDescriptor(), "com.ghatana.audio.video.vision.grpc.VisionService", "DetectObjects");
        assertService(MultimodalServiceGrpc.getServiceDescriptor(), "com.ghatana.audio.video.multimodal.grpc.MultimodalService", "ProcessMultimodal");

        // Touch the canonical file descriptors too, proving message descriptors are present.
        require(SttServiceProto.getDescriptor().getServices().size() == 1, "STT proto descriptor missing");
        require(TtsServiceProto.getDescriptor().getServices().size() == 1, "TTS proto descriptor missing");
        require(VisionServiceProto.getDescriptor().getServices().size() == 1, "Vision proto descriptor missing");
        require(MultimodalServiceProto.getDescriptor().getServices().size() == 1, "Multimodal proto descriptor missing");
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
