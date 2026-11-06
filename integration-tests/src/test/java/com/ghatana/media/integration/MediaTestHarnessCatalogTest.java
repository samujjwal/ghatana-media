/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.media.integration;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Consumer contract for the executable IT-01 test and fixture inventory. */
@Tag("integration")
class MediaTestHarnessCatalogTest {

    @TempDir
    Path temporaryDirectory;

    @Test
    void catalogExposesThreeTiersAndRunnableGradleSelectors() throws Exception {
        Path root = repositoryRoot();
        var profiles = MediaTestHarness.testProfiles(root);

        assertThat(profiles).isNotEmpty();
        assertThat(profiles).extracting(MediaTestHarness.TestProfile::tier)
                .contains(MediaTestHarness.TestTier.LOCAL_FIXTURE,
                        MediaTestHarness.TestTier.ISOLATED_INTEGRATION,
                        MediaTestHarness.TestTier.EXTERNAL_QUALIFICATION);
        assertThat(profiles.stream().map(MediaTestHarness.TestProfile::id).collect(Collectors.toSet()))
                .containsExactlyInAnyOrder(
                        "local-lifecycle-fixtures",
                        "synthetic-stream-workload",
                        "synthetic-frame-timebase",
                        "optional-platform-no-effect",
                        "disabled-legacy-scaffolds",
                        "launcher-h2-localstack-subject-isolation",
                        "launcher-postgres-localstack",
                        "source-free-canonical-runtime-selected",
                        "postgres-localstack-restart-and-policy",
                        "postgres-stt-fencing",
                        "postgres-authorized-stt-restart",
                        "compose-startup-refusal",
                        "journey-j03-synthetic-business-recording",
                        "journey-j12-local-animation-preview",
                        "journey-j12-animation-integration-fixture",
                        "journey-j13-spatial-local-slice",
                        "journey-j16-dubbing-capability-slice",
                        "journey-j17-music-effects-local-dsp",
                        "journey-outcome-j01", "journey-outcome-j02", "journey-outcome-j05",
                        "journey-outcome-j04-voice-consent-negative",
                        "journey-outcome-j06", "journey-outcome-j07", "journey-outcome-j08",
                        "journey-outcome-j09", "journey-outcome-j10", "journey-outcome-j11",
                        "journey-outcome-j14", "journey-outcome-j15", "journey-outcome-j18",
                        "journey-outcome-j19", "journey-outcome-j20", "journey-outcome-j21",
                        "journey-outcome-j22", "journey-outcome-j25", "journey-outcome-j26",
                        "journey-outcome-j27", "journey-outcome-j28", "journey-outcome-j29",
                        "journey-outcome-j23-browser-offline-reconnect-fixture",
                        "journey-outcome-j24-cli-command-boundary-fixture");

        for (MediaTestHarness.TestProfile profile : profiles) {
            assertThat(profile.sources()).as(profile.id()).isNotEmpty();
            assertThat(profile.selectors()).as(profile.id()).isNotEmpty();
            assertThat(profile.prerequisites()).as(profile.id()).isNotEmpty();
            assertThat(profile.safety()).as(profile.id()).isNotBlank();
            assertThat(profile.evidenceLimit()).as(profile.id()).isNotBlank();
            if (profile.commandKind() == MediaTestHarness.TestCommandKind.GRADLE) {
                assertThat(profile.gradleTestTask()).as(profile.id())
                        .matches("^:[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)+:test$");
                List<String> expectedGradleArguments = new ArrayList<>(List.of(profile.gradleTestTask()));
                for (String selector : profile.selectors()) {
                    expectedGradleArguments.add("--tests");
                    expectedGradleArguments.add(selector);
                }
                assertThat(profile.gradleArguments()).as(profile.id()).containsExactlyElementsOf(expectedGradleArguments);
                assertThat(profile.commandArguments()).as(profile.id()).isEmpty();
            } else {
                assertThat(profile.commandKind()).isEqualTo(MediaTestHarness.TestCommandKind.PNPM);
                assertThat(profile.gradleTestTask()).isNull();
                assertThat(profile.commandArguments()).as(profile.id()).startsWith("pnpm", "--filter", "@audio-video/client");
            }
            for (String selector : profile.selectors()) {
                if (profile.commandKind() == MediaTestHarness.TestCommandKind.PNPM) {
                    assertThat(profile.sources().stream().map(source -> {
                        try { return Files.readString(root.resolve(source)); }
                        catch (java.io.IOException exception) { throw new java.io.UncheckedIOException(exception); }
                    }).anyMatch(sourceText -> sourceText.contains(selector)))
                            .as("PNPM selector %s for %s must exist in a declared source", selector, profile.id()).isTrue();
                    continue;
                }
                String className = selectorClassName(selector, profile.sources());
                String selectorSource = profile.sources().stream()
                        .filter(source -> source.endsWith("/src/test/java/"
                                + className.replace('.', '/') + ".java"))
                        .findFirst().orElseThrow(() -> new AssertionError(
                                "selector source missing from profile " + profile.id() + ": " + className));
                assertThat(profile.sources()).as("selector source %s for %s", selector, profile.id())
                        .contains(selectorSource);
                String sourceText = Files.readString(root.resolve(selectorSource));
                String simpleClassName = className.substring(className.lastIndexOf('.') + 1);
                assertThat(Pattern.compile("\\bclass\\s+" + Pattern.quote(simpleClassName) + "\\b")
                                .matcher(sourceText).find())
                        .as("catalog selector class %s for %s", className, profile.id()).isTrue();
                if (!selector.equals(className)) {
                    String methodName = selector.substring(className.length() + 1);
                    assertThat(Pattern.compile("\\bvoid\\s+" + Pattern.quote(methodName) + "\\s*\\(")
                                    .matcher(sourceText).find())
                            .as("catalog selector method %s for %s", selector, profile.id()).isTrue();
                }
            }
            for (String source : profile.sources()) {
                assertThat(Files.isRegularFile(root.resolve(source)))
                        .as("catalog source %s for %s", source, profile.id()).isTrue();
            }
        }
    }

