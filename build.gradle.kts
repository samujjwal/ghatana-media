plugins {
    id("base")
}

// Ghatana Media build root (audio-video is a retained compatibility coordinate).
// Build only this product: ./gradlew buildAll (alias for buildFull).
// buildMediaJvm compiles its actual JVM subprojects; buildPnpm restricts pnpm
// work to Media packages and buildCargo builds the declared Rust workspace.

group = "com.ghatana.audio-video"
version = "0.1.0-SNAPSHOT"

// java-module/java-application/protobuf-module read this product-owned target
// from gradle/libs.versions.toml. Media modules with explicit toolchains use the
// same catalog value; no post-evaluation target or Lombok repair is needed.
val mediaJavaTarget = libs.versions.java.get().toInt()
val mediaLombokVersion = libs.versions.lombok.get()
val mediaCompositeScope = providers.gradleProperty("ghatana.media.compositeScope")
    .map { it.trim() }
    .orElse("FULL")
    .get()
    .uppercase()
val focusedMediaModules = providers.gradleProperty("ghatana.media.focusedModules")
    .orNull
    ?.split(',')
    ?.map { it.trim().lowercase() }
    ?.toSet()
    .orEmpty()

// Keep this set in sync with the Shared dependency substitutions in settings.gradle.kts.
// Any new Shared coordinate must be source-substituted before it can be allowed here.
val focusedSharedPlatformArtifacts = setOf(
    "contracts",
    "core",
    "config",
    "database",
    "http",
    "grpc-client",
    "observability",
    "runtime",
    "security",
    "audit",
    "cache",
    "messaging",
    "schema",
    "agent-core",
    "agent-runtime",
    "workflow",
    "platform-bom",
    "governance",
    "testing",
    "testing-activej",
    "testing-integration"
)

// A focused source composite intentionally omits Kernel, Tools, Ghatana services,
// Data Cloud, Event Plane, and AI Inference. Reject their coordinates during
// resolution so an accidental new dependency cannot fall through to Maven.
if (mediaCompositeScope == "FOCUSED") {
    allprojects {
        configurations.configureEach {
            resolutionStrategy.eachDependency {
                val dependencyGroup = requested.group.orEmpty()
                val dependencyName = requested.name
                val omittedSourceReason = when {
                    dependencyGroup == "com.ghatana.kernel" ->
                        "Kernel source and its OCR adapter are omitted from FOCUSED"
                    dependencyGroup == "com.ghatana.platform" && dependencyName.startsWith("tool-") ->
                        "Tools source is omitted from FOCUSED"
                    dependencyGroup == "com.ghatana" && dependencyName == "launcher-support" &&
                        ("launcher" in focusedMediaModules || "runtime-integration" in focusedMediaModules) -> null
                    dependencyGroup == "com.ghatana.platform" && dependencyName !in focusedSharedPlatformArtifacts ->
                        "this platform coordinate is not in the Shared source substitution allowlist"
                    dependencyGroup == "com.ghatana" ||
                        dependencyGroup.startsWith("com.ghatana.datacloud") ||
                        dependencyGroup.startsWith("com.ghatana.eventplane") ||
                        dependencyGroup.startsWith("com.ghatana.aiinference") ||
                        dependencyGroup.startsWith("com.ghatana.services.data-cloud") ||
                        dependencyGroup.startsWith("com.ghatana.services.event-plane") ||
                        dependencyGroup.startsWith("com.ghatana.services.ai-inference") ->
                        "the canonical Ghatana source project is available only in FULL"
                    else -> null
                }
                if (omittedSourceReason != null) {
                    throw GradleException(
                        "FOCUSED source allowlist $focusedMediaModules cannot resolve " +
                            "$dependencyGroup:$dependencyName: $omittedSourceReason; " +
                            "remove the dependency from this core scope or use compositeScope=FULL"
                    )
                }
            }
        }
    }
}

