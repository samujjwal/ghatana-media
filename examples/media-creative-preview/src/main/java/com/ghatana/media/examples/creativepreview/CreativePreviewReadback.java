package com.ghatana.media.examples.creativepreview;

import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

/** Strict independent readers for the two JSON-bearing preview artifacts. */
final class CreativePreviewReadback {
    private static final ObjectMapper JSON = new ObjectMapper(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build())
            .rebuild().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();

    record SimulationSummary(double startTimeSeconds, double endTimeSeconds, int observationCount) { }

    private CreativePreviewReadback() { }

    static JsonNode parseSupportedGlbJson(byte[] glb) throws IOException {
        ByteBuffer input = ByteBuffer.wrap(glb).order(ByteOrder.LITTLE_ENDIAN);
        if (input.remaining() < 28 || input.getInt() != 0x46546c67 || input.getInt() != 2
                || input.getInt() != input.limit()) {
            throw new IOException("GLB header/declared length failed independent readback");
        }
        int jsonLength = readChunkLength(input, 0x4e4f534a, "JSON");
        if (jsonLength < 2 || jsonLength % 4 != 0 || jsonLength > input.remaining() - 8) {
            throw new IOException("GLB JSON chunk failed supported-profile bounds check");
        }
        byte[] jsonBytes = new byte[jsonLength];
        input.get(jsonBytes);
        int binaryLength = readChunkLength(input, 0x004e4942, "BIN");
        if (binaryLength % 4 != 0 || binaryLength != input.remaining()) {
            throw new IOException("GLB BIN chunk failed supported-profile bounds check");
        }
        int binaryDataOffset = input.position();
        input.position(input.position() + binaryLength);
        if (input.hasRemaining()) throw new IOException("GLB has unsupported trailing chunks or bytes");

        String jsonText = decodeUtf8(jsonBytes, "GLB JSON chunk");
        JsonNode root = readJson(jsonText, "GLB JSON chunk");
        require(root.isObject(), "GLB JSON root must be an object");
        require("2.0".equals(root.path("asset").path("version").asString()), "GLB asset version is not 2.0");
        require("Ghatana Media bounded spatial rig".equals(root.path("asset").path("generator").asString()),
                "GLB generator is outside the supported local profile");

        JsonNode nodes = root.path("nodes");
        require(nodes.isArray() && nodes.size() == 1 && "root".equals(nodes.get(0).path("name").asString()),
                "GLB root rig node lineage is missing");
        JsonNode animations = root.path("animations");
        require(animations.isArray() && !animations.isEmpty(), "GLB animation is missing");
        JsonNode buffers = root.path("buffers");
        require(buffers.isArray() && buffers.size() == 1
                        && buffers.get(0).path("byteLength").asInt(-1) == binaryLength,
                "GLB buffer declaration does not match the BIN chunk");

        JsonNode mediaSpatial = root.path("extras").path("mediaSpatial");
        require("local-rig-v1".equals(mediaSpatial.path("rigId").asString()), "GLB rig lineage is missing");
        require("local-project:revision-v1".equals(mediaSpatial.path("sourceProjectRevisionRef").asString()),
                "GLB project revision lineage is missing");
        require("local-frame".equals(mediaSpatial.path("frameRef").asString())
                        && "v1".equals(mediaSpatial.path("frameVersionRef").asString()),
                "GLB coordinate frame lineage is missing");
        require("RIGHT_HANDED".equals(mediaSpatial.path("handedness").asString())
                        && mediaSpatial.path("axisDirections").isArray()
                        && mediaSpatial.path("axisDirections").size() == 3
                        && "POS_X".equals(mediaSpatial.path("axisDirections").get(0).asString())
                        && "POS_Y".equals(mediaSpatial.path("axisDirections").get(1).asString())
                        && "POS_Z".equals(mediaSpatial.path("axisDirections").get(2).asString())
                        && "urn:media:spatial:unit:metre:v1".equals(mediaSpatial.path("positionUnitRef").asString())
                        && "urn:media:spatial:orientation:unit-quaternion-xyzw:v1".equals(mediaSpatial.path("orientationUnitRef").asString()),
                "GLB coordinate profile is outside the supported right-handed metre/XYZW profile");
        require("FLOAT32_SECONDS".equals(mediaSpatial.path("timeEncoding").asString()),
                "GLB time encoding is missing");
        require("FLOAT32_APPROXIMATION".equals(mediaSpatial.path("lossDisposition").asString())
                        && mediaSpatial.path("float32LossFields").isArray()
                        && mediaSpatial.path("float32LossFields").size() == 3
                        && "animation.inputTimeSeconds".equals(mediaSpatial.path("float32LossFields").get(0).asString())
                        && "animation.outputTranslation".equals(mediaSpatial.path("float32LossFields").get(1).asString())
                        && "animation.outputRotation".equals(mediaSpatial.path("float32LossFields").get(2).asString()),
                "GLB float32 loss disposition is missing");
        JsonNode exactTimes = mediaSpatial.path("exactKeyframeTimes");
        require(exactTimes.isArray() && exactTimes.size() == 1
                        && "root".equals(exactTimes.get(0).path("boneId").asString())
                        && exactTimes.get(0).path("times").isArray()
                        && exactTimes.get(0).path("times").size() == 2
                        && "0".equals(exactTimes.get(0).path("times").get(0).get(0).asString())
                        && "1".equals(exactTimes.get(0).path("times").get(0).get(1).asString())
                        && "1".equals(exactTimes.get(0).path("times").get(1).get(0).asString())
                        && "1".equals(exactTimes.get(0).path("times").get(1).get(1).asString()),
                "GLB exact rational keyframe-time report is missing or mismatched");
        validateAnimationData(root, glb, binaryDataOffset, binaryLength, mediaSpatial);
        JsonNode sources = mediaSpatial.path("sourceVersions");
        require(sources.isArray() && sources.size() == 1
                        && "local-tenant".equals(sources.get(0).path("tenantId").asString())
                        && "fixture-artifact".equals(sources.get(0).path("artifactId").asString())
                        && "v1".equals(sources.get(0).path("versionId").asString()),
                "GLB source artifact version lineage is missing");
        return root;
    }

