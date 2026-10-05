package com.ghatana.audio.video.multimodal.adapter;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Typed transport-security policy for Media STT gRPC providers.
 *
 * <p>Production-like profiles require explicit trust material and TLS or mTLS. Plaintext is
 * restricted to explicit local/test/development profiles and is never the default.
 *
 * @doc.type record
 * @doc.purpose Fail-closed TLS/mTLS policy for grounded STT provider transport
 * @doc.layer product
 * @doc.pattern Configuration, Security Policy
 */
public record SttGrpcTransportSecurity(
        Mode mode,
        Profile profile,
        Path trustCertificate,
        Path clientCertificate,
        Path clientPrivateKey) {

    private static final Set<Profile> PLAINTEXT_PROFILES = Set.of(
            Profile.LOCAL, Profile.TEST, Profile.DEVELOPMENT);

    public SttGrpcTransportSecurity {
        mode = Objects.requireNonNull(mode, "mode");
        profile = Objects.requireNonNull(profile, "profile");
        trustCertificate = normalize(trustCertificate);
        clientCertificate = normalize(clientCertificate);
        clientPrivateKey = normalize(clientPrivateKey);

        if (mode == Mode.PLAINTEXT && !PLAINTEXT_PROFILES.contains(profile)) {
            throw new IllegalArgumentException(
                    "Plaintext STT gRPC transport is allowed only in local/test/development profiles");
        }
        if (profile.productionLike() && mode == Mode.PLAINTEXT) {
            throw new IllegalArgumentException(
                    "Production-like STT gRPC transport requires TLS or mTLS");
        }
        if (profile.productionLike() && trustCertificate == null) {
            throw new IllegalArgumentException(
                    "Production-like STT gRPC transport requires STT_GRPC_TRUST_CERT_PATH");
        }
        if (mode == Mode.MTLS) {
            if (trustCertificate == null || clientCertificate == null || clientPrivateKey == null) {
                throw new IllegalArgumentException(
                        "mTLS requires trust, client certificate, and client private-key paths");
            }
        }
        requireReadableFile(trustCertificate, "trust certificate");
        requireReadableFile(clientCertificate, "client certificate");
        requireReadableFile(clientPrivateKey, "client private key");
    }

    public static SttGrpcTransportSecurity fromEnvironment(Map<String, String> environment) {
        Objects.requireNonNull(environment, "environment");
        Profile profile = Profile.parse(environment.getOrDefault(
                "MEDIA_RUNTIME_ENVIRONMENT",
                environment.getOrDefault("MEDIA_PROFILE", "local")));
        Mode mode = Mode.parse(environment.getOrDefault("STT_GRPC_TRANSPORT_MODE", "tls"));
        return new SttGrpcTransportSecurity(
                mode,
                profile,
                optionalPath(environment.get("STT_GRPC_TRUST_CERT_PATH")),
                optionalPath(environment.get("STT_GRPC_CLIENT_CERT_PATH")),
                optionalPath(environment.get("STT_GRPC_CLIENT_KEY_PATH")));
    }

    /** Explicit test/local-only plaintext policy. */
    public static SttGrpcTransportSecurity localPlaintext() {
        return new SttGrpcTransportSecurity(Mode.PLAINTEXT, Profile.TEST, null, null, null);
    }

    public enum Mode {
        TLS,
        MTLS,
        PLAINTEXT;

        static Mode parse(String value) {
            try {
                return Mode.valueOf(requireText(value, "STT_GRPC_TRANSPORT_MODE")
                        .toUpperCase(Locale.ROOT));
            } catch (IllegalArgumentException failure) {
                throw new IllegalArgumentException(
                        "STT_GRPC_TRANSPORT_MODE must be tls, mtls, or plaintext", failure);
            }
        }
    }

    public enum Profile {
        LOCAL,
        TEST,
        DEVELOPMENT,
        STAGING,
        PRODUCTION,
        SOVEREIGN;

        static Profile parse(String value) {
            try {
                return Profile.valueOf(requireText(value, "MEDIA_RUNTIME_ENVIRONMENT")
                        .toUpperCase(Locale.ROOT));
            } catch (IllegalArgumentException failure) {
                throw new IllegalArgumentException(
                        "MEDIA runtime profile must be local, test, development, staging, production, or sovereign",
                        failure);
            }
        }

        boolean productionLike() {
            return this == STAGING || this == PRODUCTION || this == SOVEREIGN;
        }
    }

    private static Path optionalPath(String value) {
        return value == null || value.isBlank() ? null : Path.of(value.trim());
    }

    private static Path normalize(Path value) {
        return value == null ? null : value.toAbsolutePath().normalize();
    }

    private static void requireReadableFile(Path path, String label) {
        if (path != null && (!Files.isRegularFile(path) || !Files.isReadable(path))) {
            throw new IllegalArgumentException("STT gRPC " + label + " must be a readable file: " + path);
        }
    }

    private static String requireText(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(field + " must not be blank");
        }
        return value.trim();
    }
}
