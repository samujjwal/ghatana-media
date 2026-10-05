rootProject.name = "audio-video"

// Detect build mode
val isStandaloneBuild = gradle.parent == null
val siblingGhatanaRoot = File(rootDir.parentFile, "ghatana")
val monorepoRoot = if (isStandaloneBuild) {
    siblingGhatanaRoot.takeIf { it.isDirectory } ?: rootDir
} else {
    rootDir.parentFile.parentFile
}
val productProjectPrefix = if (isStandaloneBuild) "services:media" else "media"
// Standalone builds retain the monorepo project coordinates so existing media
// build files and dependency declarations remain identical in both modes.

// Store context
extra["isStandaloneBuild"] = isStandaloneBuild
extra["monorepoRoot"] = monorepoRoot

fun includeProject(projectPath: String, projectDir: File) {
    include(projectPath)
    project(":$projectPath").projectDir = projectDir
}

// DEPRECATED: products/ directory is no longer used. In monorepo builds, canonical paths
// are services/media/*. In standalone builds, we use the local directory structure.
// This section maintained for backward compatibility only and can be removed in a future release.
include(productProjectPrefix)
// The standalone root project already owns rootDir. Keep the legacy :media
// aggregator as a synthetic parent so child paths remain addressable without
// assigning the same directory to two Gradle projects.
if (isStandaloneBuild) {
    project(":services").projectDir = rootDir.parentFile.parentFile
}
project(":$productProjectPrefix").projectDir = rootDir.parentFile
include("$productProjectPrefix:modules")
project(":$productProjectPrefix:modules").projectDir = File(rootDir, "modules")
include("$productProjectPrefix:modules:audio-streaming")
project(":$productProjectPrefix:modules:audio-streaming").projectDir = File(rootDir, "modules/audio-streaming")
include("$productProjectPrefix:modules:speech")
project(":$productProjectPrefix:modules:speech").projectDir = File(rootDir, "modules/speech")
include("$productProjectPrefix:modules:speech:stt-service")
project(":$productProjectPrefix:modules:speech:stt-service").projectDir = File(rootDir, "modules/speech/stt-service")
include("$productProjectPrefix:modules:speech:tts-service")
project(":$productProjectPrefix:modules:speech:tts-service").projectDir = File(rootDir, "modules/speech/tts-service")
include("$productProjectPrefix:modules:vision")
project(":$productProjectPrefix:modules:vision").projectDir = File(rootDir, "modules/vision")
include("$productProjectPrefix:modules:vision:vision-service")
project(":$productProjectPrefix:modules:vision:vision-service").projectDir = File(rootDir, "modules/vision/vision-service")
include("$productProjectPrefix:modules:intelligence")
project(":$productProjectPrefix:modules:intelligence").projectDir = File(rootDir, "modules/intelligence")
include("$productProjectPrefix:modules:infrastructure:messaging")
project(":$productProjectPrefix:modules:infrastructure:messaging").projectDir = File(rootDir, "modules/infrastructure/messaging")
include("$productProjectPrefix:modules:infrastructure:persistence")
project(":$productProjectPrefix:modules:infrastructure:persistence").projectDir = File(rootDir, "modules/infrastructure/persistence")
include("$productProjectPrefix:modules:infrastructure:cache")
project(":$productProjectPrefix:modules:infrastructure:cache").projectDir = File(rootDir, "modules/infrastructure/cache")
include("$productProjectPrefix:modules:infrastructure:security")
project(":$productProjectPrefix:modules:infrastructure:security").projectDir = File(rootDir, "modules/infrastructure/security")
include("$productProjectPrefix:libs")
project(":$productProjectPrefix:libs").projectDir = File(rootDir, "libs")
include("$productProjectPrefix:adapters")
project(":$productProjectPrefix:adapters").projectDir = File(rootDir, "adapters")

// Include contracts (needed by domain-models and other libs)
val contractsDir = File(if (isStandaloneBuild) rootDir else monorepoRoot, "contracts")
if (contractsDir.exists()) {
    include("contracts")
    project(":contracts").projectDir = contractsDir

    // Include contract modules
    listOf("proto", "pojos", "mappers", "json-schemas").forEach { name ->
        val contractDir = File(contractsDir, name)
        if (contractDir.exists()) {
            include("contracts:$name")
            project(":contracts:$name").projectDir = contractDir
        }
    }
}

