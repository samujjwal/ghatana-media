plugins {
    id("java-module")
}

group = "com.ghatana.media"
version = rootProject.version

description = "Media Runtime artifact, job, stream, and provider contracts"

java {
    toolchain { languageVersion.set(JavaLanguageVersion.of(21)) }
}

dependencies {
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.assertj.core)
    testRuntimeOnly(libs.junit.jupiter.engine)
}

tasks.test { useJUnitPlatform() }
