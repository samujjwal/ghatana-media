/**
 * Audio-Video Observability Module
 *
 * Provides gRPC health checking, distributed tracing instrumentation,
 * and structured observability for Audio-Video microservices.
 */
plugins {
    id("java-module")
}

description = "Audio-Video Observability — health, tracing, and instrumentation"

dependencies {
    implementation("com.ghatana.platform:observability:${providers.gradleProperty("ghatana.shared.version").get()}")

    // gRPC health protocol
    implementation(libs.grpc.services)
    implementation(libs.grpc.stub)
    implementation(libs.grpc.protobuf)
    implementation(libs.slf4j.api)
    implementation(libs.opentelemetry.api)

    testImplementation(libs.junit.jupiter)
    testImplementation(libs.junit.jupiter.engine)
    testImplementation(libs.mockito.core)
    testImplementation(libs.mockito.junit.jupiter)
    testImplementation(libs.assertj.core)
    testImplementation(libs.grpc.inprocess)
    testRuntimeOnly(libs.log4j.slf4j.impl)
}



