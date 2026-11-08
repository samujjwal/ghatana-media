package com.ghatana.media.tts.phoneme;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

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
    /** Required SHA-256 pin for the OS-specific binary. */
    public static final String PHONEMIZE_SHA_ENV = "GHATANA_MEDIA_PIPER_PHONEMIZE_SHA256";
    /** Required SHA-256 tree pin for the bundled dynamic-library directory. */
    public static final String PHONEMIZE_LIB_SHA_ENV = "GHATANA_MEDIA_PIPER_LIB_SHA256";
    /** Required SHA-256 tree pin for adjacent {@code share/espeak-ng-data}. */
    public static final String ESPEAK_DATA_SHA_ENV = "GHATANA_MEDIA_ESPEAK_DATA_SHA256";

    private static final int MAX_TEXT_CHARS = 4_096;
    private static final int MAX_STDOUT_BYTES = 64 * 1024;
    private static final int MAX_STDERR_BYTES = 16 * 1024;
    private static final int MAX_TREE_ENTRIES = 100_000;
    private static final long MAX_TREE_BYTES = 1024L * 1024 * 1024;
    private static final Duration TIMEOUT = Duration.ofSeconds(15);
    private static final int QUALITY_TIER = 10;

    private final Path binary;
    private final Path bundle;
    private final Path libraryDir;
    private final Path espeakData;
    private final String binarySha256;
    private final String librarySha256;
    private final String espeakDataSha256;
    private final String language;

    private PiperPhonemizeProcessConverter(
            Path binary, Path bundle, Path libraryDir, Path espeakData,
            String binarySha256, String librarySha256, String espeakDataSha256, String language) {
        this.binary = binary;
        this.bundle = bundle;
        this.libraryDir = libraryDir;
        this.espeakData = espeakData;
        this.binarySha256 = binarySha256;
        this.librarySha256 = librarySha256;
        this.espeakDataSha256 = espeakDataSha256;
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
        return tryCreate(binaryPath, System.getenv(PHONEMIZE_SHA_ENV),
                System.getenv(PHONEMIZE_LIB_SHA_ENV), System.getenv(ESPEAK_DATA_SHA_ENV));
    }

    static Optional<TextToPhonemeConverter> tryCreate(
            Path binaryPath, String expectedBinarySha256,
            String expectedLibrarySha256, String expectedEspeakDataSha256) {
        try {
            Path binary = binaryPath.toRealPath();
            Path bundle = binary.getParent().getParent().toRealPath();
            Path libraryDir = bundle.resolve("lib");
            Path dataDir = bundle.resolve("share/espeak-ng-data");
            String binaryPin = normalizePin(expectedBinarySha256);
            String libraryPin = normalizePin(expectedLibrarySha256);
            String dataPin = normalizePin(expectedEspeakDataSha256);
            if (!Files.isRegularFile(binary, LinkOption.NOFOLLOW_LINKS) || !Files.isExecutable(binary)
                    || !isContainedNonSymlinkDirectory(bundle, libraryDir)
                    || !isContainedNonSymlinkDirectory(bundle, dataDir)
                    || binaryPin == null || libraryPin == null || dataPin == null
                    || !digestMatches(binary, binaryPin)
                    || !digestTree(libraryDir).equals(libraryPin)
                    || !digestTree(dataDir).equals(dataPin)) {
                return Optional.empty();
            }
            return Optional.of(new PiperPhonemizeProcessConverter(
                    binary, bundle, libraryDir.toRealPath(), dataDir.toRealPath(),
                    binaryPin, libraryPin, dataPin, "en-us"));
        } catch (IOException | RuntimeException failure) {
            return Optional.empty();
        }
    }

    @Override
    public String convert(String text, Locale locale) {
        requireSupportedLocale(locale);
        if (text == null || text.isBlank()) return "";
        if (text.length() > MAX_TEXT_CHARS) {
            throw new PhonemeConversionException("Phonemize input exceeds bounded length");
        }
        long deadline = System.nanoTime() + TIMEOUT.toNanos();
        revalidatePinnedAssets(deadline);
        List<String> command = new ArrayList<>(List.of(
                binary.toString(), "-l", language, "--espeak_data", espeakData.toString()));
        Process process;
        try {
            ensureWithinDeadline(deadline);
            ProcessBuilder builder = new ProcessBuilder(command);
            // The vendored binary loads its bundled dylibs from ../lib.
            String libraryPathKey = libraryPathEnvironmentKey(System.getProperty("os.name", ""));
            builder.environment().merge(libraryPathKey, libraryDir.toString(),
                    (existing, bundled) -> existing.isBlank()
                            ? bundled : bundled + libraryPathSeparator() + existing);
            process = builder.start();
            ensureWithinDeadlineAfterStart(process, deadline);
        } catch (PhonemeConversionException failure) {
            throw failure;
        } catch (IOException failure) {
            throw new PhonemeConversionException("Phonemize process could not start", failure);
        }
        // One total deadline covers stdin write, both output drains and exit. Both
        // output pipes are drained concurrently into bounded memory; diagnostics
        // are never spooled to an unbounded temporary file.
        java.io.ByteArrayOutputStream stdout = new java.io.ByteArrayOutputStream(MAX_STDOUT_BYTES);
        java.io.ByteArrayOutputStream stderr = new java.io.ByteArrayOutputStream(MAX_STDERR_BYTES);
        AtomicBoolean stdoutExceeded = new AtomicBoolean();
        AtomicBoolean stderrExceeded = new AtomicBoolean();
        Thread writer = new Thread(() -> {
            try (OutputStream stdin = process.getOutputStream()) {
                stdin.write(text.getBytes(StandardCharsets.UTF_8));
                stdin.write('\n');
            } catch (IOException ignored) { }
        }, "media-phonemize-stdin");
        writer.setDaemon(true);
        Thread drain = drainStream(process, process.getInputStream(), stdout,
                MAX_STDOUT_BYTES, stdoutExceeded, "media-phonemize-stdout");
        Thread drainError = drainStream(process, process.getErrorStream(), stderr,
                MAX_STDERR_BYTES, stderrExceeded, "media-phonemize-stderr");
        drain.setDaemon(true);
        drainError.setDaemon(true);
        try {
            writer.start();
            drain.start();
            drainError.start();
            long remaining = deadline - System.nanoTime();
            boolean finished = remaining > 0 && process.waitFor(remaining, TimeUnit.NANOSECONDS);
            if (!finished) {
                killTree(process);
                throw new PhonemeConversionException("Phonemize process exceeded its time budget");
            }
            joinBeforeDeadline(writer, process, deadline, "stdin writer");
            joinBeforeDeadline(drain, process, deadline, "stdout drain");
            joinBeforeDeadline(drainError, process, deadline, "stderr drain");
            if (stdoutExceeded.get()) {
                throw new PhonemeConversionException("Phonemize process exceeded its stdout budget");
            }
            if (stderrExceeded.get()) {
                throw new PhonemeConversionException("Phonemize process exceeded its stderr budget");
            }
            if (process.exitValue() != 0) {
                String err = stderr.toString(StandardCharsets.UTF_8);
                throw new PhonemeConversionException(
                        "Phonemize process failed: " + err.substring(0, Math.min(err.length(), 256)));
            }
            return extractPhonemes(stdout.toString(StandardCharsets.UTF_8));
        } catch (InterruptedException interrupted) {
            killTree(process);
            Thread.currentThread().interrupt();
            throw new PhonemeConversionException("Phonemize process interrupted", interrupted);
        }
    }

    /** Recheck the construction-time pins immediately before each process launch. */
    void revalidatePinnedAssets(long deadlineNanos) {
        try {
            ensureWithinDeadline(deadlineNanos);
            if (!Files.isRegularFile(binary, LinkOption.NOFOLLOW_LINKS)
                    || !Files.isExecutable(binary)
                    || !isContainedNonSymlinkDirectory(bundle, libraryDir)
                    || !isContainedNonSymlinkDirectory(bundle, espeakData)
                    || !digestMatches(binary, binarySha256, deadlineNanos)
                    || !digestTree(libraryDir, deadlineNanos).equals(librarySha256)
                    || !digestTree(espeakData, deadlineNanos).equals(espeakDataSha256)) {
                throw new PhonemeConversionException("Pinned phonemizer assets changed after initialization");
            }
            ensureWithinDeadline(deadlineNanos);
        } catch (IOException | RuntimeException failure) {
            if (failure instanceof PhonemeConversionException conversionFailure) throw conversionFailure;
            throw new PhonemeConversionException(
                    "Pinned phonemizer assets could not be revalidated", failure);
        }
    }

    private static void ensureWithinDeadline(long deadlineNanos) {
        if (Thread.currentThread().isInterrupted()) {
            throw new PhonemeConversionException("Phonemize operation interrupted");
        }
        if (System.nanoTime() >= deadlineNanos) {
            throw new PhonemeConversionException("Phonemize process exceeded its time budget");
        }
    }

    static void ensureWithinDeadlineAfterStart(Process process, long deadlineNanos) {
        try {
            ensureWithinDeadline(deadlineNanos);
        } catch (PhonemeConversionException failure) {
            killTree(process);
            throw failure;
        }
    }

    private static void joinBeforeDeadline(Thread thread, Process process, long deadline, String worker) {
        while (thread.isAlive()) {
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) {
                killTree(process);
                throw new PhonemeConversionException(
                        "Phonemize " + worker + " exceeded its time budget");
            }
            long millis = TimeUnit.NANOSECONDS.toMillis(remaining);
            int nanos = (int) (remaining - TimeUnit.MILLISECONDS.toNanos(millis));
            try {
                thread.join(millis, nanos);
            } catch (InterruptedException interrupted) {
                killTree(process);
                Thread.currentThread().interrupt();
                throw new PhonemeConversionException("Phonemize process interrupted", interrupted);
            }
        }
    }

    private static Thread drainStream(
            Process process,
            java.io.InputStream input,
            java.io.ByteArrayOutputStream output,
            int maximumBytes,
            AtomicBoolean exceeded,
            String threadName) {
        return new Thread(() -> {
            try (var in = input) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) >= 0) {
                    boolean overLimit;
                    synchronized (output) {
                        int remaining = maximumBytes - output.size();
                        int accepted = Math.min(read, remaining);
                        output.write(buffer, 0, accepted);
                        overLimit = accepted < read;
                    }
                    if (overLimit) {
                        exceeded.set(true);
                        terminateTree(process);
                        break;
                    }
                }
            } catch (IOException ignored) { }
        }, threadName);
    }

    /** This configured Piper bundle invokes the en-US phonemizer only. */
    static void requireSupportedLocale(Locale locale) {
        // Locale.ENGLISH is the legacy in-process spelling used by PiperOnnxEngine;
        // this model's sole configured profile resolves that unspecified region to en-US.
        if (!Locale.US.equals(locale) && !Locale.ENGLISH.equals(locale)) {
            throw new PhonemeConversionException(
                    "The configured Piper phonemizer only supports en-US; requested locale: "
                            + (locale == null ? "unspecified" : locale.toLanguageTag()));
        }
    }

    /** The binary digest must match its configured pin exactly. */
    private static boolean digestMatches(Path binary, String expectedSha256) throws IOException {
        return digestMatches(binary, expectedSha256, null);
    }

    static boolean digestMatches(Path binary, String expectedSha256, long deadlineNanos) throws IOException {
        return digestMatches(binary, expectedSha256, Long.valueOf(deadlineNanos));
    }

    private static boolean digestMatches(Path binary, String expectedSha256, Long deadlineNanos) throws IOException {
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            try (var in = Files.newInputStream(binary)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while (true) {
                    checkDeadline(deadlineNanos);
                    read = in.read(buffer);
                    if (read < 0) break;
                    digest.update(buffer, 0, read);
                }
            }
            checkDeadline(deadlineNanos);
            return java.security.MessageDigest.isEqual(
                    java.util.HexFormat.of().formatHex(digest.digest()).getBytes(StandardCharsets.UTF_8),
                    expectedSha256.trim().toLowerCase(java.util.Locale.ROOT)
                            .getBytes(StandardCharsets.UTF_8));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static void checkDeadline(Long deadlineNanos) {
        if (deadlineNanos != null) ensureWithinDeadline(deadlineNanos);
    }

    private static boolean isContainedNonSymlinkDirectory(Path bundle, Path candidate) throws IOException {
        Path canonicalBundle = bundle.toRealPath();
        Path canonicalCandidate = candidate.toRealPath();
        if (!canonicalCandidate.startsWith(canonicalBundle)
                || !Files.isDirectory(candidate, LinkOption.NOFOLLOW_LINKS)) return false;
        Path current = canonicalBundle;
        for (Path component : canonicalBundle.relativize(candidate)) {
            current = current.resolve(component);
            if (Files.isSymbolicLink(current)) return false;
        }
        return true;
    }

    static String libraryPathEnvironmentKey(String osName) {
        String normalized = osName.toLowerCase(java.util.Locale.ROOT);
        if (normalized.contains("win")) return "PATH";
        if (normalized.contains("mac") || normalized.contains("darwin")) return "DYLD_LIBRARY_PATH";
        return "LD_LIBRARY_PATH";
    }

    static String libraryPathSeparator() {
        return java.io.File.pathSeparator;
    }

    /**
     * Deterministic SHA-256 tree format: entries (including directories) are sorted by
     * slash-separated UTF-8 relative path. Each entry contributes a one-byte type
     * ({@code D}/{@code F}), a four-byte big-endian path length, path bytes, then for
     * files an eight-byte big-endian size followed by the raw file bytes. Symlinks,
     * special files, and a non-directory root are rejected. Trees are bounded to
     * 100,000 entries and 1 GiB total file bytes. Empty trees have the SHA-256 of
     * the empty stream. Pins are lowercase or uppercase 64-digit hex. Trees are
     * checked at construction and again immediately before each process launch.
     * Revalidation and process work share the 15-second conversion deadline with
     * cooperative checks. A single blocking filesystem operation or
     * {@code ProcessBuilder.start()} cannot be interrupted until it returns.
     * Rehashing is bounded but can add I/O cost for large bundles; the OS loader
     * can still race a later asset replacement after revalidation (TOCTOU).
     */
    static String digestTree(Path root) throws IOException {
        return digestTree(root, null);
    }

    static String digestTree(Path root, long deadlineNanos) throws IOException {
        return digestTree(root, Long.valueOf(deadlineNanos));
    }

    private static String digestTree(Path root, Long deadlineNanos) throws IOException {
        checkDeadline(deadlineNanos);
        if (!Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Pinned asset tree root is not a directory");
        }
        Path normalizedRoot = root.toAbsolutePath().normalize();
        List<Path> entries;
        try (var walk = Files.walk(normalizedRoot)) {
            entries = new ArrayList<>();
            var iterator = walk.iterator();
            while (iterator.hasNext()) {
                checkDeadline(deadlineNanos);
                Path path = iterator.next();
                if (!path.equals(normalizedRoot)) {
                    entries.add(path);
                    if (entries.size() > MAX_TREE_ENTRIES) {
                        throw new IOException("Pinned asset tree has too many entries");
                    }
                }
            }
        }
        entries.sort(java.util.Comparator.comparing(path ->
                normalizedRoot.relativize(path).toString().replace(path.getFileSystem().getSeparator(), "/")));
        try {
            var digest = java.security.MessageDigest.getInstance("SHA-256");
            long totalBytes = 0;
            for (Path entry : entries) {
                checkDeadline(deadlineNanos);
                BasicFileAttributes attributes = Files.readAttributes(
                        entry, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                byte type;
                if (attributes.isDirectory()) type = (byte) 'D';
                else if (attributes.isRegularFile()) type = (byte) 'F';
                else throw new IOException("Unsafe entry in pinned asset tree: " + entry);
                byte[] name = normalizedRoot.relativize(entry).toString()
                        .replace(entry.getFileSystem().getSeparator(), "/").getBytes(StandardCharsets.UTF_8);
                digest.update(type);
                digest.update(ByteBuffer.allocate(Integer.BYTES).putInt(name.length).array());
                digest.update(name);
                if (type == 'F') {
                    if (attributes.size() > MAX_TREE_BYTES - totalBytes) {
                        throw new IOException("Pinned asset tree exceeds byte limit");
                    }
                    totalBytes += attributes.size();
                    digest.update(ByteBuffer.allocate(Long.BYTES).putLong(attributes.size()).array());
                    try (var input = Files.newInputStream(entry)) {
                        byte[] buffer = new byte[64 * 1024];
                        int read;
                        long fileBytesRead = 0;
                        while (true) {
                            checkDeadline(deadlineNanos);
                            read = input.read(buffer);
                            if (read < 0) break;
                            fileBytesRead += read;
                            if (fileBytesRead > attributes.size()) {
                                throw new IOException("Pinned asset changed while being hashed");
                            }
                            digest.update(buffer, 0, read);
                        }
                        if (fileBytesRead != attributes.size()) {
                            throw new IOException("Pinned asset changed while being hashed");
                        }
                    }
                }
            }
            checkDeadline(deadlineNanos);
            return java.util.HexFormat.of().formatHex(digest.digest());
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static String normalizePin(String value) {
        if (value == null || !value.trim().matches("(?i)[0-9a-f]{64}")) return null;
        return value.trim().toLowerCase(java.util.Locale.ROOT);
    }

    /** Kills the worker and any descendants it spawned so nothing outlives the budget. */
    private static void killTree(Process process) {
        terminateTree(process);
        boolean interrupted = Thread.currentThread().isInterrupted();
        try {
            process.waitFor(2, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
            interrupted = true;
        } finally {
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    private static void terminateTree(Process process) {
        process.descendants().forEach(descendant -> {
            try { descendant.destroyForcibly(); } catch (RuntimeException ignored) { }
        });
        process.destroyForcibly();
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
