plugins {
    id("java-module")
}

dependencies {
    testImplementation(project(":services:media:libs:java:common"))
    testImplementation(project(":services:media:libs:common"))
    testImplementation(project(":services:media:modules:speech:stt-service"))
    testImplementation(project(":services:media:modules:speech:tts-service"))
    testImplementation(project(":services:media:modules:vision:vision-service"))
    testImplementation(project(":services:media:modules:intelligence:multimodal-service"))
    testImplementation(project(":services:media:modules:infrastructure:persistence"))
    testImplementation(project(":integration-tests:service-contract-test-utils"))

    testImplementation("com.ghatana.platform:testing:${providers.gradleProperty("ghatana.shared.version").get()}")
    testImplementation("com.ghatana.platform:testing-activej:${providers.gradleProperty("ghatana.shared.version").get()}")

    testImplementation(libs.junit.jupiter)
    testImplementation(libs.mockito.core)
    testImplementation(libs.mockito.junit.jupiter)
    testImplementation(libs.assertj.core)

    testImplementation(libs.grpc.netty.shaded)
    testImplementation(libs.grpc.protobuf)
    testImplementation(libs.grpc.stub)
    testImplementation("io.grpc:grpc-inprocess:${libs.versions.grpc.get()}")
    testImplementation("io.grpc:grpc-testing:${libs.versions.grpc.get()}")
    testImplementation(libs.protobuf.java)
    testImplementation(libs.nimbus.jose.jwt)
    testImplementation(libs.micrometer.core)
}

tasks.test {
    useJUnitPlatform()

    // Keep integration-style names visible to CI even under the default test task.
    include("**/*Test.class", "**/*IT.class", "**/*E2ETest.class")
}

