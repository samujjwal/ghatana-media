import org.gradle.api.artifacts.VersionCatalogsExtension

plugins {
        id("application")
    id("protobuf-module")
    id("jacoco")
}

val libsCatalog = extensions.getByType<VersionCatalogsExtension>().named("libs")


dependencies {
    // Audio-Video common library — TtsEngine, SttEngine, VisionEngine, media types, security interceptors
    implementation(project(":services:media:libs:java:common"))
    implementation(project(":services:media:libs:common"))

    // gRPC
    implementation(libs.grpc.netty.shaded)
    implementation(libs.grpc.protobuf)
    implementation(libs.grpc.stub)

    // Multi-tenancy
    implementation("com.ghatana.platform:governance:${providers.gradleProperty("ghatana.shared.version").get()}")

    // Platform security (JWT, RBAC, User model)
    implementation("com.ghatana.platform:security:${providers.gradleProperty("ghatana.shared.version").get()}")

    // Platform observability (MetricsCollector, TracingManager)
    implementation("com.ghatana.platform:observability:${providers.gradleProperty("ghatana.shared.version").get()}")

    // Platform audit (AuditService, AuditEvent)
    implementation("com.ghatana.platform:audit:${providers.gradleProperty("ghatana.shared.version").get()}")

    // Persistence layer
    implementation(project(":services:media:modules:infrastructure:persistence"))

    // Protobuf
    implementation(libs.protobuf.java)

    // javax.annotation for gRPC generated code
    implementation(libs.javax.inject)

    // Logging
    implementation(libs.log4j.core)
    implementation(libs.log4j.api)

    // JSON processing

    // SLF4J
    implementation(libs.slf4j.api)

    // Jackson
    implementation(libs.jackson.databind)
    // Micrometer metrics
    implementation(libs.micrometer.core)

    // OpenTelemetry for tracing
    implementation(libs.opentelemetry.api)

    // Testing
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.platform.launcher)
    testImplementation(libs.mockito.core)
    testImplementation(libs.mockito.junit.jupiter)
    testImplementation(libs.assertj.core)
}

application {
    mainClass.set("com.ghatana.tts.grpc.TtsGrpcServer")
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}


tasks.test {
    useJUnitPlatform()
}

// Environment variables for service
val ttsPort = System.getenv("TTS_GRPC_PORT") ?: "50052"

tasks.register<JavaExec>("runTtsService") {
    group = "application"
    description = "Run the TTS gRPC service"
    classpath = sourceSets["main"].runtimeClasspath
    mainClass.set("com.ghatana.tts.grpc.TtsGrpcServer")
    environment("TTS_GRPC_PORT", ttsPort)
}

// AV-P0-003: Smoke test that validates the mainClass is resolvable on the runtime classpath.
tasks.register<JavaExec>("smokeTestMainClass") {
    group = "verification"
    description = "AV-P0-003: Verify mainClass 'com.ghatana.tts.grpc.TtsGrpcServer' is resolvable on the runtime classpath."
    classpath = sourceSets["main"].runtimeClasspath
    mainClass.set("com.ghatana.tts.grpc.TtsGrpcServer")
    systemProperty("av.smokeTest", "true")
    isIgnoreExitValue = false
    jvmArgs("-Dav.smokeTest=true")
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
