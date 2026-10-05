package com.ghatana.media.tts.phoneme;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Rule-based English phoneme converter.
 *
 * <p>Covers the most common English phonological patterns without any native
 * library dependency.  Suitable for development, testing, and environments
 * where espeak-ng is unavailable.  {@link EspeakNgPhonemeConverter} provides
 * higher accuracy in production.
 *
 * <p>The algorithm proceeds in three phases:
 * <ol>
 *   <li>Text normalisation — expand numbers, strip punctuation, lower-case.</li>
 *   <li>Irregular word dictionary — 60+ hand-coded exceptions.</li>
 *   <li>Rule engine — digraph/trigraph recognition, silent-e, vowel-pair,
 *       and single-character fallback rules.</li>
 * </ol>
 *
 * @doc.type class
 * @doc.purpose Rule-based English phonemiser (no native dependencies)
 * @doc.layer platform
 * @doc.pattern Strategy
 */
public class HeuristicPhonemeConverter implements TextToPhonemeConverter {

    // ── Irregular word dictionary ─────────────────────────────────────────────

    private static final Map<String, String> EXCEPTIONS = new HashMap<>();

    static {
        // Common irregular words (ARPAbet-style approximation)
        EXCEPTIONS.put("the",    "ðə");
        EXCEPTIONS.put("a",      "ə");
        EXCEPTIONS.put("an",     "æn");
        EXCEPTIONS.put("of",     "ɔv");
        EXCEPTIONS.put("to",     "tuː");
        EXCEPTIONS.put("in",     "ɪn");
        EXCEPTIONS.put("is",     "ɪz");
        EXCEPTIONS.put("it",     "ɪt");
        EXCEPTIONS.put("you",    "juː");
        EXCEPTIONS.put("he",     "hiː");
        EXCEPTIONS.put("she",    "ʃiː");
        EXCEPTIONS.put("we",     "wiː");
        EXCEPTIONS.put("they",   "ðeɪ");
        EXCEPTIONS.put("were",   "wɜr");
        EXCEPTIONS.put("are",    "ɑːr");
        EXCEPTIONS.put("was",    "wɔz");
        EXCEPTIONS.put("have",   "hæv");
        EXCEPTIONS.put("had",    "hæd");
        EXCEPTIONS.put("has",    "hæz");
        EXCEPTIONS.put("be",     "biː");
        EXCEPTIONS.put("been",   "bɪn");
        EXCEPTIONS.put("do",     "duː");
        EXCEPTIONS.put("does",   "dʌz");
        EXCEPTIONS.put("did",    "dɪd");
        EXCEPTIONS.put("would",  "wʊd");
        EXCEPTIONS.put("could",  "kʊd");
        EXCEPTIONS.put("should", "ʃʊd");
        EXCEPTIONS.put("will",   "wɪl");
        EXCEPTIONS.put("can",    "kæn");
        EXCEPTIONS.put("may",    "meɪ");
        EXCEPTIONS.put("might",  "maɪt");
        EXCEPTIONS.put("must",   "mʌst");
        EXCEPTIONS.put("shall",  "ʃæl");
        EXCEPTIONS.put("that",   "ðæt");
        EXCEPTIONS.put("this",   "ðɪs");
        EXCEPTIONS.put("with",   "wɪð");
        EXCEPTIONS.put("from",   "frɔm");
        EXCEPTIONS.put("by",     "baɪ");
        EXCEPTIONS.put("at",     "æt");
        EXCEPTIONS.put("for",    "fɔr");
        EXCEPTIONS.put("on",     "ɔn");
        EXCEPTIONS.put("or",     "ɔr");
        EXCEPTIONS.put("but",    "bʌt");
        EXCEPTIONS.put("not",    "nɔt");
        EXCEPTIONS.put("what",   "wɔt");
        EXCEPTIONS.put("who",    "huː");
        EXCEPTIONS.put("which",  "wɪtʃ");
        EXCEPTIONS.put("when",   "wɛn");
        EXCEPTIONS.put("where",  "wɛr");
        EXCEPTIONS.put("how",    "haʊ");
        EXCEPTIONS.put("why",    "waɪ");
        EXCEPTIONS.put("all",    "ɔːl");
        EXCEPTIONS.put("one",    "wʌn");
        EXCEPTIONS.put("two",    "tuː");
        EXCEPTIONS.put("three",  "θriː");
        EXCEPTIONS.put("four",   "fɔːr");
        EXCEPTIONS.put("five",   "faɪv");
        EXCEPTIONS.put("six",    "sɪks");
        EXCEPTIONS.put("seven",  "sɛvən");
        EXCEPTIONS.put("eight",  "eɪt");
        EXCEPTIONS.put("nine",   "naɪn");
        EXCEPTIONS.put("ten",    "tɛn");
        EXCEPTIONS.put("zero",   "zɪroʊ");
        EXCEPTIONS.put("come",   "kʌm");
        EXCEPTIONS.put("some",   "sʌm");
        EXCEPTIONS.put("give",   "ɡɪv");
        EXCEPTIONS.put("live",   "lɪv");
        EXCEPTIONS.put("love",   "lʌv");
        EXCEPTIONS.put("move",   "muːv");
        EXCEPTIONS.put("once",   "wʌns");
        EXCEPTIONS.put("sure",   "ʃʊr");
        EXCEPTIONS.put("your",   "jɔːr");
        EXCEPTIONS.put("their",  "ðɛr");
        EXCEPTIONS.put("there",  "ðɛr");
        EXCEPTIONS.put("here",   "hɪr");
        EXCEPTIONS.put("know",   "noʊ");
        EXCEPTIONS.put("known",  "noʊn");
        EXCEPTIONS.put("write",  "raɪt");
        EXCEPTIONS.put("right",  "raɪt");
        EXCEPTIONS.put("whole",  "hoʊl");
        EXCEPTIONS.put("world",  "wɜrld");
        EXCEPTIONS.put("word",   "wɜrd");
        EXCEPTIONS.put("work",   "wɜrk");
        EXCEPTIONS.put("other",  "ʌðər");
        EXCEPTIONS.put("over",   "oʊvər");
        EXCEPTIONS.put("under",  "ʌndər");
        EXCEPTIONS.put("after",  "æftər");
        EXCEPTIONS.put("again",  "əɡɛn");
        EXCEPTIONS.put("about",  "əbaʊt");
        EXCEPTIONS.put("above",  "əbʌv");
        EXCEPTIONS.put("across", "əkrɔs");
        EXCEPTIONS.put("also",   "ɔːlsoʊ");
    }

