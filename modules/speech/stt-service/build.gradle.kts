import org.gradle.api.artifacts.VersionCatalogsExtension

plugins {
        id("application")
    id("protobuf-module")
    id("jacoco")
}

val libsCatalog = extensions.getByType<VersionCatalogsExtension>().named("libs")


dependencies {
    // Audio-Video common library — SttEngine, TtsEngine, media types, security interceptors
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

    // Data Cloud integration for media artifact operations
    implementation(project(":services:data-cloud:delivery:api"))

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
    mainClass.set("com.ghatana.stt.grpc.SttGrpcServer")
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
val sttPort = System.getenv("STT_GRPC_PORT") ?: "50051"

tasks.register<JavaExec>("runSttService") {
    group = "application"
    description = "Run the STT gRPC service"
    classpath = sourceSets["main"].runtimeClasspath
    mainClass.set("com.ghatana.stt.grpc.SttGrpcServer")
    environment("STT_GRPC_PORT", sttPort)
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
// Runs the JVM with -cp and -noverify-style class loading check via Class.forName in dry-run mode.
// This task is intended for CI verification and will fail if the mainClass is wrong or missing.
tasks.register<JavaExec>("smokeTestMainClass") {
    group = "verification"
    description = "AV-P0-003: Verify mainClass 'com.ghatana.stt.grpc.SttGrpcServer' is resolvable on the runtime classpath."
    classpath = sourceSets["main"].runtimeClasspath
    mainClass.set("com.ghatana.stt.grpc.SttGrpcServer")
    // Pass a smoke-check system property so the server main() can detect dry-run mode and exit cleanly
    systemProperty("av.smokeTest", "true")
    // Fail-fast: treat non-zero exit as a build error
    isIgnoreExitValue = false
    jvmArgs("-Dav.smokeTest=true")
}

// Data Cloud event bridge test - validates STT service can consume Data Cloud media events
tasks.register<Test>("testDataCloudEventBridge") {
    group = "verification"
    description = "Test Data Cloud event bridge integration for STT service"
    useJUnitPlatform {
        includeTags("datacloud-event-bridge")
    }
    systemProperty("datacloud.event.bridge.test", "true")
}
