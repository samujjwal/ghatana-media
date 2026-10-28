package com.ghatana.media.stt.engine.onnx;

import com.ghatana.media.common.ModelLoadingError;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.HashSet;
import java.util.Locale;

/** Decoder for the token strings emitted by a Whisper GPT-2 BPE decoder head. */
final class WhisperTokenizer {
    private static final long TIKTOKEN_ASSET_BYTES = 816_730L;
    private static final long MAX_TIKTOKEN_ASSET_BYTES = 2_000_000L;
    private static final String TIKTOKEN_ASSET_SHA256 = "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126";
    private static final long FIRST_WHISPER_SPECIAL_ID = 50_257L;
    private static final long LAST_WHISPER_SPECIAL_ID = 51_864L;
    private static final long END_OF_TEXT = 50_257L;
    private static final long START_OF_TRANSCRIPT = 50_258L;
    private static final long TRANSCRIBE = 50_359L;
    private static final long NO_SPEECH = 50_362L;
    private static final long NO_TIMESTAMPS = 50_363L;
    // Keep this order in sync with OpenAI Whisper's LANGUAGES map at the pinned tokenizer source.
    private static final List<String> MULTILINGUAL_LANGUAGES = List.of(
            "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar",
            "sv", "it", "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu",
            "ta", "no", "th", "ur", "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa",
            "lv", "bn", "sr", "az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy", "ne", "mn",
            "bs", "kk", "sq", "sw", "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc",
            "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn",
            "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln", "ha", "ba", "jw",
            "su");

    private final Map<Long, String> tokens;
    private final Map<Integer, Character> byteDecoder;
    private final Set<Long> specialIds;

    private WhisperTokenizer(Map<Long, String> tokens, Set<Long> specialIds) {
        this.tokens = Map.copyOf(tokens);
        this.byteDecoder = createByteDecoder();
        this.specialIds = Set.copyOf(specialIds);
    }

