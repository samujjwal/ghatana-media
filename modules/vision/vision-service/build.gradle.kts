import org.gradle.api.artifacts.VersionCatalogsExtension

plugins {
        id("application")
    id("protobuf-module")
    id("jacoco")
}

val libsCatalog = extensions.getByType<VersionCatalogsExtension>().named("libs")


dependencies {
    implementation(project(":services:media:runtime-contracts"))
    // Audio-Video common (health/metrics server, gRPC interceptor chain, security)
    implementation(project(":services:media:libs:java:common"))
    implementation(project(":services:media:libs:common"))
    implementation(project(":services:media:audio-video-observability"))
    implementation(libs.opentelemetry.api)

    // gRPC
    implementation(libs.grpc.netty.shaded)
    implementation(libs.grpc.services)
    implementation(libs.grpc.protobuf)
    implementation(libs.grpc.stub)

    // Multi-tenancy
    implementation("com.ghatana.platform:governance:${providers.gradleProperty("ghatana.shared.version").get()}")

    // Metrics and provider-boundary observability are direct Vision API dependencies;
    // they were previously supplied transitively by the optional Kernel OCR adapter.
    implementation("com.ghatana.platform:observability:${providers.gradleProperty("ghatana.shared.version").get()}")
    implementation(libs.micrometer.core)

    // Platform audit (AuditService, AuditEvent)
    implementation("com.ghatana.platform:audit:${providers.gradleProperty("ghatana.shared.version").get()}")

    // Persistence integration
    implementation(project(":services:media:modules:infrastructure:persistence"))

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

    // Jackson annotations
    implementation(libs.jackson.annotations)

    // OpenCV for computer vision
    implementation(libs.opencv)
    implementation(libs.native.lib.loader)

    // Testing
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.grpc.inprocess)
    testImplementation(libs.opentelemetry.sdk)
    testImplementation(libs.opentelemetry.sdk.testing)
    testImplementation(libs.mockito.core)
    testImplementation(libs.mockito.junit.jupiter)
    testImplementation("com.ghatana.platform:testing:${providers.gradleProperty("ghatana.shared.version").get()}")
    testImplementation("com.ghatana.platform:testing-activej:${providers.gradleProperty("ghatana.shared.version").get()}")
}

application {
    mainClass.set("com.ghatana.audio.video.vision.grpc.VisionGrpcServer")
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(libs.versions.java.get().toInt()))
    }
}


tasks.test {
    useJUnitPlatform()
}

val visionPort = System.getenv("VISION_GRPC_PORT") ?: "50054"

tasks.register<JavaExec>("runVisionService") {
    group = "application"
    description = "Run the Vision gRPC service"
    classpath = sourceSets["main"].runtimeClasspath
    mainClass.set("com.ghatana.audio.video.vision.grpc.VisionGrpcServer")
    environment("VISION_GRPC_PORT", visionPort)
}

// AV-P0-003: Smoke test that validates the mainClass is resolvable on the runtime classpath.
tasks.register<JavaExec>("smokeTestMainClass") {
    group = "verification"
    description = "AV-P0-003: Verify mainClass 'com.ghatana.audio.video.vision.grpc.VisionGrpcServer' is resolvable on the runtime classpath."
    classpath = sourceSets["main"].runtimeClasspath
    mainClass.set("com.ghatana.audio.video.vision.grpc.VisionGrpcServer")
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
