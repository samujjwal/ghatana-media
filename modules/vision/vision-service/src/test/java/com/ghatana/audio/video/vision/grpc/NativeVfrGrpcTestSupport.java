package com.ghatana.audio.video.vision.grpc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.vision.detection.VisionDetector;
import com.ghatana.audio.video.vision.grpc.proto.SceneTextRoi;
import com.ghatana.audio.video.vision.grpc.proto.SourceFrameResolveRequest;
import com.ghatana.audio.video.vision.grpc.proto.VisionServiceGrpc;
import com.ghatana.audio.video.vision.scenetext.MediaRuntimeSceneTextSource;
import com.ghatana.audio.video.vision.scenetext.SceneTextRecognitionService.ResolvedCrop;
import com.ghatana.audio.video.vision.video.SourceMediaTimestamp;
import com.ghatana.audio.video.vision.video.VideoFrameExtractor;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import io.grpc.Context;
import io.grpc.Contexts;
import io.grpc.ManagedChannel;
import io.grpc.ManagedChannelBuilder;
import io.grpc.Server;
import io.grpc.ServerBuilder;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;

/** Package-local composition access for the pinned native VFR gRPC integration test. */
public final class NativeVfrGrpcTestSupport {
    private NativeVfrGrpcTestSupport() { }

    public static void assertRpcResolution(MediaProcessingRuntimePort port, String tenant, String principal,
                                           String version, String sourceSha, int ordinal, long ptsUs,
                                           int frameWidth, int frameHeight, SourceMediaTimestamp timestamp,
                                           ResolvedCrop expected) throws Exception {
        VisionGrpcService grpc = new VisionGrpcService(mock(VisionDetector.class), new VideoFrameExtractor());
        grpc.bindMediaRuntimeSceneTextSource(new MediaRuntimeSceneTextSource(port));
        Server rpcServer = ServerBuilder.forPort(0).directExecutor().intercept(new ServerInterceptor() {
            @Override public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
                    ServerCall<ReqT, RespT> call, io.grpc.Metadata headers, ServerCallHandler<ReqT, RespT> next) {
                Context context = Context.current().withValue(JwtServerInterceptor.CTX_TENANT, tenant)
                        .withValue(JwtServerInterceptor.CTX_SUBJECT, principal);
                return Contexts.interceptCall(context, call, headers, next);
            }
        }).addService(grpc).build().start();
        ManagedChannel rpcChannel = ManagedChannelBuilder.forAddress("localhost", rpcServer.getPort())
                .usePlaintext().directExecutor().build();
        try {
            var result = VisionServiceGrpc.newBlockingStub(rpcChannel).resolveSourceFrame(
                    SourceFrameResolveRequest.newBuilder().setSourceArtifactId("vfr-source")
                            .setSourceVersion(version).setPurposeRef("native-vfr-purpose")
                            .setFrameId(Integer.toString(ordinal)).setPtsUs(ptsUs)
                            .setFrameWidth(frameWidth).setFrameHeight(frameHeight)
                            .setRoi(SceneTextRoi.newBuilder().setX(2).setY(2).setWidth(16).setHeight(16))
                            .build());
            assertThat(result.hasResolved()).isTrue();
            var frame = result.getResolved();
            assertThat(frame.getTenantId()).isEqualTo(tenant);
            assertThat(frame.getPrincipalId()).isEqualTo(principal);
            assertThat(frame.getSourceVersion()).isEqualTo(version);
            assertThat(frame.getSourceSha256()).isEqualTo(sourceSha);
            assertThat(frame.getFrameNumber()).isEqualTo(ordinal);
            assertThat(frame.getSourcePts()).isEqualTo(timestamp.pts());
            assertThat(frame.getTimeBaseNumerator()).isEqualTo(timestamp.timeBaseNumerator());
            assertThat(frame.getTimeBaseDenominator()).isEqualTo(timestamp.timeBaseDenominator());
            assertThat(frame.getPtsUs()).isEqualTo(ptsUs);
            assertThat(frame.getSourceStreamSelector()).isEqualTo("0:v:0");
            assertThat(frame.getArtifactLocalEpoch()).startsWith("artifact-local:");
            assertThat(frame.getFrameWidth()).isEqualTo(frameWidth);
            assertThat(frame.getFrameHeight()).isEqualTo(frameHeight);
            assertThat(frame.getRoi().getX()).isEqualTo(2);
            assertThat(frame.getRoi().getY()).isEqualTo(2);
            assertThat(frame.getRoi().getWidth()).isEqualTo(16);
            assertThat(frame.getRoi().getHeight()).isEqualTo(16);
            assertThat(frame.getFrameSha256()).isEqualTo(expected.originalFrameSha256());
            assertThat(frame.getCropSha256()).isEqualTo(expected.videoFrameBinding().cropSha256());
        } finally {
            rpcChannel.shutdownNow();
            rpcServer.shutdownNow();
        }
    }
}
