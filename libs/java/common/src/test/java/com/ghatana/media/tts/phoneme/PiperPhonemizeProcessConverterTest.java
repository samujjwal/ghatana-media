package com.ghatana.media.tts.phoneme;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@EnabledOnOs({OS.LINUX, OS.MAC})
class PiperPhonemizeProcessConverterTest {

    @TempDir
    Path tempDir;

    @Test
    void parsesCompleteCanonicalPiperPhonemizerOutput() throws Exception {
        TextToPhonemeConverter converter = converterWithScript(
                "printf '%s\\n' '{\"phonemes\":[\"h\",\"i\"]}'");

        assertThat(converter).isInstanceOf(PiperPhonemizeProcessConverter.class);
        assertThat(converter.qualityTier()).isEqualTo(10);
        assertThat(converter.convert("hi")).isEqualTo("hi");
    }

    @Test
    void rejectsOutputThatWouldPreviouslyBeParsedAfterTruncation() throws Exception {
        TextToPhonemeConverter converter = converterWithScript(
                "printf '%s\\n' '{\"phonemes\":[\"h\",\"i\"]}'; head -c 65536 /dev/zero");

        assertThatThrownBy(() -> converter.convert("hi"))
                .isInstanceOf(TextToPhonemeConverter.PhonemeConversionException.class)
                .hasMessageContaining("exceeded its stdout budget");
    }

    @Test
    void boundsStderrWithoutSpoolingUntrustedProcessOutputToDisk() throws Exception {
        TextToPhonemeConverter converter = converterWithScript("head -c 16385 /dev/zero >&2");

        assertThatThrownBy(() -> converter.convert("hi"))
                .isInstanceOf(TextToPhonemeConverter.PhonemeConversionException.class)
                .hasMessageContaining("exceeded its stderr budget");
    }