    @Test
    void missingOutcomeJourneysRemainExplicitlyUnrepresented() throws Exception {
        Path root = repositoryRoot();
        var catalog = new tools.jackson.databind.ObjectMapper().readTree(
                root.resolve("docs/implementation/media-integration-test-census.v1.json").toFile());
        var unrepresentedNode = catalog.path("journeySelectorCoverage").path("unrepresentedJourneyIds");
        assertThat(unrepresentedNode)
                .extracting(var -> var.asString())
                .containsExactly("J-30");
        assertThat(catalog.path("journeySelectorCoverage").path("meaning").asString())
                .contains("not a completion or admission status");

        Set<String> allJourneys = new HashSet<>();
        for (int number = 1; number <= 30; number++) allJourneys.add("J-%02d".formatted(number));
        Set<String> unrepresented = new HashSet<>();
        unrepresentedNode.forEach(value -> unrepresented.add(value.asString()));
        Set<String> represented = new HashSet<>();
        Pattern profileId = Pattern.compile("^journey-(?:outcome-)?j(\\d{2})(?:-|$)");
        for (MediaTestHarness.TestProfile profile : MediaTestHarness.testProfiles(root)) {
            var match = profileId.matcher(profile.id());
            if (match.find()) represented.add("J-" + match.group(1));
        }
        Set<String> expectedRepresented = new HashSet<>(allJourneys);
        expectedRepresented.removeAll(unrepresented);
        assertThat(represented).isEqualTo(expectedRepresented);
        Set<String> covered = new HashSet<>(represented);
        covered.addAll(unrepresented);
        assertThat(covered).isEqualTo(allJourneys);
        var profiles = MediaTestHarness.testProfiles(root).stream()
                .collect(Collectors.toMap(MediaTestHarness.TestProfile::id, profile -> profile));
        var j23 = profiles.get("journey-outcome-j23-browser-offline-reconnect-fixture");
        assertThat(j23.commandArguments()).containsExactly("pnpm", "--filter", "@audio-video/client", "run", "test:browser:offline-store");
        assertThat(j23.sources()).contains("libs/audio-video-client/scripts/test-indexeddb-offline-edit-store-browser.mjs");
        assertThat(Files.readString(root.resolve(j23.sources().getFirst())))
                .contains("hostHeldKey", "authorizationReads", "applyCount");
        assertThat(Files.readString(root.resolve("libs/audio-video-client/package.json")))
                .contains("\"test:browser:offline-store\": \"pnpm build && node scripts/test-indexeddb-offline-edit-store-browser.mjs\"");
        var j24 = profiles.get("journey-outcome-j24-cli-command-boundary-fixture");
        assertThat(j24.commandArguments()).containsExactly("pnpm", "--filter", "@audio-video/client", "exec", "vitest", "run",
                "src/cli.test.ts", "-t", "keeps the J-24 CLI scenario truthful across the currently supported command boundary");
        assertThat(Files.readString(root.resolve(j24.sources().getFirst())))
                .contains(j24.selectors().getFirst(), "NOT_ADMITTED");
    }

