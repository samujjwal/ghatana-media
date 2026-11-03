package com.ghatana.media.tts.phoneme;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Set;

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

        assertThat(converter.convert("hi")).isEqualTo("hi");
    }

    @Test
    void rejectsOutputThatWouldPreviouslyBeParsedAfterTruncation() throws Exception {
        TextToPhonemeConverter converter = converterWithScript(
                "printf '%s\\n' '{\"phonemes\":[\"h\",\"i\"]}'; head -c 65536 /dev/zero");

        assertThatThrownBy(() -> converter.convert("hi"))
                .isInstanceOf(TextToPhonemeConverter.PhonemeConversionException.class)
                .hasMessageContaining("exceeded its output budget");
    }

    private TextToPhonemeConverter converterWithScript(String body) throws Exception {
        Path root = Files.createDirectories(tempDir.resolve("piper"));
        Path bin = Files.createDirectories(root.resolve("bin"));
        Files.createDirectories(root.resolve("share/espeak-ng-data"));
        Path executable = bin.resolve("piper_phonemize");
        Files.writeString(executable, "#!/bin/sh\n" + body + "\n");
        Files.setPosixFilePermissions(executable, Set.of(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE,
                PosixFilePermission.OWNER_EXECUTE));
        String digest = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(executable)));
        return PiperPhonemizeProcessConverter.tryCreate(executable, digest)
                .orElseThrow(() -> new IOException("test phonemizer fixture was not accepted"));
    }
}
