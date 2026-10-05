plugins {
    id("java-module")
}

group = "com.ghatana.audio.video"
version = rootProject.version

description = "Audio-Video Common Library - Shared security, observability, and resilience utilities"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

dependencies {
    val sharedVersion = providers.gradleProperty("ghatana.shared.version").get()
    val toolsVersion = providers.gradleProperty("ghatana.tools.version").get()

    // Media processing errors and validation — from libs/java/common
    api(project(":services:media:libs:java:common"))

    // Tool handler SPI — owned and published by ghatana-tools.
    api("com.ghatana.platform:tool-runtime:$toolsVersion")

    // gRPC interceptor API
    api(libs.grpc.stub)
    api(libs.grpc.protobuf)
    api(libs.protobuf.java)
    implementation("com.ghatana.platform:security:$sharedVersion")
    implementation("com.ghatana.platform:core:$sharedVersion")

    // JWT validation
    implementation(libs.nimbus.jose.jwt)

    // Jackson for type-safe JSON serialisation in platform clients
    implementation(libs.jackson.databind)

    // Logging
    implementation(libs.slf4j.api)

    // Testing
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.assertj.core)
    testImplementation(libs.mockito.core)
    testImplementation(libs.mockito.junit.jupiter)
    testRuntimeOnly(libs.log4j.slf4j.impl)
    testRuntimeOnly(libs.junit.jupiter.engine)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.named<Test>("test") {
    useJUnitPlatform()
}
