rootProject.name = "document-intelligence-java-client"

// Media-consistent dependency versions. The catalog is read from the Media repository when this
// module is built in place; a sources-jar consumer builds with the pinned fallback versions below.
val mediaCatalog = file("../../../../gradle/libs.versions.toml")
dependencyResolutionManagement {
    repositories { mavenCentral() }
    if (mediaCatalog.exists()) {
        versionCatalogs { create("libs") { from(files(mediaCatalog)) } }
    }
}
