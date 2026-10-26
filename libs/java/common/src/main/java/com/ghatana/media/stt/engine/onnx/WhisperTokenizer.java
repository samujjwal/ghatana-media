package com.ghatana.media.stt.engine.onnx;

import com.ghatana.media.common.ModelLoadingError;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Decoder for the token strings emitted by a Whisper GPT-2 BPE decoder head. */
final class WhisperTokenizer {
    private final Map<Long, String> tokens;
    private final Map<Integer, Character> byteDecoder;

    private WhisperTokenizer(Map<Long, String> tokens) {
        this.tokens = Map.copyOf(tokens);
        this.byteDecoder = createByteDecoder();
    }

    static WhisperTokenizer load(Path modelPath) {
        Path directory = modelPath.toAbsolutePath().getParent();
        Path vocabulary = directory.resolve("vocab.json");
        Path merges = directory.resolve("merges.txt");
        if (!Files.isRegularFile(vocabulary) || !Files.isRegularFile(merges)) {
            throw new ModelLoadingError("Whisper tokenizer profile unavailable: expected vocab.json and merges.txt beside model");
        }
        try {
            Object parsed = new ObjectMapper().readValue(vocabulary.toFile(), Map.class);
            if (!(parsed instanceof Map<?, ?> raw) || raw.isEmpty()) {
                throw new ModelLoadingError("Whisper tokenizer vocabulary is empty or malformed");
            }
            Map<Long, String> tokens = new HashMap<>();
            raw.forEach((token, id) -> {
                Long numericId = exactNonnegativeLong(id);
                if (!(token instanceof String text) || text.isEmpty() || numericId == null
                        || tokens.put(numericId, text) != null) {
                    throw new ModelLoadingError("Whisper tokenizer vocabulary contains invalid or duplicate IDs");
                }
            });
            List<String> mergeLines = Files.readAllLines(merges, StandardCharsets.UTF_8);
            if (mergeLines.size() < 2 || !mergeLines.get(0).startsWith("#version:")) {
                throw new ModelLoadingError("Whisper tokenizer merges profile is malformed");
            }
            java.util.Set<String> seenMerges = new java.util.HashSet<>();
            for (int lineNumber = 1; lineNumber < mergeLines.size(); lineNumber++) {
                String line = mergeLines.get(lineNumber).trim();
                if (line.isEmpty()) continue;
                String[] pair = line.split("\\s+");
                if (pair.length != 2 || !seenMerges.add(pair[0] + "\u0000" + pair[1])) {
                    throw new ModelLoadingError("Whisper tokenizer merges profile has malformed or duplicate row at line " + (lineNumber + 1));
                }
            }
            return new WhisperTokenizer(tokens);
        } catch (IOException e) {
            throw new ModelLoadingError("Unable to load Whisper tokenizer profile", e);
        } catch (ModelLoadingError e) {
            throw e;
        } catch (RuntimeException e) {
            throw new ModelLoadingError("Unable to parse Whisper tokenizer profile", e);
        }
    }

    private static Long exactNonnegativeLong(Object value) {
        if (!(value instanceof Number number)) return null;
        try {
            long id = new BigDecimal(number.toString()).longValueExact();
            return id < 0 ? null : id;
        } catch (NumberFormatException | ArithmeticException e) {
            return null;
        }
    }

    static WhisperTokenizer forTokens(Map<Long, String> tokens) {
        return new WhisperTokenizer(tokens);
    }

    String decode(long[] ids) {
        List<Byte> bytes = new ArrayList<>();
        for (long id : ids) {
            if (id < 0) throw new IllegalArgumentException("Whisper output contains a negative token ID");
            String token = tokens.get(id);
            if (token == null) throw new IllegalArgumentException("Whisper output token ID is absent from configured vocabulary: " + id);
            if (isSpecial(token)) continue;
            for (int i = 0; i < token.length(); i++) {
                Character value = byteDecoder.get((int) token.charAt(i));
                if (value == null) throw new IllegalArgumentException("Whisper token contains an invalid byte-encoding character");
                bytes.add((byte) value.charValue());
            }
        }
        byte[] output = new byte[bytes.size()];
        for (int i = 0; i < bytes.size(); i++) output[i] = bytes.get(i);
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(output)).toString().trim();
        } catch (CharacterCodingException e) {
            throw new IllegalArgumentException("Whisper token sequence contains malformed UTF-8 bytes", e);
        }
    }

    private static boolean isSpecial(String token) {
        return token.startsWith("<|") && token.endsWith("|>");
    }

    private static Map<Integer, Character> createByteDecoder() {
        List<Integer> bytes = new ArrayList<>();
        for (int b = 33; b <= 126; b++) bytes.add(b);
        for (int b = 161; b <= 172; b++) bytes.add(b);
        for (int b = 174; b <= 255; b++) bytes.add(b);
        List<Integer> codepoints = new ArrayList<>(bytes);
        int extra = 0;
        for (int b = 0; b < 256; b++) {
            if (!bytes.contains(b)) { bytes.add(b); codepoints.add(256 + extra++); }
        }
        Map<Integer, Character> decoder = new HashMap<>();
        for (int i = 0; i < bytes.size(); i++) decoder.put(codepoints.get(i), (char) (int) bytes.get(i));
        return decoder;
    }
}
