package com.ghatana.multimodal.engine;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.OptionalLong;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Structural validator for the PDP-1 source-grounded cross-modal result artifact.
 *
 * <p>{@link #validate(Map, Map, Set)} validates a typed artifact pointer and a supplied
 * content value against {@code media.multimodal.result-content.cross-modal.v1}. It does
 * not retrieve content or establish that it belongs to the pointer's stored version; the
 * caller must obtain and authorize that exact version separately. It also does not resolve
 * dimensions, claims, profiles, methods, rights, or modalities.
 */
public final class SourceGroundedCrossModalResultValidator {

    public static final String ARTIFACT_TYPE =
            "source-grounded-cross-modal-result-with-provenance-and-uncertainty";
    public static final String CONTENT_SCHEMA_REF = "media.multimodal.result-content.cross-modal.v1";

    private static final Pattern ARTIFACT_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]*");
    private static final Pattern VERSION_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:+-]*");
    private static final Pattern DIMENSION_REF = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]*");
    private static final Pattern MEDIA_TYPE = Pattern.compile(
            "[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+");

    private SourceGroundedCrossModalResultValidator() { }

    /**
     * Validates and binds the supplied pointer/content structures to an immutable value.
     *
     * <p>The requested dimension references are compared exactly with every claim's
     * dimension-evidence keys. This structural check cannot prove that those dimensions
     * resolve to different supported modalities.
     *
     * @param typedArtifact closed typed output pointer
     * @param content source-grounded result content for the pointer's exact content schema
     * @param requestedDimensions exact dimensions from the corresponding analysis request
     * @return immutable structurally validated pointer and content
     * @throws IllegalArgumentException if any field violates the source schema or rules
     */
    public static ValidatedArtifact validate(
            Map<?, ?> typedArtifact, Map<?, ?> content, Set<String> requestedDimensions) {
        Set<String> dimensions = copyRequestedDimensions(requestedDimensions);
        ArtifactPointer pointer = parsePointer(typedArtifact);
        ResultContent resultContent = parseContent(content, dimensions);
        return new ValidatedArtifact(pointer, resultContent);
    }

    /** Validator-issued immutable holder; callers cannot forge a successful validation result. */
    public static final class ValidatedArtifact {
        private final ArtifactPointer pointer;
        private final ResultContent content;

        private ValidatedArtifact(ArtifactPointer pointer, ResultContent content) {
            this.pointer = Objects.requireNonNull(pointer, "pointer");
            this.content = Objects.requireNonNull(content, "content");
        }

        public ArtifactPointer pointer() { return pointer; }
        public ResultContent content() { return content; }
    }

    /** Immutable value DTO; only {@link ValidatedArtifact} represents validator-issued validation. */
    public record ArtifactPointer(
            String artifactType,
            String artifactId,
            String versionId,
            String contentSchemaRef,
            Optional<String> sourceRef,
            Optional<String> declaredMediaType,
            OptionalLong declaredByteLength) {
        public ArtifactPointer {
            Objects.requireNonNull(artifactType, "artifactType");
            Objects.requireNonNull(artifactId, "artifactId");
            Objects.requireNonNull(versionId, "versionId");
            Objects.requireNonNull(contentSchemaRef, "contentSchemaRef");
            sourceRef = Objects.requireNonNull(sourceRef, "sourceRef");
            declaredMediaType = Objects.requireNonNull(declaredMediaType, "declaredMediaType");
            declaredByteLength = Objects.requireNonNull(declaredByteLength, "declaredByteLength");
        }
    }

    public enum ResultDisposition { REPORTED, UNKNOWN, ABSTAINED }
    public enum ClaimDisposition { REPORTED, UNKNOWN, ABSTAINED }
    public enum EvidenceDisposition { PRESENT, UNKNOWN, ABSTAINED }
    public enum UncertaintyDisposition { QUANTIFIED, QUALITATIVE, UNKNOWN }

    /** Immutable value DTO; constructing it directly does not imply schema validation. */
    public record ResultContent(
            ResultDisposition resultDisposition,
            List<String> sourceRefs,
            List<Claim> claims,
            List<String> reasonRefs) {
        public ResultContent {
            Objects.requireNonNull(resultDisposition, "resultDisposition");
            sourceRefs = List.copyOf(Objects.requireNonNull(sourceRefs, "sourceRefs"));
            claims = List.copyOf(Objects.requireNonNull(claims, "claims"));
            reasonRefs = List.copyOf(Objects.requireNonNull(reasonRefs, "reasonRefs"));
        }
    }

    /** Immutable value DTO; constructing it directly does not imply schema validation. */
    public record Claim(
            String claimRef,
            ClaimDisposition disposition,
            Map<String, DimensionEvidence> dimensionEvidence,
            Uncertainty uncertainty) {
        public Claim {
            Objects.requireNonNull(claimRef, "claimRef");
            Objects.requireNonNull(disposition, "disposition");
            dimensionEvidence = Map.copyOf(Objects.requireNonNull(dimensionEvidence, "dimensionEvidence"));
            Objects.requireNonNull(uncertainty, "uncertainty");
        }
    }

    /** Immutable value DTO; constructing it directly does not imply schema validation. */
    public record DimensionEvidence(
            String sourceRef,
            EvidenceDisposition evidenceDisposition,
            List<String> evidenceRefs,
            List<String> reasonRefs) {
        public DimensionEvidence {
            Objects.requireNonNull(sourceRef, "sourceRef");
            Objects.requireNonNull(evidenceDisposition, "evidenceDisposition");
            evidenceRefs = List.copyOf(Objects.requireNonNull(evidenceRefs, "evidenceRefs"));
            reasonRefs = List.copyOf(Objects.requireNonNull(reasonRefs, "reasonRefs"));
        }
    }

    /** Immutable value DTO; constructing it directly does not imply schema validation. */
    public record Uncertainty(
            String scopeRef,
            UncertaintyDisposition disposition,
            EvidenceDisposition evidenceDisposition,
            List<String> evidenceRefs,
            List<String> limitationRefs,
            List<String> reasonRefs) {
        public Uncertainty {
            Objects.requireNonNull(scopeRef, "scopeRef");
            Objects.requireNonNull(disposition, "disposition");
            Objects.requireNonNull(evidenceDisposition, "evidenceDisposition");
            evidenceRefs = List.copyOf(Objects.requireNonNull(evidenceRefs, "evidenceRefs"));
            limitationRefs = List.copyOf(Objects.requireNonNull(limitationRefs, "limitationRefs"));
            reasonRefs = List.copyOf(Objects.requireNonNull(reasonRefs, "reasonRefs"));
        }
    }

    private static Set<String> copyRequestedDimensions(Set<String> requestedDimensions) {
        if (requestedDimensions == null || requestedDimensions.isEmpty() || requestedDimensions.size() > 32) {
            throw invalid("requestedDimensions", "must contain 1..32 exact dimension references");
        }
        Set<String> copy = new LinkedHashSet<>();
        for (String dimension : requestedDimensions) {
            requirePattern(dimension, 1, 128, DIMENSION_REF, "requestedDimensions");
            copy.add(dimension);
        }
        return Set.copyOf(copy);
    }

    private static ArtifactPointer parsePointer(Map<?, ?> raw) {
        Map<String, Object> artifact = object(raw, "artifact");
        requireKeys(artifact, Set.of("artifactType", "payload"), "artifact");
        String artifactType = string(artifact.get("artifactType"), 1, 128, "artifact.artifactType");
        if (!ARTIFACT_TYPE.equals(artifactType)) {
            throw invalid("artifact.artifactType", "must be " + ARTIFACT_TYPE);
        }
        Map<String, Object> payload = object(artifact.get("payload"), "artifact.payload");
        requireKeys(payload, Set.of("artifactId", "versionId", "contentSchemaRef"), "artifact.payload",
                Set.of("artifactId", "versionId", "contentSchemaRef", "sourceRef", "declaredMediaType",
                        "declaredByteLength"));
        String artifactId = patternString(payload.get("artifactId"), 1, 128, ARTIFACT_ID,
                "artifact.payload.artifactId");
        String versionId = patternString(payload.get("versionId"), 1, 128, VERSION_ID,
                "artifact.payload.versionId");
        String contentSchemaRef = string(payload.get("contentSchemaRef"), 1, 128,
                "artifact.payload.contentSchemaRef");
        if (!CONTENT_SCHEMA_REF.equals(contentSchemaRef)) {
            throw invalid("artifact.payload.contentSchemaRef", "must be " + CONTENT_SCHEMA_REF);
        }
        Optional<String> sourceRef = payload.containsKey("sourceRef")
                ? Optional.of(reference(payload.get("sourceRef"), "artifact.payload.sourceRef"))
                : Optional.empty();
        Optional<String> mediaType = payload.containsKey("declaredMediaType")
                ? Optional.of(patternString(payload.get("declaredMediaType"), 3, 127, MEDIA_TYPE,
                        "artifact.payload.declaredMediaType"))
                : Optional.empty();
        OptionalLong byteLength = payload.containsKey("declaredByteLength")
                ? OptionalLong.of(integer(payload.get("declaredByteLength"), 0, 2_147_483_648L,
                        "artifact.payload.declaredByteLength"))
                : OptionalLong.empty();
        return new ArtifactPointer(artifactType, artifactId, versionId, contentSchemaRef,
                sourceRef, mediaType, byteLength);
    }

    private static ResultContent parseContent(Map<?, ?> raw, Set<String> requestedDimensions) {
        Map<String, Object> content = object(raw, "content");
        requireKeys(content, Set.of("resultDisposition", "sourceRefs", "claims", "reasonRefs"), "content");
        ResultDisposition disposition = enumValue(content.get("resultDisposition"), ResultDisposition.class,
                "content.resultDisposition");
        List<String> sourceRefs = stringArray(content.get("sourceRefs"), 1, 64, "content.sourceRefs");
        List<?> rawClaims = array(content.get("claims"), 0, 512, "content.claims");
        List<String> reasonRefs = stringArray(content.get("reasonRefs"), 0, 64, "content.reasonRefs");
        List<Claim> claims = new ArrayList<>(rawClaims.size());
        for (int index = 0; index < rawClaims.size(); index++) {
            claims.add(parseClaim(rawClaims.get(index), requestedDimensions, "content.claims[" + index + "]"));
        }
        if (disposition == ResultDisposition.REPORTED && claims.isEmpty()) {
            throw invalid("content.claims", "REPORTED result requires at least one claim");
        }
        if (disposition != ResultDisposition.REPORTED && reasonRefs.isEmpty()) {
            throw invalid("content.reasonRefs", disposition + " result requires at least one reason reference");
        }
        return new ResultContent(disposition, sourceRefs, claims, reasonRefs);
    }

    private static Claim parseClaim(Object raw, Set<String> requestedDimensions, String path) {
        Map<String, Object> claim = object(raw, path);
        requireKeys(claim, Set.of("claimRef", "disposition", "dimensionEvidence", "uncertainty"), path);
        String claimRef = reference(claim.get("claimRef"), path + ".claimRef");
        ClaimDisposition disposition = enumValue(claim.get("disposition"), ClaimDisposition.class,
                path + ".disposition");
        Map<String, Object> rawEvidence = object(claim.get("dimensionEvidence"), path + ".dimensionEvidence");
        if (rawEvidence.size() < 2 || rawEvidence.size() > 32) {
            throw invalid(path + ".dimensionEvidence", "must contain 2..32 dimension entries");
        }
        if (!rawEvidence.keySet().equals(requestedDimensions)) {
            throw invalid(path + ".dimensionEvidence", "keys must equal the exact requested dimension set");
        }
        Map<String, DimensionEvidence> dimensionEvidence = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : rawEvidence.entrySet()) {
            String dimension = entry.getKey();
            requirePattern(dimension, 1, 128, DIMENSION_REF, path + ".dimensionEvidence key");
            dimensionEvidence.put(dimension, parseDimensionEvidence(entry.getValue(),
                    path + ".dimensionEvidence." + dimension));
        }
        Uncertainty uncertainty = parseUncertainty(claim.get("uncertainty"), path + ".uncertainty");
        if (!claimRef.equals(uncertainty.scopeRef())) {
            throw invalid(path + ".uncertainty.scopeRef", "must equal claimRef");
        }
        if (disposition == ClaimDisposition.REPORTED) {
            for (Map.Entry<String, DimensionEvidence> entry : dimensionEvidence.entrySet()) {
                DimensionEvidence evidence = entry.getValue();
                if (evidence.evidenceDisposition() != EvidenceDisposition.PRESENT || evidence.evidenceRefs().isEmpty()) {
                    throw invalid(path + ".dimensionEvidence." + entry.getKey(),
                            "REPORTED claim requires PRESENT evidence with at least one evidence reference");
                }
            }
            if (uncertainty.disposition() == UncertaintyDisposition.UNKNOWN
                    || uncertainty.evidenceDisposition() != EvidenceDisposition.PRESENT
                    || uncertainty.evidenceRefs().isEmpty()) {
                throw invalid(path + ".uncertainty",
                        "REPORTED claim requires quantified or qualitative PRESENT uncertainty with evidence");
            }
        } else if (uncertainty.disposition() != UncertaintyDisposition.UNKNOWN
                || uncertainty.reasonRefs().isEmpty()) {
            throw invalid(path + ".uncertainty",
                    disposition + " claim requires UNKNOWN uncertainty and at least one reason reference");
        }
        return new Claim(claimRef, disposition, dimensionEvidence, uncertainty);
    }

    private static DimensionEvidence parseDimensionEvidence(Object raw, String path) {
        Map<String, Object> evidence = object(raw, path);
        requireKeys(evidence, Set.of("sourceRef", "evidenceDisposition", "evidenceRefs", "reasonRefs"), path);
        String sourceRef = reference(evidence.get("sourceRef"), path + ".sourceRef");
        EvidenceDisposition disposition = enumValue(evidence.get("evidenceDisposition"), EvidenceDisposition.class,
                path + ".evidenceDisposition");
        List<String> evidenceRefs = stringArray(evidence.get("evidenceRefs"), 0, 64, path + ".evidenceRefs");
        List<String> reasonRefs = stringArray(evidence.get("reasonRefs"), 0, 64, path + ".reasonRefs");
        if (disposition == EvidenceDisposition.PRESENT && evidenceRefs.isEmpty()) {
            throw invalid(path + ".evidenceRefs", "PRESENT evidence requires at least one evidence reference");
        }
        if (disposition != EvidenceDisposition.PRESENT && reasonRefs.isEmpty()) {
            throw invalid(path + ".reasonRefs", disposition + " evidence requires at least one reason reference");
        }
        return new DimensionEvidence(sourceRef, disposition, evidenceRefs, reasonRefs);
    }

    private static Uncertainty parseUncertainty(Object raw, String path) {
        Map<String, Object> uncertainty = object(raw, path);
        requireKeys(uncertainty,
                Set.of("scopeRef", "disposition", "evidenceDisposition", "evidenceRefs", "limitationRefs",
                        "reasonRefs"), path);
        String scopeRef = reference(uncertainty.get("scopeRef"), path + ".scopeRef");
        UncertaintyDisposition disposition = enumValue(uncertainty.get("disposition"),
                UncertaintyDisposition.class, path + ".disposition");
        EvidenceDisposition evidenceDisposition = enumValue(uncertainty.get("evidenceDisposition"),
                EvidenceDisposition.class, path + ".evidenceDisposition");
        List<String> evidenceRefs = stringArray(uncertainty.get("evidenceRefs"), 0, 64, path + ".evidenceRefs");
        List<String> limitationRefs = stringArray(uncertainty.get("limitationRefs"), 0, 64,
                path + ".limitationRefs");
        List<String> reasonRefs = stringArray(uncertainty.get("reasonRefs"), 0, 64, path + ".reasonRefs");
        if (evidenceDisposition == EvidenceDisposition.PRESENT && evidenceRefs.isEmpty()) {
            throw invalid(path + ".evidenceRefs", "PRESENT uncertainty evidence requires at least one reference");
        }
        if (evidenceDisposition != EvidenceDisposition.PRESENT && reasonRefs.isEmpty()) {
            throw invalid(path + ".reasonRefs", evidenceDisposition + " uncertainty evidence requires a reason");
        }
        if (disposition == UncertaintyDisposition.UNKNOWN && reasonRefs.isEmpty()) {
            throw invalid(path + ".reasonRefs", "UNKNOWN uncertainty requires at least one reason reference");
        }
        return new Uncertainty(scopeRef, disposition, evidenceDisposition,
                evidenceRefs, limitationRefs, reasonRefs);
    }

    private static Map<String, Object> object(Object value, String path) {
        if (!(value instanceof Map<?, ?> map)) throw invalid(path, "must be an object");
        Map<String, Object> copy = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            if (!(entry.getKey() instanceof String key)) throw invalid(path, "object keys must be strings");
            copy.put(key, entry.getValue());
        }
        return copy;
    }

    private static void requireKeys(Map<String, Object> value, Set<String> required, String path) {
        requireKeys(value, required, path, required);
    }

    private static void requireKeys(Map<String, Object> value, Set<String> required,
            String path, Set<String> allowed) {
        if (!value.keySet().containsAll(required)) throw invalid(path, "missing required properties");
        if (!allowed.containsAll(value.keySet())) throw invalid(path, "additional properties are not allowed");
    }

    private static List<?> array(Object value, int minItems, int maxItems, String path) {
        if (!(value instanceof List<?> items) || items.size() < minItems || items.size() > maxItems) {
            throw invalid(path, "must be an array with " + minItems + ".." + maxItems + " items");
        }
        return items;
    }

    private static List<String> stringArray(Object value, int minItems, int maxItems, String path) {
        List<?> items = array(value, minItems, maxItems, path);
        List<String> result = new ArrayList<>(items.size());
        Set<String> seen = new LinkedHashSet<>();
        for (int index = 0; index < items.size(); index++) {
            String item = reference(items.get(index), path + "[" + index + "]");
            if (!seen.add(item)) throw invalid(path, "items must be unique");
            result.add(item);
        }
        return List.copyOf(result);
    }

    private static String reference(Object value, String path) {
        if (!(value instanceof String text) || !isOpaqueVersionedReference(text)) {
            throw invalid(path, "must be a well-formed opaque versioned reference without whitespace (1..384 code points)");
        }
        return text;
    }

    /** Mirrors the canonical MediaVersionRefRules semantics without exposing that internal runtime helper. */
    private static boolean isOpaqueVersionedReference(String value) {
        return value != null && !value.isEmpty()
                && value.codePointCount(0, value.length()) <= 384
                && hasWellFormedUtf16(value)
                && value.codePoints().noneMatch(SourceGroundedCrossModalResultValidator::isEcmaScriptWhitespace);
    }

    private static boolean hasWellFormedUtf16(String value) {
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (Character.isHighSurrogate(current)) {
                if (index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1))) return false;
                index++;
            } else if (Character.isLowSurrogate(current)) {
                return false;
            }
        }
        return true;
    }

    /** ECMAScript \S whitespace set used by the shared Media version-reference contract. */
    private static boolean isEcmaScriptWhitespace(int codePoint) {
        return switch (codePoint) {
            case 0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020,
                    0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF -> true;
            default -> codePoint >= 0x2000 && codePoint <= 0x200A;
        };
    }

    private static String string(Object value, int minLength, int maxLength, String path) {
        if (!(value instanceof String text) || text.length() < minLength || text.length() > maxLength) {
            throw invalid(path, "must be a string with length " + minLength + ".." + maxLength);
        }
        return text;
    }

    private static String patternString(Object value, int minLength, int maxLength, Pattern pattern, String path) {
        String text = string(value, minLength, maxLength, path);
        if (!pattern.matcher(text).matches()) throw invalid(path, "has invalid format");
        return text;
    }

    private static long integer(Object value, long minimum, long maximum, String path) {
        if (!(value instanceof Number number)) throw invalid(path, "must be an integer");
        double numericValue = number.doubleValue();
        if (!Double.isFinite(numericValue) || numericValue != Math.rint(numericValue)
                || numericValue < minimum || numericValue > maximum) {
            throw invalid(path, "must be an integer in " + minimum + ".." + maximum);
        }
        return (long) numericValue;
    }

    private static void requirePattern(String value, int minLength, int maxLength, Pattern pattern, String path) {
        if (value == null || value.length() < minLength || value.length() > maxLength
                || !pattern.matcher(value).matches()) {
            throw invalid(path, "contains an invalid reference");
        }
    }

    private static <E extends Enum<E>> E enumValue(Object value, Class<E> enumType, String path) {
        if (!(value instanceof String text)) throw invalid(path, "must be a string enum value");
        try {
            return Enum.valueOf(enumType, text);
        } catch (IllegalArgumentException invalidEnum) {
            throw invalid(path, "has unsupported value " + text);
        }
    }

    private static IllegalArgumentException invalid(String path, String reason) {
        return new IllegalArgumentException(path + " " + reason);
    }
}
