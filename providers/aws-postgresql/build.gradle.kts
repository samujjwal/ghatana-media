plugins {
    id("java-module")
    alias(libs.plugins.spotbugs)
}

group = "com.ghatana.media"
version = rootProject.version

description = "Media Runtime S3 artifact and PostgreSQL state providers"

java {
    toolchain { languageVersion.set(JavaLanguageVersion.of(21)) }
}

dependencies {
    val sharedVersion = providers.gradleProperty("ghatana.shared.version").get()

    api(project(":services:media:runtime-contracts"))
    implementation(project(":platform:java:launcher-support"))
    implementation(platform(libs.jackson.bom))
    implementation(libs.jackson.databind)
    implementation(libs.hikaricp)
    implementation(libs.flyway.core)
    implementation(libs.flyway.postgresql)
    implementation(platform(libs.aws.sdk.bom))
    implementation(libs.aws.s3)
    runtimeOnly(libs.postgresql)

    testImplementation(libs.junit.jupiter)
    testImplementation(libs.assertj.core)
    testImplementation(libs.h2)
    testImplementation(libs.testcontainers.postgresql)
    testImplementation(libs.testcontainers.localstack)
    testImplementation(libs.testcontainers.junit.jupiter)
    testRuntimeOnly(libs.junit.jupiter.engine)
}

tasks.test { useJUnitPlatform() }

spotbugs {
    toolVersion.set("4.8.6")
    ignoreFailures.set(false)
    effort.set(com.github.spotbugs.snom.Effort.MAX)
    reportLevel.set(com.github.spotbugs.snom.Confidence.MEDIUM)
    excludeFilter.set(rootProject.file("config/spotbugs/spotbugs-exclude.xml"))
}