    /** Decodes the bounded one-node/two-keyframe fixture profile from the persisted BIN bytes. */
    private static void validateAnimationData(JsonNode root, byte[] glb, int binaryStart,
            int binaryLength, JsonNode mediaSpatial) throws IOException {
        JsonNode accessors = root.path("accessors");
        JsonNode views = root.path("bufferViews");
        JsonNode animations = root.path("animations");
        require(accessors.isArray() && accessors.size() == 3 && views.isArray() && views.size() == 3
                        && animations.isArray() && animations.size() == 1,
                "GLB animation is outside the supported single-root fixture profile");
        JsonNode animation = animations.get(0);
        JsonNode samplers = animation.path("samplers");
        JsonNode channels = animation.path("channels");
        require(samplers.isArray() && samplers.size() == 2 && channels.isArray() && channels.size() == 2,
                "GLB animation channel layout is outside the supported fixture profile");
        int inputAccessor = integer(samplers.get(0).path("input"), "animation input accessor");
        require(inputAccessor == integer(samplers.get(1).path("input"), "animation input accessor"),
                "GLB translation and rotation must share the exact same time accessor");
        require(integer(channels.get(0).path("sampler"), "translation sampler") == 0
                        && "translation".equals(channels.get(0).path("target").path("path").asString())
                        && integer(channels.get(1).path("sampler"), "rotation sampler") == 1
                        && "rotation".equals(channels.get(1).path("target").path("path").asString())
                        && integer(channels.get(0).path("target").path("node"), "translation node") == 0
                        && integer(channels.get(1).path("target").path("node"), "rotation node") == 0,
                "GLB animation targets do not match the supported root translation/rotation profile");
        float[] times = readFloatAccessor(glb, binaryStart, binaryLength, views, accessors,
                inputAccessor, "SCALAR", 1);
        JsonNode exactTimes = mediaSpatial.path("exactKeyframeTimes").get(0).path("times");
        require(times.length == exactTimes.size(), "GLB time accessor count differs from exact rational report");
        for (int index = 0; index < times.length; index++) {
            JsonNode rational = exactTimes.get(index);
            require(rational.isArray() && rational.size() == 2
                            && rational.get(0).isString() && rational.get(1).isString(),
                    "GLB exact rational time entry is malformed");
            double seconds;
            try {
                seconds = new java.math.BigDecimal(rational.get(0).asString())
                        .divide(new java.math.BigDecimal(rational.get(1).asString()),
                                java.math.MathContext.DECIMAL128).doubleValue();
            } catch (NumberFormatException | ArithmeticException malformed) {
                throw new IOException("GLB exact rational time entry is malformed", malformed);
            }
            require(Float.isFinite(times[index]) && Float.floatToIntBits(times[index])
                            == Float.floatToIntBits((float) seconds)
                            && (index == 0 || times[index] > times[index - 1]),
                    "GLB time accessor disagrees with exact rational keyframe-time report");
        }
        float[] translation = readFloatAccessor(glb, binaryStart, binaryLength, views, accessors,
                integer(samplers.get(0).path("output"), "translation accessor"), "VEC3", 3);
        float[] rotation = readFloatAccessor(glb, binaryStart, binaryLength, views, accessors,
                integer(samplers.get(1).path("output"), "rotation accessor"), "VEC4", 4);
        require(translation.length == times.length * 3 && rotation.length == times.length * 4,
                "GLB transform accessor counts differ from the time accessor");
        for (float value : translation) require(Float.isFinite(value), "GLB translation accessor contains a non-finite value");
        for (int index = 0; index < rotation.length; index += 4) {
            double norm = Math.sqrt(rotation[index] * rotation[index] + rotation[index + 1] * rotation[index + 1]
                    + rotation[index + 2] * rotation[index + 2] + rotation[index + 3] * rotation[index + 3]);
            require(Double.isFinite(norm) && Math.abs(norm - 1.0) < 1e-5,
                    "GLB rotation accessor contains a non-unit quaternion");
        }
    }

