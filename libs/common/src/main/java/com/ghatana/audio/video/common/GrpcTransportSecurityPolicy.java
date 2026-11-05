package com.ghatana.audio.video.common;

import java.nio.file.Path;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

/**
 * Resolves one consistent mTLS/TLS/plaintext policy for standalone Media gRPC services.
 *
 * <p>Production, staging, and sovereign profiles require mutual TLS with an explicit client CA.
 * Plaintext requires an explicit local/test/development profile and is selected only when no
 * service-specific or shared Media TLS material is configured. A configured client CA enables
 * mutual TLS in any profile.
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
    private static final String SHARED_CLIENT_CA = "MEDIA_GRPC_TLS_CLIENT_CA_PATH";

    private GrpcTransportSecurityPolicy() { }

    public static AudioVideoGrpcServerBase.TransportSecurity resolve(
            Map<String, String> environment,
            String servicePrefix) {
        Objects.requireNonNull(environment, "environment");
        String prefix = canonicalPrefix(servicePrefix);
        Profiles profiles = resolveProfiles(environment, prefix);

        String serviceCertificateKey = prefix + "_GRPC_TLS_CERT_CHAIN_PATH";
        String servicePrivateKeyKey = prefix + "_GRPC_TLS_PRIVATE_KEY_PATH";
        String serviceClientCaKey = prefix + "_GRPC_TLS_CLIENT_CA_PATH";
        String serviceCertificate = text(environment.get(serviceCertificateKey));
        String servicePrivateKey = text(environment.get(servicePrivateKeyKey));
        String serviceClientCa = text(environment.get(serviceClientCaKey));
        String sharedCertificate = text(environment.get(SHARED_CERTIFICATE));
        String sharedPrivateKey = text(environment.get(SHARED_PRIVATE_KEY));
        String sharedClientCa = text(environment.get(SHARED_CLIENT_CA));

        Pair pair;
        String clientCa;
        if (!serviceCertificate.isBlank() || !servicePrivateKey.isBlank()) {
            pair = completePair(serviceCertificate, servicePrivateKey,
                    serviceCertificateKey, servicePrivateKeyKey);
            clientCa = serviceClientCa;
        } else if (!sharedCertificate.isBlank() || !sharedPrivateKey.isBlank()) {
            pair = completePair(sharedCertificate, sharedPrivateKey,
                    SHARED_CERTIFICATE, SHARED_PRIVATE_KEY);
            clientCa = sharedClientCa;
        } else {
            if (!serviceClientCa.isBlank() || !sharedClientCa.isBlank()) {
                throw new IllegalArgumentException("gRPC client CA requires a matching server certificate and key");
            }
            if (profiles.productionLike()) {
                throw new IllegalStateException(
                        "Production-like " + prefix + " gRPC requires mTLS server certificate, private key, and client CA; "
                                + "configure " + serviceCertificateKey + "/" + servicePrivateKeyKey
                                + "/" + serviceClientCaKey + " or " + SHARED_CERTIFICATE + "/"
                                + SHARED_PRIVATE_KEY + "/" + SHARED_CLIENT_CA);
            }
            if (!profiles.configured()) {
                throw new IllegalStateException(
                        prefix + " gRPC requires an explicit environment profile before plaintext can be enabled; "
                                + "set " + prefix + "_ENVIRONMENT, MEDIA_ENVIRONMENT, or "
                                + "GHATANA_DEPLOYMENT_PROFILE");
            }
            return AudioVideoGrpcServerBase.TransportSecurity.plaintext();
        }
        if (profiles.productionLike() && clientCa.isBlank()) {
            throw new IllegalStateException("Production-like " + prefix
                    + " gRPC requires a client CA for mutual TLS; configure "
                    + serviceClientCaKey + " or " + SHARED_CLIENT_CA);
        }
        return clientCa.isBlank()
                ? AudioVideoGrpcServerBase.TransportSecurity.tls(
                        Path.of(pair.certificate()), Path.of(pair.privateKey()))
                : AudioVideoGrpcServerBase.TransportSecurity.mtls(
                        Path.of(pair.certificate()), Path.of(pair.privateKey()), Path.of(clientCa));
    }

    /**
     * A service override can make a development profile stricter, but cannot downgrade an
     * explicitly production-like deployment or Media profile to plaintext. Conflicting
     * profile sources therefore retain the most restrictive transport requirement.
     */
    private static Profiles resolveProfiles(Map<String, String> environment, String prefix) {
        boolean productionLike = false;
        boolean configured = false;
        for (String candidate : new String[] {
                environment.get(prefix + "_ENVIRONMENT"),
                environment.get("MEDIA_ENVIRONMENT"),
                environment.get("GHATANA_DEPLOYMENT_PROFILE")}) {
            String value = text(candidate);
            if (value.isBlank()) continue;
            configured = true;
            String normalized = value.toLowerCase(Locale.ROOT);
            boolean candidateProductionLike = switch (normalized) {
                case "production", "staging", "sovereign" -> true;
                case "local", "test", "development" -> false;
                default -> throw new IllegalArgumentException(
                        "Unsupported " + prefix + " gRPC environment profile");
            };
            productionLike |= candidateProductionLike;
        }
        return new Profiles(productionLike, configured);
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
    private record Profiles(boolean productionLike, boolean configured) { }
}
