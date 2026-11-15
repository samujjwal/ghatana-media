package com.ghatana.media.launcher;

import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/**
 * Pure, deterministic bounded search over an integer CRF ladder (J-19). It never measures or encodes anything: the
 * caller reports each attempt's feasibility and this class decides the next CRF and, at the end, which MEASURED
 * attempt (if any) is chosen.
 *
 * <p>Both goals are monotone in the CRF to a first approximation (a higher CRF gives a smaller file and lower quality),
 * so the next CRF is the midpoint of the interval that can still contain the best feasible attempt. Monotonicity is only
 * used to decide where to look next: the chosen attempt is always one that was actually measured and satisfied the
 * target, never an extrapolation, and the report says whether the ladder was exhausted or the attempt budget ended the
 * search (so a "best of what was tried" result is never presented as a proven optimum).
 */
final class MediaDevQualitySearch {
    enum Goal { MIN_BYTES_AT_QUALITY, MAX_QUALITY_UNDER_BYTES }

    enum StopReason { RANGE_EXHAUSTED, ATTEMPT_BUDGET_EXHAUSTED }

    /** One measured attempt as the search sees it. {@code quality} is the target metric's rounded value. */
    record Candidate(int index, int crf, long bytes, double quality, boolean feasible) { }

    private final Goal goal;
    private final int maxAttempts;
    private int lo;
    private int hi;
    private int attempts;

    MediaDevQualitySearch(Goal goal, int crfMin, int crfMax, int maxAttempts) {
        if (goal == null || crfMin > crfMax || maxAttempts < 1) throw new IllegalArgumentException("invalid search bounds");
        this.goal = goal;
        this.lo = crfMin;
        this.hi = crfMax;
        this.maxAttempts = maxAttempts;
    }

    boolean done() { return lo > hi || attempts >= maxAttempts; }

    StopReason stopReason() { return lo > hi ? StopReason.RANGE_EXHAUSTED : StopReason.ATTEMPT_BUDGET_EXHAUSTED; }

    int next() {
        if (done()) throw new IllegalStateException("the search is finished");
        return lo + (hi - lo) / 2;
    }

    /** Reports the feasibility of the attempt at {@code crf}, narrowing the interval that is still worth trying. */
    void record(int crf, boolean feasible) {
        attempts++;
        boolean higherCrfCanStillBeFeasible = goal == Goal.MIN_BYTES_AT_QUALITY;
        if (feasible == higherCrfCanStillBeFeasible) lo = crf + 1;
        else hi = crf - 1;
    }

    /**
     * The best feasible attempt, or empty (the caller abstains). MIN_BYTES_AT_QUALITY: fewest bytes, then lowest CRF.
     * MAX_QUALITY_UNDER_BYTES: highest quality, then fewest bytes, then lowest CRF.
     */
    static Optional<Candidate> choose(Goal goal, List<Candidate> attempts) {
        Comparator<Candidate> order = goal == Goal.MIN_BYTES_AT_QUALITY
                ? Comparator.comparingLong(Candidate::bytes).thenComparingInt(Candidate::crf)
                : Comparator.comparingDouble(Candidate::quality).reversed().thenComparingLong(Candidate::bytes)
                        .thenComparingInt(Candidate::crf);
        return attempts.stream().filter(Candidate::feasible).min(order);
    }
}
