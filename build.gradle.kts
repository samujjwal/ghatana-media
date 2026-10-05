plugins {
    id("base")
}

// Audio-Video Product Root
// This build file coordinates the polyglot build system:
// - Java/Gradle: ./gradlew build
// - TypeScript/PNPM: pnpm -r build
// - Rust/Cargo: cargo build

group = "com.ghatana.audio-video"
version = rootProject.version

// Aggregate task to build all language components
tasks.register("buildAll") {
    group = "build"
    description = "Builds all language components (Java, TypeScript, Rust)"
    dependsOn("build")
}

// Task to verify pnpm build
tasks.register<Exec>("buildPnpm") {
    group = "build"
    description = "Builds TypeScript/JavaScript components using pnpm"
    commandLine("pnpm", "-r", "build")
    workingDir = projectDir
}

// Task to verify cargo build
tasks.register<Exec>("buildCargo") {
    group = "build"
    description = "Builds Rust components using cargo"
    commandLine("cargo", "build")
    workingDir = projectDir
}

// Wrapper task to build all components
tasks.register("buildFull") {
    group = "build"
    description = "Builds all components across all languages"
    dependsOn("build")
    dependsOn("buildPnpm")
    dependsOn("buildCargo")
}
