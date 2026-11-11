package com.ghatana.media.examples.storyboarddraft;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.util.Arrays;
import java.util.stream.IntStream;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class StoryboardDraftCommandTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void emitsDeterministicAuthoredSourceFreeOrderedNonRenderableDraft() throws Exception {
        String first = StoryboardDraftCommand.render(input(true));
        String second = StoryboardDraftCommand.render(input(false));
        assertEquals(first, second);

        JsonNode output = JSON.readTree(first);
        assertEquals("LOCAL_STORYBOARD_DRAFT_CANDIDATE", output.path("kind").textValue());
        assertEquals("LOCAL_DRAFT_CANDIDATE", output.path("disposition").textValue());
        assertEquals("LOCAL_DRAFT", output.path("state").textValue());
        assertEquals("USER_AUTHORED_SOURCE_FREE", output.path("origin").textValue());
        assertFalse(output.path("renderable").booleanValue());
        assertEquals("NOT_PERFORMED", output.path("persistence").textValue());
        assertTrue(output.path("disclosure").textValue().contains("not persisted, reviewed, approved, or renderable"));
        assertEquals("scene-first", output.path("scenes").get(0).path("sceneId").textValue());
        assertEquals("shot-first", output.path("scenes").get(0).path("shots").get(0).path("shotId").textValue());
        assertEquals(0, output.path("scenes").get(0).path("storyStart").path("ticks").longValue());
        assertEquals(2, output.path("scenes").get(0).path("storyEndExclusive").path("ticks").longValue());
        assertEquals(1, output.path("scenes").get(0).path("storyEndExclusive").path("rateNumerator").longValue());
        assertEquals(1, output.path("scenes").get(0).path("shots").get(0).path("storyStart").path("ticks").longValue());
        assertEquals(13, output.path("scenes").get(0).path("shots").get(0).path("storyEndExclusive").path("ticks").longValue());
        assertEquals(24, output.path("scenes").get(0).path("storyStart").path("rateNumerator").longValue());
        assertEquals("STORY", output.path("scenes").get(0).path("storyStart").path("clock").textValue());
        assertTrue(output.path("scenes").get(0).path("shots").get(0).has("exactSources") == false);
    }

    @Test
    void rejectsUnknownSourceReferenceFields() {
        String sourceBearing = input(true).replace("\"intent\":\"A person enters\"", "\"intent\":\"A person enters\",\"exactSources\":[]");
        assertThrows(IllegalArgumentException.class, () -> StoryboardDraftCommand.render(sourceBearing));
    }

    @Test
    void rejectsDuplicateSceneIdentitiesAndOrders() {
        String duplicateIdentity = input(true).replace("\"sceneId\":\"scene-second\"", "\"sceneId\":\"scene-first\"");
        assertThrows(IllegalArgumentException.class, () -> StoryboardDraftCommand.render(duplicateIdentity));
        String duplicateOrder = input(true).replace("\"sceneId\":\"scene-second\",\"order\":1", "\"sceneId\":\"scene-second\",\"order\":0");
        assertThrows(IllegalArgumentException.class, () -> StoryboardDraftCommand.render(duplicateOrder));
    }

    @Test
    void rejectsDuplicateShotIdsAcrossScenes() {
        String duplicate = input(true).replace("\"shotId\":\"shot-second\"", "\"shotId\":\"shot-first\"");
        assertThrows(IllegalArgumentException.class, () -> StoryboardDraftCommand.render(duplicate));
    }

    @Test
    void rejectsSceneAndPerSceneShotLimitsAtJsonBoundary() {
        String root = input(true).substring(0, input(true).indexOf("\"scenes\":"));
        String tooManyScenes = root + "\"scenes\":[" + String.join(",", java.util.Collections.nCopies(257, "{}")) + "]}";
        IllegalArgumentException sceneError = assertThrows(IllegalArgumentException.class,
                () -> StoryboardDraftCommand.render(tooManyScenes));
        assertTrue(sceneError.getMessage().contains("256 scene"));

        String shots = String.join(",", IntStream.range(0, 1_025).mapToObj(i -> "{}").toList());
        String tooManyShots = root + "\"scenes\":[{\"shots\":[" + shots + "]}]}";
        IllegalArgumentException shotError = assertThrows(IllegalArgumentException.class,
                () -> StoryboardDraftCommand.render(tooManyShots));
        assertTrue(shotError.getMessage().contains("1024 shot"));
    }

    @Test
    void rejectsOutOfSceneAndMalformedIntervalsAndDuplicateJsonProperties() throws Exception {
        String outside = input(true).replace("\"ticks\":1,\"rateNumerator\":24", "\"ticks\":60,\"rateNumerator\":24");
        assertThrows(IllegalArgumentException.class, () -> StoryboardDraftCommand.render(outside));
        String zeroRate = input(true).replace("\"rateNumerator\":24", "\"rateNumerator\":0");
        assertThrows(IllegalArgumentException.class, () -> StoryboardDraftCommand.render(zeroRate));
        assertThrows(Exception.class, () -> StoryboardDraftCommand.render("{\"tenantId\":\"t\",\"tenantId\":\"t\"}"));
    }

    @Test
    void rejectsOversizedPublicApiInputByUtf8ByteLength() {
        String oversized = " ".repeat(1_048_577);
        assertThrows(IllegalArgumentException.class, () -> StoryboardDraftCommand.render(oversized));
        String multibyteOversized = "é".repeat(524_289);
        assertThrows(IllegalArgumentException.class, () -> StoryboardDraftCommand.render(multibyteOversized));
    }

    @Test
    void boundedCliReadStopsAtOneBytePastLimitForGrowingInput() {
        AtomicInteger consumed = new AtomicInteger();
        InputStream growing = new InputStream() {
            @Override public int read() {
                consumed.incrementAndGet();
                return 'x';
            }

            @Override public int read(byte[] target, int offset, int length) {
                Arrays.fill(target, offset, offset + length, (byte) 'x');
                consumed.addAndGet(length);
                return length;
            }
        };
        assertThrows(IllegalArgumentException.class, () -> StoryboardDraftCommand.readBoundedUtf8(growing));
        assertEquals(1_048_577, consumed.get());
    }

    @Test
    void cliInputRequiresStrictUtf8AndApiRejectsTrailingJsonRootValues() {
        assertThrows(IllegalArgumentException.class, () -> StoryboardDraftCommand.readBoundedUtf8(
                new ByteArrayInputStream(new byte[] {(byte) 0xc3, (byte) 0x28})));
        assertThrows(Exception.class, () -> StoryboardDraftCommand.render(input(true) + " {}"));
    }

    private static String input(boolean reverse) {
        String firstScene = """
                {"sceneId":"scene-first","order":0,"intent":"Establish the room","storyStart":{"ticks":0,"rateNumerator":24,"rateDenominator":1},"storyDuration":{"ticks":48,"rateNumerator":24,"rateDenominator":1},"shots":[{"shotId":"shot-first","order":0,"intent":"A person enters","storyStart":{"ticks":1,"rateNumerator":24,"rateDenominator":1},"storyDuration":{"ticks":12,"rateNumerator":24,"rateDenominator":1}}]}
                """;
        String secondScene = """
                {"sceneId":"scene-second","order":1,"intent":"A quiet pause","storyStart":{"ticks":48,"rateNumerator":24,"rateDenominator":1},"storyDuration":{"ticks":24,"rateNumerator":24,"rateDenominator":1},"shots":[{"shotId":"shot-second","order":0,"intent":"Hold on the empty room","storyStart":{"ticks":48,"rateNumerator":24,"rateDenominator":1},"storyDuration":{"ticks":12,"rateNumerator":24,"rateDenominator":1}}]}
                """;
        return """
                {
                  "tenantId":"tenant-local", "principalId":"creator-local",
                  "projectId":"project-local", "expectedProjectRevisionId":"revision-local",
                  "scenePlanId":"plan-local", "semanticVersion":"v1",
                  "brief":{"briefId":"brief-local","semanticVersion":"v1","purpose":"personal-project","narrative":"A short authored scene without source material."},
                  "scenes":[%s,%s]
                }
                """.formatted(reverse ? secondScene : firstScene, reverse ? firstScene : secondScene);
    }
}
