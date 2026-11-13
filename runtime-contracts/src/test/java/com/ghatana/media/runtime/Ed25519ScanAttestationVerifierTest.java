package com.ghatana.media.runtime;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import com.ghatana.media.runtime.Ed25519ScanAttestationVerifier.TrustRoot;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactScanVerdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.QuarantinedArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ScanAttestationBinding;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Cross-language test: the vector in scan-attestation/ed25519-interop-v1.json was produced by the TS
 * scanner package (ed25519Signer + attestationBinding) with a TEST-ONLY key and is verified here by the JDK
 * verifier over exactly the canonical bytes the TS side signed.
 */
class Ed25519ScanAttestationVerifierTest {
    private static JsonNode fixture;
    private static PublicKey publicKey;
    private static String payload;
    private static ScanAttestationBinding binding;
    private static final Instant NOW = Instant.parse("2026-11-12T12:05:00Z");

    @BeforeAll
    static void load() throws Exception {
        try (InputStream in = Ed25519ScanAttestationVerifierTest.class
                .getResourceAsStream("/scan-attestation/ed25519-interop-v1.json")) {
            fixture = new ObjectMapper().readTree(in);
        }
        publicKey = KeyFactory.getInstance("Ed25519").generatePublic(
                new X509EncodedKeySpec(Base64.getDecoder().decode(fixture.get("publicKeySpkiBase64").asString())));
        payload = fixture.get("canonicalPayload").asString();
        JsonNode b = fixture.get("binding");
        binding = new ScanAttestationBinding(b.get("attestationRef").asString(), b.get("algorithm").asString(),
                b.get("keyId").asString(), b.get("signature").asString(), b.get("payloadSha256").asString());
    }

    private static ArtifactScanDecision decision(ArtifactScanVerdict verdict, String tenant, long size, Instant expires) {
        JsonNode f = fixture.get("facts");
        return new ArtifactScanDecision("clamd", "1.4.0", "policy", "p1", tenant, "principal-a",
                f.get("uploadId").asString(), f.get("sha256").asString(), size, "video/mp4", verdict,
                Instant.parse("2026-11-12T12:00:00Z"), expires).withAttestation(binding);
    }

    private static ArtifactScanDecision good() {
        return decision(ArtifactScanVerdict.CLEAN, "tenant-a", 4096, Instant.parse("2026-11-12T12:09:00Z"));
    }

    private static Ed25519ScanAttestationVerifier verifier(
            Map<String, TrustRoot> roots, Set<String> revoked, Set<String> algs, String servedPayload) {
        return new Ed25519ScanAttestationVerifier(roots, revoked, algs,
                ref -> ref.equals("att-interop-0001") ? servedPayload.getBytes(StandardCharsets.UTF_8) : null);
    }

    private static Ed25519ScanAttestationVerifier trusting() {
        return verifier(Map.of("interop-key-1", new TrustRoot(publicKey)), Set.of(), Set.of("Ed25519"), payload);
    }

    @Test
    void verifiesTypeScriptSignedAttestationOverExactCanonicalBytes() {
        assertThat(trusting().verify(good(), binding, NOW)).isTrue();
        var artifact = new QuarantinedArtifact("tenant-a", "principal-a", "upload-a",
                fixture.get("facts").get("sha256").asString(), 4096, "video/mp4", "quarantine://x");
        assertThat(ArtifactScanDecision.admitsSignedRelease(good(), artifact, NOW, trusting())).isTrue();
    }

    @Test
    void tamperedPayloadIsRejected() {
        String tampered = payload.replace("\"scannedSizeBytes\":4096", "\"scannedSizeBytes\":4097");
        assertThat(verifier(Map.of("interop-key-1", new TrustRoot(publicKey)), Set.of(), Set.of("Ed25519"), tampered)
                .verify(good(), binding, NOW)).isFalse();
        // payload and hash both substituted, signature no longer matches
        var rebound = new ScanAttestationBinding(binding.attestationRef(), binding.algorithm(), binding.keyId(),
                binding.signature(), sha256Hex(tampered));
        assertThat(verifier(Map.of("interop-key-1", new TrustRoot(publicKey)), Set.of(), Set.of("Ed25519"), tampered)
                .verify(good().withAttestation(rebound), rebound, NOW)).isFalse();
    }