    // ── Digit expansion ───────────────────────────────────────────────────────

    private static final String[] ONES  = {
        "", "one", "two", "three", "four", "five",
        "six", "seven", "eight", "nine", "ten",
        "eleven", "twelve", "thirteen", "fourteen", "fifteen",
        "sixteen", "seventeen", "eighteen", "nineteen"
    };
    private static final String[] TENS  = {
        "", "", "twenty", "thirty", "forty", "fifty",
        "sixty", "seventy", "eighty", "ninety"
    };

    @Override
    public String convert(String text, Locale locale) {
        String normalised = normalise(text);
        String[] words = normalised.split("\\s+");
        StringBuilder sb = new StringBuilder();
        for (String word : words) {
            if (word.isEmpty()) continue;
            if (sb.length() > 0) sb.append(' ');
            sb.append(phonemiseWord(word));
        }
        return sb.toString();
    }

    @Override
    public int qualityTier() {
        return 1;
    }

    // ── Text normalisation ────────────────────────────────────────────────────

    private String normalise(String text) {
        // Expand digits to words
        text = java.util.regex.Pattern.compile("\\b(\\d+)\\b").matcher(text).replaceAll(m -> numberToWords(Integer.parseInt(m.group())));
        // Remove non-alpha (keep spaces)
        text = text.replaceAll("[^a-zA-Z\\s]", " ");
        // Collapse whitespace and lower-case
        return text.replaceAll("\\s+", " ").trim().toLowerCase(Locale.ROOT);
    }

    private String numberToWords(int n) {
        if (n < 0)  return "minus " + numberToWords(-n);
        if (n == 0) return "zero";
        if (n < 20) return ONES[n];
        if (n < 100) {
            String r = TENS[n / 10];
            return (n % 10 != 0) ? r + " " + ONES[n % 10] : r;
        }
        if (n < 1000) {
            String r = ONES[n / 100] + " hundred";
            return (n % 100 != 0) ? r + " " + numberToWords(n % 100) : r;
        }
        if (n < 1_000_000) {
            String r = numberToWords(n / 1000) + " thousand";
            return (n % 1000 != 0) ? r + " " + numberToWords(n % 1000) : r;
        }
        return String.valueOf(n); // fallback for very large numbers
    }

    // ── Word phonemisation ────────────────────────────────────────────────────

    private String phonemiseWord(String word) {
        if (EXCEPTIONS.containsKey(word)) {
            return EXCEPTIONS.get(word);
        }
        return applyRules(word);
    }

