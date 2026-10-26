package com.ghatana.media.stt.engine.onnx;

import com.ghatana.media.common.ModelLoadingError;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WhisperTokenizerTest {
    @Test
    void decodesByteBpeTokensAndSkipsSpecialTokens() {
        WhisperTokenizer tokenizer = WhisperTokenizer.forTokens(Map.of(
                0L, "Ġhello", 1L, "Ġworld", 2L, "<|transcribe|>", 3L, "!") );

        assertThat(tokenizer.decode(new long[]{2, 0, 1, 3})).isEqualTo("hello world!");
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
}
