package com.ghatana.media.runtime;

/** Shared Java rules for the PDP-1 opaque version-reference wire shape. */
final class MediaVersionRefRules {
    private MediaVersionRefRules() { }

    /** Mirrors the TypeScript {@code /^\\S+$/} predicate and its 384-code-point bound. */
    static boolean isValid(String value) {
        return value != null && !value.isEmpty()
                && value.codePointCount(0, value.length()) <= 384
                && hasWellFormedUtf16(value)
                && value.codePoints().noneMatch(MediaVersionRefRules::isEcmaScriptWhitespace);
    }

    /** PDP-1 semantic-source refs additionally exclude U+001C–U+001F explicitly. */
    static boolean isValidSemanticSourceRef(String value) {
        return isValid(value) && value.codePoints().noneMatch(codePoint -> codePoint >= 0x001C && codePoint <= 0x001F);
    }

    static boolean hasWellFormedUtf16(String value) {
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (Character.isHighSurrogate(current)) {
                if (index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1))) {
                    return false;
                }
                index++;
            } else if (Character.isLowSurrogate(current)) {
                return false;
            }
        }
        return true;
    }

    /** ECMAScript WhiteSpace and LineTerminator code points used by {@code \\S}. */
    private static boolean isEcmaScriptWhitespace(int codePoint) {
        return switch (codePoint) {
            case 0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020,
                    0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF -> true;
            default -> codePoint >= 0x2000 && codePoint <= 0x200A;
        };
    }
}
