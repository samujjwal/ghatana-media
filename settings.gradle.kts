// Preserve this historical Gradle build identity for source/consumer compatibility.
// The canonical product/domain name is Media; a Gradle root rename requires a
// separately tested coordinate migration.
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

val mediaDependencyProfile = providers.gradleProperty("ghatana.media.dependencyProfile")
    .orElse("DEV_SOURCE_COMPOSITE")
    .get()
if (mediaDependencyProfile !in setOf("DEV_SOURCE_COMPOSITE", "RELEASE_ARTIFACT_ONLY")) {
    throw GradleException(
        "Unknown ghatana.media.dependencyProfile '$mediaDependencyProfile'; " +
            "use DEV_SOURCE_COMPOSITE or RELEASE_ARTIFACT_ONLY"
    )
}
val sourceCompositeEnabled = mediaDependencyProfile == "DEV_SOURCE_COMPOSITE"

val mediaCompositeScope = providers.gradleProperty("ghatana.media.compositeScope")
    .map { it.trim().uppercase() }
    .orElse("FULL")
    .get()
if (mediaCompositeScope !in setOf("FOCUSED", "FULL")) {
    throw GradleException(
        "Unknown ghatana.media.compositeScope '$mediaCompositeScope'; use FOCUSED or FULL"
    )
}

val focusedModulesProperty = providers.gradleProperty("ghatana.media.focusedModules").orNull
val focusedModules = focusedModulesProperty
    ?.split(',')
    ?.map { it.trim().lowercase() }
    ?.filter { it.isNotEmpty() }
    ?.toSet()
    .orEmpty()
