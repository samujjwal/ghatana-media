package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaDevQualitySearch.Candidate;
import com.ghatana.media.launcher.MediaDevQualitySearch.Goal;
import com.ghatana.media.launcher.MediaDevQualitySearch.StopReason;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.function.IntPredicate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaDevQualitySearchTest {
    private static List<Integer> run(MediaDevQualitySearch search, IntPredicate feasible) {
        List<Integer> visited = new ArrayList<>();
        while (!search.done()) {
            int crf = search.next();
            visited.add(crf);
            search.record(crf, feasible.test(crf));
        }
        return visited;
    }

    @Test
    void minBytesBisectionFindsTheHighestFeasibleCrfWithinTheBudget() {
        MediaDevQualitySearch search = new MediaDevQualitySearch(Goal.MIN_BYTES_AT_QUALITY, 16, 40, 8);
        // quality holds up to CRF 27 inclusive
        List<Integer> visited = run(search, crf -> crf <= 27);
        assertThat(visited).containsExactly(28, 21, 24, 26, 27);
        assertThat(search.stopReason()).isEqualTo(StopReason.RANGE_EXHAUSTED);
        assertThat(visited).doesNotHaveDuplicates();
    }

    @Test
    void maxQualityBisectionFindsTheLowestCrfThatFitsTheByteBudget() {
        MediaDevQualitySearch search = new MediaDevQualitySearch(Goal.MAX_QUALITY_UNDER_BYTES, 16, 40, 8);
        List<Integer> visited = run(search, crf -> crf >= 33); // bytes fit from CRF 33 up
        assertThat(visited).containsExactly(28, 34, 31, 32, 33);
        assertThat(search.stopReason()).isEqualTo(StopReason.RANGE_EXHAUSTED);
    }

    @Test
    void theAttemptBudgetBoundsTheSearchAndIsReportedAsTheStopReason() {
        MediaDevQualitySearch search = new MediaDevQualitySearch(Goal.MIN_BYTES_AT_QUALITY, 12, 45, 2);
        assertThat(run(search, crf -> true)).hasSize(2);
        assertThat(search.stopReason()).isEqualTo(StopReason.ATTEMPT_BUDGET_EXHAUSTED);
        assertThatThrownBy(search::next).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void aSingleCrfRangeIsOneAttemptAndInvalidBoundsAreRefused() {
        assertThat(run(new MediaDevQualitySearch(Goal.MIN_BYTES_AT_QUALITY, 30, 30, 5), crf -> false)).containsExactly(30);
        assertThatThrownBy(() -> new MediaDevQualitySearch(Goal.MIN_BYTES_AT_QUALITY, 31, 30, 5))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MediaDevQualitySearch(Goal.MIN_BYTES_AT_QUALITY, 30, 31, 0))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void theSearchIsDeterministic() {
        List<Integer> a = run(new MediaDevQualitySearch(Goal.MIN_BYTES_AT_QUALITY, 14, 44, 6), crf -> crf <= 30);
        List<Integer> b = run(new MediaDevQualitySearch(Goal.MIN_BYTES_AT_QUALITY, 14, 44, 6), crf -> crf <= 30);
        assertThat(a).isEqualTo(b);
    }

    @Test
    void selectionNeverPicksAFailingAttemptAndFollowsTheDeclaredOrder() {
        List<Candidate> attempts = List.of(
                new Candidate(1, 28, 1_000, 0.91, true),
                new Candidate(2, 34, 600, 0.80, false),
                new Candidate(3, 31, 800, 0.93, true),
                new Candidate(4, 25, 800, 0.95, true));
        // smallest feasible file; the failing 600-byte attempt is never chosen; ties break to the lower CRF
        assertThat(MediaDevQualitySearch.choose(Goal.MIN_BYTES_AT_QUALITY, attempts).orElseThrow().index()).isEqualTo(4);
        // highest quality among feasible
        assertThat(MediaDevQualitySearch.choose(Goal.MAX_QUALITY_UNDER_BYTES, attempts).orElseThrow().index()).isEqualTo(4);
        // nothing feasible: abstain
        assertThat(MediaDevQualitySearch.choose(Goal.MIN_BYTES_AT_QUALITY,
                List.of(new Candidate(1, 30, 100, 0.5, false)))).isEmpty();
        assertThat(MediaDevQualitySearch.choose(Goal.MIN_BYTES_AT_QUALITY, List.of())).isEmpty();
    }
}
