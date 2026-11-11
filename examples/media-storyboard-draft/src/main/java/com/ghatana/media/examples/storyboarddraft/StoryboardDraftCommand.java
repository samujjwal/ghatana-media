package com.ghatana.media.examples.storyboarddraft;

import com.ghatana.media.production.timeline.StoryboardPlanner;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Clock;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.RationalTime;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.core.json.JsonFactory;

import java.io.InputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** CLI and embeddable JSON API for preparing a source-free, local storyboard draft. */
public final class StoryboardDraftCommand {
    private static final int MAX_INPUT_BYTES = 1_048_576;
    // Match StoryboardPlanner's local safety ceilings before constructing domain snapshots.
    private static final int MAX_SCENES = 256;
    private static final int MAX_SHOTS_PER_SCENE = 1_024;
    private static final int MAX_TOTAL_SHOTS = 10_000;
    private static final ObjectMapper JSON = new ObjectMapper(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build());

    private StoryboardDraftCommand() { }

    public static void main(String[] args) throws Exception {
        if (args.length != 1) {
            System.err.println("Usage: storyboard-draft <brief.json>");
            System.exit(2);
        }
        Path input = Path.of(args[0]);
        try {
            try (InputStream stream = Files.newInputStream(input)) {
                System.out.println(render(readBoundedUtf8(stream)));
            }
        } catch (Exception error) {
            System.err.println("Invalid storyboard brief: " + error.getMessage());
            System.exit(2);
        }
    }

    /** Validates a source-free brief and returns deterministic ordered local-draft JSON. */
    public static String render(String inputJson) throws IOException {
        validateUtf8Size(inputJson);
        JsonNode root = JSON.reader(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(inputJson);
        object(root, "input");
        fields(root, Set.of("tenantId", "principalId", "projectId", "expectedProjectRevisionId",
                "scenePlanId", "semanticVersion", "brief", "scenes"), "input");
        Actor actor = new Actor(text(root, "tenantId"), text(root, "principalId"));
        String projectId = text(root, "projectId");
        String revisionId = text(root, "expectedProjectRevisionId");
        String planId = text(root, "scenePlanId");
        String semanticVersion = text(root, "semanticVersion");

        JsonNode briefNode = required(root, "brief", "input");
        object(briefNode, "brief");
        fields(briefNode, Set.of("briefId", "semanticVersion", "purpose", "narrative"), "brief");
        StoryboardPlanner.AuthoredBrief brief = new StoryboardPlanner.AuthoredBrief(
                text(briefNode, "briefId"), text(briefNode, "semanticVersion"),
                text(briefNode, "purpose"), text(briefNode, "narrative"), List.of());

        JsonNode sceneNodes = required(root, "scenes", "input");
        if (!sceneNodes.isArray()) throw invalid("scenes must be an array");
        if (sceneNodes.size() > MAX_SCENES) throw invalid("scenes exceeds the 256 scene safety limit");
        List<StoryboardPlanner.AuthoredScene> scenes = new ArrayList<>();
        int totalShots = 0;
        for (int sceneIndex = 0; sceneIndex < sceneNodes.size(); sceneIndex++) {
            JsonNode scene = sceneNodes.get(sceneIndex);
            String path = "scenes[" + sceneIndex + "]";
            object(scene, path);
            fields(scene, Set.of("sceneId", "order", "intent", "storyStart", "storyDuration", "shots"), path);
            JsonNode shotNodes = required(scene, "shots", path);
            if (!shotNodes.isArray()) throw invalid(path + ".shots must be an array");
            if (shotNodes.size() > MAX_SHOTS_PER_SCENE) {
                throw invalid(path + ".shots exceeds the 1024 shot safety limit");
            }
            if (totalShots > MAX_TOTAL_SHOTS - shotNodes.size()) {
                throw invalid("storyboard exceeds the 10000 total-shot safety limit");
            }
            totalShots += shotNodes.size();
            List<StoryboardPlanner.ShotInput> shots = new ArrayList<>();
            for (int shotIndex = 0; shotIndex < shotNodes.size(); shotIndex++) {
                JsonNode shot = shotNodes.get(shotIndex);
                String shotPath = path + ".shots[" + shotIndex + "]";
                object(shot, shotPath);
                fields(shot, Set.of("shotId", "order", "intent", "storyStart", "storyDuration"), shotPath);
                shots.add(new StoryboardPlanner.ShotInput(text(shot, "shotId"), integer(shot, "order"),
                        text(shot, "intent"), time(required(shot, "storyStart", shotPath), shotPath + ".storyStart"),
                        time(required(shot, "storyDuration", shotPath), shotPath + ".storyDuration"), List.of()));
            }
            scenes.add(new StoryboardPlanner.AuthoredScene(text(scene, "sceneId"), integer(scene, "order"),
                    text(scene, "intent"), time(required(scene, "storyStart", path), path + ".storyStart"),
                    time(required(scene, "storyDuration", path), path + ".storyDuration"), shots));
        }

        StoryboardPlanner planner = new StoryboardPlanner((ignoredActor, ignoredSource, ignoredPurpose) -> {
            throw new IllegalStateException("source references are not accepted by this local draft consumer");
        });
        StoryboardPlanner.ScenePlan plan = planner.prepare(actor, projectId, revisionId, planId, semanticVersion,
                brief, scenes);
        Map<String, Object> output = new LinkedHashMap<>();
        output.put("kind", "LOCAL_STORYBOARD_DRAFT_CANDIDATE");
        output.put("disposition", plan.disposition().name());
        output.put("state", plan.state().name());
        output.put("origin", "USER_AUTHORED_SOURCE_FREE");
        output.put("renderable", false);
        output.put("persistence", "NOT_PERFORMED");
        output.put("disclosure", "Local draft only. No source assets were consumed; this output is not persisted, reviewed, approved, or renderable.");
        Map<String, Object> scope = new LinkedHashMap<>();
        scope.put("tenantId", plan.tenantId());
        scope.put("principalId", plan.ownerPrincipalId());
        scope.put("projectId", plan.projectId());
        scope.put("expectedProjectRevisionId", plan.expectedProjectRevisionId());
        scope.put("scenePlanId", plan.scenePlanId());
        scope.put("semanticVersion", plan.semanticVersion());
        output.put("scope", scope);
        Map<String, Object> briefOutput = new LinkedHashMap<>();
        briefOutput.put("briefId", plan.brief().briefId());
        briefOutput.put("semanticVersion", plan.brief().semanticVersion());
        briefOutput.put("purpose", plan.brief().purpose());
        briefOutput.put("narrative", plan.brief().narrative());
        output.put("brief", briefOutput);
        output.put("scenes", plan.scenes().stream().map(StoryboardDraftCommand::sceneJson).toList());
        return JSON.writerWithDefaultPrettyPrinter().writeValueAsString(output);
    }

    /** Reads at most one byte beyond the accepted size and decodes UTF-8 without replacement. */
    static String readBoundedUtf8(InputStream input) throws IOException {
        byte[] bytes = input.readNBytes(MAX_INPUT_BYTES + 1);
        if (bytes.length == 0 || bytes.length > MAX_INPUT_BYTES) {
            throw invalid("Input JSON must contain between 1 byte and 1048576 bytes.");
        }
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException malformedUtf8) {
            throw invalid("input must be valid UTF-8");
        }
    }