    @Test
    void tamperedSignatureIsRejected() {
        char[] sig = binding.signature().toCharArray();
        sig[3] = sig[3] == 'A' ? 'B' : 'A';
        var bad = new ScanAttestationBinding(binding.attestationRef(), binding.algorithm(), binding.keyId(),
                new String(sig), binding.payloadSha256());
        assertThat(trusting().verify(good().withAttestation(bad), bad, NOW)).isFalse();
    }

    @Test
    void wrongKeyAndUnknownKeyAreRejected() throws Exception {
        KeyPair other = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        assertThat(verifier(Map.of("interop-key-1", new TrustRoot(other.getPublic())), Set.of(), Set.of("Ed25519"), payload)
                .verify(good(), binding, NOW)).isFalse();
        assertThat(verifier(Map.of("someone-else", new TrustRoot(publicKey)), Set.of(), Set.of("Ed25519"), payload)
                .verify(good(), binding, NOW)).isFalse();
    }

    @Test
    void revokedKeyIsRejectedEvenWhenTrusted() {
        assertThat(verifier(Map.of("interop-key-1", new TrustRoot(publicKey)), Set.of("interop-key-1"),
                Set.of("Ed25519"), payload).verify(good(), binding, NOW)).isFalse();
    }

    @Test
    void expiredAttestationAndOutOfWindowKeyAreRejected() {
        assertThat(trusting().verify(good(), binding, Instant.parse("2026-11-12T12:10:01Z"))).isFalse();
        assertThat(verifier(Map.of("interop-key-1", new TrustRoot(publicKey, null, Instant.parse("2026-11-12T12:01:00Z"))),
                Set.of(), Set.of("Ed25519"), payload).verify(good(), binding, NOW)).isFalse();
        assertThat(verifier(Map.of("interop-key-1", new TrustRoot(publicKey, Instant.parse("2026-11-12T12:30:00Z"), null)),
                Set.of(), Set.of("Ed25519"), payload).verify(good(), binding, NOW)).isFalse();
    }

    @Test
    void algorithmAllowListAndHmacAreRejected() {
        assertThat(verifier(Map.of("interop-key-1", new TrustRoot(publicKey)), Set.of(), Set.of("HMAC-SHA256"), payload)
                .verify(good(), binding, NOW)).isFalse();
        var hmac = new ScanAttestationBinding(binding.attestationRef(), "HMAC-SHA256", binding.keyId(),
                binding.signature(), binding.payloadSha256());
        assertThat(verifier(Map.of("interop-key-1", new TrustRoot(publicKey)), Set.of(), Set.of("Ed25519", "HMAC-SHA256"),
                payload).verify(good().withAttestation(hmac), hmac, NOW)).isFalse();
    }

    @Test
    void signedClaimsMustEqualDecisionAndPayloadMustBeResolvable() {
        assertThat(trusting().verify(decision(ArtifactScanVerdict.CLEAN, "tenant-b", 4096,
                Instant.parse("2026-11-12T12:09:00Z")), binding, NOW)).isFalse();
        assertThat(trusting().verify(decision(ArtifactScanVerdict.CLEAN, "tenant-a", 4095,
                Instant.parse("2026-11-12T12:09:00Z")), binding, NOW)).isFalse();
        assertThat(trusting().verify(decision(ArtifactScanVerdict.REJECT, "tenant-a", 4096,
                Instant.parse("2026-11-12T12:09:00Z")), binding, NOW)).isFalse();
        assertThat(trusting().verify(decision(ArtifactScanVerdict.CLEAN, "tenant-a", 4096,
                Instant.parse("2026-11-12T12:20:00Z")), binding, NOW)).isFalse();
        var unknownRef = new ScanAttestationBinding("att-unknown", binding.algorithm(), binding.keyId(),
                binding.signature(), binding.payloadSha256());
        assertThat(trusting().verify(good().withAttestation(unknownRef), unknownRef, NOW)).isFalse();
    }

    private static String sha256Hex(String text) {
        try {
            return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                    .digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
