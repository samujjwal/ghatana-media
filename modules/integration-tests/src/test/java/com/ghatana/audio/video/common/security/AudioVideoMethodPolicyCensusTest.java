package com.ghatana.audio.video.common.security;

import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalServiceProto;
import com.ghatana.audio.video.vision.grpc.proto.VisionServiceProto;
import com.ghatana.stt.core.grpc.proto.SttServiceProto;
import com.ghatana.tts.core.grpc.proto.TtsServiceProto;
import com.google.protobuf.Descriptors;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** Reconciles the cross-service application RPC descriptors with explicit RBAC dispositions. */
class AudioVideoMethodPolicyCensusTest {
    private static final List<Descriptors.ServiceDescriptor> SERVICES = List.of(
            SttServiceProto.getDescriptor().findServiceByName("STTService"),
            TtsServiceProto.getDescriptor().findServiceByName("TTSService"),
            VisionServiceProto.getDescriptor().findServiceByName("VisionService"),
            MultimodalServiceProto.getDescriptor().findServiceByName("MultimodalService"));

    @Test
    void currentDescriptorsExactlyMatchExplicitGrantAndDenyPolicy() {
        Set<String> methodIds = new HashSet<>();
        Map<String, Integer> methodsByService = new HashMap<>();
        int grants = 0;
        int explicitDenials = 0;

        for (Descriptors.ServiceDescriptor service : SERVICES) {
            assertThat(service).isNotNull();
            for (Descriptors.MethodDescriptor method : service.getMethods()) {
                String fullMethod = service.getFullName() + "/" + method.getName();
                assertThat(methodIds.add(fullMethod)).as("unique method identity %s", fullMethod).isTrue();
                methodsByService.merge(service.getFullName(), 1, Integer::sum);

                AudioVideoMethodRbacRegistry.MethodDisposition disposition =
                        AudioVideoMethodRbacRegistry.methodDisposition(fullMethod);
                assertThat(disposition).as("explicit method disposition for %s", fullMethod)
                        .isIn(AudioVideoMethodRbacRegistry.MethodDisposition.ROLE_GRANT,
                                AudioVideoMethodRbacRegistry.MethodDisposition.EXPLICIT_DENY);
                if (disposition == AudioVideoMethodRbacRegistry.MethodDisposition.ROLE_GRANT) {
                    grants++;
                    assertThat(AudioVideoMethodRbacRegistry.isAllowedAny(fullMethod,
                            Set.of("av:user", "av:admin"))).as("role grant for %s", fullMethod).isTrue();
                } else {
                    explicitDenials++;
                    assertThat(AudioVideoMethodRbacRegistry.isAllowedAny(fullMethod,
                            Set.of("av:user", "av:admin"))).as("deny-only disposition for %s", fullMethod).isFalse();
                }
            }
        }

        assertThat(methodIds).hasSize(45).contains("com.ghatana.audio.video.vision.grpc.VisionService/ResolveSourceFrame");
        assertThat(AudioVideoMethodRbacRegistry.explicitlyDispositionedMethods())
                .containsExactlyInAnyOrderElementsOf(methodIds);
        assertThat(methodsByService.get("com.ghatana.audio.video.stt.grpc.STTService")).isEqualTo(12);
        assertThat(methodsByService.get("com.ghatana.audio.video.tts.grpc.TTSService")).isEqualTo(11);
        assertThat(methodsByService.get("com.ghatana.audio.video.vision.grpc.VisionService")).isEqualTo(12);
        assertThat(methodsByService.get("com.ghatana.audio.video.multimodal.grpc.MultimodalService")).isEqualTo(10);
        assertThat(grants).isEqualTo(16);
        assertThat(explicitDenials).isEqualTo(29);
    }
}
