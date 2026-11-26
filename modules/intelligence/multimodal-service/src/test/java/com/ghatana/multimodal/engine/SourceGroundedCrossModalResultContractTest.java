package com.ghatana.multimodal.engine;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static com.ghatana.multimodal.engine.SourceGroundedCrossModalResultValidator.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class SourceGroundedCrossModalResultContractTest {

    private static final String DIMENSION_A = "dimension.audio.transcript";
    private static final String DIMENSION_B = "dimension.video.scene";
    private static final Set<String> REQUESTED_DIMENSIONS = Set.of(DIMENSION_A, DIMENSION_B);

    @Test
    void validatesReportedArtifactAndReturnsImmutableTypedValues() {
        Map<String, Object> pointer = validPointer();
        Map<String, Object> content = reportedContent();

        ValidatedArtifact validated = SourceGroundedCrossModalResultValidator.validate(
                pointer, content, REQUESTED_DIMENSIONS);

        assertThat(validated.pointer().artifactType()).isEqualTo(ARTIFACT_TYPE);
        assertThat(validated.pointer().artifactId()).isEqualTo("result-artifact-1");
        assertThat(validated.pointer().versionId()).isEqualTo("result-version-7");
        assertThat(validated.pointer().contentSchemaRef()).isEqualTo(CONTENT_SCHEMA_REF);
        assertThat(validated.content().resultDisposition()).isEqualTo(ResultDisposition.REPORTED);
        assertThat(validated.content().claims()).hasSize(1);
        assertThat(validated.content().claims().getFirst().dimensionEvidence())
                .containsOnlyKeys(DIMENSION_A, DIMENSION_B);

        ((Map<String, Object>) pointer.get("payload")).put("versionId", "mutated-version");
        ((List<String>) content.get("sourceRefs")).add("source-version-2");
        assertThat(validated.pointer().versionId()).isEqualTo("result-version-7");
        assertThat(validated.content().sourceRefs()).containsExactly("source-version-1");
        assertThatThrownBy(() -> validated.content().sourceRefs().add("source-version-3"))
                .isInstanceOf(UnsupportedOperationException.class);
        assertThatThrownBy(() -> validated.content().claims().getFirst().dimensionEvidence().clear())
                .isInstanceOf(UnsupportedOperationException.class);
    }

    @Test
    void allowsReasonedUnknownResultWithoutClaims() {
        Map<String, Object> content = mutable(
                "resultDisposition", "UNKNOWN",
                "sourceRefs", new ArrayList<>(List.of("source-version-1")),
                "claims", new ArrayList<>(),
                "reasonRefs", new ArrayList<>(List.of("reason.unresolved-linkage")));

        ValidatedArtifact validated = SourceGroundedCrossModalResultValidator.validate(
                validPointer(), content, REQUESTED_DIMENSIONS);

        assertThat(validated.content().resultDisposition()).isEqualTo(ResultDisposition.UNKNOWN);
        assertThat(validated.content().claims()).isEmpty();
        assertThat(validated.content().reasonRefs()).containsExactly("reason.unresolved-linkage");
    }

    @Test
    void oneRequestedDimensionIsStructurallyAllowedOnlyWhenThereAreNoClaims() {
        ValidatedArtifact unknown = SourceGroundedCrossModalResultValidator.validate(
                validPointer(), unknownContent(), Set.of(DIMENSION_A));

        assertThat(unknown.content().claims()).isEmpty();
        assertThat(unknown.content().resultDisposition()).isEqualTo(ResultDisposition.ABSTAINED);
        assertInvalid(validPointer(), reportedContent(), Set.of(DIMENSION_A));
    }

    @Test
    void rejectsWrongOrOpenTypedArtifactPointers() {
        Map<String, Object> wrongType = validPointer();
        wrongType.put("artifactType", "untyped-result");
        assertInvalid(wrongType, reportedContent(), REQUESTED_DIMENSIONS);

        Map<String, Object> extraField = validPointer();
        extraField.put("inlinePayload", "not-allowed");
        assertInvalid(extraField, reportedContent(), REQUESTED_DIMENSIONS);

        Map<String, Object> wrongSchema = validPointer();
        ((Map<String, Object>) wrongSchema.get("payload")).put("contentSchemaRef", "legacy-result-v0");
        assertInvalid(wrongSchema, reportedContent(), REQUESTED_DIMENSIONS);

        Map<String, Object> invalidLength = validPointer();
        ((Map<String, Object>) invalidLength.get("payload")).put("declaredByteLength", 2_147_483_649L);
        assertInvalid(invalidLength, reportedContent(), REQUESTED_DIMENSIONS);
    }

    @Test
    void rejectsUnknownContentFieldsEnumsAndDuplicateSourceReferences() {
        Map<String, Object> extraField = reportedContent();
        extraField.put("summary", "not part of the typed result");
        assertInvalid(validPointer(), extraField, REQUESTED_DIMENSIONS);

        Map<String, Object> badEnum = reportedContent();
        badEnum.put("resultDisposition", "PARTIAL");
        assertInvalid(validPointer(), badEnum, REQUESTED_DIMENSIONS);

        Map<String, Object> duplicateSources = reportedContent();
        duplicateSources.put("sourceRefs", new ArrayList<>(List.of("source-version-1", "source-version-1")));
        assertInvalid(validPointer(), duplicateSources, REQUESTED_DIMENSIONS);

        Map<String, Object> tooManySources = reportedContent();
        tooManySources.put("sourceRefs", repeated("source-version-", 65));
        assertInvalid(validPointer(), tooManySources, REQUESTED_DIMENSIONS);
    }

    @Test
    void requiresReportedResultsToHaveClaimsBoundToTheExactDimensionSet() {
        Map<String, Object> emptyReported = reportedContent();
        ((List<Object>) emptyReported.get("claims")).clear();
        assertInvalid(validPointer(), emptyReported, REQUESTED_DIMENSIONS);

        Map<String, Object> substitutedDimension = reportedContent();
        Map<String, Object> claim = firstClaim(substitutedDimension);
        Map<String, Object> evidence = mutable(
                "dimension.other", presentEvidence("source-version-1"),
                DIMENSION_B, presentEvidence("source-version-1"));
        claim.put("dimensionEvidence", evidence);
        assertInvalid(validPointer(), substitutedDimension, REQUESTED_DIMENSIONS);

        Map<String, Object> oneDimension = reportedContent();
        firstClaim(oneDimension).put("dimensionEvidence",
                mutable(DIMENSION_A, presentEvidence("source-version-1")));
        assertInvalid(validPointer(), oneDimension, REQUESTED_DIMENSIONS);

        assertInvalid(validPointer(), reportedContent(), Set.of(DIMENSION_A));
    }

    @Test
    void reportedClaimsRequirePresentEvidenceAndScopedMeasuredOrQualitativeUncertainty() {
        Map<String, Object> emptyEvidence = reportedContent();
        Map<String, Object> claim = firstClaim(emptyEvidence);
        Map<String, Object> dimension = dimensionEvidence(claim, DIMENSION_A);
        dimension.put("evidenceRefs", new ArrayList<>());
        assertInvalid(validPointer(), emptyEvidence, REQUESTED_DIMENSIONS);

        Map<String, Object> nonPresentEvidence = reportedContent();
        claim = firstClaim(nonPresentEvidence);
        dimensionEvidence(claim, DIMENSION_A).put("evidenceDisposition", "UNKNOWN");
        dimensionEvidence(claim, DIMENSION_A).put("reasonRefs", new ArrayList<>(List.of("reason.missing")));
        assertInvalid(validPointer(), nonPresentEvidence, REQUESTED_DIMENSIONS);

        Map<String, Object> wrongScope = reportedContent();
        ((Map<String, Object>) firstClaim(wrongScope).get("uncertainty")).put("scopeRef", "another-claim");
        assertInvalid(validPointer(), wrongScope, REQUESTED_DIMENSIONS);

        Map<String, Object> missingUncertaintyEvidence = reportedContent();
        Map<String, Object> uncertainty = (Map<String, Object>) firstClaim(missingUncertaintyEvidence).get("uncertainty");
        uncertainty.put("disposition", "QUALITATIVE");
        uncertainty.put("evidenceRefs", new ArrayList<>());
        assertInvalid(validPointer(), missingUncertaintyEvidence, REQUESTED_DIMENSIONS);
    }

    @Test
    void unknownAndAbstainedStatesRequireReasonReferences() {
        Map<String, Object> noResultReason = unknownContent();
        noResultReason.put("reasonRefs", new ArrayList<>());
        assertInvalid(validPointer(), noResultReason, REQUESTED_DIMENSIONS);

        Map<String, Object> unknownClaimNoReason = reportedContent();
        Map<String, Object> claim = firstClaim(unknownClaimNoReason);
        claim.put("disposition", "UNKNOWN");
        ((Map<String, Object>) claim.get("uncertainty")).put("disposition", "UNKNOWN");
        assertInvalid(validPointer(), unknownClaimNoReason, REQUESTED_DIMENSIONS);

        Map<String, Object> unknownEvidenceNoReason = reportedContent();
        claim = firstClaim(unknownEvidenceNoReason);
        Map<String, Object> evidence = dimensionEvidence(claim, DIMENSION_A);
        evidence.put("evidenceDisposition", "ABSTAINED");
        evidence.put("evidenceRefs", new ArrayList<>());
        evidence.put("reasonRefs", new ArrayList<>());
        assertInvalid(validPointer(), unknownEvidenceNoReason, REQUESTED_DIMENSIONS);

        Map<String, Object> abstainedUncertaintyNoReason = reportedContent();
        Map<String, Object> uncertainty = (Map<String, Object>) firstClaim(abstainedUncertaintyNoReason)
                .get("uncertainty");
        uncertainty.put("evidenceDisposition", "UNKNOWN");
        uncertainty.put("evidenceRefs", new ArrayList<>());
        uncertainty.put("reasonRefs", new ArrayList<>());
        assertInvalid(validPointer(), abstainedUncertaintyNoReason, REQUESTED_DIMENSIONS);
    }

    @Test
    void enforcesClaimBoundsAndOpaqueReferenceBounds() {
        Map<String, Object> emptyUnknown = unknownContent();
        emptyUnknown.put("claims", repeated("placeholder", 513));
        assertInvalid(validPointer(), emptyUnknown, REQUESTED_DIMENSIONS);

        Map<String, Object> oversizedClaimRef = reportedContent();
        firstClaim(oversizedClaimRef).put("claimRef", "c".repeat(385));
        assertInvalid(validPointer(), oversizedClaimRef, REQUESTED_DIMENSIONS);

        assertInvalid(validPointer(), unknownContent(), Set.of("invalid dimension", DIMENSION_B));
    }

    @Test
    void opaqueVersionedReferencesUseCanonicalUnicodeWhitespaceAndUtf16Rules() {
        String atCodePointLimit = "\uD83D\uDE00".repeat(384);
        Map<String, Object> pointer = validPointer();
        ((Map<String, Object>) pointer.get("payload")).put("sourceRef", atCodePointLimit);
        Map<String, Object> content = reportedContent();
        ((List<String>) content.get("sourceRefs")).set(0, atCodePointLimit);
        Map<String, Object> claim = firstClaim(content);
        claim.put("claimRef", atCodePointLimit);
        ((Map<String, Object>) claim.get("uncertainty")).put("scopeRef", atCodePointLimit);

        ValidatedArtifact validated = SourceGroundedCrossModalResultValidator.validate(
                pointer, content, REQUESTED_DIMENSIONS);

        assertThat(validated.pointer().sourceRef()).contains(atCodePointLimit);
        assertThat(validated.content().sourceRefs()).containsExactly(atCodePointLimit);
        assertThat(validated.content().claims().getFirst().claimRef()).isEqualTo(atCodePointLimit);

        Map<String, Object> overCodePointLimit = reportedContent();
        ((List<String>) overCodePointLimit.get("sourceRefs")).set(0, "\uD83D\uDE00".repeat(385));
        assertInvalid(validPointer(), overCodePointLimit, REQUESTED_DIMENSIONS);

        for (String invalid : new String[] {"source ref", "source\u00A0ref", "source\uFEFFref", "\uD800"}) {
            Map<String, Object> malformed = reportedContent();
            ((List<String>) malformed.get("sourceRefs")).set(0, invalid);
            assertInvalid(validPointer(), malformed, REQUESTED_DIMENSIONS);
        }

        // The canonical Media rule mirrors ECMAScript \S: NEL is allowed even though some Java
        // whitespace predicates classify it as whitespace.
        Map<String, Object> validNonEcmaWhitespace = reportedContent();
        ((List<String>) validNonEcmaWhitespace.get("sourceRefs")).set(0, "source\u0085ref");
        assertThat(SourceGroundedCrossModalResultValidator.validate(
                validPointer(), validNonEcmaWhitespace, REQUESTED_DIMENSIONS).content().sourceRefs())
                .containsExactly("source\u0085ref");
    }

    private static Map<String, Object> validPointer() {
        return mutable("artifactType", ARTIFACT_TYPE,
                "payload", mutable(
                        "artifactId", "result-artifact-1",
                        "versionId", "result-version-7",
                        "contentSchemaRef", CONTENT_SCHEMA_REF,
                        "sourceRef", "source-version-1",
                        "declaredMediaType", "application/json",
                        "declaredByteLength", 128));
    }

    private static Map<String, Object> reportedContent() {
        Map<String, Object> dimensionEvidence = mutable(
                DIMENSION_A, presentEvidence("source-version-1"),
                DIMENSION_B, presentEvidence("source-version-1"));
        Map<String, Object> uncertainty = mutable(
                "scopeRef", "claim.version-1",
                "disposition", "QUANTIFIED",
                "evidenceDisposition", "PRESENT",
                "evidenceRefs", new ArrayList<>(List.of("evidence.uncertainty-1")),
                "limitationRefs", new ArrayList<>(),
                "reasonRefs", new ArrayList<>());
        Map<String, Object> claim = mutable(
                "claimRef", "claim.version-1",
                "disposition", "REPORTED",
                "dimensionEvidence", dimensionEvidence,
                "uncertainty", uncertainty);
        return mutable(
                "resultDisposition", "REPORTED",
                "sourceRefs", new ArrayList<>(List.of("source-version-1")),
                "claims", new ArrayList<>(List.of(claim)),
                "reasonRefs", new ArrayList<>());
    }

    private static Map<String, Object> unknownContent() {
        return mutable(
                "resultDisposition", "ABSTAINED",
                "sourceRefs", new ArrayList<>(List.of("source-version-1")),
                "claims", new ArrayList<>(),
                "reasonRefs", new ArrayList<>(List.of("reason.no-reportable-claim")));
    }

    private static Map<String, Object> presentEvidence(String sourceRef) {
        return mutable(
                "sourceRef", sourceRef,
                "evidenceDisposition", "PRESENT",
                "evidenceRefs", new ArrayList<>(List.of("evidence." + sourceRef)),
                "reasonRefs", new ArrayList<>());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> firstClaim(Map<String, Object> content) {
        return (Map<String, Object>) ((List<Object>) content.get("claims")).getFirst();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> dimensionEvidence(Map<String, Object> claim, String dimension) {
        return (Map<String, Object>) ((Map<String, Object>) claim.get("dimensionEvidence")).get(dimension);
    }

    private static List<String> repeated(String prefix, int count) {
        List<String> values = new ArrayList<>(count);
        for (int index = 0; index < count; index++) values.add(prefix + index);
        return values;
    }

    private static void assertInvalid(Map<?, ?> pointer, Map<?, ?> content, Set<String> dimensions) {
        assertThatThrownBy(() -> SourceGroundedCrossModalResultValidator.validate(pointer, content, dimensions))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static Map<String, Object> mutable(Object... pairs) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (int index = 0; index < pairs.length; index += 2) {
            result.put((String) pairs[index], pairs[index + 1]);
        }
        return result;
    }
}
