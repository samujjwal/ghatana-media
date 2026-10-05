plugins {
    id("java-application")
    jacoco
}

group = "com.ghatana.services"
version = rootProject.version.toString()
description = "Media Service standalone artifact, job, stream, and processing runtime"

application {
    mainClass.set("com.ghatana.media.launcher.MediaLauncher")
}

dependencies {
    val sharedVersion = providers.gradleProperty("ghatana.shared.version").get()

    implementation(project(":services:media:runtime-contracts"))
    runtimeOnly(project(":services:media:providers:aws-postgresql"))

    implementation(project(":services:media:modules:audio-streaming"))
    implementation(project(":services:media:modules:video-streaming"))
    implementation(project(":services:media:modules:speech:stt-service"))
    implementation(project(":services:media:modules:speech:tts-service"))
    implementation(project(":services:media:modules:vision:vision-service"))
    implementation(project(":services:media:modules:intelligence:multimodal-service"))
    implementation(project(":services:media:modules:infrastructure:messaging"))
    implementation(project(":services:media:modules:infrastructure:persistence"))
    implementation(project(":services:media:modules:infrastructure:cache"))
    implementation(project(":services:media:modules:infrastructure:security"))

    implementation("com.ghatana.platform:core:$sharedVersion")
    implementation("com.ghatana.platform:observability:$sharedVersion")
    implementation("com.ghatana.platform:config:$sharedVersion")
    implementation("com.ghatana.platform:database:$sharedVersion")
    implementation("com.ghatana.platform:security:$sharedVersion")
    implementation("com.ghatana.platform:messaging:$sharedVersion")
    implementation("com.ghatana.platform:contracts:$sharedVersion")

    implementation(libs.activej.promise)
    implementation(libs.bundles.activej.core)
    implementation(libs.activej.common)
    implementation(libs.jackson.databind)
    implementation(libs.slf4j.api)
    implementation(project(":platform:java:launcher-support"))

    compileOnly(libs.jetbrains.annotations)
    compileOnly(libs.lombok)
    annotationProcessor(libs.lombok)

    testImplementation(libs.junit.jupiter)
    testImplementation(libs.junit.jupiter.engine)
    testImplementation(libs.assertj.core)
    testImplementation(libs.mockito.core)
}

tasks.test {
    useJUnitPlatform()
    finalizedBy(tasks.jacocoTestReport)
}

jacoco { toolVersion = libs.versions.jacoco.get() }

tasks.jacocoTestReport {
    dependsOn(tasks.test)
    reports {
        xml.required.set(true)
        html.required.set(true)
        csv.required.set(false)
    }
}

tasks.jacocoTestCoverageVerification {
    dependsOn(tasks.jacocoTestReport)
    violationRules {
        rule {
            limit {
                counter = "INSTRUCTION"
                value = "COVEREDRATIO"
                minimum = "0.60".toBigDecimal()
            }
        }
    }
}

tasks.named("check") { dependsOn(tasks.jacocoTestCoverageVerification) }
