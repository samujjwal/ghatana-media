import org.gradle.api.artifacts.VersionCatalogsExtension

plugins {
        id("application")
    id("protobuf-module")
    id("jacoco")
}

val libsCatalog = extensions.getByType<VersionCatalogsExtension>().named("libs")


dependencies {
    // Audio-Video common library (shared AI inference client, health/metrics, gRPC interceptors)
    implementation(project(":services:media:libs:java:common"))
    implementation(project(":services:media:libs:common"))
    // Direct consumer dependency: the agent sources use the canonical
    // ToolExecutor SPI rather than relying on transitive exposure by common.
    implementation("com.ghatana.platform:tool-runtime:${providers.gradleProperty("ghatana.tools.version").get()}")

    // Agent contracts plus reusable provider-neutral runtime base implementations.
    implementation("com.ghatana.platform:agent-core:${providers.gradleProperty("ghatana.shared.version").get()}")
    implementation("com.ghatana.platform:agent-runtime:${providers.gradleProperty("ghatana.shared.version").get()}")

    // Reuse the existing product video frame extraction utility instead of re-implementing it
    implementation(project(":services:media:modules:vision:vision-service"))

    // Persistence integration
    implementation(project(":services:media:modules:infrastructure:persistence"))

    // STT Service proto stubs for gRPC client
    implementation(project(":services:media:modules:speech:stt-service"))

    // gRPC
    implementation(libs.grpc.netty.shaded)
    implementation(libs.grpc.protobuf)
    implementation(libs.grpc.stub)

    // Multi-tenancy
    implementation("com.ghatana.platform:governance:${providers.gradleProperty("ghatana.shared.version").get()}")

    // Platform security (JWT, RBAC, User model)
    implementation("com.ghatana.platform:security:${providers.gradleProperty("ghatana.shared.version").get()}")
    implementation("com.ghatana.platform:messaging:${providers.gradleProperty("ghatana.shared.version").get()}")

    // Platform observability (MetricsCollector, TracingManager)
    implementation("com.ghatana.platform:observability:${providers.gradleProperty("ghatana.shared.version").get()}")

    // Platform audit (AuditService, AuditEvent)
    implementation("com.ghatana.platform:audit:${providers.gradleProperty("ghatana.shared.version").get()}")

    // Data Cloud integration for media artifact job handling
    implementation(project(":services:data-cloud:delivery:api"))
    implementation(project(":services:data-cloud:planes:shared-spi"))

    // Protobuf
    implementation(libs.protobuf.java)

    // javax.annotation for gRPC generated code
    implementation(libs.javax.inject)

    // Logging
    implementation(libs.log4j.core)
    implementation(libs.log4j.api)
    implementation(libs.slf4j.api)
    implementation(libs.log4j.slf4j.impl)

    // JSON processing

    // Jackson
    implementation(libs.jackson.databind)
    // Micrometer metrics
    implementation(libs.micrometer.core)

    // OpenTelemetry for tracing
    implementation(libs.opentelemetry.api)

    // Testing
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.mockito.core)
    testImplementation(libs.mockito.junit.jupiter)
    testImplementation("com.ghatana.platform:testing:${providers.gradleProperty("ghatana.shared.version").get()}")
    testImplementation("com.ghatana.platform:testing-activej:${providers.gradleProperty("ghatana.shared.version").get()}")
    testRuntimeOnly(libs.junit.jupiter.engine)
    testRuntimeOnly(libs.junit.platform.launcher)
}

application {
    mainClass.set("com.ghatana.audio.video.multimodal.grpc.MultimodalGrpcServer")
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}


tasks.test {
    useJUnitPlatform()
}

val multimodalPort = System.getenv("MULTIMODAL_GRPC_PORT") ?: "50055"

tasks.register<JavaExec>("runMultimodalService") {
    group = "application"
    description = "Run the Multimodal gRPC service"
    classpath = sourceSets["main"].runtimeClasspath
    mainClass.set("com.ghatana.audio.video.multimodal.grpc.MultimodalGrpcServer")
    environment("MULTIMODAL_GRPC_PORT", multimodalPort)
}

// Fix duplicate jar entries in distribution
tasks.named<Tar>("distTar") {
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
}
tasks.named<Zip>("distZip") {
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
}
tasks.named<Sync>("installDist") {
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
}

// AV-P0-003: Smoke test that validates the mainClass is resolvable on the runtime classpath.
tasks.register<JavaExec>("smokeTestMainClass") {
    group = "verification"
    description = "AV-P0-003: Verify mainClass 'com.ghatana.audio.video.multimodal.grpc.MultimodalGrpcServer' is resolvable on the runtime classpath."
    classpath = sourceSets["main"].runtimeClasspath
    mainClass.set("com.ghatana.audio.video.multimodal.grpc.MultimodalGrpcServer")
    systemProperty("av.smokeTest", "true")
    isIgnoreExitValue = false
    jvmArgs("-Dav.smokeTest=true")
}