tasks.register("verifyMediaJavaTargetAlignment") {
    group = "verification"
    description = "Checks Media Java toolchains, bytecode targets, test JVMs, and Lombok processors"
    doLast {
        val mediaJavaProjects = subprojects.filter { project ->
            (project.path.startsWith(":services:media:") || project.path.startsWith(":media:")) &&
                project.plugins.hasPlugin("java")
        }
        val failures = mutableListOf<String>()
        mediaJavaProjects.forEach { project ->
            val java = project.extensions.getByType(org.gradle.api.plugins.JavaPluginExtension::class.java)
            val toolchainVersion = java.toolchain.languageVersion.orNull?.asInt()
            if (toolchainVersion != mediaJavaTarget) {
                failures += "${project.path}: toolchain=$toolchainVersion, expected=$mediaJavaTarget"
            }
            val sourceVersion = java.sourceCompatibility.majorVersion.toIntOrNull()
            if (sourceVersion != mediaJavaTarget) {
                failures += "${project.path}: sourceCompatibility=$sourceVersion, expected=$mediaJavaTarget"
            }
            val targetVersion = java.targetCompatibility.majorVersion.toIntOrNull()
            if (targetVersion != mediaJavaTarget) {
                failures += "${project.path}: targetCompatibility=$targetVersion, expected=$mediaJavaTarget"
            }
            project.tasks.withType(org.gradle.api.tasks.compile.JavaCompile::class.java).forEach { compile ->
                val release = compile.options.release.orNull
                if (release != null && release != mediaJavaTarget) {
                    failures += "${project.path}:${compile.name}: options.release=$release, expected=$mediaJavaTarget"
                }
            }
            project.tasks.withType(org.gradle.api.tasks.testing.Test::class.java).forEach { test ->
                val testJdk = test.javaLauncher.orNull?.metadata?.languageVersion?.asInt()
                if (testJdk == null) {
                    failures += "${project.path}:${test.name}: Gradle has no toolchain-backed test launcher"
                } else if (testJdk != mediaJavaTarget) {
                    failures += "${project.path}:${test.name}: test JVM=$testJdk, expected=$mediaJavaTarget"
                }
            }
            val lombokConfigurations = listOf(
                "compileOnly",
                "annotationProcessor",
                "testCompileOnly",
                "testAnnotationProcessor"
            ).associateWith { configurationName ->
                project.configurations.findByName(configurationName)
                    ?.dependencies
                    ?.filter { it.group == "org.projectlombok" && it.name == "lombok" }
                    .orEmpty()
            }
            listOf("compileOnly", "annotationProcessor").forEach { configurationName ->
                val versions = lombokConfigurations.getValue(configurationName).map { it.version }.toSet()
                if (versions != setOf(mediaLombokVersion)) {
                    failures += "${project.path}: Lombok $configurationName=$versions, expected=$mediaLombokVersion"
                }
            }
            val testCompileOnlyVersions = lombokConfigurations.getValue("testCompileOnly").map { it.version }.toSet()
            val testProcessorVersions = lombokConfigurations.getValue("testAnnotationProcessor").map { it.version }.toSet()
            if ((testCompileOnlyVersions.isEmpty()) != (testProcessorVersions.isEmpty()) ||
                testCompileOnlyVersions.any { it != mediaLombokVersion } ||
                testProcessorVersions.any { it != mediaLombokVersion }) {
                failures += "${project.path}: paired test Lombok configurations disagree " +
                    "(testCompileOnly=$testCompileOnlyVersions, testAnnotationProcessor=$testProcessorVersions); " +
                    "each declared processor must use $mediaLombokVersion"
            }
        }
        val kotlinProjects = subprojects.filter { project ->
            (project.path.startsWith(":services:media:") || project.path.startsWith(":media:")) &&
                project.plugins.hasPlugin("org.jetbrains.kotlin.jvm")
        }
        if (kotlinProjects.isNotEmpty()) {
            failures += "Kotlin JVM target verification is required for: ${kotlinProjects.map { it.path }}"
        }
        if (failures.isNotEmpty()) {
            throw GradleException("Media JVM target alignment failed:\n- ${failures.joinToString("\n- ")}")
        }
        logger.lifecycle(
            "Verified ${mediaJavaProjects.size} Media Java projects: toolchain/source/target/test JVM=$mediaJavaTarget, " +
                "Lombok=$mediaLombokVersion; Kotlin JVM projects=${kotlinProjects.size}"
        )
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