    @Test
    void sourceFreeCanonicalRuntimeProfileSelectsOnlyInstalledGrantDenialUnknownAndRestartCases() throws Exception {
        var profile = MediaTestHarness.testProfiles(repositoryRoot()).stream()
                .filter(candidate -> candidate.id().equals("source-free-canonical-runtime-selected"))
                .findFirst().orElseThrow();
        assertThat(profile.selectors()).containsExactly(
                "com.ghatana.media.integration.MediaLauncherEndToEndIT.v01_uploadChunksFinalizeThenReadArtifactWithExactBytes",
                "com.ghatana.media.integration.MediaLauncherEndToEndIT.v02_sameRequestIdReplaysOneJobAndMismatchConflicts",
                "com.ghatana.media.integration.MediaLauncherEndToEndIT.v06LocalDiagnosticCompletionAndOutboxSurviveRuntimeRestart",
                "com.ghatana.media.integration.MediaLauncherEndToEndIT.v09_crossTenantReadsNotFoundAndForgedPrincipalScrubbed",
                "com.ghatana.media.launcher.MediaProviderPolicyDeniedFinalityPostgresIT.policyDenialAfterRecordedProviderEffectStaysUnknownAcrossRuntimeReconstruction",
                "com.ghatana.media.integration.MediaRuntimePostgresWorkflowMetricsIT.hardProcessLossRetainsSubjectArtifactAndUnknownJobWithoutReplayingEffects");
        assertThat(profile.prerequisites()).contains(
                "canonical job reconciliation and canonical SDK migration remain separate prerequisites; this profile does not exercise the SDK");
        assertThat(profile.assets()).contains("Generated bytes only", "simulated fixtures");
        assertThat(profile.evidenceLimit()).contains("not J01-J30 completion", "not SDK integration", "not real-provider positive evidence");
    }

    @Test
    void externalAssetsAndComposeImagesRemainExplicitlyGated() throws Exception {
        var profiles = MediaTestHarness.testProfiles(repositoryRoot()).stream()
                .collect(Collectors.toMap(MediaTestHarness.TestProfile::id, profile -> profile));
        var whisper = profiles.get("postgres-authorized-stt-restart");
        var compose = profiles.get("compose-startup-refusal");

        assertThat(whisper.prerequisites())
                .contains("GHATANA_MEDIA_WHISPER_PROFILE", "GHATANA_MEDIA_WHISPER_AUDIO",
                        "GHATANA_MEDIA_WHISPER_GOLD_TRANSCRIPT",
                        "independently verified rights for model and source audio");
        assertThat(whisper.assets()).contains("repository contains no Whisper profile");
        assertThat(compose.prerequisites()).contains("both image variables set to owner-pinned image digests for a qualification run");
        assertThat(compose.assets()).contains("mutable :latest tags");
        assertThat(compose.evidenceLimit()).contains("not a successful STT/TTS operation");
    }

