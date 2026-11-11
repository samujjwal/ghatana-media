plugins {
    id("java-module")
}

group = "com.ghatana.audio.video"
version = rootProject.version

description = "Audio-Video Common Library - Shared security, observability, and resilience utilities"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(libs.versions.java.get().toInt())
    }
}

dependencies {
    val sharedVersion = providers.gradleProperty("ghatana.shared.version").get()

    // Media processing errors and validation — from libs/java/common
    api(project(":services:media:libs:java:common"))

    // gRPC interceptor API
    api(libs.grpc.stub)
    api(libs.grpc.protobuf)
    implementation(libs.grpc.netty.shaded)
    api(libs.protobuf.java)
    implementation(libs.opentelemetry.api)
    implementation("com.ghatana.platform:security:$sharedVersion")
    implementation("com.ghatana.platform:core:$sharedVersion")

    // JWT validation
    implementation(libs.nimbus.jose.jwt)

    // Jackson for type-safe JSON serialisation in platform clients
    implementation(libs.jackson.databind)
    implementation(libs.networknt.validator)

    // Logging
    implementation(libs.slf4j.api)

    // Testing
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.assertj.core)
    testImplementation(libs.mockito.core)
    testImplementation(libs.mockito.junit.jupiter)
    testImplementation(libs.grpc.inprocess)
    testImplementation(libs.opentelemetry.sdk)
    testImplementation(libs.opentelemetry.sdk.testing)
    testImplementation(libs.micrometer.registry.prometheus)
    testImplementation(libs.log4j.core)
    testRuntimeOnly(libs.log4j.slf4j.impl)
    testRuntimeOnly(libs.junit.jupiter.engine)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.named<Test>("test") {
    useJUnitPlatform()
    dependsOn(tasks.named("jar"))
    // Resolve dependency files at execution time: composite builds may still be
    // evaluating included projects while this task is configured.
    doFirst {
        systemProperty(
            "media.common.consumer.archive",
            tasks.named<Jar>("jar").get().archiveFile.get().asFile.absolutePath,
        )
        // The installed-consumer regression receives only declared runtime artifacts.
        // It must not inherit Gradle's project classes directories.
        systemProperty(
            "media.common.consumer.runtimeClasspath",
            configurations.runtimeClasspath.get().files
                .filter { it.isFile && it.extension == "jar" }
                .joinToString(System.getProperty("path.separator")) { it.absolutePath },
        )
    }
}