val focusedModuleBuilds = mapOf(
    // Core modality modules use Shared primitives only. Tool and Kernel APIs live in
    // optional adapter projects in FULL scope and must not leak into focused core builds.
    "stt" to setOf("ghatana-shared"),
    "tts" to setOf("ghatana-shared"),
    "vision" to setOf("ghatana-shared"),
    "multimodal" to setOf("ghatana-shared"),
    "observability" to setOf("ghatana-shared"),
    // The standalone launcher needs only this canonical Ghatana platform project;
    // it does not require the broader Ghatana services source set.
    "launcher" to setOf("ghatana-shared"),
    // The runtime integration lane needs Shared primitives but stays outside
    // the unrelated Ghatana services, Kernel, Tools, and Lifecycle source graphs.
    "runtime-integration" to setOf("ghatana-shared")
)
val focusedModuleProjectSources = mapOf(
    "launcher" to setOf(":platform:java:launcher-support"),
    "runtime-integration" to setOf(":platform:java:launcher-support")
)
val focusedModuleProjectClosure = mapOf(
    "stt" to setOf(
        ":services:media:modules:speech:stt-service",
        ":services:media:runtime-contracts",
        ":services:media:audio-video-observability",
        ":services:media:libs:common",
        ":services:media:libs:java:common",
        ":services:media:modules:infrastructure:persistence"
    ),
    "tts" to setOf(
        ":services:media:modules:speech:tts-service",
        ":services:media:runtime-contracts",
        ":services:media:audio-video-observability",
        ":services:media:libs:common",
        ":services:media:libs:java:common",
        ":services:media:modules:infrastructure:persistence"
    ),
    "vision" to setOf(
        ":services:media:modules:vision:vision-service",
        ":services:media:runtime-contracts",
        ":services:media:audio-video-observability",
        ":services:media:libs:common",
        ":services:media:libs:java:common",
        ":services:media:modules:infrastructure:persistence"
    ),
    "multimodal" to setOf(
        ":services:media:modules:intelligence:multimodal-service",
        ":services:media:modules:vision:vision-service",
        ":services:media:modules:speech:stt-service",
        ":services:media:runtime-contracts",
        ":services:media:audio-video-observability",
        ":services:media:libs:common",
        ":services:media:libs:java:common",
        ":services:media:modules:infrastructure:persistence"
    ),
    "observability" to setOf(
        ":services:media:audio-video-observability",
        ":services:media:libs:common",
        ":services:media:libs:java:common"
    ),
    "launcher" to setOf(
        ":services:media:launcher",
        ":services:media:providers:aws-postgresql",
        ":services:media:runtime-contracts",
        ":services:media:audio-video-observability",
        ":services:media:modules:audio-streaming",
        ":services:media:modules:video-streaming",
        ":services:media:modules:speech:stt-service",
        ":services:media:modules:speech:tts-service",
        ":services:media:modules:vision:vision-service",
        ":services:media:modules:intelligence:multimodal-service",
        ":services:media:modules:infrastructure:messaging",
        ":services:media:modules:infrastructure:persistence",
        ":services:media:modules:infrastructure:cache",
        ":services:media:modules:infrastructure:security",
        ":services:media:libs:common",
        ":services:media:libs:java:common",
        ":platform:java:launcher-support"
    ),
    "runtime-integration" to setOf(
        ":services:media:integration-tests",
        ":services:media:launcher",
        ":services:media:providers:aws-postgresql",
        ":services:media:runtime-contracts",
        ":services:media:audio-video-observability",
        ":services:media:modules:audio-streaming",
        ":services:media:modules:video-streaming",
        ":services:media:modules:speech:stt-service",
        ":services:media:modules:speech:tts-service",
        ":services:media:modules:vision:vision-service",
        ":services:media:modules:intelligence:multimodal-service",
        ":services:media:modules:infrastructure:messaging",
        ":services:media:modules:infrastructure:persistence",
        ":services:media:modules:infrastructure:cache",
        ":services:media:modules:infrastructure:security",
        ":services:media:libs:common",
        ":services:media:libs:java:common",
        ":platform:java:launcher-support"
    )
)
if (mediaCompositeScope == "FOCUSED") {
    if (!sourceCompositeEnabled || !isStandaloneBuild) {
        throw GradleException("FOCUSED requires a standalone DEV_SOURCE_COMPOSITE Media build")
    }
    if (focusedModules.isEmpty()) {
        throw GradleException(
            "FOCUSED requires -Pghatana.media.focusedModules=" +
                "<stt,tts,vision,multimodal,observability,launcher,runtime-integration>; " +
                "these names select a fixed source dependency allowlist, not Gradle task-name parsing"
        )
    }
    val unknownFocusedModules = focusedModules - focusedModuleBuilds.keys
    if (unknownFocusedModules.isNotEmpty()) {
        throw GradleException(
            "Unsupported focused Media module(s): $unknownFocusedModules; " +
                "adapters and aggregate builds require compositeScope=FULL"
        )
    }
    val allFocusedCoreProjects = focusedModuleProjectClosure.values.flatten().toSet()
    val allowedFocusedCoreProjects = focusedModules
        .flatMap { focusedModuleProjectClosure.getValue(it) }
        .toSet()
    val focusedAggregateTaskPaths = setOf(
        ":services:media:buildMediaJvm",
        ":services:media:buildFull",
        ":services:media:buildAll"
    )
    gradle.taskGraph.whenReady {
        val requestedAggregates = allTasks.map { it.path }.toSet() intersect focusedAggregateTaskPaths
        if (requestedAggregates.isNotEmpty()) {
            throw GradleException(
                "Aggregate task(s) $requestedAggregates require compositeScope=FULL"
            )
        }
        val requestedCoreProjects = allTasks.map { it.project.path }.toSet() intersect allFocusedCoreProjects
        val unexpectedCoreProjects = requestedCoreProjects - allowedFocusedCoreProjects
        if (unexpectedCoreProjects.isNotEmpty()) {
            throw GradleException(
                "FOCUSED source allowlist $focusedModules does not cover selected Media core project(s) " +
                    "$unexpectedCoreProjects; select the matching focusedModules or use compositeScope=FULL"
            )
        }
    }
} else if (focusedModulesProperty != null) {
    throw GradleException("ghatana.media.focusedModules is valid only with compositeScope=FOCUSED")
}

val focusedRequiredBuilds = focusedModules.flatMap { focusedModuleBuilds.getValue(it) }.toSet()
val focusedRequiredProjectSources = focusedModules
    .flatMap { focusedModuleProjectSources[it].orEmpty() }
    .toSet()
