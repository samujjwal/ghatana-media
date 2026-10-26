plugins {
    id("java-module")
}

dependencies {
    // OCR remains a Media-facing port; the optional Kernel bridge lives here.
    implementation(project(":services:media:modules:vision:vision-service"))
    implementation("com.ghatana.kernel:kernel-product-api:${providers.gradleProperty("ghatana.kernel.version").get()}")

    testImplementation(libs.junit.jupiter)
    testImplementation(libs.assertj.core)
    testRuntimeOnly(libs.junit.jupiter.engine)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    useJUnitPlatform()
}
