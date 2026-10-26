plugins {
    id("base")
}

// Ghatana Media build root (audio-video is a retained compatibility coordinate).
// Build only this product: ./gradlew buildAll (alias for buildFull).
// buildMediaJvm compiles its actual JVM subprojects; buildPnpm restricts pnpm
// work to Media packages and buildCargo builds the declared Rust workspace.

group = "com.ghatana.audio-video"
version = "0.1.0-SNAPSHOT"

// Media consumes the checked-out Shared source composite, whose Java modules now
// require JVM 27. The imported Kernel java-module convention still fixes targets
// to 21 and pins an older Lombok processor, so align only Media Java projects with
// the source-composite toolchain and the version catalog's compatible processor.
val mediaLombokVersion = extensions.getByType(org.gradle.api.artifacts.VersionCatalogsExtension::class.java)
    .named("libs").findVersion("lombok").orElseThrow().requiredVersion
subprojects {
    afterEvaluate {
        val isMediaJavaProject = path.startsWith(":services:media:") || path.startsWith(":media:")
        if (isMediaJavaProject && plugins.hasPlugin("java")) {
            extensions.configure(org.gradle.api.plugins.JavaPluginExtension::class.java) {
                toolchain.languageVersion.set(org.gradle.jvm.toolchain.JavaLanguageVersion.of(27))
                sourceCompatibility = org.gradle.api.JavaVersion.toVersion(27)
                targetCompatibility = org.gradle.api.JavaVersion.toVersion(27)
            }
            dependencies.add("compileOnly", "org.projectlombok:lombok:$mediaLombokVersion")
            dependencies.add("annotationProcessor", "org.projectlombok:lombok:$mediaLombokVersion")
            dependencies.add("testCompileOnly", "org.projectlombok:lombok:$mediaLombokVersion")
            dependencies.add("testAnnotationProcessor", "org.projectlombok:lombok:$mediaLombokVersion")
        }
    }
}

// Compatibility alias: the old buildAll task previously built only the root
// Gradle project while claiming a polyglot build. Delegate to the real aggregate.
tasks.register("buildAll") {
    group = "build"
    description = "Compatibility alias for full local Media build"
    dependsOn("buildFull")
}

// Task to verify pnpm build
tasks.register<Exec>("buildPnpm") {
    group = "build"
    description = "Builds TypeScript/JavaScript components using pnpm"
    // Workspace includes Shared/Tools/Lifecycle siblings for development resolution,
    // but Media's aggregate build must not rebuild unrelated repositories.
    commandLine("pnpm", "--filter", "./apps/**", "--filter", "./libs/**",
        "--filter", "./modules/**", "-r", "build")
    workingDir = projectDir
}

// Task to verify cargo build
tasks.register<Exec>("buildCargo") {
    group = "build"
    description = "Builds Rust components using cargo"
    commandLine("cargo", "build")
    workingDir = projectDir
}

// Build only the real Media JVM child projects, not synthetic namespace
// parents, sibling Data Cloud projects, or imported Shared composite projects.
tasks.register("buildMediaJvm") {
    group = "build"
    description = "Builds Media JVM subprojects with Gradle"
    dependsOn(subprojects
        .filter { (it.path.startsWith(":services:media:") || it.path.startsWith(":media:")) && it.buildFile.isFile }
        .map { "${it.path}:build" })
}

// A full polyglot build is intentionally allowed to fail when any Media
// compilation or installed public dependency fails; no compile/test exclusions.
tasks.register("buildFull") {
    group = "build"
    description = "Builds Media Java, TypeScript and Rust source"
    dependsOn("buildMediaJvm", "buildPnpm", "buildCargo")
}