val focusedSourceProjectDirectories = mapOf(
    ":platform:java:launcher-support" to File(monorepoRoot, "platform/java/launcher-support")
)
val unknownFocusedProjectSources = focusedRequiredProjectSources - focusedSourceProjectDirectories.keys
if (unknownFocusedProjectSources.isNotEmpty()) {
    throw GradleException("FOCUSED selector references unsupported source project(s): $unknownFocusedProjectSources")
}
if (mediaCompositeScope == "FOCUSED") {
    focusedRequiredProjectSources.forEach { projectPath ->
        val sourceDirectory = focusedSourceProjectDirectories.getValue(projectPath)
        val sourceBuildFile = sequenceOf("build.gradle.kts", "build.gradle")
            .map { File(sourceDirectory, it) }
            .firstOrNull(File::isFile)
        if (!sourceDirectory.isDirectory || sourceBuildFile == null) {
            throw GradleException(
                "FOCUSED selector requires canonical source project $projectPath at $sourceDirectory; " +
                    "published-artifact fallback is forbidden"
            )
        }
    }
}
val requiredSourceBuilds = if (mediaCompositeScope == "FULL") {
    setOf("ghatana-shared", "ghatana-kernel", "ghatana-tools", "ghatana-services")
} else {
    focusedRequiredBuilds
}
val includeLifecycleSource = providers.gradleProperty("ghatana.media.includeLifecycle")
    .map { it.toBooleanStrict() }
    .orElse(false)
    .get()
if (includeLifecycleSource && mediaCompositeScope != "FULL") {
    throw GradleException("Lifecycle source is an optional FULL-scope dependency only")
}

if (isStandaloneBuild && sourceCompositeEnabled && mediaCompositeScope == "FOCUSED"
    && ("launcher" in focusedModules || "runtime-integration" in focusedModules)) {
    val launcherDirectory = File(rootDir, "launcher")
    val launcherBuildFile = sequenceOf("build.gradle.kts", "build.gradle")
        .map { File(launcherDirectory, it) }
        .firstOrNull(File::isFile)
    if (!launcherDirectory.isDirectory || launcherBuildFile == null) {
        throw GradleException(
            "FOCUSED launcher selection requires Media launcher sources at $launcherDirectory"
        )
    }
    val awsProviderDirectory = File(rootDir, "providers/aws-postgresql")
    val awsProviderBuildFile = sequenceOf("build.gradle.kts", "build.gradle")
        .map { File(awsProviderDirectory, it) }
        .firstOrNull(File::isFile)
    if (!awsProviderDirectory.isDirectory || awsProviderBuildFile == null) {
        throw GradleException(
            "FOCUSED launcher selection requires Media aws-postgresql provider sources at $awsProviderDirectory"
        )
    }
}

if (mediaDependencyProfile == "RELEASE_ARTIFACT_ONLY") {
    val lockPath = providers.gradleProperty("ghatana.media.releaseArtifactLock")
        .orElse("config/dependency-admission/release-artifact-lock.json")
        .get()
    val lockFile = file(lockPath)
    if (!lockFile.isFile) {
        throw GradleException(
            "RELEASE_ARTIFACT_ONLY requires an admitted immutable artifact lock at $lockPath"
        )
    }
    @Suppress("UNCHECKED_CAST")
    val lock = groovy.json.JsonSlurper().parse(lockFile) as? Map<String, Any?>
        ?: throw GradleException("RELEASE_ARTIFACT_ONLY artifact lock must be a JSON object")
    if (lock["schemaVersion"] != "media.release-artifact-lock.v1"
        || lock["profile"] != "RELEASE_ARTIFACT_ONLY"
        || lock["status"] != "ADMITTED") {
        throw GradleException(
            "RELEASE_ARTIFACT_ONLY is not admitted: artifact lock status is ${lock["status"] ?: "missing"}"
        )
    }
    @Suppress("UNCHECKED_CAST")
    val policy = groovy.json.JsonSlurper().parse(file("config/dependency-profile-policy.json")) as Map<String, Any?>
    @Suppress("UNCHECKED_CAST")
    val profiles = policy["profiles"] as Map<String, Map<String, Any?>>
    @Suppress("UNCHECKED_CAST")
    val releasePolicy = profiles["RELEASE_ARTIFACT_ONLY"] as Map<String, Any?>
    if (releasePolicy["status"] != "ADMITTED" || releasePolicy["releaseEligible"] != true) {
        throw GradleException("RELEASE_ARTIFACT_ONLY is not enabled by dependency-profile-policy.json")
    }
    @Suppress("UNCHECKED_CAST")
    val requiredIds = (releasePolicy["requiredDependencyIds"] as List<String>).toSet()
    @Suppress("UNCHECKED_CAST")
    val artifacts = lock["artifacts"] as? List<Map<String, Any?>> ?: emptyList()
    val artifactIds = artifacts.mapNotNull { it["dependencyId"] as? String }
    if (artifactIds.toSet() != requiredIds || artifactIds.size != artifactIds.toSet().size) {
        throw GradleException("RELEASE_ARTIFACT_ONLY lock must contain each required dependency exactly once")
    }
    val missingEvidence = artifacts.flatMap { artifact ->
        listOf("owner", "ownerDecisionRef", "coordinates", "version", "artifactSha256", "licenseExpression", "licenseReportRef", "sbomSha256", "installedConsumerTestRef")
            .filter { field -> artifact[field] !is String || (artifact[field] as String).isBlank() }
            .map { field -> "${artifact["dependencyId"] ?: "unknown"}.$field" }
    }
    val nonIsolatedConsumers = artifacts.filter { it["sourceFree"] != true }.map { it["dependencyId"] }
    val invalidDigests = artifacts.filter { artifact ->
        val artifactDigest = artifact["artifactSha256"] as? String
        val sbomDigest = artifact["sbomSha256"] as? String
        artifactDigest?.matches(Regex("sha256:[a-f0-9]{64}")) != true
            || sbomDigest?.matches(Regex("sha256:[a-f0-9]{64}")) != true
            || (artifact["version"] as? String)?.contains("SNAPSHOT") != false
    }.map { it["dependencyId"] }
    if (missingEvidence.isNotEmpty() || nonIsolatedConsumers.isNotEmpty() || invalidDigests.isNotEmpty()) {
        throw GradleException(
            "RELEASE_ARTIFACT_ONLY lock is incomplete; missing fields=$missingEvidence, " +
                "consumers still use source bindings=$nonIsolatedConsumers, invalid artifact/version digests=$invalidDigests"
        )
    }
}
extra["mediaDependencyProfile"] = mediaDependencyProfile
logger.lifecycle("Media dependency profile: $mediaDependencyProfile")
// Standalone builds retain the monorepo project coordinates so existing media
// build files and dependency declarations remain identical in both modes.