    @Test
    void catalogScaffoldsStayDisabledAndComposeSuitesStayImageGated() throws Exception {
        Path root = repositoryRoot();
        var catalog = new tools.jackson.databind.ObjectMapper().readTree(
                root.resolve("docs/implementation/media-integration-test-census.v1.json").toFile());
        var profiles = MediaTestHarness.testProfiles(root);
        Set<String> runnableSelectors = new HashSet<>();
        profiles.stream().filter(profile -> !profile.id().equals("disabled-legacy-scaffolds"))
                .forEach(profile -> runnableSelectors.addAll(profile.selectors()));

        var scaffolds = catalog.path("classification").path("STUB_SCAFFOLD_DISABLED").path("files");
        assertThat(scaffolds.isArray()).isTrue();
        for (var entry : scaffolds) {
            String file = entry.asString().replaceFirst(" \\(.*$", "");
            String simpleName = file.substring(0, file.indexOf(".java"));
            String className = "com.ghatana.audio.video.integration." + simpleName;
            Class<?> scaffold = Class.forName(className, false, getClass().getClassLoader());
            assertThat(scaffold.getAnnotation(Disabled.class))
                    .as("catalog scaffold %s must remain disabled until wired", className).isNotNull();
            assertThat(runnableSelectors).as("simulated scaffold %s is not runnable evidence", className)
                    .doesNotContain(className);
        }

        String performanceFixture = "com.ghatana.audio.video.integration.PerformanceIntegrationTest";
        String guardedMixedFixture = "com.ghatana.audio.video.integration.GuardedMixedStreamWorkloadIT";
        var syntheticFixtures = catalog.path("classification").path("SYNTHETIC_LOCAL_FIXTURE").path("files");
        assertThat(syntheticFixtures.isArray()).isTrue();
        assertThat(syntheticFixtures).extracting(var -> var.asString())
                .containsExactlyInAnyOrder("PerformanceIntegrationTest.java", "GuardedMixedStreamWorkloadIT.java");
        var syntheticProfile = profiles.stream()
                .filter(profile -> profile.id().equals("synthetic-stream-workload")).findFirst().orElseThrow();
        assertThat(syntheticProfile.selectors()).containsExactly(performanceFixture, guardedMixedFixture);
        assertThat(syntheticProfile.evidenceLimit()).contains("not rights/consent qualification");
        assertThat(runnableSelectors).contains(performanceFixture, guardedMixedFixture);

        String processFixture = "com.ghatana.audio.video.integration.AudioVideoContainerProcessTest";
        var localProcessFixtures = catalog.path("classification").path("LOCAL_PROCESS_FIXTURE").path("files");
        assertThat(localProcessFixtures.isArray()).isTrue();
        assertThat(localProcessFixtures.size()).isEqualTo(1);
        assertThat(localProcessFixtures.get(0).asString()).isEqualTo("AudioVideoContainerProcessTest.java");
        var localProfile = profiles.stream()
                .filter(profile -> profile.id().equals("local-lifecycle-fixtures")).findFirst().orElseThrow();
        assertThat(localProfile.selectors()).contains(processFixture);

        var imageGated = catalog.path("classification").path("CONTAINER_GATED_REAL_INTEGRATION").path("files");
        assertThat(imageGated.isArray()).isTrue();
        for (var entry : imageGated) {
            String file = entry.asString().replaceFirst(" \\(.*$", "");
            if (file.equals("AudioVideoContainerBase.java")) continue;
            String simpleName = file.substring(0, file.indexOf(".java"));
            String className = "com.ghatana.audio.video.integration." + simpleName;
            Class<?> suite = Class.forName(className, false, getClass().getClassLoader());
            assertThat(suite.getSuperclass()).as("image-gated suite %s", className)
                    .isEqualTo(Class.forName(
                            "com.ghatana.audio.video.integration.AudioVideoContainerBase",
                            false, getClass().getClassLoader()));
        }
    }

    @Test
    void inMemoryProviderLifecycleFixtureIsNotMarkedAsProductionEvidence() {
        assertThat(MediaProviderJobLifecycleE2ETest.class.getAnnotationsByType(Tag.class))
                .extracting(Tag::value)
                .contains("integration")
                .doesNotContain("production");
    }

    @Test
    void malformedCatalogEntriesFailClosed() throws Exception {
        writeCatalog("""
                {"profiles":[{"id":"local","tier":"LOCAL_FIXTURE","selectors":[],
                 "sources":["test.java"],"resources":["JUnit"],"prerequisites":["JDK"],
                 "assets":"synthetic","safety":"isolated","evidenceLimit":"fixture only"}]}
                """);

        assertThatThrownBy(() -> MediaTestHarness.testProfiles(temporaryDirectory))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("selectors")
                .hasMessageContaining("non-empty string array");
    }

    @Test
    void unknownCatalogTierIsRejected() throws Exception {
        writeCatalog("""
                {"profiles":[{"id":"local","tier":"PRODUCTION","selectors":["Test"],
                 "sources":["test.java"],"resources":["JUnit"],"prerequisites":["JDK"],
                 "assets":"synthetic","safety":"isolated","evidenceLimit":"fixture only"}]}
                """);

        assertThatThrownBy(() -> MediaTestHarness.testProfiles(temporaryDirectory))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("unknown test census tier PRODUCTION")
                .hasMessageContaining("local");
    }

    private void writeCatalog(String json) throws Exception {
        Path catalog = temporaryDirectory.resolve("docs/implementation/media-integration-test-census.v1.json");
        Files.createDirectories(catalog.getParent());
        Files.writeString(catalog, json);
    }

    private static String selectorClassName(String selector, List<String> sources) {
        for (String source : sources) {
            String className = source.replaceFirst("^.*?/src/test/java/", "")
                    .replace('/', '.').replaceFirst("\\.java$", "");
            if (selector.equals(className) || selector.startsWith(className + ".")) return className;
        }
        throw new AssertionError("selector does not identify any declared source: " + selector);
    }

    private static Path repositoryRoot() {
        Path candidate = Path.of("").toAbsolutePath();
        while (candidate != null && !Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
            candidate = candidate.getParent();
        }
        assertThat(candidate).as("repository root containing settings.gradle.kts").isNotNull();
        return candidate;
    }
}
