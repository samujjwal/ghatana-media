package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaCreationContracts.Admission;
import com.ghatana.media.runtime.MediaCreationContracts.DeliveryOutcome;
import com.ghatana.media.runtime.MediaCreationContracts.DestinationEffect;
import com.ghatana.media.runtime.MediaCreationContracts.Lane;
import com.ghatana.media.runtime.MediaCreationContracts.Output;
import com.ghatana.media.runtime.MediaCreationContracts.ProvenanceMode;
import com.ghatana.media.runtime.MediaCreationContracts.QualifiedProfile;
import com.ghatana.media.runtime.MediaCreationContracts.RunDecision;
import com.ghatana.media.runtime.MediaCreationContracts.SourceVersion;
import com.ghatana.media.runtime.MediaCreationContracts.Specification;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaCreationContractsTest {
    private static final SourceVersion SOURCE = new SourceVersion("source-a", "sha256:" + "a".repeat(64));

    @Test
    void sourceFreeCreationAndSourceDerivedCompositionHaveDistinctInputs() {
        Specification creation = specification(Lane.SOURCE_FREE_CREATION, null, ProvenanceMode.CREATIVE);
        Specification composition = specification(Lane.SOURCE_DERIVED_COMPOSITION, SOURCE, ProvenanceMode.PRESERVE);
        assertThat(creation.source()).isNull();
        assertThat(composition.source()).isEqualTo(SOURCE);

        assertThatThrownBy(() -> specification(Lane.SOURCE_FREE_CREATION, SOURCE, ProvenanceMode.CREATIVE))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("must not reference");
        assertThatThrownBy(() -> specification(Lane.SOURCE_DERIVED_COMPOSITION, null, ProvenanceMode.PRESERVE))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("exact source version");
    }

    @Test
    void missingQualifiedProviderProducesNotAdmittedWithoutOutput() {
        RunDecision run = RunDecision.withoutQualifiedProvider("run-1",
                specification(Lane.SOURCE_FREE_CREATION, null, ProvenanceMode.CREATIVE));
        assertThat(run.admission()).isEqualTo(Admission.NOT_ADMITTED);
        assertThat(run.reason()).isEqualTo("NO_QUALIFIED_PROVIDER_PROFILE");
        assertThat(run.profile()).isEmpty();
        assertThatThrownBy(() -> Output.verified("out-1", run, new byte[] {1}, "audio/wav", List.of("creative")))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("non-admitted");
    }

    @Test
    void admittedOutputPinsIdentitiesDigestAndExactSourceProvenance() {
        Specification spec = specification(Lane.SOURCE_DERIVED_COMPOSITION, SOURCE, ProvenanceMode.PRESERVE);
        RunDecision run = new RunDecision("run-2", spec, Admission.ADMITTED,
                java.util.Optional.of(new QualifiedProfile("engine-a", "v1", "profile-a")), "");
        byte[] bytes = new byte[] {1, 2, 3, 4};
        Output output = Output.verified("output-b", run, bytes, "audio/wav",
                List.of("source-a", SOURCE.version(), "creative-plan:spec-1"));
        assertThat(output.digest()).isEqualTo(MediaCreationContracts.sha256(bytes));
        assertThat(output.runId()).isEqualTo("run-2");
        assertThat(output.specificationId()).isEqualTo("spec-1");
        assertThat(output.planId()).isEqualTo("plan-1");
        assertThat(output.profile()).isEqualTo(new QualifiedProfile("engine-a", "v1", "profile-a"));
        assertThat(output.provenanceRefs()).contains("urn:ghatana:media-provider:engine-a:v1:profile:profile-a");
        assertThat(output.preservesSource()).isTrue();
        assertThat(output.verifiesBytes(bytes)).isTrue();
        assertThat(output.verifiesBytes(new byte[] {4, 3, 2, 1})).isFalse();

        assertThatThrownBy(() -> new Output("source-a", "run-2", "spec-1", "plan-1", output.digest(),
                "audio/wav", List.of("source-a", SOURCE.version()), java.util.Optional.of(SOURCE), output.profile()))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("new artifact identity");
    }

    @Test
    void sourceDerivedOutputRequiresBothSourcePins() {
        Specification spec = specification(Lane.SOURCE_DERIVED_COMPOSITION, SOURCE, ProvenanceMode.CREATIVE);
        RunDecision run = new RunDecision("run-3", spec, Admission.ADMITTED,
                java.util.Optional.of(new QualifiedProfile("engine-a", "v1", "profile-a")), "");
        assertThatThrownBy(() -> Output.verified("output-c", run, new byte[] {9}, "video/mp4", List.of("creative-plan")))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("exact source identity and version");
    }

    @Test
    void deliveryIsSeparateAndUnknownCannotBePromotedWithoutReceipt() {
        DestinationEffect unknown = new DestinationEffect("effect-1", "out-1", "destination-1",
                DeliveryOutcome.UNKNOWN, "");
        assertThat(unknown.outcome()).isEqualTo(DeliveryOutcome.UNKNOWN);
        assertThatThrownBy(() -> new DestinationEffect("effect-2", "out-1", "destination-1",
                DeliveryOutcome.KNOWN, ""))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("receipt");
        assertThatThrownBy(() -> new DestinationEffect("effect-3", "out-1", "destination-1",
                DeliveryOutcome.UNKNOWN, "receipt:fake"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("only known delivery");
    }

    private static Specification specification(Lane lane, SourceVersion source, ProvenanceMode mode) {
        return new Specification("spec-1", "plan-1", lane, "v1", source, mode,
                "media-creation", "quality-rules-v1");
    }
}