// Store context
extra["isStandaloneBuild"] = isStandaloneBuild
extra["monorepoRoot"] = monorepoRoot

fun includeProject(projectPath: String, projectDir: File) {
    include(projectPath)
    project(":$projectPath").projectDir = projectDir
}

// Stable project coordinates: :services:media in a standalone composite,
// :media when included by the canonical monorepo. Parent projects are
// synthetic namespace nodes, not extra runtime implementations.
include(productProjectPrefix)
// The standalone root project already owns rootDir. Use a synthetic
// namespace parent so child paths remain addressable without assigning
// the same directory to two Gradle project identities.
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
    if (mediaCompositeScope == "FULL" || relativePath != "modules/integration-tests") {
        includeProject(projectName, projectDir)
    }
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

// Adapter projects have platform-owned source dependencies and belong to the
// full source composite. FOCUSED intentionally omits them so core selectors
// cannot silently resolve against a published platform artifact.
if (mediaCompositeScope == "FULL") {
    fileTree("adapters") {
        include("**/build.gradle.kts")
        include("**/build.gradle")
    }.forEach { buildFile ->
        val projectDir = buildFile.parentFile
        val relativePath = projectDir.relativeTo(rootDir).path
        val projectName = "$productProjectPrefix:${relativePath.replace("/", ":")}"
        includeProject(projectName, projectDir)
    }
}

// Include provider implementations (for example the AWS PostgreSQL provider)
// used by the standalone launcher dependency graph.
include("$productProjectPrefix:providers")
project(":$productProjectPrefix:providers").projectDir = File(rootDir, "providers")
if (mediaCompositeScope == "FULL") {
    fileTree("providers") {
        include("**/build.gradle.kts")
        include("**/build.gradle")
    }.forEach { buildFile ->
        val projectDir = buildFile.parentFile
        val relativePath = projectDir.relativeTo(rootDir).path
        val projectName = "$productProjectPrefix:${relativePath.replace("/", ":")}"
        includeProject(projectName, projectDir)
    }
} else if (mediaCompositeScope == "FOCUSED"
    && ("launcher" in focusedModules || "runtime-integration" in focusedModules)) {
    val providerDir = File(rootDir, "providers/aws-postgresql")
    includeProject("$productProjectPrefix:providers:aws-postgresql", providerDir)
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
        val focusedExcludedProjects = setOf("adapters", "launcher", "providers", "integration-tests")
        val selectedFocusedLauncher = relativePath == "launcher"
            && ("launcher" in focusedModules || "runtime-integration" in focusedModules)
        val selectedRuntimeIntegration = relativePath == "integration-tests"
            && "runtime-integration" in focusedModules
        val excludedForFocused = mediaCompositeScope == "FOCUSED"
            && ((relativePath in focusedExcludedProjects
                && !selectedFocusedLauncher && !selectedRuntimeIntegration) ||
                relativePath.startsWith("providers/"))
        if (!excludedForFocused) {
            val projectName = "$productProjectPrefix:${relativePath.replace("/", ":")}"
            includeProject(projectName, projectDir)
        }
    }
}

