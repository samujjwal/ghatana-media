package com.ghatana.stt.grpc;

import com.ghatana.stt.core.grpc.proto.AudioChunk;
import com.ghatana.stt.core.grpc.proto.STTServiceGrpc;
import com.ghatana.stt.core.grpc.proto.TranscribeRequest;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;
import com.ghatana.stt.core.grpc.proto.Transcription;
import com.google.protobuf.Descriptors;
import io.grpc.MethodDescriptor;
import io.grpc.ServiceDescriptor;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** Locks the public STT RPC identities and selected wire field numbers to the proto authority. */
class SttProtoContractTest {

    private record Rpc(String request, String response, MethodDescriptor.MethodType type) {}

    @Test
    void serviceDescriptorRetainsAllTwelveRpcIdentitiesAndStreamingShapes() {
        Map<String, Rpc> expected = new LinkedHashMap<>();
        expected.put("Transcribe", new Rpc("TranscribeRequest", "TranscribeResponse", MethodDescriptor.MethodType.UNARY));
        expected.put("StreamTranscribe", new Rpc("AudioChunk", "Transcription", MethodDescriptor.MethodType.BIDI_STREAMING));
        expected.put("LoadModel", new Rpc("LoadModelRequest", "LoadModelResponse", MethodDescriptor.MethodType.UNARY));
        expected.put("UnloadModel", new Rpc("UnloadModelRequest", "UnloadModelResponse", MethodDescriptor.MethodType.UNARY));
        expected.put("ListModels", new Rpc("ListModelsRequest", "ListModelsResponse", MethodDescriptor.MethodType.UNARY));
        expected.put("AdaptModel", new Rpc("AdaptRequest", "AdaptResponse", MethodDescriptor.MethodType.UNARY));
        expected.put("GetStatus", new Rpc("StatusRequest", "StatusResponse", MethodDescriptor.MethodType.UNARY));
        expected.put("HealthCheck", new Rpc("HealthCheckRequest", "HealthCheckResponse", MethodDescriptor.MethodType.UNARY));
        expected.put("CreateProfile", new Rpc("CreateProfileRequest", "ProfileResponse", MethodDescriptor.MethodType.UNARY));
        expected.put("GetProfile", new Rpc("GetProfileRequest", "ProfileResponse", MethodDescriptor.MethodType.UNARY));
        expected.put("UpdateProfile", new Rpc("UpdateProfileRequest", "ProfileResponse", MethodDescriptor.MethodType.UNARY));
        expected.put("SubmitCorrection", new Rpc("CorrectionRequest", "CorrectionResponse", MethodDescriptor.MethodType.UNARY));

        ServiceDescriptor generated = STTServiceGrpc.getServiceDescriptor();
        Descriptors.ServiceDescriptor proto = TranscribeRequest.getDescriptor().getFile()
                .findServiceByName("STTService");

        assertThat(generated.getName()).isEqualTo("com.ghatana.audio.video.stt.grpc.STTService");
        assertThat(generated.getMethods()).hasSize(12);
        assertThat(proto.getMethods()).hasSize(12);
        for (Map.Entry<String, Rpc> entry : expected.entrySet()) {
            String methodName = entry.getKey();
            Rpc rpc = entry.getValue();
            Descriptors.MethodDescriptor protoMethod = proto.findMethodByName(methodName);
            MethodDescriptor<?, ?> grpcMethod = generated.getMethods().stream()
                    .filter(candidate -> candidate.getFullMethodName().endsWith("/" + methodName))
                    .findFirst()
                    .orElse(null);

            assertThat(protoMethod).as("proto method %s", methodName).isNotNull();
            assertThat(protoMethod.getInputType().getName()).isEqualTo(rpc.request());
            assertThat(protoMethod.getOutputType().getName()).isEqualTo(rpc.response());
            assertThat(grpcMethod).as("generated gRPC method %s", methodName).isNotNull();
            assertThat(grpcMethod.getFullMethodName())
                    .isEqualTo("com.ghatana.audio.video.stt.grpc.STTService/" + methodName);
            assertThat(grpcMethod.getType()).isEqualTo(rpc.type());
            assertThat(protoMethod.isClientStreaming()).isEqualTo(rpc.type() == MethodDescriptor.MethodType.BIDI_STREAMING);
            assertThat(protoMethod.isServerStreaming()).isEqualTo(rpc.type() == MethodDescriptor.MethodType.BIDI_STREAMING);
        }
    }

    @Test
    void selectedTranscriptionAndStreamWireFieldNumbersRemainStable() {
        assertField(TranscribeRequest.getDescriptor(), "audio_data", 1);
        assertField(TranscribeRequest.getDescriptor(), "sample_rate", 2);
        assertField(TranscribeRequest.getDescriptor(), "options", 5);
        assertField(TranscribeRequest.getDescriptor(), "tenant_id", 6);
        assertField(TranscribeRequest.getDescriptor(), "correlation_id", 9);
        assertField(TranscribeRequest.getDescriptor(), "consent_status", 10);

        assertField(TranscribeResponse.getDescriptor(), "text", 1);
        assertField(TranscribeResponse.getDescriptor(), "word_timings", 3);
        assertField(TranscribeResponse.getDescriptor(), "alternatives", 6);
        assertField(TranscribeResponse.getDescriptor(), "word_timing_timebase", 8);
        assertField(TranscribeResponse.getDescriptor(), "confidence_calibration", 9);

        assertField(AudioChunk.getDescriptor(), "audio_data", 1);
        assertField(AudioChunk.getDescriptor(), "timestamp_ms", 3);
        assertField(AudioChunk.getDescriptor(), "session_id", 4);
        assertField(AudioChunk.getDescriptor(), "sequence", 5);
        assertField(Transcription.getDescriptor(), "accepted_sequence_snapshot", 6);
        assertField(Transcription.getDescriptor(), "revision", 7);
        assertField(Transcription.getDescriptor(), "durable_resume_enabled", 9);
        assertField(Transcription.getDescriptor(), "outcome_unknown", 10);
        assertField(Transcription.getDescriptor(), "backpressured", 11);
    }

    private static void assertField(Descriptors.Descriptor message, String fieldName, int number) {
        Descriptors.FieldDescriptor field = message.findFieldByName(fieldName);
        assertThat(field).as("%s.%s", message.getName(), fieldName).isNotNull();
        assertThat(field.getNumber()).as("%s.%s field number", message.getName(), fieldName)
                .isEqualTo(number);
    }
}
