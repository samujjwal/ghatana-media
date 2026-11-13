package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanVerdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.ScanAttestationBinding;
import com.ghatana.media.runtime.MediaRuntimeContracts.ScanAttestationVerifier;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Function;

/**
 * JDK-only Ed25519 verifier for the scanner's signed attestation (TS {@code signAttestation}/
 * {@code ed25519Signer}). It verifies exactly the canonical-JSON bytes the TS scanner signed: those
 * bytes are fetched by attestation reference through a host-injected resolver, must hash to the
 * binding's {@code payloadSha256}, and must carry a valid signature from a trusted, unrevoked,
 * in-validity key. Signed claims (tenant, digest, size, verdict, expiry, attestation ref) must equal
 * the decision. Only public keys are held here; the algorithm allow-list defaults to Ed25519 only.
 *
 * <p>HMAC-SHA256 (the TS test-friendly mode) is deliberately NOT supported: a verifier holding the
 * shared secret could also forge attestations, so it is not a production verification mode.
 * Every failure returns {@code false} (fail closed).
 */
public final class Ed25519ScanAttestationVerifier implements ScanAttestationVerifier {
    /** Trusted verification key for one {@code keyId}, with an optional validity window. */
    public record TrustRoot(PublicKey publicKey, Instant notBefore, Instant notAfter) {
        public TrustRoot {
            Objects.requireNonNull(publicKey, "publicKey");
            if (!"Ed25519".equals(publicKey.getAlgorithm()) && !"EdDSA".equals(publicKey.getAlgorithm())) {
                throw new IllegalArgumentException("trust root must be an Ed25519 public key");
            }
        }

        public TrustRoot(PublicKey publicKey) { this(publicKey, null, null); }
    }

    private static final int MAX_PAYLOAD_BYTES = 64 * 1024;
    private final Map<String, TrustRoot> trustRoots;
    private final Set<String> revokedKeyIds;
    private final Set<String> allowedAlgorithms;
    private final Function<String, byte[]> canonicalPayloadByAttestationRef;

    /**
     * @param trustRoots trusted public keys by keyId (copied)
     * @param revokedKeyIds key ids that must never verify, even if present in trustRoots (copied)
     * @param allowedAlgorithms binding algorithms accepted; only {@code Ed25519} can ever verify
     * @param canonicalPayloadByAttestationRef resolves the exact signed canonical bytes, or null if unknown
     */
    public Ed25519ScanAttestationVerifier(
            Map<String, TrustRoot> trustRoots, Set<String> revokedKeyIds, Set<String> allowedAlgorithms,
            Function<String, byte[]> canonicalPayloadByAttestationRef) {
        this.trustRoots = Map.copyOf(Objects.requireNonNull(trustRoots, "trustRoots"));
        this.revokedKeyIds = Set.copyOf(Objects.requireNonNull(revokedKeyIds, "revokedKeyIds"));
        this.allowedAlgorithms = Set.copyOf(Objects.requireNonNull(allowedAlgorithms, "allowedAlgorithms"));
        this.canonicalPayloadByAttestationRef =
                Objects.requireNonNull(canonicalPayloadByAttestationRef, "canonicalPayloadByAttestationRef");
    }

    @Override
    public boolean verify(ArtifactScanDecision decision, ScanAttestationBinding binding, Instant now) {
        try {
            return verifyOrThrow(decision, binding, now);
        } catch (RuntimeException | GeneralSecurityException failure) {
            return false;
        }
    }

