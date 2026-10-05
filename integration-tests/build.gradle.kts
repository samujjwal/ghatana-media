/*
 * Build file for audio-video integration-tests module.
 *
 * This module runs end-to-end integration tests for the audio-video product
 * suite. Tests are gated by the `integration` tag and require Docker for
 * Testcontainers-based container orchestration (gated by GH-90000 until the
 * real service images are available).
 */
plugins {
    id("java-module")
}

group = "com.ghatana.audio-video"
version = rootProject.version

description = "Audio-Video end-to-end integration tests (STT, TTS, multi-service workflows)"

dependencies {
    // Runtime helpers shared across audio-video Java modules
    testImplementation(project(":services:media:libs:java:common"))

    // Platform testing utilities (EventloopTestBase, etc.)
    testImplementation("com.ghatana.platform:testing:${providers.gradleProperty("ghatana.shared.version").get()}")
    testImplementation("com.ghatana.platform:testing-activej:${providers.gradleProperty("ghatana.shared.version").get()}")

    // Testcontainers: standard containers (includes core testcontainers with Docker Compose support)
    testImplementation(libs.bundles.testing.containers)

    // JUnit + AssertJ
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.assertj.core)
    testImplementation(libs.mockito.junit.jupiter)

    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    // Only run integration tests when explicitly requested (require Docker)
    useJUnitPlatform {
        includeTags("integration")
    }
}
