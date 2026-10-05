/*
 * Audio-Video Common Library Module - Build Configuration
 *
 * Migrated from platform:java:audio-video per Phase 3.1 of the audit.
 * Provides shared audio-video processing capabilities (STT, TTS, Vision).
 *
 * @doc.type module
 * @doc.purpose Shared audio-video processing utilities
 * @doc.layer product
 * @doc.pattern Library
 */

plugins {
    id("java-module")
}

group = "com.ghatana.audio-video"
version = rootProject.version

description = "Audio-Video Common Library - STT, TTS, and Vision engine APIs and ONNX implementations"

dependencies {
    // Error hierarchy and resilience primitives used by the engine decorators.
    api("com.ghatana.platform:core:${providers.gradleProperty("ghatana.shared.version").get()}")
    api("com.ghatana.platform:contracts:${providers.gradleProperty("ghatana.shared.version").get()}")
    api(libs.activej.promise)
    api(libs.activej.eventloop)
    api(libs.activej.http)

    // ONNX runtime for ML models
    implementation(libs.onnx.runtime)

    // HTTP adapters serialize request/response payloads with Jackson.
    implementation(libs.jackson.databind)

    // Logging
    implementation(libs.slf4j.api)

    // Testing
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.mockito.core)
    testImplementation(libs.mockito.junit.jupiter)
    testImplementation(libs.assertj.core)
    testImplementation("com.ghatana.platform:testing:${providers.gradleProperty("ghatana.shared.version").get()}")

    compileOnly(libs.lombok)
    annotationProcessor(libs.lombok)
    testCompileOnly(libs.lombok)
    testAnnotationProcessor(libs.lombok)
}

tasks.test {
    useJUnitPlatform()
    maxParallelForks = 4
}