// platform/contracts and platform/java are provided by ghatana-shared composite build

// shared-services are provided by ghatana-shared composite build

// platform/java modules are provided by ghatana-shared composite build

// Include audio-video modules
fileTree("modules") {
    include("**/build.gradle.kts")
    include("**/build.gradle")
}.forEach { buildFile ->
    val projectDir = buildFile.parentFile
    val relativePath = projectDir.relativeTo(rootDir).path
    val projectName = "$productProjectPrefix:${relativePath.replace("/", ":")}"
    includeProject(projectName, projectDir)
}

// Include audio-video libs (including nested java/ subdirectory)
fileTree("libs") {
    include("**/build.gradle.kts")
    include("**/build.gradle")
}.forEach { buildFile ->
    val projectDir = buildFile.parentFile
    val relativePath = projectDir.relativeTo(rootDir).path
    // Handle both libs/xxx and libs/java/xxx patterns
    val projectName = "$productProjectPrefix:${relativePath.replace("/", ":")}"
    includeProject(projectName, projectDir)
}

// Include Audio-Video adapters
fileTree("adapters") {
    include("**/build.gradle.kts")
    include("**/build.gradle")
}.forEach { buildFile ->
    val projectDir = buildFile.parentFile
    val relativePath = projectDir.relativeTo(rootDir).path
    val projectName = "$productProjectPrefix:${relativePath.replace("/", ":")}"
    includeProject(projectName, projectDir)
}

// Include provider implementations (for example the AWS PostgreSQL provider)
// used by the standalone launcher dependency graph.
include("$productProjectPrefix:providers")
project(":$productProjectPrefix:providers").projectDir = File(rootDir, "providers")
fileTree("providers") {
    include("**/build.gradle.kts")
    include("**/build.gradle")
}.forEach { buildFile ->
    val projectDir = buildFile.parentFile
    val relativePath = projectDir.relativeTo(rootDir).path
    val projectName = "$productProjectPrefix:${relativePath.replace("/", ":")}"
    includeProject(projectName, projectDir)
}

// Include top-level audio-video submodules (e.g. audio-video-observability, benchmarks, etc.)
fileTree(rootDir) {
    include("*/build.gradle.kts")
    include("*/build.gradle")
    exclude("modules/**")
    exclude("libs/**")
    exclude("apps/**")
}.forEach { buildFile ->
    val projectDir = buildFile.parentFile
    if (projectDir != rootDir) {
        val relativePath = projectDir.relativeTo(rootDir).path
        val projectName = "$productProjectPrefix:${relativePath.replace("/", ":")}"
        includeProject(projectName, projectDir)
    }
}

// ============================================================================
// Composite Build — ghatana-shared
// ============================================================================
// In standalone mode, include ghatana-shared as a composite build so that
// shared platform modules and services are available.
val ghatanaSharedPath = File(monorepoRoot.parentFile, "ghatana-shared")
if (isStandaloneBuild && ghatanaSharedPath.exists()) {
    logger.lifecycle("Including ghatana-shared composite build from: $ghatanaSharedPath")
    includeBuild(ghatanaSharedPath) {
        name = "ghatana-shared"
    }
} else if (isStandaloneBuild) {
    logger.lifecycle("WARNING: ghatana-shared not found at $ghatanaSharedPath — standalone build requires immutable published artifacts")
}

// ============================================================================
// Composite Build — ghatana-tools
// ============================================================================
// ToolHandler and ToolExecutor are owned by the sibling ghatana-tools
// repository. Standalone media builds must compile against that canonical
// source; no compatibility copies are maintained in this repository.
val ghatanaToolsPath = providers.gradleProperty("ghatana.tools.path")
    .map { file(it) }
    .orElse(File(monorepoRoot.parentFile, "ghatana-tools"))
    .get()