// ============================================================================
// Composite Build — ghatana-shared
// ============================================================================
// In standalone mode, include ghatana-shared as a composite build so that
// shared platform modules and services are available.
val ghatanaSharedPath = File(monorepoRoot.parentFile, "ghatana-shared")
if (isStandaloneBuild && sourceCompositeEnabled && "ghatana-shared" in requiredSourceBuilds) {
    if (!ghatanaSharedPath.isDirectory) {
        throw GradleException(
            "DEV_SOURCE_COMPOSITE requires the canonical ghatana-shared checkout at $ghatanaSharedPath; " +
                "published artifact fallback is forbidden"
        )
    }
    logger.lifecycle("Including ghatana-shared composite build from: $ghatanaSharedPath")
    includeBuild(ghatanaSharedPath) {
        name = "ghatana-shared"
        // Keep Media's declared Maven coordinates while compiling the canonical
        // Shared projects directly from the sibling checkout. These paths and
        // coordinates are verified against ghatana-shared/settings.gradle.kts.
        dependencySubstitution {
            val sharedProjects = mapOf(
                "contracts" to ":platform:contracts",
                "core" to ":platform:java:core",
                "config" to ":platform:java:config",
                "database" to ":platform:java:database",
                "http" to ":platform:java:http",
                "grpc-client" to ":platform:java:grpc-client",
                "observability" to ":platform:java:observability",
                "runtime" to ":platform:java:runtime",
                "security" to ":platform:java:security",
                "audit" to ":platform:java:audit",
                "cache" to ":platform:java:cache",
                "messaging" to ":platform:java:messaging",
                "schema" to ":platform:java:schema",
                "agent-core" to ":platform:java:agent-core",
                "agent-runtime" to ":platform:java:agent-runtime",
                "workflow" to ":platform:java:workflow",
                "platform-bom" to ":platform:java:platform-bom",
                "governance" to ":platform:java:governance",
                "testing" to ":platform:java:testing",
                "testing-activej" to ":platform:java:testing-activej",
                "testing-integration" to ":platform:java:testing-integration"
            )
            sharedProjects.forEach { (artifact, projectPath) ->
                substitute(module("com.ghatana.platform:$artifact"))
                    .using(project(projectPath))
            }
        }
    }
} else if (isStandaloneBuild && !sourceCompositeEnabled) {
    logger.lifecycle("Using published Shared artifacts; source composite substitution is disabled")
}

// Kernel's published product API currently uses a stable 0.1.0 coordinate,
// unlike the sibling Shared and Tools workspaces which are at SNAPSHOT versions.
val ghatanaKernelPath = providers.gradleProperty("ghatana.kernel.path")
    .map { file(it) }
    .orElse(File(monorepoRoot.parentFile, "ghatana-kernel"))
    .get()
