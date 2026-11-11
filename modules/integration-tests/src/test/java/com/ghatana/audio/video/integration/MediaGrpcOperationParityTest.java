package com.ghatana.audio.video.integration;

import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalServiceGrpc;
import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalServiceProto;
import com.ghatana.audio.video.multimodal.grpc.MultimodalGrpcService;
import com.ghatana.audio.video.vision.grpc.proto.VisionServiceGrpc;
import com.ghatana.audio.video.vision.grpc.proto.VisionServiceProto;
import com.ghatana.audio.video.vision.grpc.ProductionVisionGrpcService;
import com.ghatana.stt.core.grpc.proto.STTServiceGrpc;
import com.ghatana.stt.core.grpc.proto.SttServiceProto;
import com.ghatana.stt.grpc.ProductionSttGrpcService;
import com.ghatana.tts.core.grpc.proto.TTSServiceGrpc;
import com.ghatana.tts.core.grpc.proto.TtsServiceProto;
import com.ghatana.tts.grpc.ProductionTtsGrpcService;
import com.google.protobuf.Descriptors;
import io.grpc.MethodDescriptor;
import io.grpc.stub.StreamObserver;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Ensures the four governed gRPC descriptors have both generated client calls
 * and non-default handlers in the active production service compositions.
 * Outcome semantics and authorization are exercised by the service-specific
 * in-process RPC matrices.
 */
class MediaGrpcOperationParityTest {

    private record Surface(
            Descriptors.ServiceDescriptor proto,
            Class<?> serviceBase,
            Class<?> activeService,
            Class<?> generatedService,
            Class<?> asyncStub) {}

    private static final List<Surface> SURFACES = List.of(
            new Surface(SttServiceProto.getDescriptor().findServiceByName("STTService"),
                    STTServiceGrpc.STTServiceImplBase.class, ProductionSttGrpcService.class,
                    STTServiceGrpc.class, STTServiceGrpc.STTServiceStub.class),
            new Surface(TtsServiceProto.getDescriptor().findServiceByName("TTSService"),
                    TTSServiceGrpc.TTSServiceImplBase.class, ProductionTtsGrpcService.class,
                    TTSServiceGrpc.class, TTSServiceGrpc.TTSServiceStub.class),
            new Surface(VisionServiceProto.getDescriptor().findServiceByName("VisionService"),
                    VisionServiceGrpc.VisionServiceImplBase.class, ProductionVisionGrpcService.class,
                    VisionServiceGrpc.class, VisionServiceGrpc.VisionServiceStub.class),
            new Surface(MultimodalServiceProto.getDescriptor().findServiceByName("MultimodalService"),
                    MultimodalServiceGrpc.MultimodalServiceImplBase.class, MultimodalGrpcService.class,
                    MultimodalServiceGrpc.class, MultimodalServiceGrpc.MultimodalServiceStub.class));

    @Test
    void allDeclaredRpcsHaveClientCallsAndActiveHandlers() throws Exception {
        for (Surface surface : SURFACES) {
            assertThat(surface.proto()).as("protobuf service descriptor").isNotNull();
            for (Descriptors.MethodDescriptor protoMethod : surface.proto().getMethods()) {
                String javaMethodName = lowerCamel(protoMethod.getName());
                Class<?> requestType = messageType(surface.proto().getFile(), protoMethod.getInputType());
                boolean clientStreaming = protoMethod.isClientStreaming();

                Method handler = clientStreaming
                        ? surface.activeService().getMethod(javaMethodName, StreamObserver.class)
                        : surface.activeService().getMethod(javaMethodName, requestType, StreamObserver.class);
                assertThat(handler.getDeclaringClass())
                        .as("%s.%s must not fall through to generated UNIMPLEMENTED", surface.proto().getName(),
                                protoMethod.getName())
                        .isNotEqualTo(surface.serviceBase());

                io.grpc.ServiceDescriptor runtimeDescriptor = (io.grpc.ServiceDescriptor) surface.generatedService()
                        .getMethod("getServiceDescriptor").invoke(null);
                MethodDescriptor<?, ?> generatedMethod = runtimeDescriptor.getMethods().stream()
                        .filter(candidate -> candidate.getBareMethodName().equals(protoMethod.getName()))
                        .findFirst().orElse(null);
                assertThat(generatedMethod)
                        .as("generated descriptor for %s.%s", surface.proto().getName(), protoMethod.getName())
                        .isNotNull();
                assertThat(generatedMethod.getType())
                        .as("generated client/server streaming shape for %s", protoMethod.getName())
                        .isEqualTo(methodType(protoMethod.isClientStreaming(), protoMethod.isServerStreaming()));
                Method clientCall = clientStreaming
                        ? surface.asyncStub().getMethod(javaMethodName, StreamObserver.class)
                        : surface.asyncStub().getMethod(javaMethodName, requestType, StreamObserver.class);
                assertThat(clientCall).as("generated async client call for %s", protoMethod.getName()).isNotNull();
            }
        }
    }

    @Test
    void currentVisionSourceFrameResolverHasGeneratedCallAndActiveHandler() throws Exception {
        Surface vision = SURFACES.stream()
                .filter(surface -> surface.proto().getName().equals("VisionService"))
                .findFirst().orElseThrow();
        Descriptors.MethodDescriptor protoMethod = vision.proto().findMethodByName("ResolveSourceFrame");

        assertThat(protoMethod).as("current Vision source-frame resolver descriptor").isNotNull();
        Class<?> requestType = messageType(vision.proto().getFile(), protoMethod.getInputType());
        Method handler = vision.activeService().getMethod("resolveSourceFrame", requestType, StreamObserver.class);
        assertThat(handler.getDeclaringClass())
                .as("ResolveSourceFrame must not fall through to generated UNIMPLEMENTED")
                .isNotEqualTo(vision.serviceBase());

        io.grpc.ServiceDescriptor runtimeDescriptor = (io.grpc.ServiceDescriptor) vision.generatedService()
                .getMethod("getServiceDescriptor").invoke(null);
        assertThat(runtimeDescriptor.getMethods().stream()
                .map(MethodDescriptor::getBareMethodName))
                .contains("ResolveSourceFrame");
        assertThat(vision.asyncStub().getMethod("resolveSourceFrame", requestType, StreamObserver.class))
                .as("generated async client call for ResolveSourceFrame")
                .isNotNull();
    }

    private static MethodDescriptor.MethodType methodType(boolean clientStreaming, boolean serverStreaming) {
        if (clientStreaming && serverStreaming) return MethodDescriptor.MethodType.BIDI_STREAMING;
        if (clientStreaming) return MethodDescriptor.MethodType.CLIENT_STREAMING;
        if (serverStreaming) return MethodDescriptor.MethodType.SERVER_STREAMING;
        return MethodDescriptor.MethodType.UNARY;
    }

    private static Class<?> messageType(Descriptors.FileDescriptor file, Descriptors.Descriptor message)
            throws ClassNotFoundException {
        String javaPackage = file.getOptions().hasJavaPackage()
                ? file.getOptions().getJavaPackage() : file.getPackage();
        return Class.forName(javaPackage + "." + message.getName());
    }

    private static String lowerCamel(String value) {
        return Character.toLowerCase(value.charAt(0)) + value.substring(1);
    }
}
