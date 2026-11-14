import org.gradle.jvm.application.tasks.CreateStartScripts
import java.util.zip.ZipFile

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

// The modality server is part of the launcher distribution so its ServiceLoader lookup
// sees ComposedMediaRuntimePortFactory without introducing a launcher -> Vision cycle.
val visionStartScripts = tasks.register<CreateStartScripts>("visionStartScripts") {
    applicationName = "vision-service"
    mainClass.set("com.ghatana.audio.video.vision.grpc.VisionGrpcServer")
    outputDir = layout.buildDirectory.dir("vision-start-scripts").get().asFile
    classpath = files(tasks.named<Jar>("jar").map { it.archiveFile }, configurations.runtimeClasspath)
}

distributions {
    main {
        contents {
            from(visionStartScripts) { into("bin") }
        }
    }
}

val verifyVisionDistributionEntryPoint = tasks.register("verifyVisionDistributionEntryPoint") {
    group = "verification"
    description = "Verifies the packaged Vision script carries the canonical runtime factory."
    dependsOn(visionStartScripts, tasks.named<Jar>("jar"))
    doLast {
        val outputDir = visionStartScripts.get().outputDir ?: error("Vision start script output directory is unset")
        val script = outputDir.resolve("vision-service")
        check(script.isFile) { "Vision start script was not generated: $script" }
        check(script.readText().contains("\$APP_HOME/lib/launcher-${project.version}.jar")) {
            "Vision start script is missing the launcher JAR from its classpath"
        }
        val jarFile = tasks.named<Jar>("jar").get().archiveFile.get().asFile
        ZipFile(jarFile).use { archive ->
            val descriptor = archive.getEntry("META-INF/services/com.ghatana.media.runtime.MediaRuntimePortFactory")
                ?: error("Launcher JAR is missing the MediaRuntimePortFactory service descriptor")
            val implementation = archive.getInputStream(descriptor).bufferedReader().use { it.readText() }
            check(implementation.lines().any { it.trim() == "com.ghatana.media.launcher.ComposedMediaRuntimePortFactory" }) {
                "Launcher JAR does not register the canonical MediaRuntimePortFactory"
            }
        }
    }
}

tasks.named("installDist") { dependsOn(verifyVisionDistributionEntryPoint) }

dependencies {
    val sharedVersion = providers.gradleProperty("ghatana.shared.version").get()

    implementation(project(":services:media:runtime-contracts"))
    implementation(project(":services:media:modules:production:timeline"))
    implementation(project(":services:media:modules:production:delivery"))
    implementation(project(":services:media:modules:production:animation"))
    implementation(project(":services:media:modules:production:rendering"))
    implementation(project(":services:media:modules:production:review"))
    implementation(project(":services:media:modules:production:audio-mixing"))
    implementation(project(":services:media:modules:production:simulation"))
    implementation(project(":services:media:modules:production:spatial"))
    implementation(project(":services:media:audio-video-observability"))
    runtimeOnly(project(":services:media:providers:aws-postgresql"))

    implementation(project(":services:media:modules:audio-streaming"))
    implementation(project(":services:media:modules:video-streaming"))
    implementation(project(":services:media:modules:speech:stt-service"))
    implementation(project(":services:media:libs:java:common"))
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
    implementation(libs.micrometer.registry.prometheus)
    implementation(project(":platform:java:launcher-support"))

    compileOnly(libs.jetbrains.annotations)
    compileOnly(libs.lombok)
    annotationProcessor(libs.lombok)

    testImplementation(libs.junit.jupiter)
    testImplementation(libs.junit.jupiter.engine)
    testRuntimeOnly(libs.junit.platform.launcher)
    testImplementation(libs.assertj.core)
    testImplementation(libs.mockito.core)
    testImplementation(libs.jackson.dataformat.yaml)
    testImplementation(project(":services:media:providers:aws-postgresql"))
    testImplementation(platform(libs.aws.sdk.bom))
    testImplementation(libs.aws.s3)
    testImplementation(libs.testcontainers.postgresql)
    testImplementation(libs.testcontainers.localstack)
    testImplementation(libs.testcontainers.junit.jupiter)
}

tasks.test {
    useJUnitPlatform()
    doFirst {
        systemProperty("media.child.classpath", sourceSets.test.get().runtimeClasspath.asPath)
    }
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