    private static float[] readFloatAccessor(byte[] glb, int binaryStart, int binaryLength,
            JsonNode views, JsonNode accessors, int accessorIndex, String type, int components) throws IOException {
        require(accessorIndex >= 0 && accessorIndex < accessors.size(), "GLB accessor index is out of bounds");
        JsonNode accessor = accessors.get(accessorIndex);
        require(integer(accessor.path("componentType"), "accessor component type") == 5126
                        && type.equals(accessor.path("type").asString()),
                "GLB animation accessor is outside the float32 supported profile");
        int count = integer(accessor.path("count"), "accessor count");
        int viewIndex = integer(accessor.path("bufferView"), "accessor buffer view");
        require(count == 2 && viewIndex >= 0 && viewIndex < views.size(),
                "GLB animation accessor count or buffer view is invalid");
        JsonNode view = views.get(viewIndex);
        require(integer(view.path("buffer"), "buffer view buffer") == 0,
                "GLB animation accessor references an unsupported buffer");
        int viewOffset = view.path("byteOffset").isMissingNode() ? 0
                : integer(view.path("byteOffset"), "buffer view byte offset");
        int viewLength = integer(view.path("byteLength"), "buffer view byte length");
        int accessorOffset = accessor.path("byteOffset").isMissingNode() ? 0
                : integer(accessor.path("byteOffset"), "accessor byte offset");
        int byteLength = count * components * Float.BYTES;
        require(view.path("byteStride").isMissingNode() && accessor.path("sparse").isMissingNode(),
                "GLB animation accessor uses unsupported stride or sparse encoding");
        long accessorEnd = (long) accessorOffset + byteLength;
        long viewEnd = (long) viewOffset + viewLength;
        long absoluteStart = (long) binaryStart + viewOffset + accessorOffset;
        long absoluteEnd = absoluteStart + byteLength;
        require(viewOffset >= 0 && accessorOffset >= 0 && viewLength >= 0
                        && accessorEnd <= viewLength && viewEnd <= binaryLength
                        && absoluteStart >= binaryStart && absoluteEnd <= (long) binaryStart + binaryLength
                        && absoluteEnd <= glb.length,
                "GLB animation accessor exceeds BIN chunk bounds");
        ByteBuffer data = ByteBuffer.wrap(glb).order(ByteOrder.LITTLE_ENDIAN);
        data.position(Math.toIntExact(absoluteStart));
        float[] result = new float[count * components];
        for (int index = 0; index < result.length; index++) result[index] = data.getFloat();
        return result;
    }

