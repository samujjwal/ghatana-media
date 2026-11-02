/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.media.integration;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
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
            assertThat(profile.gradleArguments()).as(profile.id())
                    .startsWith(":services:media:integration-tests:test")
                    .contains("--tests");
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
