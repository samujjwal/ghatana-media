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
                        "launcher-h2-localstack",
                        "postgres-localstack-restart-and-policy",
                        "postgres-stt-fencing",
                        "postgres-authorized-stt-restart",
                        "compose-startup-refusal");

        for (MediaTestHarness.TestProfile profile : profiles) {
            assertThat(profile.sources()).as(profile.id()).isNotEmpty();
            assertThat(profile.selectors()).as(profile.id()).isNotEmpty();
            assertThat(profile.prerequisites()).as(profile.id()).isNotEmpty();
            assertThat(profile.safety()).as(profile.id()).isNotBlank();
            assertThat(profile.evidenceLimit()).as(profile.id()).isNotBlank();
            List<String> expectedGradleArguments = new ArrayList<>(
                    List.of(":services:media:integration-tests:test"));
            for (String selector : profile.selectors()) {
                expectedGradleArguments.add("--tests");
                expectedGradleArguments.add(selector);
            }
            assertThat(profile.gradleArguments()).as(profile.id())
                    .containsExactlyElementsOf(expectedGradleArguments);
            for (String source : profile.sources()) {
                assertThat(Files.isRegularFile(root.resolve(source)))
                        .as("catalog source %s for %s", source, profile.id()).isTrue();
            }
            for (String selector : profile.selectors()) {
                assertThat(Class.forName(selector, false, getClass().getClassLoader()))
                        .as("catalog selector %s for %s", selector, profile.id()).isNotNull();
            }
        }
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
        var syntheticFixtures = catalog.path("classification").path("SYNTHETIC_LOCAL_FIXTURE").path("files");
        assertThat(syntheticFixtures.isArray()).isTrue();
        assertThat(syntheticFixtures.size()).isEqualTo(1);
        assertThat(syntheticFixtures.get(0).asString()).isEqualTo("PerformanceIntegrationTest.java");
        var syntheticProfile = profiles.stream()
                .filter(profile -> profile.id().equals("synthetic-stream-workload")).findFirst().orElseThrow();
        assertThat(syntheticProfile.selectors()).containsExactly(performanceFixture);
        assertThat(syntheticProfile.evidenceLimit()).contains("not a real audio/video transport");
        assertThat(runnableSelectors).contains(performanceFixture);

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

    private static Path repositoryRoot() {
        Path candidate = Path.of("").toAbsolutePath();
        while (candidate != null && !Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
            candidate = candidate.getParent();
        }
        assertThat(candidate).as("repository root containing settings.gradle.kts").isNotNull();
        return candidate;
    }
}
