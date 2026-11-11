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
                        "journey-outcome-j02-corrupt-chunk-restart",
                        "journey-outcome-j03-caption-rights-ambiguity",
                        "journey-outcome-j03-caption-unknown-revocation-fixture",
                        "journey-outcome-j06-service-ambiguous-rights",
                        "journey-outcome-j08-timebase-bound",
                        "journey-outcome-j04-voice-consent-negative",
                        "journey-outcome-j04-profile-binding-negative",
                        "journey-outcome-j06", "journey-outcome-j07", "journey-outcome-j08",
                        "journey-outcome-j09", "journey-outcome-j10", "journey-outcome-j11",
                        "journey-outcome-j14", "journey-outcome-j15", "journey-outcome-j18",
                        "journey-outcome-j19-ambiguous-candidate",
                        "journey-outcome-j19", "journey-outcome-j19-cancellation",
                        "journey-outcome-j20", "journey-outcome-j21",
                        "journey-outcome-j22", "journey-outcome-j25", "journey-outcome-j26",
                        "journey-outcome-j27", "journey-outcome-j28", "journey-outcome-j29",
                        "journey-outcome-j27-process-restart-unknown",
                        "journey-outcome-j29-runtime-unknown-prefix",
                        "journey-outcome-j30-unavailable-readiness",
                        "journey-outcome-j30-inventory-not-admission",
                        "journey-outcome-j23-browser-offline-reconnect-fixture",
                        "journey-outcome-j23-wrong-project-readback-negative",
                        "journey-outcome-j24-cli-unregistered-command-negative-fixture");

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
    void outcomeJourneySelectorsAndExplicitUnrepresentedStatusAreReconciled() throws Exception {
        Path root = repositoryRoot();
        var catalog = new tools.jackson.databind.ObjectMapper().readTree(
                root.resolve("docs/implementation/media-integration-test-census.v1.json").toFile());
        var unrepresentedNode = catalog.path("journeySelectorCoverage").path("unrepresentedJourneyIds");
        assertThat(unrepresentedNode)
                .extracting(var -> var.asString())
                .isEmpty();
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
        var j04Consent = profiles.get("journey-outcome-j04-voice-consent-negative");
        assertThat(j04Consent.selectors()).containsExactly("com.ghatana.tts.grpc.TtsVoiceConsentNegativeTest");
        var j04ProfileBinding = profiles.get("journey-outcome-j04-profile-binding-negative");
        assertThat(j04ProfileBinding.gradleTestTask()).isEqualTo(":services:media:modules:integration-tests:test");
        assertThat(j04ProfileBinding.selectors()).containsExactly(
                "com.ghatana.tts.grpc.TtsAuthorizedVoiceSynthesisScenarioTest"
                        + ".profileOnlySelectionReturnsUnavailableWithoutAudioOrModelLookup");
        assertThat(j04ProfileBinding.sources()).contains(
                ".product-experience/pdp-0-product-truth/journey-catalog.yaml",
                ".product-experience/pdp-1-domain-data/operations.yaml",
                "modules/speech/tts-service/src/main/java/com/ghatana/tts/grpc/TtsRequestAuthorization.java",
                "modules/integration-tests/src/test/java/com/ghatana/tts/grpc/TtsAuthorizedVoiceSynthesisScenarioTest.java");
        assertThat(j04ProfileBinding.safety()).contains("unqualified profile-only request", "UNAVAILABLE",
                "before TTS engine lookup", "no audio");
        assertThat(j04ProfileBinding.evidenceLimit())
                .contains("no licensed voice/model", "journey completion is established");
        var j02 = profiles.get("journey-outcome-j02");
        String j02SdkSelector = "com.ghatana.media.integration.MediaDevIssuerHeadlessRestartIT"
                + ".ownerIssuedDevIdentityCompletesAndReadsBackUploadAndDiagnosticJobAcrossRestart";
        String j02CliResumeSelector = "com.ghatana.media.integration.MediaDevIssuerHeadlessRestartIT"
                + ".devOnlyCliResumesPartialOpenUploadFromSameIdempotencyKeyAfterLauncherRestart";
        String j02BrowserSelector = "com.ghatana.media.integration.MediaDevProjectTimelineRestartIT"
                + ".realExplorerUploadKeepsProductInspectionNotAdmittedAcrossLauncherRestart";
        String j02RecoverySelector = "com.ghatana.media.integration.MediaDevProjectTimelineRestartIT"
                + ".realExplorerResumesUploadAfterReloadAndLauncherRestart";
        String j02TimelineLinkSelector = "com.ghatana.media.integration.MediaDevProjectTimelineRestartIT"
                + ".realExplorerUploadsThenLinksExactArtifactVersionAcrossLauncherRestart";
        assertThat(j02.selectors()).containsExactly(
                "com.ghatana.media.integration.MediaLauncherArtifactIntakeRestartIT"
                        + ".authenticatedUploadResumesAcknowledgedPrefixAfterLauncherProcessRestart",
                j02SdkSelector,
                j02CliResumeSelector,
                j02BrowserSelector,
                j02RecoverySelector,
                j02TimelineLinkSelector);
        assertThat(j02.sources()).contains(
                ".product-experience/pdp-0-product-truth/journey-catalog.yaml",
                ".product-experience/pdp-3-product-experience/journey-contracts/upload-import-and-verify-artifact.yaml",
                ".product-experience/pdp-3-product-experience/cli/local-development-command-registry.yaml",
                "libs/audio-video-client/package.json",
                "libs/audio-video-client/src/cli-dev.ts",
                "libs/audio-video-client/src/cli.ts",
                "libs/audio-video-client/src/canonical-operations.ts",
                "apps/media-experience-explorer/package.json",
                "integration-tests/src/test/resources/media-dev-artifact-upload-recovery-live-browser.mjs",
                "integration-tests/src/test/java/com/ghatana/media/integration/MediaDevIssuerHeadlessRestartIT.java",
                "integration-tests/src/test/java/com/ghatana/media/integration/MediaDevProjectTimelineRestartIT.java");
        assertThat(j02.resources()).contains("Node.js compiled CLI process",
                "Playwright Chromium browser and Vite Explorer process");
        assertThat(j02.prerequisites()).anySatisfy(prerequisite -> assertThat(prerequisite)
                .contains("pnpm install", "pnpm --filter @audio-video/client build", "compiled CLI entry point"));
        assertThat(j02.evidenceLimit()).contains("bounded local DEV_ONLY J-02 SDK denial/recovery",
                "read-only CLI point-in-time job observation", "CLI result is not provider-finality evidence",
                "Explorer artifact-intake restart/readback", "do not establish production authority",
                "J-01", "J-02 completion", "J-01–J-30 completion",
                "exact SHA-256 version into a project timeline clip across launcher restarts");
        assertThat(j02.prerequisites()).anySatisfy(prerequisite -> assertThat(prerequisite)
                .contains("Playwright 1.63.0 Chromium runtime", "Vite 7.3.1", "8.3.0"));
        assertThat(j02.evidenceLimit()).contains("one browser upload-recovery scenario",
                "generated synthetic WAV bytes");
        String j02SdkSource = Files.readString(root.resolve(
                "integration-tests/src/test/java/com/ghatana/media/integration/MediaDevIssuerHeadlessRestartIT.java"));
        assertThat(j02SdkSource).contains("issueArtifactReadOnlyDevToken(tenant, principal)",
                "media:artifact:read", "runHeadlessSdkExampleExpectingFailure(",
                "doesNotContain(readOnlyArtifactToken)", "assertUploadSessionAndChunks(",
                "issueJobReadOnlyDevToken(tenant, principal)", "assertJobReadOnlyToken(",
                "assertRealHostCliJobGet(", "GHATANA_MEDIA_BEARER_TOKEN",
                "media.cli-result.v1", "media.cli.local-development.job.get");
        var j20 = profiles.get("journey-outcome-j20");
        assertThat(j20.selectors()).containsExactly(
                "com.ghatana.media.integration.MediaLauncherSttProcessIT"
                        + ".dispatchedJobBecomesUnknownAfterHardProcessRestartWithoutRedispatch",
                "com.ghatana.media.integration.MediaRuntimePostgresWorkflowMetricsIT"
                        + ".hardProcessLossRetainsSubjectArtifactAndUnknownJobWithoutReplayingEffects",
                j02SdkSelector,
                "com.ghatana.media.launcher.MediaDevOnlyJobCancellationFinalityPostgresIT"
                        + ".definitiveProviderSuccessFinalizesAfterUnconfirmedCancellation",
                "com.ghatana.media.launcher.MediaDevOnlyJobCancellationRestartPostgresIT"
                        + ".hardProcessLossDuringCancelDispatchReplaysUnknownWithoutRedispatch");
        assertThat(j20.sources()).contains(
                ".product-experience/pdp-0-product-truth/journey-catalog.yaml",
                ".product-experience/pdp-3-product-experience/journey-contracts/long-running-job-observation-and-recovery.yaml",
                ".product-experience/pdp-3-product-experience/cli/local-development-command-registry.yaml",
                "libs/audio-video-client/package.json",
                "libs/audio-video-client/src/cli-dev.ts",
                "libs/audio-video-client/src/cli.ts",
                "libs/audio-video-client/src/canonical-operations.ts",
                "integration-tests/src/test/java/com/ghatana/media/integration/MediaDevIssuerHeadlessRestartIT.java",
                "integration-tests/src/test/java/com/ghatana/media/launcher/MediaDevOnlyJobCancellationFinalityPostgresIT.java",
                "integration-tests/src/test/java/com/ghatana/media/launcher/MediaDevOnlyJobCancellationRestartPostgresIT.java");
        assertThat(j20.evidenceLimit()).contains("completed local-diagnostic job across launcher restart",
                "definitive typed synthetic provider receipt", "PostgreSQL",
                "runtime/store reconstruction", "do not prove real provider output",
                "after a test-owned LOCAL cancellation callback begins",
                "persisted cancellation fingerprint", "no second provider call",
                "does not establish journey completion");
        var j22 = profiles.get("journey-outcome-j22");
        assertThat(j22.selectors()).containsExactly(
                "com.ghatana.audio.video.integration.DeliveryDestinationReceiptScenarioTest"
                        + ".wrongDestinationReceiptRemainsUnknownAndHasNoDeliveredReceiptReference",
                "com.ghatana.audio.video.integration.DeliveryDestinationReceiptScenarioTest"
                        + ".acknowledgedChunkWithLostProgressPersistenceReconcilesAfterRestartWithoutReplay");
        assertThat(j22.evidenceLimit()).contains("lost SENT-progress persistence",
                "after restart without resending", "synthetic fixtures",
                "does not establish authenticated destination acceptance");
        String j02BrowserSource = Files.readString(root.resolve(
                "integration-tests/src/test/java/com/ghatana/media/integration/MediaDevProjectTimelineRestartIT.java"));
        assertThat(j02BrowserSource).contains("realExplorerUploadKeepsProductInspectionNotAdmittedAcrossLauncherRestart",
                "realExplorerResumesUploadAfterReloadAndLauncherRestart",
                "realExplorerUploadsThenLinksExactArtifactVersionAcrossLauncherRestart",
                "media-dev-artifact-upload-recovery-live-browser.mjs");
        var j03Unknown = profiles.get("journey-outcome-j03-caption-unknown-revocation-fixture");
        assertThat(j03Unknown.gradleTestTask()).isEqualTo(":services:media:integration-tests:test");
        assertThat(j03Unknown.selectors()).containsExactly(
                "com.ghatana.media.launcher.J03CaptionUnknownRevocationScenarioTest"
                        + ".unknownCaptionWriteStaysOnExactTranscriptAndRevocationBlocksRetry");
        assertThat(j03Unknown.sources()).contains(
                ".product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml",
                "integration-tests/src/test/java/com/ghatana/media/launcher/J03CaptionUnknownRevocationScenarioTest.java");
        assertThat(j03Unknown.evidenceLimit()).contains("does not establish licensed inference",
                "durable caption readback/restart", "journey completion");
        var j23 = profiles.get("journey-outcome-j23-browser-offline-reconnect-fixture");
        assertThat(j23.commandArguments()).containsExactly("pnpm", "--filter", "@audio-video/client", "run", "test:browser:offline-store");
        assertThat(j23.sources()).contains("libs/audio-video-client/scripts/test-indexeddb-offline-edit-store-browser.mjs");
        assertThat(Files.readString(root.resolve(j23.sources().getFirst())))
                .contains("hostHeldKey", "authorizationReads", "applyCount");
        assertThat(Files.readString(root.resolve("libs/audio-video-client/package.json")))
                .contains("\"test:browser:offline-store\": \"pnpm build && node scripts/test-indexeddb-offline-edit-store-browser.mjs\"");
        var j23WrongProject = profiles.get("journey-outcome-j23-wrong-project-readback-negative");
        assertThat(j23WrongProject.commandArguments()).containsExactly("pnpm", "--filter", "@audio-video/client", "exec",
                "vitest", "run", "src/offline-reconnect.test.ts", "-t",
                "keeps wrong-project authorization readback unknown without applying or revoking the edit"
                        + "|keeps wrong-project version readback unknown without authorizing or applying the edit");
        assertThat(j23WrongProject.selectors()).containsExactly(
                "keeps wrong-project authorization readback unknown without applying or revoking the edit",
                "keeps wrong-project version readback unknown without authorizing or applying the edit");
        assertThat(j23WrongProject.sources()).contains("libs/audio-video-client/src/offline-reconnect.test.ts");
        assertThat(j23WrongProject.evidenceLimit()).contains("do not prove a canonical project-edit route");
        var j24 = profiles.get("journey-outcome-j24-cli-unregistered-command-negative-fixture");
        String j24Selector = "never exposes the unregistered fixture command";
        assertThat(j24.commandArguments()).containsExactly("pnpm", "--filter", "@audio-video/client", "exec", "vitest", "run",
                "src/cli.test.ts", "-t", j24Selector);
        assertThat(j24.selectors()).containsExactly(j24Selector);
        String j24CliTest = Files.readString(root.resolve("libs/audio-video-client/src/cli.test.ts"));
        assertThat(j24CliTest).contains("command: 'job batch', args: ['job', 'batch']", j24Selector,
                "expect(JSON.parse(result.stderr).code).toBe('INVALID_INVOCATION')");
        String j24Contract = Files.readString(root.resolve(
                ".product-experience/pdp-3-product-experience/journey-contracts/run-cli-batch-and-review-verified-outputs.yaml"));
        assertThat(j24.sources()).contains(
                ".product-experience/pdp-3-product-experience/journey-contracts/run-cli-batch-and-review-verified-outputs.yaml");
        assertThat(j24Contract).contains("journeyId: J-24", "status: pdp0-grounded-proposal", "NO_STEP_SCENARIO_BOUND");
        assertThat(j24.evidenceLimit()).contains("before fetch", "J-24 remains NO_STEP_SCENARIO_BOUND",
                "no positive output", "durable finality", "journey completion");
        var j30 = profiles.get("journey-outcome-j30-unavailable-readiness");
        assertThat(j30.tier()).isEqualTo(MediaTestHarness.TestTier.LOCAL_FIXTURE);
        assertThat(j30.selectors()).containsExactly(
                "com.ghatana.audio.video.vision.grpc.VisionRoiAdmissionIntegrationTest.roiRequestsFailClosedBeforeProviderEffects");
        assertThat(j30.sources()).contains(
                ".product-experience/pdp-3-product-experience/journey-contracts/check-which-processing-options-are-eligible.yaml",
                "modules/integration-tests/src/test/java/com/ghatana/audio/video/vision/grpc/VisionRoiAdmissionIntegrationTest.java");
        assertThat(j30.evidenceLimit()).contains("does not establish a composite eligibility catalog");
        var j29 = profiles.get("journey-outcome-j29");
        String j29Selector = "com.ghatana.audio.video.integration.GuardedCrossModalityStreamStateMachineTest"
                + ".revokedConsentBlocksReconnectAndResumeAcrossModalities";
        String journeyCatalogPath = ".product-experience/pdp-0-product-truth/journey-catalog.yaml";
        String j29JourneyCatalog = Files.readString(root.resolve(journeyCatalogPath));
        int j29Start = j29JourneyCatalog.indexOf("- id: J-29");
        int j30Start = j29JourneyCatalog.indexOf("- id: J-30");
        assertThat(j29.sources()).contains(journeyCatalogPath,
                "modules/integration-tests/src/test/java/com/ghatana/audio/video/integration/"
                        + "GuardedCrossModalityStreamStateMachineTest.java");
        assertThat(j29.selectors()).contains(j29Selector);
        assertThat(j29Start).isGreaterThanOrEqualTo(0);
        assertThat(j30Start).isGreaterThan(j29Start);
        String j29Declaration = j29JourneyCatalog.substring(j29Start, j30Start).replaceAll("\\s+", " ");
        assertThat(j29Declaration)
                .contains("title: Live session loss, consent change, and bounded recovery",
                        "no new frame crosses the boundary after revocation or fencing",
                        "Fence new frames; use prior consent only for permitted termination");
        assertThat(Files.readString(root.resolve(
                "modules/integration-tests/src/test/java/com/ghatana/audio/video/integration/"
                        + "GuardedCrossModalityStreamStateMachineTest.java")))
                .contains("void revokedConsentBlocksReconnectAndResumeAcrossModalities(");
        var j29UnknownPrefix = profiles.get("journey-outcome-j29-runtime-unknown-prefix");
        assertThat(j29UnknownPrefix.gradleTestTask()).isEqualTo(":services:media:integration-tests:test");
        assertThat(j29UnknownPrefix.selectors()).containsExactly(
                "com.ghatana.media.launcher.MediaRuntimeUnknownStreamPrefixScenarioIT"
                        + ".ambiguousFrameAfterAcknowledgedPrefixDoesNotAdvanceCursorOrRepeatProviderEffect");
        assertThat(j29UnknownPrefix.evidenceLimit()).contains(
                "does not prove authenticated transport", "journey completion");
        var j19Ambiguous = profiles.get("journey-outcome-j19-ambiguous-candidate");
        assertThat(j19Ambiguous.tier()).isEqualTo(MediaTestHarness.TestTier.LOCAL_FIXTURE);
        assertThat(j19Ambiguous.gradleTestTask()).isEqualTo(":services:media:modules:integration-tests:test");
        assertThat(j19Ambiguous.selectors()).containsExactly(
                "com.ghatana.audio.video.integration.J19QualityOutcomeScenarioTest.ambiguousSecondAttemptRetainsOnlyExactRevisionsAndPreservesSourceUndoPath");
        assertThat(j19Ambiguous.evidenceLimit()).contains(
                "does not establish a real quality improvement", "journey completion");
        var j19Cancellation = profiles.get("journey-outcome-j19-cancellation");
        assertThat(j19Cancellation.tier()).isEqualTo(MediaTestHarness.TestTier.LOCAL_FIXTURE);
        assertThat(j19Cancellation.gradleTestTask()).isEqualTo(":services:media:modules:integration-tests:test");
        assertThat(j19Cancellation.selectors()).containsExactly(
                "com.ghatana.audio.video.integration.J19QualityOutcomeScenarioTest."
                        + "cancellationAfterCandidateDispatchRetainsKnownRevisionsWithoutReport");
        assertThat(j19Cancellation.evidenceLimit()).contains(
                "does not establish a real quality improvement", "journey completion");
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
    void directlyConstructedProfilesRejectBlankSelectorsAndSources() {
        assertThatThrownBy(() -> new MediaTestHarness.TestProfile(
                "direct-profile",
                MediaTestHarness.TestTier.LOCAL_FIXTURE,
                MediaTestHarness.TestCommandKind.GRADLE,
                ":services:media:integration-tests:test",
                List.of(),
                List.of(" "),
                List.of("integration-tests/src/test/java/ExampleTest.java"),
                List.of("JUnit"),
                List.of("local runtime"),
                "synthetic bytes",
                "isolated fixture",
                "fixture only"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("selectors entries must be non-blank");

        assertThatThrownBy(() -> new MediaTestHarness.TestProfile(
                "direct-profile",
                MediaTestHarness.TestTier.LOCAL_FIXTURE,
                MediaTestHarness.TestCommandKind.GRADLE,
                ":services:media:integration-tests:test",
                List.of(),
                List.of("ExampleTest.example"),
                List.of(" "),
                List.of("JUnit"),
                List.of("local runtime"),
                "synthetic bytes",
                "isolated fixture",
                "fixture only"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sources entries must be non-blank");
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
