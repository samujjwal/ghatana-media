# Multi-stage build for the Audio-Video STT gRPC service.

FROM eclipse-temurin:21-jdk-jammy AS builder

WORKDIR /build

COPY build-logic/ build-logic/
COPY gradle/ gradle/
COPY platform/ platform/
COPY shared-services/ shared-services/
COPY products/audio-video/ products/audio-video/

WORKDIR /build/products/audio-video

RUN ./gradlew :products:audio-video:modules:speech:stt-service:installDist \
    --no-daemon \
    -x test \
    --stacktrace

FROM eclipse-temurin:21-jre-jammy AS runtime

RUN groupadd --gid 1001 stt \
    && useradd --uid 1001 --gid stt --shell /bin/bash --create-home stt

WORKDIR /app

COPY --from=builder /build/products/audio-video/modules/speech/stt-service/build/install/stt-service/ /app/

RUN chown -R stt:stt /app

USER stt

ENV STT_GRPC_PORT=50051
ENV JAVA_OPTS="-XX:+UseZGC -XX:MaxRAMPercentage=75.0 -XX:+ExitOnOutOfMemoryError -Dfile.encoding=UTF-8"

EXPOSE 50051

ENTRYPOINT ["sh", "-c", "exec /app/bin/stt-service"]