plugins {
    id("base")
}

// Audio-Video Product Root
// This build file coordinates the polyglot build system:
// - Java/Gradle: ./gradlew build
// - TypeScript/PNPM: pnpm -r build
// - Rust/Cargo: cargo build

group = "com.ghatana.audio-video"
version = "0.1.0-SNAPSHOT"

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
