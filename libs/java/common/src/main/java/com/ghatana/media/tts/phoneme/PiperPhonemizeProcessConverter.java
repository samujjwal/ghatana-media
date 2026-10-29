package com.ghatana.media.tts.phoneme;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

/**
 * Process adapter for the pinned {@code piper_phonemize} binary, which embeds the
 * canonical espeak-ng engine and produces the exact IPA phoneme stream Piper
 * voices were trained on. Each conversion runs a bounded subprocess with
 * bounded input length, wall-clock timeout and bounded output — the JVM never
 * links the GPL espeak library.
 */
public final class PiperPhonemizeProcessConverter implements TextToPhonemeConverter {

    /** Environment variable naming the pinned piper_phonemize binary. */
    public static final String PHONEMIZE_ENV = "GHATANA_MEDIA_PIPER_PHONEMIZE";
    /** Optional SHA-256 pin for the OS-specific binary; when set it must match exactly. */
    public static final String PHONEMIZE_SHA_ENV = "GHATANA_MEDIA_PIPER_PHONEMIZE_SHA256";

    private static final int MAX_TEXT_CHARS = 4_096;
    private static final int MAX_OUTPUT_BYTES = 64 * 1024;
    private static final Duration TIMEOUT = Duration.ofSeconds(15);
    private static final int QUALITY_TIER = 10;

    private final Path binary;
    private final Path espeakData;
    private final String language;

    private PiperPhonemizeProcessConverter(Path binary, Path espeakData, String language) {
        this.binary = binary;
        this.espeakData = espeakData;
        this.language = language;
    }

    /**
     * Creates a converter when the configured binary exists and is executable.
     * The binary must sit in the vendored {@code bin/} directory beside
     * {@code share/espeak-ng-data} (as in the official piper-phonemize release).
     */
    public static Optional<TextToPhonemeConverter> tryCreate() {
        String configured = System.getenv(PHONEMIZE_ENV);
        if (configured == null || configured.isBlank()) return Optional.empty();
        return tryCreate(Path.of(configured));
    }

    public static Optional<TextToPhonemeConverter> tryCreate(Path binaryPath) {
        try {
            Path binary = binaryPath.toRealPath();
            Path dataDir = binary.getParent().getParent().resolve("share/espeak-ng-data");
            if (!Files.isRegularFile(binary) || !Files.isExecutable(binary) || !Files.isDirectory(dataDir)
                    || !digestMatches(binary, System.getenv(PHONEMIZE_SHA_ENV))) {
                return Optional.empty();
            }
            return Optional.of(new PiperPhonemizeProcessConverter(binary, dataDir.toRealPath(), "en-us"));
        } catch (IOException | RuntimeException failure) {
            return Optional.empty();
        }
    }