    private static void validateUtf8Size(String input) {
        ByteBuffer bytes = ByteBuffer.allocate(MAX_INPUT_BYTES + 1);
        var encoder = StandardCharsets.UTF_8.newEncoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
        try {
            var result = encoder.encode(CharBuffer.wrap(input), bytes, true);
            if (result.isOverflow()) throw invalid("Input JSON must not exceed 1048576 UTF-8 bytes.");
            if (result.isError()) result.throwException();
            result = encoder.flush(bytes);
            if (result.isOverflow()) throw invalid("Input JSON must not exceed 1048576 UTF-8 bytes.");
            if (result.isError()) result.throwException();
        } catch (CharacterCodingException malformedUtf16) {
            throw invalid("input must be valid Unicode encodable as UTF-8");
        }
        if (bytes.position() > MAX_INPUT_BYTES) throw invalid("Input JSON must not exceed 1048576 UTF-8 bytes.");
        if (bytes.position() == 0) throw invalid("Input JSON must contain at least 1 UTF-8 byte.");
    }

    private static Map<String, Object> sceneJson(StoryboardPlanner.PlannedScene scene) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("sceneId", scene.sceneId());
        value.put("order", scene.authoredOrder());
        value.put("intent", scene.intent());
        value.put("storyStart", timeJson(scene.storyStart()));
        value.put("storyDuration", timeJson(scene.storyDuration()));
        value.put("storyEndExclusive", timeJson(scene.storyStart().plus(scene.storyDuration())));
        value.put("shots", scene.shots().stream().map(shot -> {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("shotId", shot.shotId());
            item.put("order", shot.authoredOrder());
            item.put("intent", shot.intent());
            item.put("storyStart", timeJson(shot.storyStart()));
            item.put("storyDuration", timeJson(shot.storyDuration()));
            item.put("storyEndExclusive", timeJson(shot.storyStart().plus(shot.storyDuration())));
            return item;
        }).toList());
        return value;
    }

    private static Map<String, Object> timeJson(RationalTime time) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("ticks", time.ticks());
        value.put("rateNumerator", time.rateNumerator());
        value.put("rateDenominator", time.rateDenominator());
        value.put("clock", Clock.STORY.name());
        return value;
    }

    private static RationalTime time(JsonNode node, String path) {
        object(node, path);
        fields(node, Set.of("ticks", "rateNumerator", "rateDenominator"), path);
        return new RationalTime(longInteger(node, "ticks", path), longInteger(node, "rateNumerator", path),
                longInteger(node, "rateDenominator", path), Clock.STORY);
    }

    private static String text(JsonNode node, String name) {
        JsonNode value = required(node, name, "object");
        if (!value.isTextual() || value.textValue().isBlank()) throw invalid(name + " must be a non-blank string");
        return value.textValue();
    }

    private static int integer(JsonNode node, String name) {
        long value = longInteger(node, name, "object");
        if (value < Integer.MIN_VALUE || value > Integer.MAX_VALUE) throw invalid(name + " must be a 32-bit integer");
        return (int) value;
    }

    private static long longInteger(JsonNode node, String name, String path) {
        JsonNode value = required(node, name, path);
        if (!value.isIntegralNumber() || !value.canConvertToLong()) throw invalid(path + "." + name + " must be an integer");
        return value.longValue();
    }

    private static JsonNode required(JsonNode node, String name, String path) {
        JsonNode value = node.get(name);
        if (value == null || value.isNull()) throw invalid(path + "." + name + " is required");
        return value;
    }

    private static void object(JsonNode node, String path) {
        if (node == null || !node.isObject()) throw invalid(path + " must be an object");
    }

    private static void fields(JsonNode node, Set<String> allowed, String path) {
        node.propertyNames().forEach(name -> {
            if (!allowed.contains(name)) throw invalid(path + " contains unsupported field '" + name + "'");
        });
    }

    private static IllegalArgumentException invalid(String message) { return new IllegalArgumentException(message); }
}
