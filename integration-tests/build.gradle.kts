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
    testImplementation(project(":services:media:modules:speech:stt-service"))

    // Real launcher + durable-provider wiring for launcher-level end-to-end tests
    testImplementation(project(":services:media:launcher"))
    testImplementation(project(":services:media:runtime-contracts"))
    testImplementation(project(":services:media:providers:aws-postgresql"))

    // Platform testing utilities (EventloopTestBase, etc.)
    testImplementation("com.ghatana.platform:governance:${providers.gradleProperty("ghatana.shared.version").get()}")
    testImplementation("com.ghatana.platform:testing:${providers.gradleProperty("ghatana.shared.version").get()}")
    testImplementation("com.ghatana.platform:testing-activej:${providers.gradleProperty("ghatana.shared.version").get()}")

    // Testcontainers: standard containers (includes core testcontainers with Docker Compose support)
    testImplementation(libs.bundles.testing.containers)
    testImplementation(libs.testcontainers.localstack)
    testImplementation(libs.testcontainers.junit.jupiter)

    // H2 in PostgreSQL compatibility mode backs the durable-store E2E path
    testImplementation(libs.h2)

    // AWS SDK for direct S3 byte verification against LocalStack
    testImplementation(platform(libs.aws.sdk.bom))
    testImplementation(libs.aws.s3)

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

    // The image-gated test conditions inspect these environment-selected images.
    // Keep Gradle's up-to-date checks aligned with that runtime input so changing
    // candidates cannot silently reuse an earlier skip result.
    inputs.property(
        "audioVideoSttImage",
        providers.environmentVariable("AUDIO_VIDEO_STT_IMAGE").orElse("ghatana/stt-service:latest")
    )
    inputs.property(
        "audioVideoTtsImage",
        providers.environmentVariable("AUDIO_VIDEO_TTS_IMAGE").orElse("ghatana/tts-service:latest")
    )

    // Docker tags and daemon availability can change without Gradle inputs
    // changing, so always reevaluate image-gated integration conditions.
    outputs.upToDateWhen { false }
    outputs.cacheIf { false }
}

// A JavaExec host gives the process-boundary fixture an explicit, Gradle-resolved
// runtime classpath. The fixture passes that same path to MediaLauncher children;
// it does not depend on Gradle Test worker classloader internals or nested builds.
val integrationTestRuntimeClasspath = sourceSets.named("test").get().runtimeClasspath
tasks.register<JavaExec>("postgresWorkflowProcessRestart") {
    group = "verification"
    description = "Verify PostgreSQL-backed Media metrics across separate launcher processes"
    dependsOn(tasks.named("testClasses"))
    classpath = integrationTestRuntimeClasspath
    mainClass.set("com.ghatana.media.integration.MediaRuntimePostgresWorkflowMetricsIT")
    doFirst {
        systemProperty("media.child.classpath", integrationTestRuntimeClasspath.asPath)
    }
}

// Test-only module: no compiled main classes exist, so there is no public API surface to verify.
tasks.named("verifyIntentionalPublicApi") {
    onlyIf { layout.buildDirectory.dir("classes/java/main").get().asFile.isDirectory }
}
