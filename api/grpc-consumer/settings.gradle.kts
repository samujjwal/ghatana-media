pluginManagement {
    repositories { gradlePluginPortal(); mavenCentral() }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        val grpcApiRepo = providers.gradleProperty("grpcApiRepo").orNull
            ?: error("Pass -PgrpcApiRepo=<isolated Maven repository path>")
        maven {
            name = "isolatedMediaGrpcApi"
            url = uri(grpcApiRepo)
            content { includeGroup("com.ghatana.audio-video") }
        }
        mavenCentral {
            content { excludeGroup("com.ghatana.audio-video") }
        }
    }
}

rootProject.name = "media-grpc-api-installed-consumer"
