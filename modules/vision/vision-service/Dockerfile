# Multi-stage build for the Audio-Video Vision gRPC service.

FROM eclipse-temurin:21-jdk-jammy AS builder

WORKDIR /build

COPY build-logic/ build-logic/
COPY gradle/ gradle/
COPY platform/ platform/
COPY shared-services/ shared-services/
COPY products/audio-video/ products/audio-video/

WORKDIR /build/products/audio-video

RUN ./gradlew :products:audio-video:modules:vision:vision-service:installDist \
    --no-daemon \
    -x test \
    --stacktrace

FROM eclipse-temurin:21-jre-jammy AS runtime

RUN groupadd --gid 1001 vision \
    && useradd --uid 1001 --gid vision --shell /bin/bash --create-home vision

WORKDIR /app

COPY --from=builder /build/products/audio-video/modules/vision/vision-service/build/install/vision-service/ /app/

RUN chown -R vision:vision /app

USER vision

ENV VISION_GRPC_PORT=50054
ENV JAVA_OPTS="-XX:+UseZGC -XX:MaxRAMPercentage=75.0 -XX:+ExitOnOutOfMemoryError -Dfile.encoding=UTF-8"

EXPOSE 50054

ENTRYPOINT ["sh", "-c", "exec /app/bin/vision-service"]