    /**
     * Apply character-level phoneme rules left-to-right.
     *
     * <p>Rules are checked in priority order:
     * <ol>
     *   <li>Silent-e (trailing 'e' after consonant).</li>
     *   <li>Trigraphs (tch).</li>
     *   <li>Digraphs (sh, ch, th, ph, wh, ck, ng, qu, gh, kn, wr).</li>
     *   <li>Vowel pairs (ai, ay, ea, ee, oa, oo, ou, ow, ie, ue, ei, au, aw).</li>
     *   <li>Single-character defaults.</li>
     * </ol>
     */
    private String applyRules(String w) {
        // Pre-process: strip silent trailing 'e' (e.g. "make" → "mak")
        boolean silentE = w.length() > 2
            && w.charAt(w.length() - 1) == 'e'
            && isConsonant(w.charAt(w.length() - 2))
            && isVowel(w.charAt(w.length() - 3));
        String word = silentE ? w.substring(0, w.length() - 1) : w;

        StringBuilder ph = new StringBuilder();
        int i = 0;
        while (i < word.length()) {
            char c = word.charAt(i);
            char n = (i + 1 < word.length()) ? word.charAt(i + 1) : 0;
            char n2 = (i + 2 < word.length()) ? word.charAt(i + 2) : 0;

            // ── Trigraph ──────────────────────────────────────────────────────
            if (c == 't' && n == 'c' && n2 == 'h') { ph.append("tʃ"); i += 3; continue; }

            // ── Digraphs ──────────────────────────────────────────────────────
            if (c == 's' && n == 'h') { ph.append("ʃ");    i += 2; continue; }
            if (c == 'c' && n == 'h') { ph.append("tʃ");   i += 2; continue; }
            if (c == 't' && n == 'h') { ph.append("θ");    i += 2; continue; }
            if (c == 'p' && n == 'h') { ph.append("f");    i += 2; continue; }
            if (c == 'w' && n == 'h') { ph.append("w");    i += 2; continue; }
            if (c == 'c' && n == 'k') { ph.append("k");    i += 2; continue; }
            if (c == 'n' && n == 'g') { ph.append("ŋ");    i += 2; continue; }
            if (c == 'q' && n == 'u') { ph.append("kw");   i += 2; continue; }
            if (c == 'g' && n == 'h') { i += 2; continue; }  // silent gh
            if (c == 'k' && n == 'n') { ph.append("n");    i += 2; continue; }
            if (c == 'w' && n == 'r') { ph.append("r");    i += 2; continue; }

            // ── Vowel pairs ───────────────────────────────────────────────────
            if (c == 'a') {
                if (n == 'i' || n == 'y')  { ph.append("eɪ"); i += 2; continue; }
                if (n == 'e')              { ph.append("iː"); i += 2; continue; }
                if (n == 'u' || n == 'w')  { ph.append("ɔː"); i += 2; continue; }
                if (silentE)               { ph.append("eɪ"); i += 1; continue; }
                ph.append("æ"); i++; continue;
            }
            if (c == 'e') {
                if (n == 'e' || n == 'a')  { ph.append("iː"); i += 2; continue; }
                if (n == 'i')              { ph.append("eɪ"); i += 2; continue; }
                ph.append("ɛ"); i++; continue;
            }
            if (c == 'i') {
                if (n == 'e')              { ph.append("iː"); i += 2; continue; }
                if (silentE)               { ph.append("aɪ"); i += 1; continue; }
                ph.append("ɪ"); i++; continue;
            }
            if (c == 'o') {
                if (n == 'a')              { ph.append("oʊ"); i += 2; continue; }
                if (n == 'o')              { ph.append("uː"); i += 2; continue; }
                if (n == 'u' || n == 'w')  { ph.append("aʊ"); i += 2; continue; }
                if (silentE)               { ph.append("oʊ"); i += 1; continue; }
                ph.append("ɔ"); i++; continue;
            }
            if (c == 'u') {
                if (n == 'e')              { ph.append("uː"); i += 2; continue; }
                if (silentE)               { ph.append("juː"); i += 1; continue; }
                ph.append("ʌ"); i++; continue;
            }

            // ── Consonants ────────────────────────────────────────────────────
            switch (c) {
                case 'b' -> ph.append("b");
                case 'c' -> ph.append((n == 'e' || n == 'i' || n == 'y') ? "s" : "k");
                case 'd' -> ph.append("d");
                case 'f' -> ph.append("f");
                case 'g' -> ph.append((n == 'e' || n == 'i' || n == 'y') ? "dʒ" : "ɡ");
                case 'h' -> ph.append("h");
                case 'j' -> ph.append("dʒ");
                case 'k' -> ph.append("k");
                case 'l' -> ph.append("l");
                case 'm' -> ph.append("m");
                case 'n' -> ph.append("n");
                case 'p' -> ph.append("p");
                case 'r' -> ph.append("r");
                case 's' -> ph.append((n == 'i' || n == 'e') && i > 0 ? "z" : "s");
                case 't' -> ph.append("t");
                case 'v' -> ph.append("v");
                case 'w' -> ph.append("w");
                case 'x' -> ph.append("ks");
                case 'y' -> ph.append(isVowel(n) ? "j" : "aɪ");
                case 'z' -> ph.append("z");
                default  -> ph.append(String.valueOf(c));
            }
            i++;
        }

        return ph.toString();
    }

    private static boolean isVowel(char c) {
        return "aeiou".indexOf(c) >= 0;
    }

    private static boolean isConsonant(char c) {
        return Character.isLetter(c) && !isVowel(c);
    }
}
