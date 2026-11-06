plugins {
    id("java-module")
    alias(libs.plugins.spotbugs)
}

group = "com.ghatana.media"
version = rootProject.version

description = "Media Runtime S3 artifact and PostgreSQL state providers"

java {
    toolchain { languageVersion.set(JavaLanguageVersion.of(libs.versions.java.get().toInt())) }
}

dependencies {
    val sharedVersion = providers.gradleProperty("ghatana.shared.version").get()

    api(project(":services:media:runtime-contracts"))
    implementation(project(":services:media:modules:production:delivery"))
    implementation("com.ghatana.platform:core:$sharedVersion")
    implementation("com.ghatana.platform:messaging:$sharedVersion")
    implementation("com.ghatana.platform:governance:$sharedVersion")
    implementation("com.ghatana.platform:security:$sharedVersion")
    implementation(project(":platform:java:launcher-support"))
    implementation(platform(libs.jackson.bom))
    implementation(libs.jackson.databind)
    implementation(libs.hikaricp)
    implementation(libs.flyway.core)
    implementation(libs.flyway.postgresql)
    implementation(platform(libs.aws.sdk.bom))
    implementation(libs.aws.s3)
    implementation(libs.postgresql)

    testImplementation(libs.junit.jupiter)
    testImplementation(libs.assertj.core)
    testImplementation(project(":services:media:modules:production:timeline"))
    testImplementation(libs.h2)
    testImplementation(libs.testcontainers.postgresql)
    testImplementation(libs.testcontainers.localstack)
    testImplementation(libs.testcontainers.junit.jupiter)
    testRuntimeOnly(libs.junit.jupiter.engine)
}

val providerTestRuntimeClasspath = sourceSets.named("test").get().runtimeClasspath
tasks.test {
    useJUnitPlatform()
    // The IP-06 process-crash test launches a separate JVM and passes the exact test runtime
    // classpath explicitly instead of depending on Gradle Test worker classloader internals.
    doFirst { systemProperty("media.child.classpath", providerTestRuntimeClasspath.asPath) }
}

spotbugs {
    toolVersion.set("4.8.6")
    ignoreFailures.set(false)
    effort.set(com.github.spotbugs.snom.Effort.MAX)
    reportLevel.set(com.github.spotbugs.snom.Confidence.MEDIUM)
    excludeFilter.set(rootProject.file("config/spotbugs/spotbugs-exclude.xml"))
}
