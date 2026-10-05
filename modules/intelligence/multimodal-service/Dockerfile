# Multi-stage build for the Audio-Video Multimodal gRPC service.

FROM eclipse-temurin:21-jdk-jammy AS builder

WORKDIR /build

COPY build-logic/ build-logic/
COPY gradle/ gradle/
COPY platform/ platform/
COPY shared-services/ shared-services/
COPY products/audio-video/ products/audio-video/

WORKDIR /build/products/audio-video

RUN ./gradlew :products:audio-video:modules:intelligence:multimodal-service:installDist \
    --no-daemon \
    -x test \
    --stacktrace

FROM eclipse-temurin:21-jre-jammy AS runtime

RUN groupadd --gid 1001 multimodal \
    && useradd --uid 1001 --gid multimodal --shell /bin/bash --create-home multimodal

WORKDIR /app

COPY --from=builder /build/products/audio-video/modules/intelligence/multimodal-service/build/install/multimodal-service/ /app/

RUN chown -R multimodal:multimodal /app

USER multimodal

ENV MULTIMODAL_GRPC_PORT=50055
ENV JAVA_OPTS="-XX:+UseZGC -XX:MaxRAMPercentage=75.0 -XX:+ExitOnOutOfMemoryError -Dfile.encoding=UTF-8"

EXPOSE 50055

ENTRYPOINT ["sh", "-c", "exec /app/bin/multimodal-service"]