    @Test
    void totalDeadlineKillsLongRunningWorkerAndItsChild() throws Exception {
        Path childPid = tempDir.resolve("phonemizer-child.pid");
        Fixture fixture = fixture("sleep 30 & echo $! > '" + shellQuotePath(childPid) + "'; wait");
        Pins pins = pins(fixture);
        TextToPhonemeConverter converter = PiperPhonemizeProcessConverter.tryCreate(
                        fixture.executable, pins.binary, pins.library, pins.data)
                .orElseThrow(() -> new IOException("test phonemizer fixture was not accepted"));

        assertThatThrownBy(() -> converter.convert("hi"))
                .isInstanceOf(TextToPhonemeConverter.PhonemeConversionException.class)
                .hasMessageContaining("exceeded its time budget");

        long pid = Long.parseLong(Files.readString(childPid).trim());
        long cleanupDeadline = System.nanoTime() + Duration.ofSeconds(2).toNanos();
        while (ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false)
                && System.nanoTime() < cleanupDeadline) {
            Thread.sleep(20);
        }
        assertThat(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false)).isFalse();
    }

    @Test
    void requiresExactPinsForBinaryLibraryAndEspeakTrees() throws Exception {
        Fixture fixture = fixture("printf '%s\\n' '{\"phonemes\":[\"h\",\"i\"]}'");
        Pins pins = pins(fixture);

        assertThat(PiperPhonemizeProcessConverter.tryCreate(fixture.executable, null,
                pins.library, pins.data)).isEmpty();
        assertThat(PiperPhonemizeProcessConverter.tryCreate(fixture.executable, pins.binary,
                null, pins.data)).isEmpty();
        assertThat(PiperPhonemizeProcessConverter.tryCreate(fixture.executable, pins.binary,
                pins.library, null)).isEmpty();
        assertThat(PiperPhonemizeProcessConverter.tryCreate(fixture.executable, pins.binary,
                " ", pins.data)).isEmpty();
        assertThat(PiperPhonemizeProcessConverter.tryCreate(fixture.executable, pins.binary,
                pins.library, "0".repeat(64))).isEmpty();
        assertThat(PiperPhonemizeProcessConverter.tryCreate(fixture.executable, pins.binary,
                pins.library, pins.data)).isPresent();
    }

    @Test
    void rejectsSymlinksInsidePinnedTreesAndAncestors() throws Exception {
        Fixture fixture = fixture("printf '%s\\n' '{\"phonemes\":[\"h\"]}'");
        Pins pins = pins(fixture);
        Path outside = Files.writeString(tempDir.resolve("outside"), "unsafe");
        Files.createSymbolicLink(fixture.library.resolve("link"), outside);
        assertThatThrownBy(() -> PiperPhonemizeProcessConverter.digestTree(fixture.library))
                .isInstanceOf(IOException.class);
        assertThat(PiperPhonemizeProcessConverter.tryCreate(fixture.executable,
                pins.binary, pins.library, pins.data)).isEmpty();

        Fixture escaped = fixture("printf '%s\\n' '{\"phonemes\":[\"h\"]}'");
        Pins escapedPins = pins(escaped);
        Path bundle = escaped.executable.getParent().getParent();
        Path originalShare = escaped.data.getParent();
        Files.delete(escaped.data.resolve("en-us/dict"));
        Files.delete(escaped.data.resolve("en-us"));
        Files.delete(escaped.data);
        Files.delete(originalShare);
        Path externalShare = Files.createDirectories(tempDir.resolve("external/share"));
        Files.createDirectories(externalShare.resolve("espeak-ng-data"));
        Files.createSymbolicLink(bundle.resolve("share"), externalShare);
        assertThat(PiperPhonemizeProcessConverter.tryCreate(escaped.executable,
                escapedPins.binary, escapedPins.library, escapedPins.data)).isEmpty();
    }

    @Test
    void rejectsAssetMutationBeforeConverterConstruction() throws Exception {
        Fixture fixture = fixture("printf '%s\\n' '{\"phonemes\":[\"h\",\"i\"]}'");
        Pins pins = pins(fixture);
        Files.writeString(fixture.library.resolve("libfixture.dylib"), "changed after pin");

        assertThat(PiperPhonemizeProcessConverter.tryCreate(
                fixture.executable, pins.binary, pins.library, pins.data)).isEmpty();
    }

    @Test
    void rejectsBinaryMutationAfterConverterConstructionBeforeLaunching() throws Exception {
        Path launched = tempDir.resolve("binary-launched");
        Fixture fixture = fixture("printf launched > '" + shellQuotePath(launched)
                + "'; printf '%s\\n' '{\"phonemes\":[\"h\"]}'");
        TextToPhonemeConverter converter = converter(fixture);
        Files.writeString(fixture.executable,
                "#!/bin/sh\nprintf launched > '" + shellQuotePath(launched) + "'\n");

        assertThatThrownBy(() -> converter.convert("hi"))
                .isInstanceOf(TextToPhonemeConverter.PhonemeConversionException.class)
                .hasMessageContaining("Pinned phonemizer assets changed");
        assertThat(launched).doesNotExist();
    }

    @Test
    void rejectsBundledTreeMutationAfterConverterConstructionBeforeLaunching() throws Exception {
        Path launched = tempDir.resolve("tree-launched");
        Fixture fixture = fixture("printf launched > '" + shellQuotePath(launched)
                + "'; printf '%s\\n' '{\"phonemes\":[\"h\"]}'");
        TextToPhonemeConverter converter = converter(fixture);
        Files.writeString(fixture.library.resolve("libfixture.dylib"), "changed after construction");

        assertThatThrownBy(() -> converter.convert("hi"))
                .isInstanceOf(TextToPhonemeConverter.PhonemeConversionException.class)
                .hasMessageContaining("Pinned phonemizer assets changed");
        assertThat(launched).doesNotExist();
    }

    @Test
    void rejectsEspeakDataMutationAfterConverterConstructionBeforeLaunching() throws Exception {
        Path launched = tempDir.resolve("espeak-data-launched");
        Fixture fixture = fixture("printf launched > '" + shellQuotePath(launched)
                + "'; printf '%s\\n' '{\"phonemes\":[\"h\"]}'");
        TextToPhonemeConverter converter = converter(fixture);
        Files.writeString(fixture.data.resolve("en-us/dict"), "changed after construction");

        assertThatThrownBy(() -> converter.convert("hi"))
                .isInstanceOf(TextToPhonemeConverter.PhonemeConversionException.class)
                .hasMessageContaining("Pinned phonemizer assets changed");
        assertThat(launched).doesNotExist();
    }

    @Test
    void expiredDeadlineStopsAssetRevalidationAndDigestHelpers() throws Exception {
        Path launched = tempDir.resolve("expired-deadline-launched");
        Fixture fixture = fixture("printf launched > '" + shellQuotePath(launched)
                + "'; printf '%s\\n' '{\"phonemes\":[\"h\"]}'");
        TextToPhonemeConverter converter = converter(fixture);
        long expiredDeadline = System.nanoTime() - 1;

        assertThatThrownBy(() -> ((PiperPhonemizeProcessConverter) converter)
                .revalidatePinnedAssets(expiredDeadline))
                .isInstanceOf(TextToPhonemeConverter.PhonemeConversionException.class)
                .hasMessageContaining("exceeded its time budget");
        assertThatThrownBy(() -> PiperPhonemizeProcessConverter.digestTree(
                fixture.library, expiredDeadline))
                .isInstanceOf(TextToPhonemeConverter.PhonemeConversionException.class)
                .hasMessageContaining("exceeded its time budget");
        assertThatThrownBy(() -> PiperPhonemizeProcessConverter.digestMatches(
                fixture.executable, pins(fixture).binary, expiredDeadline))
                .isInstanceOf(TextToPhonemeConverter.PhonemeConversionException.class)
                .hasMessageContaining("exceeded its time budget");
        assertThat(launched).doesNotExist();
    }

    @Test
    void interruptedAssetRevalidationFailsTypedAndPreservesInterruptStatus() throws Exception {
        Fixture fixture = fixture("printf '%s\\n' '{\"phonemes\":[\"h\"]}'");
        TextToPhonemeConverter converter = converter(fixture);
        Thread.currentThread().interrupt();
        try {
            assertThatThrownBy(() -> ((PiperPhonemizeProcessConverter) converter)
                    .revalidatePinnedAssets(System.nanoTime() + Duration.ofSeconds(1).toNanos()))
                    .isInstanceOf(TextToPhonemeConverter.PhonemeConversionException.class)
                    .hasMessageContaining("Phonemize operation interrupted");
            assertThat(Thread.currentThread().isInterrupted()).isTrue();
        } finally {
            Thread.interrupted();
        }
    }

    @Test
    void interruptedPostStartCheckPreservesInterruptAndKillsWorkerTree() throws Exception {
        Path workerPidFile = tempDir.resolve("post-start-worker.pid");
        Path childPidFile = tempDir.resolve("post-start-child.pid");
        Fixture fixture = fixture("echo $$ > '" + shellQuotePath(workerPidFile)
                + "'; sleep 30 & echo $! > '" + shellQuotePath(childPidFile) + "'; wait");
        Process process = new ProcessBuilder(fixture.executable.toString()).start();
        Thread conversionThread = null;
        try {
            awaitFile(workerPidFile);
            long childPid = Long.parseLong(awaitFile(childPidFile));
            AtomicReference<Throwable> failure = new AtomicReference<>();
            AtomicReference<Boolean> interruptPreserved = new AtomicReference<>(false);
            conversionThread = new Thread(() -> {
                Thread.currentThread().interrupt();
                try {
                    PiperPhonemizeProcessConverter.ensureWithinDeadlineAfterStart(
                            process, System.nanoTime() + Duration.ofSeconds(5).toNanos());
                } catch (Throwable thrown) {
                    failure.set(thrown);
                } finally {
                    interruptPreserved.set(Thread.currentThread().isInterrupted());
                    Thread.interrupted();
                }
            }, "test-phonemize-conversion");
            conversionThread.start();
            conversionThread.join(3_000);

            assertThat(conversionThread.isAlive()).isFalse();
            assertThat(failure.get())
                    .isInstanceOf(TextToPhonemeConverter.PhonemeConversionException.class)
                    .hasMessageContaining("Phonemize operation interrupted");
            assertThat(interruptPreserved.get()).isTrue();
            assertThat(process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            long cleanupDeadline = System.nanoTime() + Duration.ofSeconds(2).toNanos();
            while (ProcessHandle.of(childPid).map(ProcessHandle::isAlive).orElse(false)
                    && System.nanoTime() < cleanupDeadline) {
                Thread.sleep(20);
            }
            assertThat(ProcessHandle.of(childPid).map(ProcessHandle::isAlive).orElse(false)).isFalse();
        } finally {
            if (conversionThread != null && conversionThread.isAlive()) {
                conversionThread.interrupt();
                conversionThread.join(1_000);
            }
            process.destroyForcibly();
        }
    }

    @Test
    void selectsNativeLoaderVariableAndPathSeparatorForEachOsFamily() {
        assertThat(PiperPhonemizeProcessConverter.libraryPathEnvironmentKey("Linux")).isEqualTo("LD_LIBRARY_PATH");
        assertThat(PiperPhonemizeProcessConverter.libraryPathEnvironmentKey("Mac OS X")).isEqualTo("DYLD_LIBRARY_PATH");
        assertThat(PiperPhonemizeProcessConverter.libraryPathEnvironmentKey("Windows 11")).isEqualTo("PATH");
        assertThat(PiperPhonemizeProcessConverter.libraryPathSeparator()).isEqualTo(File.pathSeparator);
    }

    private TextToPhonemeConverter converterWithScript(String body) throws Exception {
        Fixture fixture = fixture(body);
        return converter(fixture);
    }

    private TextToPhonemeConverter converter(Fixture fixture) throws Exception {
        Pins pins = pins(fixture);
        return PiperPhonemizeProcessConverter.tryCreate(
                        fixture.executable, pins.binary, pins.library, pins.data)
                .orElseThrow(() -> new IOException("test phonemizer fixture was not accepted"));
    }

    private Fixture fixture(String body) throws IOException {
        Path root = Files.createTempDirectory(tempDir, "piper-");
        Path bin = Files.createDirectories(root.resolve("bin"));
        Path library = Files.createDirectories(root.resolve("lib"));
        Path data = Files.createDirectories(root.resolve("share/espeak-ng-data"));
        Files.writeString(library.resolve("libfixture.dylib"), "fixture library");
        Files.createDirectories(data.resolve("en-us"));
        Files.writeString(data.resolve("en-us").resolve("dict"), "fixture data");
        Path executable = bin.resolve("piper_phonemize");
        Files.writeString(executable, "#!/bin/sh\n" + body + "\n");
        Files.setPosixFilePermissions(executable, Set.of(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE,
                PosixFilePermission.OWNER_EXECUTE));
        return new Fixture(executable, library, data);
    }

    private Pins pins(Fixture fixture) throws Exception {
        String binary = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(fixture.executable)));
        return new Pins(binary, PiperPhonemizeProcessConverter.digestTree(fixture.library),
                PiperPhonemizeProcessConverter.digestTree(fixture.data));
    }

    private static String shellQuotePath(Path path) {
        return path.toString().replace("'", "'\"'\"'");
    }

    private static String awaitFile(Path path) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(3).toNanos();
        while (!Files.exists(path) && System.nanoTime() < deadline) Thread.sleep(10);
        return Files.readString(path).trim();
    }

    private record Fixture(Path executable, Path library, Path data) { }
    private record Pins(String binary, String library, String data) { }
}
