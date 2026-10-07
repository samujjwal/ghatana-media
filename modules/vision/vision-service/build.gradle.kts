import org.gradle.api.artifacts.VersionCatalogsExtension

plugins {
        id("application")
    id("protobuf-module")
    id("jacoco")
}

val libsCatalog = extensions.getByType<VersionCatalogsExtension>().named("libs")


dependencies {
    // Public Kernel Product API. Media owns the OCR model; this module only adapts
    // the model-backed service to the accepted provider contract.
    implementation("com.ghatana.kernel:kernel-product-api:${providers.gradleProperty("ghatana.kernel.version").get()}")

    // Audio-Video common (health/metrics server, gRPC interceptor chain, security)
    implementation(project(":services:media:libs:java:common"))
    implementation(project(":services:media:libs:common"))

    // gRPC
    implementation(libs.grpc.netty.shaded)
    implementation(libs.grpc.protobuf)
    implementation(libs.grpc.stub)

    // Multi-tenancy
    implementation("com.ghatana.platform:governance:${providers.gradleProperty("ghatana.shared.version").get()}")

    // Platform audit (AuditService, AuditEvent)
    implementation("com.ghatana.platform:audit:${providers.gradleProperty("ghatana.shared.version").get()}")

    // Data Cloud integration for media artifact job handling and result schema
    implementation(project(":services:data-cloud:delivery:api"))

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
        languageVersion.set(JavaLanguageVersion.of(21))
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

// Data Cloud job handling test - validates vision service can handle Data Cloud media processing jobs
tasks.register<Test>("testDataCloudJobHandling") {
    group = "verification"
    description = "Test Data Cloud job handling and result schema for vision service"
    useJUnitPlatform {
        includeTags("datacloud-job-handling")
    }
    systemProperty("datacloud.job.handling.test", "true")
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
