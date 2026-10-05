package com.ghatana.media.stt.eval;

import java.util.Arrays;
import java.util.List;

/**
 * Word Error Rate (WER) calculator.
 *
 * <p>WER is the standard metric for ASR quality evaluation:
 * <pre>
 *   WER = (S + D + I) / N
 * </pre>
 * where S = substitutions, D = deletions, I = insertions, N = words in reference.
 *
 * <p>The implementation uses dynamic programming (Wagner-Fischer / Levenshtein)
 * to find the minimum edit distance between the reference and hypothesis word
 * sequences.  Normalisation steps (strip punctuation, lower-case) match the
 * conventions used in standard ASR evaluation toolkits (sclite, JiWER).
 *
 * <p>Usage example:
 * <pre>{@code
 * WerCalculator calc = new WerCalculator();
 * WerCalculator.WerResult result = calc.compute(
 *     "the cat sat on the mat",
 *     "the cat sat on mat");
 * System.out.println(result.wer());  // 0.1667 (1 deletion / 6 words)
 * }</pre>
 *
 * @doc.type class
 * @doc.purpose WER evaluation metric for ASR quality benchmarking
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public class WerCalculator {

    /**
     * Compute WER between a reference transcript and a hypothesis transcript.
     *
     * @param reference   the ground-truth transcript
     * @param hypothesis  the ASR output to evaluate
     * @return detailed WER result
     */
    public WerResult compute(String reference, String hypothesis) {
        String[] refWords = tokenise(reference);
        String[] hypWords = tokenise(hypothesis);
        return computeFromWords(refWords, hypWords);
    }

    /**
     * Compute aggregate WER over a corpus of (reference, hypothesis) pairs.
     * Aggregation is at corpus level (total errors / total reference words),
     * which gives equal weight to longer utterances.
     *
     * @param pairs list of reference-hypothesis pairs
     * @return corpus-level WER result
     */
    public WerResult computeCorpus(List<Pair> pairs) {
        long totalSubstitutions = 0;
        long totalDeletions     = 0;
        long totalInsertions    = 0;
        long totalRefWords      = 0;

        for (Pair p : pairs) {
            WerResult r = compute(p.reference(), p.hypothesis());
            totalSubstitutions += r.substitutions();
            totalDeletions     += r.deletions();
            totalInsertions    += r.insertions();
            totalRefWords      += r.referenceLength();
        }

        double wer = totalRefWords == 0 ? 0.0
            : (double) (totalSubstitutions + totalDeletions + totalInsertions) / totalRefWords;

        return new WerResult(
            wer,
            (int) totalSubstitutions,
            (int) totalDeletions,
            (int) totalInsertions,
            (int) totalRefWords
        );
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private WerResult computeFromWords(String[] ref, String[] hyp) {
        int n = ref.length;
        int m = hyp.length;

        // Standard Levenshtein DP table
        int[][] dp = new int[n + 1][m + 1];
        for (int i = 0; i <= n; i++) dp[i][0] = i;
        for (int j = 0; j <= m; j++) dp[0][j] = j;

        for (int i = 1; i <= n; i++) {
            for (int j = 1; j <= m; j++) {
                if (ref[i - 1].equals(hyp[j - 1])) {
                    dp[i][j] = dp[i - 1][j - 1];
                } else {
                    dp[i][j] = 1 + Math.min(dp[i - 1][j - 1],       // substitution
                                   Math.min(dp[i - 1][j],             // deletion
                                            dp[i][j - 1]));           // insertion
                }
            }
        }

        // Back-trace to count operation types
        int subs = 0, dels = 0, ins = 0;
        int i = n, j = m;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && ref[i - 1].equals(hyp[j - 1])) {
                i--; j--;
            } else if (i > 0 && j > 0 && dp[i][j] == dp[i - 1][j - 1] + 1) {
                subs++; i--; j--;
            } else if (i > 0 && dp[i][j] == dp[i - 1][j] + 1) {
                dels++; i--;
            } else {
                ins++; j--;
            }
        }

        double wer = n == 0 ? (m == 0 ? 0.0 : 1.0) : (double) (subs + dels + ins) / n;
        return new WerResult(wer, subs, dels, ins, n);
    }

    /**
     * Tokenise a transcript into normalised word tokens.
     * Match sclite/JiWER conventions: lower-case, strip punctuation.
     */
    static String[] tokenise(String text) {
        if (text == null || text.isBlank()) return new String[0];
        return Arrays.stream(
                text.toLowerCase()
                    .replaceAll("[^a-z0-9'\\s]", "")
                    .replaceAll("\\s+", " ")
                    .trim()
                    .split(" ")
            )
            .filter(w -> !w.isEmpty())
            .toArray(String[]::new);
    }

    // ── Value types ───────────────────────────────────────────────────────────

    /**
     * Immutable WER result.
     *
     * @param wer             word error rate (0.0 = perfect, 1.0 = 100% errors)
     * @param substitutions   number of word substitutions
     * @param deletions       number of word deletions
     * @param insertions      number of word insertions
     * @param referenceLength number of words in the reference
     */
    public record WerResult(
        double wer,
        int    substitutions,
        int    deletions,
        int    insertions,
        int    referenceLength
    ) {
        /** Word accuracy = 1 − WER, clamped to [0,1]. */
        public double accuracy() {
            return Math.max(0.0, 1.0 - wer);
        }

        @Override
        public String toString() {
            return String.format("WER=%.2f%% (S=%d D=%d I=%d N=%d acc=%.2f%%)",
                wer * 100, substitutions, deletions, insertions, referenceLength, accuracy() * 100);
        }
    }

    /** A reference-hypothesis transcription pair. */
    public record Pair(String reference, String hypothesis) {}
}