    private static int integer(JsonNode value, String label) throws IOException {
        require(value.isInt(), "GLB " + label + " must be an integer");
        return value.intValue();
    }

    static SimulationSummary parseSimulation(String json, String expectedSourceVersion) throws IOException {
        JsonNode root = readJson(json, "simulation JSON");
        require(root.isObject(), "simulation JSON root must be an object");
        require("DETERMINISTIC_SIMULATION_ONLY".equals(root.path("kind").asString()),
                "simulation evidence kind is missing");
        require(expectedSourceVersion.equals(root.path("sourceVersion").asString()),
                "simulation source version is missing or mismatched");
        require(root.path("solver").isString() && !root.path("solver").asString().isBlank(),
                "simulation solver identity is missing");
        require("DETERMINISTIC_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE".equals(root.path("evidenceClass").asString()),
                "simulation evidence limitation is missing");
        JsonNode clock = root.path("clock");
        require("local-simulation-clock".equals(clock.path("clockId").asString())
                        && "SECOND".equals(clock.path("timeUnit").asString()),
                "simulation clock identity is missing");

        JsonNode observations = root.path("observations");
        require(observations.isArray() && observations.size() >= 2, "simulation observations are missing");
        double previousTime = Double.NEGATIVE_INFINITY;
        for (JsonNode observation : observations) {
            require(observation.isObject(), "simulation observation must be an object");
            double time = finiteNumber(observation.path("timeSeconds"), "timeSeconds");
            finiteNumber(observation.path("positionMeters"), "positionMeters");
            finiteNumber(observation.path("velocityMetersPerSecond"), "velocityMetersPerSecond");
            require(time > previousTime, "simulation observation times must be strictly increasing");
            previousTime = time;
        }
        return new SimulationSummary(finiteNumber(observations.get(0).path("timeSeconds"), "timeSeconds"),
                previousTime, observations.size());
    }

    private static int readChunkLength(ByteBuffer source, int expectedType, String name) throws IOException {
        if (source.remaining() < 8) throw new IOException("GLB " + name + " chunk header is truncated");
        int length = source.getInt();
        int type = source.getInt();
        if (length < 0 || type != expectedType || length > source.remaining()) {
            throw new IOException("GLB " + name + " chunk header/bounds are invalid");
        }
        return length;
    }

    private static String decodeUtf8(byte[] bytes, String label) throws IOException {
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException malformed) {
            throw new IOException(label + " is not valid UTF-8", malformed);
        }
    }

    private static JsonNode readJson(String source, String label) throws IOException {
        try {
            JsonNode parsed = JSON.readTree(source);
            if (parsed == null) throw new IOException(label + " is empty");
            return parsed;
        } catch (tools.jackson.core.JacksonException malformed) {
            throw new IOException(label + " is not valid JSON", malformed);
        }
    }

    private static double finiteNumber(JsonNode value, String label) throws IOException {
        require(value.isNumber(), "simulation " + label + " must be a JSON number");
        double number = value.doubleValue();
        require(Double.isFinite(number), "simulation " + label + " must be finite");
        return number;
    }

    private static void require(boolean condition, String message) throws IOException {
        if (!condition) throw new IOException(message);
    }
}
