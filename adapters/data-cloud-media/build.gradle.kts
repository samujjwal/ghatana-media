plugins {
    id("java-module")
}

dependencies {
    // Keep Media's modality implementations independently buildable from optional Data Cloud APIs.
    implementation(project(":services:media:modules:speech:stt-service"))
    implementation(project(":services:media:modules:vision:vision-service"))
    implementation(project(":services:media:modules:intelligence:multimodal-service"))

    // Data Cloud contracts remain owned by their source projects and are consumed only here.
    implementation(project(":services:data-cloud:delivery:api"))
    implementation(project(":services:data-cloud:planes:shared-spi"))
    implementation(libs.activej.promise)
    implementation(libs.slf4j.api)

    testImplementation(libs.junit.jupiter)
    testImplementation(libs.mockito.core)
    testImplementation(libs.assertj.core)
    testImplementation(libs.log4j.core)
    testImplementation("com.ghatana.platform:testing:${providers.gradleProperty("ghatana.shared.version").get()}")
    testImplementation("com.ghatana.platform:testing-activej:${providers.gradleProperty("ghatana.shared.version").get()}")
    testRuntimeOnly(libs.junit.jupiter.engine)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    useJUnitPlatform()
}

// Preserve the existing targeted Data Cloud checks at the adapter boundary.
tasks.register<Test>("testDataCloudEventBridge") {
    group = "verification"
    description = "Test Data Cloud event bridge adapter behavior for STT"
    useJUnitPlatform {
        includeTags("datacloud-event-bridge")
    }
    systemProperty("datacloud.event.bridge.test", "true")
}

tasks.register<Test>("testDataCloudJobHandling") {
    group = "verification"
    description = "Test Data Cloud job adapter behavior for Vision"
    useJUnitPlatform {
        includeTags("datacloud-job-handling")
    }
    systemProperty("datacloud.job.handling.test", "true")
}
