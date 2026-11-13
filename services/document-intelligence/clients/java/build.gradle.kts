plugins {
    `java-library`
    `maven-publish`
}

// Independently versioned, source-free transport for the frozen document-intelligence.v1 contract.
// Coordinates a Kernel/consumer binds to: dev.ghatana.documentintelligence:document-intelligence-java-client
group = "dev.ghatana.documentintelligence"
version = "0.1.0-SNAPSHOT"
val contractVersion = "document-intelligence.v1"

val catalog = extensions.findByType<VersionCatalogsExtension>()?.find("libs")?.orElse(null)
fun pinned(alias: String, fallbackModule: String, fallbackVersion: String): Any =
    catalog?.findLibrary(alias)?.orElse(null)?.map { it as Any }?.get() ?: "$fallbackModule:$fallbackVersion"

dependencies {
    implementation(pinned("jackson-databind", "tools.jackson.core:jackson-databind", "3.2.2"))
    testImplementation(pinned("junit-jupiter", "org.junit.jupiter:junit-jupiter", "6.1.3"))
    testRuntimeOnly(pinned("junit-platform-launcher", "org.junit.platform:junit-platform-launcher", "6.1.3"))
}

java {
    toolchain { languageVersion.set(JavaLanguageVersion.of(21)) }
    withSourcesJar()
}

tasks.jar {
    manifest {
        attributes(
            "Implementation-Title" to "document-intelligence-java-client",
            "Implementation-Version" to project.version,
            "Automatic-Module-Name" to "dev.ghatana.documentintelligence.client",
            "Ghatana-Contract-Version" to contractVersion,
        )
    }
}

tasks.test { useJUnitPlatform() }

publishing {
    publications {
        create<MavenPublication>("client") {
            artifactId = "document-intelligence-java-client"
            from(components["java"])
        }
    }
    // Local-file channel used by scripts/package-media-install-set.mjs (-PmediaInstallRepository=<dir>).
    findProperty("mediaInstallRepository")?.toString()?.takeIf { it.isNotBlank() }?.let { dir ->
        repositories { maven { name = "mediaInstall"; url = uri(file(dir)) } }
    }
}
