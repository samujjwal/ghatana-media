package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.media.runtime.MediaRuntimeContracts;
import org.junit.jupiter.api.Test;

import java.util.AbstractList;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class CanonicalOperationPlanTest {
    @Test
    void acceptsTheRuntimeContractsChildLimit() {
        List<CanonicalChildSelection> children = selections(MediaRuntimeContracts.MultimodalOperationSpec.MAX_CHILDREN);

        CanonicalOperationPlan plan = new CanonicalOperationPlan("capability", children, null);

        assertThat(plan.children()).hasSize(MediaRuntimeContracts.MultimodalOperationSpec.MAX_CHILDREN);
    }

    @Test
    void rejectsExcessChildrenBeforeConsumingTheFirstExcessEntry() {
        int max = MediaRuntimeContracts.MultimodalOperationSpec.MAX_CHILDREN;
        AtomicInteger reads = new AtomicInteger();
        List<CanonicalChildSelection> hostile = new AbstractList<>() {
            @Override public CanonicalChildSelection get(int index) {
                reads.incrementAndGet();
                return child(index);
            }
            @Override public int size() { return max + 1; }
        };

        assertThatThrownBy(() -> new CanonicalOperationPlan("capability", hostile, null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("children exceed their bound of " + max);
        assertThat(reads).hasValue(max);
    }

    private static List<CanonicalChildSelection> selections(int count) {
        List<CanonicalChildSelection> children = new ArrayList<>(count);
        for (int index = 0; index < count; index++) children.add(child(index));
        return children;
    }

    private static CanonicalChildSelection child(int index) {
        return new CanonicalChildSelection("child-" + index,
                MediaRuntimeContracts.JobType.SPEECH_TO_TEXT, "", new byte[] {1},
                "application/octet-stream", "", java.util.Map.of());
    }
}
