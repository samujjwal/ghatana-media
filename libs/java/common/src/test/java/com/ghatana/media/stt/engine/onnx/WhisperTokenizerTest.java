package com.ghatana.media.stt.engine.onnx;

import com.ghatana.media.common.ModelLoadingError;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Locale;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WhisperTokenizerTest {
    @Test
    void decodesByteBpeTokensAndSkipsSpecialTokens() {
        WhisperTokenizer tokenizer = WhisperTokenizer.forTokens(Map.of(
                0L, "Ġhello", 1L, "Ġworld", 50_258L, "<|transcribe|>", 3L, "!") );

        assertThat(tokenizer.decode(new long[]{50_258, 0, 1, 3})).isEqualTo("hello world!");
    }

    @Test
    void parsesSyntheticTiktokenRowsAndDecodesTheirOutput() {
        byte[] asset = (row("hello ", 0) + row("world", 1) + row("!", 2)).getBytes(StandardCharsets.UTF_8);
        WhisperTokenizer tokenizer = WhisperTokenizer.parseTiktoken(asset, asset.length);

        assertThat(tokenizer.decode(new long[]{0, 1, 2})).isEqualTo("hello world!");
        assertThat(tokenizer.decode(new long[]{50_257, 0, 50_864, 1})).isEqualTo("hello world");
    }

    @Test
    void tiktokenLoaderRejectsBadDigestAndWrongSizeBeforeParsing() throws Exception {
        Path asset = Files.createTempFile("whisper-tiktoken", ".tiktoken");
        byte[] bytes = row("hello", 0).getBytes(StandardCharsets.UTF_8);
        try {
            Files.write(asset, bytes);
            assertThatThrownBy(() -> WhisperTokenizer.loadTiktoken(asset, bytes.length, "0".repeat(64)))
                    .isInstanceOf(ModelLoadingError.class)
                    .hasMessageContaining("SHA-256");
            assertThatThrownBy(() -> WhisperTokenizer.loadTiktoken(asset, bytes.length + 1, sha256(bytes)))
                    .isInstanceOf(ModelLoadingError.class)
                    .hasMessageContaining("unexpected size");
            assertThatThrownBy(() -> WhisperTokenizer.loadTiktoken(asset, 2_000_001L, sha256(bytes)))
                    .isInstanceOf(ModelLoadingError.class)
                    .hasMessageContaining("size limit is invalid");
        } finally {
            Files.deleteIfExists(asset);
        }
    }

    @Test
    void tiktokenParserRejectsDuplicateRanksGapsAndOverLimitInput() {
        byte[] duplicate = (row("a", 0) + row("b", 0)).getBytes(StandardCharsets.UTF_8);
        byte[] duplicateToken = (row("a", 0) + row("a", 1)).getBytes(StandardCharsets.UTF_8);
        byte[] gap = (row("a", 0) + row("b", 2)).getBytes(StandardCharsets.UTF_8);
        byte[] emptyAtWrongRank = "= 0\n".getBytes(StandardCharsets.UTF_8);
        byte[] valid = row("a", 0).getBytes(StandardCharsets.UTF_8);

        assertThatThrownBy(() -> WhisperTokenizer.parseTiktoken(duplicate, duplicate.length))
                .isInstanceOf(ModelLoadingError.class)
                .hasMessageContaining("duplicate");
        assertThatThrownBy(() -> WhisperTokenizer.parseTiktoken(duplicateToken, duplicateToken.length))
                .isInstanceOf(ModelLoadingError.class)
                .hasMessageContaining("duplicate token bytes");
        assertThatThrownBy(() -> WhisperTokenizer.parseTiktoken(gap, gap.length))
                .isInstanceOf(ModelLoadingError.class)
                .hasMessageContaining("gap");
        assertThatThrownBy(() -> WhisperTokenizer.parseTiktoken(emptyAtWrongRank, emptyAtWrongRank.length))
                .isInstanceOf(ModelLoadingError.class)
                .hasMessageContaining("empty token encoding outside rank 50256");
        assertThatThrownBy(() -> WhisperTokenizer.parseTiktoken(valid, valid.length - 1))
                .isInstanceOf(ModelLoadingError.class)
                .hasMessageContaining("size limit");
    }

    @Test
    void keepsLegacyVocabularyAndMergesProfileAvailable() throws Exception {
        Path directory = Files.createTempDirectory("whisper-tokenizer-legacy");
        Path model = directory.resolve("model.onnx");
        try {
            Files.writeString(directory.resolve("vocab.json"), "{\"Ġhello\":0,\"<|transcribe|>\":9}");
            Files.writeString(directory.resolve("merges.txt"), "#version: 0.2\nhello world\n");
            assertThat(WhisperTokenizer.load(model).decode(new long[]{9, 0})).isEqualTo("hello");
        } finally {
            Files.deleteIfExists(directory.resolve("vocab.json"));
            Files.deleteIfExists(directory.resolve("merges.txt"));
            Files.deleteIfExists(directory);
        }
    }

    @Test
    void corruptTiktokenSidecarFailsInsteadOfFallingBackToLegacyProfile() throws Exception {
        Path directory = Files.createTempDirectory("whisper-tokenizer-sidecar-precedence");
        Path model = directory.resolve("model.onnx");
        try {
            Files.writeString(directory.resolve("vocab.json"), "{\"hello\":0}");
            Files.writeString(directory.resolve("merges.txt"), "#version: 0.2\nhello world\n");
            Files.writeString(directory.resolve("multilingual.tiktoken"), "corrupt");
            assertThatThrownBy(() -> WhisperTokenizer.load(model))
                    .isInstanceOf(ModelLoadingError.class)
                    .hasMessageContaining("unexpected size");
        } finally {
            Files.deleteIfExists(directory.resolve("multilingual.tiktoken"));
            Files.deleteIfExists(directory.resolve("vocab.json"));
            Files.deleteIfExists(directory.resolve("merges.txt"));
            Files.deleteIfExists(directory);
        }
    }

    @Test
    void pinnedProfileLoaderRequiresItsTiktokenAssetAndNeverUsesLegacyFallback() throws Exception {
        Path directory = Files.createTempDirectory("whisper-pinned-tokenizer-");
        try {
            Path vocabulary = directory.resolve("vocab.json");
            Path merges = directory.resolve("merges.txt");
            Files.writeString(vocabulary, "{\"hello\": 0}");
            Files.writeString(merges, "#version: 0.2\n");
            assertThatThrownBy(() -> WhisperTokenizer.loadPinnedTiktoken(directory.resolve("multilingual.tiktoken")))
                    .isInstanceOf(ModelLoadingError.class)
                    .hasMessageContaining("Unable to read Whisper tiktoken asset");
        } finally {
            Files.deleteIfExists(directory.resolve("vocab.json"));
            Files.deleteIfExists(directory.resolve("merges.txt"));
            Files.deleteIfExists(directory);
        }
    }

    @Test
    void rejectsUnknownSpecialRangeIdsInLegacyProfile() {
        WhisperTokenizer tokenizer = WhisperTokenizer.forTokens(Map.of(0L, "hello"));
        assertThatThrownBy(() -> tokenizer.decode(new long[]{50_258}))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("absent from configured vocabulary");
    }

    @Test
    void treatsRank50256AsOrdinaryAndWhisperId50257AsSpecial() {
        WhisperTokenizer tokenizer = WhisperTokenizer.forTiktokenTokens(Map.of(
                50_256L, "ordinary", 50_257L, "<|startoftranscript|>"));

        assertThat(tokenizer.decode(new long[]{50_256, 50_257})).isEqualTo("ordinary");
    }

    @Test
    void transcriptionPromptUsesPinnedMultilingualLanguageAndTaskTokenIds() {
        assertThat(WhisperTokenizer.transcriptionPrompt(Locale.US))
                .containsExactly(50_258L, 50_259L, 50_359L, 50_363L);
        assertThat(WhisperTokenizer.transcriptionPrompt(Locale.forLanguageTag("hi-IN")))
                .containsExactly(50_258L, 50_276L, 50_359L, 50_363L);
        assertThat(WhisperTokenizer.transcriptionPrompt(Locale.forLanguageTag("ne-NP")))
                .containsExactly(50_258L, 50_313L, 50_359L, 50_363L);
        assertThatThrownBy(() -> WhisperTokenizer.transcriptionPrompt(Locale.forLanguageTag("zz-ZZ")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("does not support language");
    }

    @Test
    void rejectsUnknownAndNegativeTokenIdsInsteadOfFabricatingText() {
        WhisperTokenizer tokenizer = WhisperTokenizer.forTokens(Map.of(0L, "hello"));

        assertThatThrownBy(() -> tokenizer.decode(new long[]{4}))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("absent from configured vocabulary");
        assertThatThrownBy(() -> tokenizer.decode(new long[]{-1}))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("negative token ID");
    }

    @Test
    void rejectsMalformedUtf8InsteadOfReplacingBytes() {
        WhisperTokenizer tokenizer = WhisperTokenizer.forTokens(Map.of(0L, "Ã"));

        assertThatThrownBy(() -> tokenizer.decode(new long[]{0}))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("malformed UTF-8");
    }

    @Test
    void rejectsFractionalVocabularyIdsAndMalformedOrDuplicateMerges() throws Exception {
        Path directory = Files.createTempDirectory("whisper-tokenizer-test");
        Path model = directory.resolve("model.onnx");
        Path vocabulary = directory.resolve("vocab.json");
        Path merges = directory.resolve("merges.txt");
        try {
            Files.writeString(merges, "#version: 0.2\na b\n");
            Files.writeString(vocabulary, "{\"a\":1.5}");
            assertThatThrownBy(() -> WhisperTokenizer.load(model))
                    .isInstanceOf(ModelLoadingError.class)
                    .hasMessageContaining("invalid or duplicate IDs");

            Files.writeString(vocabulary, "{\"a\":0,\"b\":1}");
            Files.writeString(merges, "#version: 0.2\na b\na b\n");
            assertThatThrownBy(() -> WhisperTokenizer.load(model))
                    .isInstanceOf(ModelLoadingError.class)
                    .hasMessageContaining("malformed or duplicate row");

            Files.writeString(merges, "#version: 0.2\nmalformed\n");
            assertThatThrownBy(() -> WhisperTokenizer.load(model))
                    .isInstanceOf(ModelLoadingError.class)
                    .hasMessageContaining("malformed or duplicate row");
        } finally {
            Files.deleteIfExists(vocabulary);
            Files.deleteIfExists(merges);
            Files.deleteIfExists(directory);
        }
    }

    private static String row(String token, long rank) {
        return Base64.getEncoder().encodeToString(token.getBytes(StandardCharsets.UTF_8)) + " " + rank + "\n";
    }

    private static String sha256(byte[] content) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(content);
        StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte value : digest) hex.append(String.format("%02x", value & 0xff));
        return hex.toString();
    }
}
