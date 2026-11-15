package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaDevSpeechRuntime.SpeechRefusedException;
import org.junit.jupiter.api.Test;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** J-09 storyboard contract: derived story time, frame alignment, typed paths, placeholders and the brief scaffold. */
class MediaDevStoryboardSpecTest {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String V1 = "sha256:" + "a".repeat(64);

    private static Map<String, Object> doc(String json) {
        return JSON.readValue(json, new TypeReference<LinkedHashMap<String, Object>>() { });
    }

    private static final String TWO_SCENES = """
            {"brief":{"title":"Launch","text":"Two scenes"},"format":{"width":320,"height":240,"fps":25},
             "scenes":[
              {"sceneId":"intro","title":"Intro","shots":[
                {"shotId":"a","durationMs":1000,"source":{"kind":"ANIMATION","spec":{"background":"#102030","shapes":[]}}},
                {"shotId":"b","durationMs":1520,"source":{"kind":"ASSET","artifactId":"art-1","artifactVersionId":"%s","sourceInMs":40}}]},
              {"sceneId":"outro","title":"Outro","narration":{"artifactId":"nar-1","artifactVersionId":"%s"},"shots":[
                {"shotId":"c","durationMs":2000,"source":{"kind":"PLACEHOLDER","note":"to be shot"}}]}]}
            """.formatted(V1, V1);

    @Test
    void storyTimeIsDerivedContiguousAndFrameAligned() {
        var sb = MediaDevStoryboardSpec.parse(doc(TWO_SCENES));
        assertThat(sb.totalMs()).isEqualTo(4520);
        var intro = sb.scenes().get(0);
        var outro = sb.scenes().get(1);
        assertThat(intro.startMs()).isZero();
        assertThat(intro.endMs()).isEqualTo(2520);
        assertThat(outro.startMs()).isEqualTo(2520);
        assertThat(intro.shots().get(0).startMs()).isZero();
        assertThat(intro.shots().get(1).startMs()).isEqualTo(1000);
        assertThat(outro.shots().get(0).startMs()).isEqualTo(2520);
        List<Object> timeline = sb.timeline();
        Map<?, ?> first = (Map<?, ?>) timeline.get(0);
        assertThat(first.get("frames")).isEqualTo(63L);
        assertThat(((Map<?, ?>) ((List<?>) first.get("shots")).get(1)).get("startFrame")).isEqualTo(25L);
    }

    @Test
    void reorderingScenesRecomputesEveryBoundary() {
        Map<String, Object> reordered = doc(TWO_SCENES);
        List<Object> scenes = MediaDevStoryboardSpec.list(reordered.get("scenes"), "$.scenes");
        scenes.add(0, scenes.remove(1));
        var sb = MediaDevStoryboardSpec.parse(reordered);
        assertThat(sb.scenes().get(0).sceneId()).isEqualTo("outro");
        assertThat(sb.scenes().get(0).startMs()).isZero();
        assertThat(sb.scenes().get(1).startMs()).isEqualTo(2000);
        assertThat(sb.scenes().get(1).shots().get(1).startMs()).isEqualTo(3000);
    }

    @Test
    void identicalContentHasIdenticalCanonicalBytes() {
        String once = MediaDevDubSupport.JSON.writeValueAsString(MediaDevStoryboardSpec.parse(doc(TWO_SCENES)).authored());
        String twice = MediaDevDubSupport.JSON.writeValueAsString(MediaDevStoryboardSpec.parse(doc(TWO_SCENES)).authored());
        assertThat(once).isEqualTo(twice);
    }

    private static SpeechRefusedException refused(String json) {
        return (SpeechRefusedException) catchThrowable(() -> MediaDevStoryboardSpec.parse(doc(json)));
    }

    private static Throwable catchThrowable(Runnable run) {
        try { run.run(); } catch (Throwable failure) { return failure; }
        throw new AssertionError("expected a refusal");
    }

    @Test
    void refusalsAreTyped422WithTheOffendingPath() {
        SpeechRefusedException notAligned = refused(TWO_SCENES.replace("1520", "1530"));
        assertThat(notAligned.status()).isEqualTo(422);
        assertThat(notAligned.code()).isEqualTo("DURATION_NOT_FRAME_ALIGNED");
        assertThat(notAligned.details()).containsEntry("path", "$.scenes[0].shots[1].durationMs");

        SpeechRefusedException duplicate = refused(TWO_SCENES.replace("\"shotId\":\"c\"", "\"shotId\":\"a\""));
        assertThat(duplicate.details()).containsEntry("path", "$.scenes[1].shots[0].shotId");

        SpeechRefusedException derived = refused(TWO_SCENES.replace("\"background\":\"#102030\"",
                "\"width\":64,\"background\":\"#102030\""));
        assertThat(derived.code()).isEqualTo("STORYBOARD_INVALID");
        assertThat(derived.details()).containsEntry("path", "$.scenes[0].shots[0].source.spec.width");

        SpeechRefusedException badColour = refused(TWO_SCENES.replace("#102030", "red"));
        assertThat(badColour.details().get("path").toString()).startsWith("$.scenes[0].shots[0].source.spec.");

        SpeechRefusedException unknownKind = refused(TWO_SCENES.replace("PLACEHOLDER", "STOCK"));
        assertThat(unknownKind.details()).containsEntry("path", "$.scenes[1].shots[0].source.kind");

        SpeechRefusedException badVersion = refused(TWO_SCENES.replaceFirst("sha256:a{64}", "v1"));
        assertThat(badVersion.details()).containsEntry("path", "$.scenes[0].shots[1].source.artifactVersionId");

        SpeechRefusedException extra = refused(TWO_SCENES.replace("\"title\":\"Intro\"", "\"title\":\"Intro\",\"startMs\":5"));
        assertThat(extra.details()).containsEntry("path", "$.scenes[0].startMs");

        SpeechRefusedException empty = refused("{\"brief\":{\"title\":\"t\",\"text\":\"x\"},\"scenes\":[]}");
        assertThat(empty.details()).containsEntry("path", "$.scenes");
    }

    @Test
    void briefScaffoldIsOnePlaceholderPerParagraphAndCannotRender() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("brief", Map.of("title", "Spring", "text", "Open on a field.\n\nSnow melts.\nBirds return."));
        body.putAll(MediaDevStoryboardSpec.draftScenes("Open on a field.\n\nSnow melts.\nBirds return."));
        var sb = MediaDevStoryboardSpec.parse(body);
        assertThat(sb.scenes()).hasSize(3);
        assertThat(sb.scenes()).allSatisfy(scene -> assertThat(scene.shots().get(0).kind())
                .isEqualTo(MediaDevStoryboardSpec.Kind.PLACEHOLDER));
        assertThat(sb.totalMs()).isEqualTo(6000);
    }

    @Test
    void aShotAboveTheCeilingIsRefused() {
        assertThatThrownBy(() -> MediaDevStoryboardSpec.parse(doc(TWO_SCENES.replace("1000", "61000"))))
                .isInstanceOf(SpeechRefusedException.class);
    }
}
