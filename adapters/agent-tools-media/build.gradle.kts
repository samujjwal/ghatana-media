plugins {
    id("java-module")
}

dependencies {
    // Optional integration boundary: keep canonical Tool SPI adapters out of core modality libraries.
    implementation(project(":services:media:libs:common"))
    implementation(project(":services:media:modules:intelligence:multimodal-service"))
    implementation("com.ghatana.platform:tool-runtime:${providers.gradleProperty("ghatana.tools.version").get()}")
    implementation(libs.networknt.validator)

    // The moved agent wrappers use Shared's agent contracts/runtime directly.
    implementation("com.ghatana.platform:agent-core:${providers.gradleProperty("ghatana.shared.version").get()}")
    implementation("com.ghatana.platform:agent-runtime:${providers.gradleProperty("ghatana.shared.version").get()}")

    testImplementation(libs.junit.jupiter)
    testImplementation(libs.assertj.core)
    testImplementation(libs.mockito.core)
    testImplementation(libs.mockito.junit.jupiter)
    testImplementation("com.ghatana.platform:tool-test-support:${providers.gradleProperty("ghatana.tools.version").get()}")
    testImplementation("com.ghatana.platform:testing-activej:${providers.gradleProperty("ghatana.shared.version").get()}")
    testRuntimeOnly(libs.junit.jupiter.engine)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    useJUnitPlatform()
}
