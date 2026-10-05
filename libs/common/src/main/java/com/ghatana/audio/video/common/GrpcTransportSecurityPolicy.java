package com.ghatana.audio.video.common;

import java.nio.file.Path;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

/**
 * Resolves one consistent TLS/plaintext policy for standalone Media gRPC services.
 *
 * <p>Production, staging, and sovereign profiles require TLS. Local/test profiles may use
 * plaintext only when neither service-specific nor shared Media TLS material is configured.
 * Service-specific certificate/key configuration takes precedence over the shared Media pair,
 * but a pair can never be assembled across scopes.
 *
 * @doc.type class
 * @doc.purpose Resolve fail-closed profile-aware Media gRPC transport security
 * @doc.layer product
 * @doc.pattern Policy, Configuration
 */
public final class GrpcTransportSecurityPolicy {
    private static final String SHARED_CERTIFICATE = "MEDIA_GRPC_TLS_CERT_CHAIN_PATH";
    private static final String SHARED_PRIVATE_KEY = "MEDIA_GRPC_TLS_PRIVATE_KEY_PATH";

    private GrpcTransportSecurityPolicy() { }

    public static AudioVideoGrpcServerBase.TransportSecurity resolve(
            Map<String, String> environment,
            String servicePrefix) {
        Objects.requireNonNull(environment, "environment");
        String prefix = canonicalPrefix(servicePrefix);
        String profile = firstNonBlank(
                environment.get(prefix + "_ENVIRONMENT"),
                environment.get("MEDIA_ENVIRONMENT"),
                environment.get("GHATANA_DEPLOYMENT_PROFILE"),
                "local").toLowerCase(Locale.ROOT);
        boolean productionLike = switch (profile) {
            case "production", "staging", "sovereign" -> true;
            default -> false;
        };

        String serviceCertificateKey = prefix + "_GRPC_TLS_CERT_CHAIN_PATH";
        String servicePrivateKeyKey = prefix + "_GRPC_TLS_PRIVATE_KEY_PATH";
        String serviceCertificate = text(environment.get(serviceCertificateKey));
        String servicePrivateKey = text(environment.get(servicePrivateKeyKey));
        String sharedCertificate = text(environment.get(SHARED_CERTIFICATE));
        String sharedPrivateKey = text(environment.get(SHARED_PRIVATE_KEY));

        Pair pair;
        if (!serviceCertificate.isBlank() || !servicePrivateKey.isBlank()) {
            pair = completePair(serviceCertificate, servicePrivateKey,
                    serviceCertificateKey, servicePrivateKeyKey);
        } else if (!sharedCertificate.isBlank() || !sharedPrivateKey.isBlank()) {
            pair = completePair(sharedCertificate, sharedPrivateKey,
                    SHARED_CERTIFICATE, SHARED_PRIVATE_KEY);
        } else {
            if (productionLike) {
                throw new IllegalStateException(
                        "Production-like " + prefix + " gRPC requires TLS certificate chain and private key; "
                                + "configure " + serviceCertificateKey + "/" + servicePrivateKeyKey
                                + " or " + SHARED_CERTIFICATE + "/" + SHARED_PRIVATE_KEY);
            }
            return AudioVideoGrpcServerBase.TransportSecurity.plaintext();
        }
        return AudioVideoGrpcServerBase.TransportSecurity.tls(
                Path.of(pair.certificate()), Path.of(pair.privateKey()));
    }

    private static Pair completePair(
            String certificate,
            String privateKey,
            String certificateKey,
            String privateKeyKey) {
        if (certificate.isBlank() || privateKey.isBlank()) {
            throw new IllegalArgumentException(
                    certificateKey + " and " + privateKeyKey + " must be configured together");
        }
        return new Pair(certificate, privateKey);
    }

    private static String canonicalPrefix(String value) {
        String prefix = text(value).toUpperCase(Locale.ROOT);
        if (!prefix.matches("[A-Z][A-Z0-9_]*")) {
            throw new IllegalArgumentException("servicePrefix must be an uppercase environment token");
        }
        return prefix;
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            String normalized = text(value);
            if (!normalized.isBlank()) return normalized;
        }
        return "";
    }

    private static String text(String value) {
        return value == null ? "" : value.trim();
    }

    private record Pair(String certificate, String privateKey) { }
}
