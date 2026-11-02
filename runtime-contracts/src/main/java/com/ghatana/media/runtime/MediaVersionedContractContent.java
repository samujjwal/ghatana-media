package com.ghatana.media.runtime;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Objects;

/**
 * Opaque contract content returned by a Media contract resolver. This helper
 * checks the resolver response's reference echo and self-reported digest, then
 * exposes a local fingerprint input. It does not prove that a reference is
 * immutable, authorized, or correctly mapped by a trusted store, and it does
 * not parse, validate, or assign semantics to the content.
 */
public final class MediaVersionedContractContent {
    /** Operational guard for each already-materialized resolver response. */
    public static final int MAX_CONTENT_BYTES = 1_048_576;

    private MediaVersionedContractContent() { }

    @FunctionalInterface
    public interface Resolver {
        ResolvedContent resolve(String requestedVersionRef);
    }

    /** Raw resolver result. The byte array is copied on construction and access. */
    public record ResolvedContent(String versionRef, byte[] content, String sha256) {
        public ResolvedContent {
            Objects.requireNonNull(versionRef, "versionRef");
            byte[] suppliedContent = Objects.requireNonNull(content, "content");
            if (suppliedContent.length > MAX_CONTENT_BYTES) {
                throw new IllegalArgumentException("resolved content exceeds the operational byte limit");
            }
            content = suppliedContent.clone();
            sha256 = normalizeDigest(sha256);
        }

        @Override public byte[] content() { return content.clone(); }
    }

    /** Resolver response fingerprint; it is not an authority or immutable-source proof. */
    public record ResolvedContentFingerprint(String versionRef, String sha256, int byteLength) {
        public ResolvedContentFingerprint {
            Objects.requireNonNull(versionRef, "versionRef");
            sha256 = normalizeDigest(sha256);
            if (byteLength < 0) throw new IllegalArgumentException("byteLength must be nonnegative");
        }
    }

    /**
     * Resolve one reference and check that the resolver echoed it and that its
     * claimed digest matches the returned bytes. The resolver must independently
     * enforce immutable-version lookup and authorization; this method cannot
     * establish those properties from the echoed reference and response alone.
     */
    public static ResolvedContentFingerprint resolveDigestChecked(String requestedVersionRef, Resolver resolver) {
        Objects.requireNonNull(requestedVersionRef, "requestedVersionRef");
        ResolvedContent resolved = Objects.requireNonNull(resolver, "resolver").resolve(requestedVersionRef);
        if (resolved == null) throw new IllegalArgumentException("versioned content is unavailable");
        if (!requestedVersionRef.equals(resolved.versionRef())) {
            throw new IllegalArgumentException("resolver returned content for a different version reference");
        }
        byte[] bytes = resolved.content();
        String actualDigest = "sha256:" + sha256(bytes);
        if (!actualDigest.equals(resolved.sha256())) {
            throw new IllegalArgumentException("resolved content digest does not match its bytes");
        }
        return new ResolvedContentFingerprint(requestedVersionRef, actualDigest, bytes.length);
    }

    private static String normalizeDigest(String value) {
        if (value == null || !value.matches("sha256:[0-9a-f]{64}")) {
            throw new IllegalArgumentException("sha256 must be a lowercase sha256 digest");
        }
        return value;
    }

    private static String sha256(byte[] value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