if (isStandaloneBuild && sourceCompositeEnabled && "ghatana-kernel" in requiredSourceBuilds) {
    if (!ghatanaKernelPath.isDirectory) {
        throw GradleException(
            "Selected Media composite scope requires ghatana-kernel source at $ghatanaKernelPath; " +
                "published artifact fallback is forbidden"
        )
    }
    logger.lifecycle("Including ghatana-kernel composite build from: $ghatanaKernelPath")
    includeBuild(ghatanaKernelPath) {
        name = "ghatana-kernel"
        dependencySubstitution {
            substitute(module("com.ghatana.kernel:kernel-product-api"))
                .using(project(":platform-kernel:kernel-product-api"))
        }
    }
} else if (isStandaloneBuild && !sourceCompositeEnabled) {
    logger.lifecycle("Using the published Kernel API; source composite substitution is disabled")
} else if (isStandaloneBuild && mediaCompositeScope == "FOCUSED") {
    logger.lifecycle("Kernel source omitted by the selected FOCUSED dependency allowlist")
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
if (isStandaloneBuild && sourceCompositeEnabled && "ghatana-tools" in requiredSourceBuilds) {
    if (!ghatanaToolsPath.isDirectory) {
        throw GradleException(
            "Selected Media composite scope requires ghatana-tools source at $ghatanaToolsPath; " +
                "published artifact fallback is forbidden"
        )
    }
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
} else if (isStandaloneBuild && !sourceCompositeEnabled) {
    logger.lifecycle("Using published Tools artifacts; source composite substitution is disabled")
}

// ============================================================================
// Composite Build — ghatana-lifecycle
// ============================================================================
// Lifecycle is an independent sibling repository (not part of Tools). Media
// currently has no direct Lifecycle dependency; including its source build
// makes Lifecycle projects available to local development without introducing
// a product dependency or changing Lifecycle's published coordinates.
val ghatanaLifecyclePath = providers.gradleProperty("ghatana.lifecycle.path")
    .map { file(it) }
    .orElse(File(monorepoRoot.parentFile, "ghatana-lifecycle"))
    .get()
if (isStandaloneBuild && sourceCompositeEnabled && includeLifecycleSource) {
    if (!ghatanaLifecyclePath.isDirectory) {
        throw GradleException(
            "ghatana.media.includeLifecycle=true requires a source checkout at $ghatanaLifecyclePath"
        )
    }
    logger.lifecycle("Including ghatana-lifecycle composite build from: $ghatanaLifecyclePath")
    includeBuild(ghatanaLifecyclePath) {
        name = "ghatana-lifecycle"
    }
} else if (isStandaloneBuild) {
    logger.lifecycle("Lifecycle source build omitted; Media has no direct Lifecycle project dependency")
}

// Standalone media sources still use a small set of platform/Data Cloud
// project coordinates. Map those coordinates to their canonical monorepo
// sources so configuring the media graph does not silently fall back to
// duplicate or stale compatibility artifacts.
if (isStandaloneBuild && sourceCompositeEnabled && "ghatana-services" in requiredSourceBuilds) {
    val externalProjectPaths = mapOf(
        "platform/java/launcher-support" to File(monorepoRoot, "platform/java/launcher-support"),
        "integration-tests/service-contract-test-utils" to
            File(monorepoRoot, "integration-tests/service-contract-test-utils"),
        "services/event-plane/contracts" to File(monorepoRoot, "services/event-plane/contracts"),
        "services/data-cloud/planes/shared-spi" to
            File(monorepoRoot, "services/data-cloud/planes/shared-spi"),
        "services/data-cloud/planes/intelligence/analytics" to
            File(monorepoRoot, "services/data-cloud/planes/intelligence/analytics"),
        "services/data-cloud/delivery/api" to File(monorepoRoot, "services/data-cloud/delivery/api"),
        "services/ai-inference/delivery/api" to File(monorepoRoot, "services/ai-inference/delivery/api")
    )
    val missingExternalProjects = externalProjectPaths.filterValues { !it.isDirectory }.keys
    if (missingExternalProjects.isNotEmpty()) {
        throw GradleException(
            "FULL DEV_SOURCE_COMPOSITE requires Ghatana source projects under $monorepoRoot; " +
                "missing: $missingExternalProjects. Published-artifact fallback is forbidden"
        )
    }
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

// The focused launcher lane needs only the canonical platform launcher-support
// project. Keep it independent from the broader Ghatana services source set.
if (isStandaloneBuild && sourceCompositeEnabled && mediaCompositeScope == "FOCUSED") {
    focusedRequiredProjectSources.forEach { projectPath ->
        val sourceDirectory = focusedSourceProjectDirectories.getValue(projectPath)
        include(projectPath)
        when (projectPath) {
            ":platform:java:launcher-support" -> {
                project(":platform").projectDir = File(monorepoRoot, "platform")
                project(":platform:java").projectDir = File(monorepoRoot, "platform/java")
            }
        }
        project(projectPath).projectDir = sourceDirectory
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
    val pluginDependencyProfile = gradle.startParameter.projectProperties["ghatana.media.dependencyProfile"]
        ?: "DEV_SOURCE_COMPOSITE"
    if (pluginDependencyProfile == "DEV_SOURCE_COMPOSITE" && !sharedBuildLogic.isDirectory) {
        throw GradleException(
            "DEV_SOURCE_COMPOSITE requires Shared build logic at $sharedBuildLogic; " +
                "published plugin/artifact fallback is forbidden"
        )
    }
    if (pluginDependencyProfile == "DEV_SOURCE_COMPOSITE") {
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