    @Override
    public String convert(String text, Locale locale) {
        if (text == null || text.isBlank()) return "";
        if (text.length() > MAX_TEXT_CHARS) {
            throw new PhonemeConversionException("Phonemize input exceeds bounded length");
        }
        List<String> command = new ArrayList<>(List.of(
                binary.toString(), "-l", language, "--espeak_data", espeakData.toString()));
        Process process;
        Path errorLog = null;
        try {
            errorLog = Files.createTempFile("phonemize-", ".log");
            ProcessBuilder builder = new ProcessBuilder(command)
                    .redirectError(errorLog.toFile());
            // The vendored binary loads its bundled dylibs from ../lib.
            String dyldKey = System.getProperty("os.name", "").toLowerCase().contains("win")
                    ? "PATH" : "DYLD_LIBRARY_PATH";
            builder.environment().merge(dyldKey,
                    binary.getParent().getParent().resolve("lib").toString(),
                    (a, b) -> a.isBlank() ? b : a + ":" + b);
            process = builder.start();
        } catch (IOException failure) {
            if (errorLog != null) {
                try { Files.deleteIfExists(errorLog); } catch (IOException ignored) { }
            }
            throw new PhonemeConversionException("Phonemize process could not start", failure);
        }
        // One total deadline covers stdin write, stdout drain and exit: a blocked
        // pipe can never outlive the budget. stderr goes to a private temp file
        // that is always deleted.
        long deadline = System.nanoTime() + TIMEOUT.toNanos();
        java.io.ByteArrayOutputStream stdout = new java.io.ByteArrayOutputStream(MAX_OUTPUT_BYTES);
        Thread writer = new Thread(() -> {
            try (OutputStream stdin = process.getOutputStream()) {
                stdin.write(text.getBytes(StandardCharsets.UTF_8));
                stdin.write('\n');
            } catch (IOException ignored) { }
        }, "media-phonemize-stdin");
        writer.setDaemon(true);
        Thread drain = new Thread(() -> {
            try {
                var in = process.getInputStream();
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) >= 0) {
                    synchronized (stdout) {
                        stdout.write(buffer, 0,
                                Math.min(read, Math.max(0, MAX_OUTPUT_BYTES - stdout.size())));
                    }
                    if (stdout.size() >= MAX_OUTPUT_BYTES) break;
                }
            } catch (IOException ignored) { }
        }, "media-phonemize-drain");
        drain.setDaemon(true);
        try {
            writer.start();
            drain.start();
            boolean finished = process.waitFor(
                    Math.max(1L, TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())),
                    TimeUnit.MILLISECONDS);
            if (!finished) {
                killTree(process);
                throw new PhonemeConversionException("Phonemize process exceeded its time budget");
            }
            writer.join(2_000);
            drain.join(2_000);
            if (process.exitValue() != 0) {
                String err = Files.exists(errorLog) ? Files.readString(errorLog) : "";
                throw new PhonemeConversionException(
                        "Phonemize process failed: " + err.substring(0, Math.min(err.length(), 256)));
            }
            return extractPhonemes(stdout.toString(StandardCharsets.UTF_8));
        } catch (IOException failure) {
            killTree(process);
            throw new PhonemeConversionException("Phonemize process I/O failed", failure);
        } catch (InterruptedException interrupted) {
            killTree(process);
            Thread.currentThread().interrupt();
            throw new PhonemeConversionException("Phonemize process interrupted", interrupted);
        } finally {
            if (errorLog != null) {
                try { Files.deleteIfExists(errorLog); } catch (IOException ignored) { }
            }
        }
    }

    /** When a pin is configured the binary digest must match it exactly. */
    private static boolean digestMatches(Path binary, String expectedSha256) throws IOException {
        if (expectedSha256 == null || expectedSha256.isBlank()) return true;
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            try (var in = Files.newInputStream(binary)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) >= 0) digest.update(buffer, 0, read);
            }
            return java.security.MessageDigest.isEqual(
                    java.util.HexFormat.of().formatHex(digest.digest()).getBytes(StandardCharsets.UTF_8),
                    expectedSha256.trim().toLowerCase(java.util.Locale.ROOT)
                            .getBytes(StandardCharsets.UTF_8));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    /** Kills the worker and any descendants it spawned so nothing outlives the budget. */
    private static void killTree(Process process) {
        process.descendants().forEach(descendant -> {
            try { descendant.destroyForcibly(); } catch (RuntimeException ignored) { }
        });
        process.destroyForcibly();
        try { process.waitFor(2, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
    }

    @Override
    public int qualityTier() {
        return QUALITY_TIER;
    }

    /** Extracts the phoneme symbols array from piper_phonemize JSONL output. */
    private static String extractPhonemes(String jsonl) {
        String line = jsonl.lines().findFirst()
                .orElseThrow(() -> new PhonemeConversionException("Phonemize process produced no output"));
        String key = "\"phonemes\":[";
        int start = line.indexOf(key);
        if (start < 0) throw new PhonemeConversionException("Phonemize output lacks a phonemes array");
        int end = line.indexOf(']', start + key.length());
        if (end < 0) throw new PhonemeConversionException("Phonemize phonemes array is unterminated");
        String inside = line.substring(start + key.length(), end);
        StringBuilder out = new StringBuilder();
        int cursor = 0;
        while (cursor < inside.length()) {
            int open = inside.indexOf('"', cursor);
            if (open < 0) break;
            int close = open + 1;
            while (close < inside.length()
                    && (inside.charAt(close) != '"' || inside.charAt(close - 1) == '\\')) close++;
            if (close >= inside.length()) break;
            String symbol = inside.substring(open + 1, close);
            if (!"\\n".equals(symbol)) out.append(unescape(symbol));
            cursor = close + 1;
        }
        return out.toString();
    }

    private static String unescape(String value) {
        return value.replace("\\\"", "\"").replace("\\\\", "\\");
    }
}
