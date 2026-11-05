package com.ghatana.media.runtime;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import java.util.Objects;

/** HMAC-SHA-256 aliases prevent raw IDs and dictionary-checkable plain hashes leaving Media. */
public final class HmacMediaLifecycleIdentifierRedactor implements MediaLifecycleIdentifierRedactor {
    private final byte[] key;

    public HmacMediaLifecycleIdentifierRedactor(byte[] key) {
        Objects.requireNonNull(key, "key");
        if (key.length < 32) throw new IllegalArgumentException("redaction key must contain at least 256 bits");
        this.key = key.clone();
    }

    @Override
    public String redact(String identifierKind, String rawIdentifier) {
        if (identifierKind == null || !identifierKind.matches("[a-z][a-z0-9-]{0,31}")) {
            throw new IllegalArgumentException("identifierKind is invalid");
        }
        if (rawIdentifier == null || rawIdentifier.isBlank() || rawIdentifier.length() > 512) {
            throw new IllegalArgumentException("rawIdentifier must be bounded and non-blank");
        }
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            byte[] digest = mac.doFinal((identifierKind + "\0" + rawIdentifier.trim())
                    .getBytes(StandardCharsets.UTF_8));
            return "r1_" + HexFormat.of().formatHex(digest);
        } catch (java.security.GeneralSecurityException failure) {
            throw new IllegalStateException("Lifecycle identifier redaction is unavailable", failure);
        }
    }
}
