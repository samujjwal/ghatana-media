/**
 * Audio-Video Observability Module
 *
 * Provides gRPC health checking, distributed tracing instrumentation,
 * and structured observability for Audio-Video microservices.
 */
plugins {
    id("java-module")
}

description = "Audio-Video Observability — health, tracing, and instrumentation"

dependencies {
    api(project(":services:media:libs:common"))
    implementation("com.ghatana.platform:observability:${providers.gradleProperty("ghatana.shared.version").get()}")

    // gRPC health protocol
    implementation(libs.grpc.services)
    implementation(libs.grpc.stub)
    implementation(libs.grpc.protobuf)
    implementation(libs.slf4j.api)
    implementation(libs.opentelemetry.api)
    implementation(libs.micrometer.core)

    testImplementation(libs.junit.jupiter)
    testImplementation(libs.junit.jupiter.engine)
    testImplementation(libs.mockito.core)
    testImplementation(libs.mockito.junit.jupiter)
    testImplementation(libs.assertj.core)
    testImplementation(libs.grpc.inprocess)
    testImplementation(libs.micrometer.registry.prometheus)
    testRuntimeOnly(libs.log4j.slf4j.impl)
}

// A deterministic local exporter used by infra/monitoring's opt-in delivery smoke.
// It exercises MediaWorkflowMetrics' actual Prometheus registry/export path while
// keeping the provider observation explicitly synthetic and test-only.
tasks.register<JavaExec>("runAlertDeliveryExporterFixture") {
    group = "verification"
    description = "Run the deterministic Media metrics exporter fixture for alert delivery smoke tests."
    classpath = sourceSets.test.get().runtimeClasspath
    mainClass.set("com.ghatana.audiovideo.observability.MediaAlertDeliveryExporterFixture")
}



