plugins {
    id("java-module")
}

group = "com.ghatana.media"
version = rootProject.version

description = "Media Runtime artifact, job, stream, and provider contracts"

java {
    toolchain { languageVersion.set(JavaLanguageVersion.of(libs.versions.java.get().toInt())) }
}

dependencies {
    // Validate versioned PDP JSON Schemas at the effect-free H-02 compile boundary.
    implementation(libs.jackson.databind)
    implementation(libs.networknt.validator)
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.assertj.core)
    testRuntimeOnly(libs.junit.jupiter.engine)
}

tasks.test {
    useJUnitPlatform()
    dependsOn(tasks.jar)

    doFirst {
        val runtimeDependencyJars = configurations.runtimeClasspath.get().files
            .filter { it.isFile && it.extension.equals("jar", ignoreCase = true) }
            .map { it.canonicalPath }
            .distinct()
            .sorted()

        systemProperty(
            "media.public.events.consumer.archive",
            tasks.jar.get().archiveFile.get().asFile.canonicalPath
        )
        systemProperty(
            "media.public.events.consumer.runtimeClasspath",
            runtimeDependencyJars.joinToString(File.pathSeparator)
        )
    }
}