    static WhisperTokenizer load(Path modelPath) {
        Path directory = modelPath.toAbsolutePath().getParent();
        Path tiktoken = directory.resolve("multilingual.tiktoken");
        if (Files.exists(tiktoken, LinkOption.NOFOLLOW_LINKS)) {
            return loadTiktoken(tiktoken, TIKTOKEN_ASSET_BYTES, TIKTOKEN_ASSET_SHA256);
        }
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
            return new WhisperTokenizer(tokens, legacySpecialIds(tokens));
        } catch (IOException e) {
            throw new ModelLoadingError("Unable to load Whisper tokenizer profile", e);
        } catch (ModelLoadingError e) {
            throw e;
        } catch (RuntimeException e) {
            throw new ModelLoadingError("Unable to parse Whisper tokenizer profile", e);
        }
    }

    /** Loads only the pinned multilingual Whisper tokenizer; the profile must not fall back to legacy BPE files. */
    static WhisperTokenizer loadPinnedTiktoken(Path asset) {
        return loadTiktoken(asset, TIKTOKEN_ASSET_BYTES, TIKTOKEN_ASSET_SHA256);
    }

    static WhisperTokenizer loadTiktoken(Path asset, long expectedBytes, String expectedSha256) {
        try {
            if (expectedBytes < 1 || expectedBytes > MAX_TIKTOKEN_ASSET_BYTES) {
                throw new ModelLoadingError("Whisper tiktoken asset size limit is invalid");
            }
            long size = Files.size(asset);
            if (size != expectedBytes) {
                throw new ModelLoadingError("Whisper tiktoken asset has unexpected size: " + size);
            }
            byte[] content;
            try (InputStream input = Files.newInputStream(asset)) {
                content = input.readNBytes((int) expectedBytes + 1);
            }
            if (content.length != expectedBytes) {
                throw new ModelLoadingError("Whisper tiktoken asset changed size or exceeds its limit while reading");
            }
            String actualSha256 = sha256(content);
            if (!actualSha256.equals(expectedSha256)) {
                throw new ModelLoadingError("Whisper tiktoken asset SHA-256 does not match the pinned asset");
            }
            return parseTiktoken(content, (int) expectedBytes);
        } catch (IOException e) {
            throw new ModelLoadingError("Unable to read Whisper tiktoken asset", e);
        }
    }

    private static String sha256(byte[] content) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(content);
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte value : digest) hex.append(String.format("%02x", value & 0xff));
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("JDK does not provide SHA-256", e);
        }
    }

    static WhisperTokenizer parseTiktoken(byte[] content, int maxBytes) {
        if (content.length == 0 || content.length > maxBytes) {
            throw new ModelLoadingError("Whisper tiktoken asset is empty or exceeds its size limit");
        }
        final String text;
        try {
            text = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(content)).toString();
        } catch (CharacterCodingException e) {
            throw new ModelLoadingError("Whisper tiktoken asset is not valid UTF-8", e);
        }
        Map<Long, String> tokens = new HashMap<>();
        Set<String> seenTokens = new HashSet<>();
        Map<Integer, Character> byteEncoder = createByteEncoder();
        String[] lines = text.split("\\n", -1);
        for (int lineNumber = 0; lineNumber < lines.length; lineNumber++) {
            String line = lines[lineNumber];
            if (line.endsWith("\r")) line = line.substring(0, line.length() - 1);
            if (line.isEmpty() && lineNumber == lines.length - 1) continue;
            int separator = line.lastIndexOf(' ');
            if (separator <= 0 || separator == line.length() - 1) {
                throw new ModelLoadingError("Whisper tiktoken asset has malformed row at line " + (lineNumber + 1));
            }
            byte[] tokenBytes;
            long rank;
            try {
                String encodedToken = line.substring(0, separator);
                rank = Long.parseLong(line.substring(separator + 1));
                if ("=".equals(encodedToken)) {
                    if (rank != 50_256L) {
                        throw new ModelLoadingError("Whisper tiktoken asset has empty token encoding outside rank 50256 at line " + (lineNumber + 1));
                    }
                    tokenBytes = new byte[0];
                } else {
                    tokenBytes = Base64.getDecoder().decode(encodedToken);
                }
            } catch (ModelLoadingError e) {
                throw e;
            } catch (IllegalArgumentException e) {
                throw new ModelLoadingError("Whisper tiktoken asset has malformed token or rank at line " + (lineNumber + 1), e);
            }
            if ((tokenBytes.length == 0 && rank != 50_256L) || rank < 0 || rank >= content.length || tokens.containsKey(rank)) {
                throw new ModelLoadingError("Whisper tiktoken asset has duplicate, negative, or out-of-range rank at line " + (lineNumber + 1));
            }
            StringBuilder encodedToken = new StringBuilder(tokenBytes.length);
            for (byte tokenByte : tokenBytes) {
                Character codepoint = byteEncoder.get(tokenByte & 0xff);
                if (codepoint == null) throw new IllegalStateException("Incomplete GPT-2 byte encoder");
                encodedToken.append(codepoint);
            }
            if (!seenTokens.add(encodedToken.toString())) {
                throw new ModelLoadingError("Whisper tiktoken asset contains duplicate token bytes at line " + (lineNumber + 1));
            }
            tokens.put(rank, encodedToken.toString());
        }
        if (tokens.isEmpty()) throw new ModelLoadingError("Whisper tiktoken asset contains no tokens");
        for (long rank = 0; rank < tokens.size(); rank++) {
            if (!tokens.containsKey(rank)) {
                throw new ModelLoadingError("Whisper tiktoken asset ranks contain a gap at " + rank);
            }
        }
        return new WhisperTokenizer(tokens, tiktokenSpecialIds());
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
        return new WhisperTokenizer(tokens, legacySpecialIds(tokens));
    }

    static WhisperTokenizer forTiktokenTokens(Map<Long, String> tokens) {
        return new WhisperTokenizer(tokens, tiktokenSpecialIds());
    }

    String decode(long[] ids) {
        List<Byte> bytes = new ArrayList<>();
        for (long id : ids) {
            if (id < 0) throw new IllegalArgumentException("Whisper output contains a negative token ID");
            if (specialIds.contains(id)) continue;
            String token = tokens.get(id);
            if (token == null) throw new IllegalArgumentException("Whisper output token ID is absent from configured vocabulary: " + id);
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

    static long[] transcriptionPrompt(Locale locale) {
        String language = locale == null ? "" : locale.getLanguage().toLowerCase(Locale.ROOT);
        int languageIndex = MULTILINGUAL_LANGUAGES.indexOf(language);
        if (languageIndex < 0) {
            throw new IllegalArgumentException("Whisper multilingual model does not support language: " + language);
        }
        return new long[]{START_OF_TRANSCRIPT, START_OF_TRANSCRIPT + 1 + languageIndex, TRANSCRIBE, NO_TIMESTAMPS};
    }

    static long endOfTextToken() { return END_OF_TEXT; }
    static long noSpeechToken() { return NO_SPEECH; }
    static long blankTokenId() { return 220L; }

    private static Set<Long> legacySpecialIds(Map<Long, String> tokens) {
        Set<Long> specials = new HashSet<>();
        tokens.forEach((id, token) -> {
            if (isSpecialToken(token)) specials.add(id);
        });
        return specials;
    }

    private static Set<Long> tiktokenSpecialIds() {
        Set<Long> specials = new HashSet<>();
        for (long id = FIRST_WHISPER_SPECIAL_ID; id <= LAST_WHISPER_SPECIAL_ID; id++) specials.add(id);
        return specials;
    }

    private static boolean isSpecialToken(String token) {
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

    private static Map<Integer, Character> createByteEncoder() {
        Map<Integer, Character> encoder = new HashMap<>();
        createByteDecoder().forEach((codepoint, value) -> encoder.put(value & 0xff, (char) codepoint.intValue()));
        return encoder;
    }
}
