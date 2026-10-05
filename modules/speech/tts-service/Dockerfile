# Multi-stage build for the Audio-Video TTS gRPC service.

FROM eclipse-temurin:21-jdk-jammy AS builder

WORKDIR /build

COPY build-logic/ build-logic/
COPY gradle/ gradle/
COPY platform/ platform/
COPY shared-services/ shared-services/
COPY products/audio-video/ products/audio-video/

WORKDIR /build/products/audio-video

RUN ./gradlew :products:audio-video:modules:speech:tts-service:installDist \
    --no-daemon \
    -x test \
    --stacktrace

FROM eclipse-temurin:21-jre-jammy AS runtime

RUN groupadd --gid 1001 tts \
    && useradd --uid 1001 --gid tts --shell /bin/bash --create-home tts

WORKDIR /app

COPY --from=builder /build/products/audio-video/modules/speech/tts-service/build/install/tts-service/ /app/

RUN chown -R tts:tts /app

USER tts

ENV TTS_GRPC_PORT=50052
ENV JAVA_OPTS="-XX:+UseZGC -XX:MaxRAMPercentage=75.0 -XX:+ExitOnOutOfMemoryError -Dfile.encoding=UTF-8"

EXPOSE 50052

ENTRYPOINT ["sh", "-c", "exec /app/bin/tts-service"]