    private boolean verifyOrThrow(ArtifactScanDecision decision, ScanAttestationBinding binding, Instant now)
            throws GeneralSecurityException {
        if (decision == null || binding == null || now == null) return false;
        if (!"Ed25519".equals(binding.algorithm()) || !allowedAlgorithms.contains(binding.algorithm())) return false;
        if (revokedKeyIds.contains(binding.keyId())) return false;
        TrustRoot root = trustRoots.get(binding.keyId());
        if (root == null) return false;
        if (root.notBefore() != null && now.isBefore(root.notBefore())) return false;
        if (root.notAfter() != null && !now.isBefore(root.notAfter())) return false;

        byte[] payload = canonicalPayloadByAttestationRef.apply(binding.attestationRef());
        if (payload == null || payload.length == 0 || payload.length > MAX_PAYLOAD_BYTES) return false;
        String payloadHash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(payload));
        if (!MessageDigest.isEqual(payloadHash.getBytes(StandardCharsets.US_ASCII),
                binding.payloadSha256().getBytes(StandardCharsets.US_ASCII))) {
            return false;
        }
        byte[] signature = Base64.getUrlDecoder().decode(binding.signature());
        Signature verifier = Signature.getInstance("Ed25519");
        verifier.initVerify(root.publicKey());
        verifier.update(payload);
        if (!verifier.verify(signature)) return false;
        return claimsMatch(decision, binding, now, payload);
    }

    private static boolean claimsMatch(
            ArtifactScanDecision decision, ScanAttestationBinding binding, Instant now, byte[] payload) {
        Object parsed = new Json(new String(payload, StandardCharsets.UTF_8)).parseDocument();
        if (!(parsed instanceof Map<?, ?> claims)) return false;
        Object scanned = claims.get("scannedDigest");
        Object scannedValue = scanned instanceof Map<?, ?> digest ? digest.get("value") : null;
        Object scannedAlgorithm = scanned instanceof Map<?, ?> digest ? digest.get("algorithm") : null;
        Object size = claims.get("scannedSizeBytes");
        if (!binding.attestationRef().equals(claims.get("attestationRef"))) return false;
        if (!decision.tenantId().equals(claims.get("tenantId"))) return false;
        if (!"SHA-256".equals(scannedAlgorithm) || !decision.sourceSha256().equals(scannedValue)) return false;
        if (!(size instanceof Long signedSize) || signedSize != decision.sizeBytes()) return false;
        if (decision.verdict() != ArtifactScanVerdict.CLEAN
                || !"CLEAN".equals(claims.get("verdict")) || !"CLEAN".equals(claims.get("status"))) {
            return false;
        }
        Instant verifiedAt = instant(claims.get("verifiedAt"));
        Instant expiresAt = instant(claims.get("expiresAt"));
        if (verifiedAt == null || expiresAt == null || !expiresAt.isAfter(verifiedAt)) return false;
        if (!expiresAt.isAfter(now) || verifiedAt.isAfter(now.plusSeconds(5))) return false;
        // The decision must not outlive the signed attestation it relies on.
        return !decision.expiresAt().isAfter(expiresAt);
    }

    private static Instant instant(Object value) {
        if (!(value instanceof String text)) return null;
        try {
            return Instant.parse(text);
        } catch (RuntimeException invalid) {
            return null;
        }
    }

    /** Minimal strict JSON reader (objects, arrays, strings, integers/decimals, literals) for the signed payload. */
    private static final class Json {
        private final String text;
        private int position;

        Json(String text) { this.text = text; }

        Object parseDocument() {
            Object value = value(0);
            if (position != text.length()) throw new IllegalArgumentException("trailing JSON content");
            return value;
        }

        private Object value(int depth) {
            if (depth > 16) throw new IllegalArgumentException("JSON too deep");
            if (position >= text.length()) throw new IllegalArgumentException("unexpected end");
            char c = text.charAt(position);
            if (c == '{') return object(depth);
            if (c == '[') return array(depth);
            if (c == '"') return string();
            if (text.startsWith("true", position)) { position += 4; return Boolean.TRUE; }
            if (text.startsWith("false", position)) { position += 5; return Boolean.FALSE; }
            if (text.startsWith("null", position)) { position += 4; return null; }
            return number();
        }

        private Map<String, Object> object(int depth) {
            Map<String, Object> out = new LinkedHashMap<>();
            position++;
            if (peek() == '}') { position++; return out; }
            while (true) {
                String key = string();
                expect(':');
                if (out.containsKey(key)) throw new IllegalArgumentException("duplicate key");
                out.put(key, value(depth + 1));
                char next = take();
                if (next == '}') return out;
                if (next != ',') throw new IllegalArgumentException("expected , or }");
            }
        }

        private List<Object> array(int depth) {
            List<Object> out = new ArrayList<>();
            position++;
            if (peek() == ']') { position++; return out; }
            while (true) {
                out.add(value(depth + 1));
                char next = take();
                if (next == ']') return out;
                if (next != ',') throw new IllegalArgumentException("expected , or ]");
            }
        }

        private String string() {
            if (take() != '"') throw new IllegalArgumentException("expected string");
            StringBuilder out = new StringBuilder();
            while (true) {
                if (position >= text.length()) throw new IllegalArgumentException("unterminated string");
                char c = text.charAt(position++);
                if (c == '"') return out.toString();
                if (c < 0x20) throw new IllegalArgumentException("control character in string");
                if (c != '\\') { out.append(c); continue; }
                char e = take();
                switch (e) {
                    case '"', '\\', '/' -> out.append(e);
                    case 'b' -> out.append('\b');
                    case 'f' -> out.append('\f');
                    case 'n' -> out.append('\n');
                    case 'r' -> out.append('\r');
                    case 't' -> out.append('\t');
                    case 'u' -> {
                        if (position + 4 > text.length()) throw new IllegalArgumentException("bad escape");
                        out.append((char) Integer.parseInt(text.substring(position, position + 4), 16));
                        position += 4;
                    }
                    default -> throw new IllegalArgumentException("bad escape");
                }
            }
        }

        private Object number() {
            int start = position;
            while (position < text.length() && "+-0123456789.eE".indexOf(text.charAt(position)) >= 0) position++;
            String token = text.substring(start, position);
            if (token.isEmpty()) throw new IllegalArgumentException("unexpected token");
            if (token.chars().allMatch(ch -> ch == '-' || (ch >= '0' && ch <= '9'))) return Long.parseLong(token);
            return Double.parseDouble(token);
        }

        private char peek() {
            if (position >= text.length()) throw new IllegalArgumentException("unexpected end");
            return text.charAt(position);
        }

        private char take() {
            char c = peek();
            position++;
            return c;
        }

        private void expect(char expected) {
            if (take() != expected) throw new IllegalArgumentException("expected " + expected);
        }
    }
}