if (isStandaloneBuild && ghatanaToolsPath.exists()) {
    logger.lifecycle("Including ghatana-tools composite build from: $ghatanaToolsPath")
    includeBuild(ghatanaToolsPath) {
        name = "ghatana-tools"
        dependencySubstitution {
            mapOf(
                "tool-contracts" to ":runtime:java:tool-contracts",
                "tool-runtime-api" to ":runtime:java:tool-runtime-api",
                "tool-runtime" to ":runtime:java:tool-runtime",
                "tool-runtime-approval-jdbc" to ":runtime:java:tool-runtime-approval-jdbc",
                "tool-runtime-persistence-jdbc" to ":runtime:java:tool-runtime-persistence-jdbc",
                "tool-test-support" to ":runtime:java:tool-test-support",
                "tool-transport-http" to ":runtime:java:tool-transport-http",
                "tool-transport-grpc" to ":runtime:java:tool-transport-grpc",
                "tool-transport-mcp" to ":runtime:java:tool-transport-mcp"
            ).forEach { (artifact, projectPath) ->
                substitute(module("com.ghatana.platform:$artifact"))
                    .using(project(projectPath))
            }
        }
    }
} else if (isStandaloneBuild) {
    logger.lifecycle("WARNING: ghatana-tools not found at $ghatanaToolsPath — tool-runtime consumers require the canonical sibling checkout")
}

// Standalone media sources still use a small set of platform/Data Cloud
// project coordinates. Map those coordinates to their canonical monorepo
// sources so configuring the media graph does not silently fall back to
// duplicate or stale compatibility artifacts.
if (isStandaloneBuild) {
    include(":platform:java:launcher-support")
    include(":integration-tests:service-contract-test-utils")
    project(":platform").projectDir = File(monorepoRoot, "platform")
    project(":platform:java").projectDir = File(monorepoRoot, "platform/java")
    project(":platform:java:launcher-support").projectDir =
        File(monorepoRoot, "platform/java/launcher-support")

    project(":integration-tests").projectDir = File(monorepoRoot, "integration-tests")
    project(":integration-tests:service-contract-test-utils").projectDir =
        File(monorepoRoot, "integration-tests/service-contract-test-utils")

    val externalProjects = mapOf(
        ":services:event-plane:contracts" to "services/event-plane/contracts",
        ":services:data-cloud:planes:shared-spi" to "services/data-cloud/planes/shared-spi",
        ":services:data-cloud:planes:intelligence:analytics" to
            "services/data-cloud/planes/intelligence/analytics",
        ":services:data-cloud:delivery:api" to "services/data-cloud/delivery/api",
        ":services:ai-inference:delivery:api" to "services/ai-inference/delivery/api"
    )
    externalProjects.keys.forEach(::include)
    project(":services:event-plane").projectDir = File(monorepoRoot, "services/event-plane")
    project(":services:data-cloud").projectDir = File(monorepoRoot, "services/data-cloud")
    project(":services:data-cloud:delivery").projectDir = File(monorepoRoot, "services/data-cloud/delivery")
    project(":services:data-cloud:planes").projectDir = File(monorepoRoot, "services/data-cloud/planes")
    project(":services:data-cloud:planes:intelligence").projectDir =
        File(monorepoRoot, "services/data-cloud/planes/intelligence")
    project(":services:ai-inference").projectDir = File(monorepoRoot, "services/ai-inference")
    project(":services:ai-inference:delivery").projectDir = File(monorepoRoot, "services/ai-inference/delivery")
    externalProjects.forEach { (projectPath, relativePath) ->
        project(projectPath).projectDir = File(monorepoRoot, relativePath)
    }
}
// Plugin management - use version catalog from root
pluginManagement {
    repositories {
        mavenCentral()
        gradlePluginPortal()
    }
    val sharedBuildLogic = if (gradle.parent == null) {
        File(rootDir.parentFile, "ghatana-shared/build-logic")
    } else {
        File(rootDir.parentFile.parentFile.parentFile, "ghatana-shared/build-logic")
    }
    if (sharedBuildLogic.exists()) {
        includeBuild(sharedBuildLogic)
    }
    plugins {
        id("com.google.protobuf").version("0.9.4")
    }
}

// Dependency resolution
dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }

    // Version catalog auto-discovered from gradle/libs.versions.toml (via symlink)
}
