package com.ghatana.media.provider.aws;

import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;
import com.ghatana.launcher.config.RuntimeSecretReference;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.flywaydb.core.Flyway;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.checksums.RequestChecksumCalculation;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3ClientBuilder;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.HeadBucketRequest;

import java.net.URI;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/** Shared lifecycle for Media PostgreSQL metadata and S3 object storage. */
final class MediaAwsPostgresqlRuntimeState {
    private static final Object LOCK = new Object();
    private static MediaAwsPostgresqlRuntimeState shared;
    private static int references;

    private final ObjectMapper mapper = JsonMapper.builder().addModules(tools.jackson.databind.cfg.MapperBuilder.findModules()).build();
    private final HikariDataSource dataSource;
    private final S3Client s3;
    private final String bucket;
    private final String prefix;
    private final boolean configured;
    private final boolean productionEligible;
    private final boolean sharedLifecycle;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    private MediaAwsPostgresqlRuntimeState(
            Map<String, String> environment, boolean sharedLifecycle) {
        this.sharedLifecycle = sharedLifecycle;
        String jdbcUrl = environment.getOrDefault("MEDIA_POSTGRES_JDBC_URL", "").trim();
        String bucketValue = environment.getOrDefault("MEDIA_S3_BUCKET", "").trim();
        if (jdbcUrl.isBlank() || bucketValue.isBlank()) {
            dataSource = null;
            s3 = null;
            bucket = "";
            prefix = "";
            configured = false;
            productionEligible = false;
            return;
        }
        String profile = environment.getOrDefault("MEDIA_RUNTIME_ENVIRONMENT",
                environment.getOrDefault("MEDIA_PROFILE", "local"));
        boolean productionLike = productionLike(profile);
        if (productionLike && !jdbcUrl.toLowerCase(java.util.Locale.ROOT).startsWith("jdbc:postgresql:")) {
            throw new IllegalStateException("Production Media state requires PostgreSQL");
        }
        String username = environment.getOrDefault("MEDIA_POSTGRES_USER", "").trim();
        String password = RuntimeSecretReference.resolveOptionalEnvironment(
                environment,
                environment.getOrDefault("MEDIA_POSTGRES_PASSWORD_REFERENCE", ""),
                "Media PostgreSQL password",
                productionLike);
        if (productionLike && username.isBlank()) {
            throw new IllegalStateException("MEDIA_POSTGRES_USER is required for production-like profiles");
        }

        HikariConfig pool = new HikariConfig();
        pool.setJdbcUrl(jdbcUrl);
        if (!username.isBlank()) pool.setUsername(username);
        if (!password.isBlank()) pool.setPassword(password);
        String driver = environment.getOrDefault("MEDIA_POSTGRES_DRIVER", "").trim();
        if (!driver.isBlank()) pool.setDriverClassName(driver);
        pool.setMaximumPoolSize(integer(environment, "MEDIA_POSTGRES_POOL_SIZE", 16, 1, 128));
        pool.setMinimumIdle(1);
        pool.setConnectionTimeout(integer(
                environment, "MEDIA_POSTGRES_CONNECTION_TIMEOUT_MS", 10_000, 100, 120_000));
        pool.setPoolName("media-runtime-postgresql");
        pool.setAutoCommit(true);
        dataSource = new HikariDataSource(pool);

        bucket = bucketValue;
        prefix = normalizePrefix(environment.getOrDefault("MEDIA_S3_PREFIX", "media-runtime"));
        S3ClientBuilder builder = S3Client.builder()
                .region(Region.of(environment.getOrDefault("MEDIA_S3_REGION", "us-east-1").trim()))
                .requestChecksumCalculation(requestChecksumCalculation(environment))
                .serviceConfiguration(S3Configuration.builder()
                        .pathStyleAccessEnabled(bool(environment, "MEDIA_S3_PATH_STYLE", false))
                        .build());
        String endpoint = environment.getOrDefault("MEDIA_S3_ENDPOINT", "").trim();
        if (!endpoint.isBlank()) {
            URI endpointUri = absoluteHttpUri(endpoint, "MEDIA_S3_ENDPOINT");
            if (productionLike && !"https".equalsIgnoreCase(endpointUri.getScheme())) {
                throw new IllegalStateException("Production Media S3 endpoint override requires HTTPS");
            }
            builder.endpointOverride(endpointUri);
        }
        configureStaticCredentials(builder, environment);
        s3 = builder.build();

        try {
            Flyway.configure()
                    .dataSource(dataSource)
                    .locations("classpath:db/media-runtime")
                    .validateMigrationNaming(true)
                    .load()
                    .migrate();
            configured = true;
            productionEligible = jdbcUrl.toLowerCase(java.util.Locale.ROOT).startsWith("jdbc:postgresql:")
                    && !username.isBlank() && !password.isBlank()
                    && (endpoint.isBlank() || endpoint.toLowerCase(java.util.Locale.ROOT).startsWith("https://"));
            verifyReady();
        } catch (RuntimeException failure) {
            try { s3.close(); } catch (RuntimeException closeFailure) { failure.addSuppressed(closeFailure); }
            dataSource.close();
            throw failure;
        }
    }

    static MediaAwsPostgresqlRuntimeState acquire() {
        synchronized (LOCK) {
            if (shared == null || shared.closed.get()) {
                shared = new MediaAwsPostgresqlRuntimeState(System.getenv(), true);
            }
            references++;
            return shared;
        }
    }

    private static RequestChecksumCalculation requestChecksumCalculation(
            Map<String, String> environment) {
        String configured = environment.getOrDefault(
                "MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_SUPPORTED").trim();
        try {
            return RequestChecksumCalculation.valueOf(configured.toUpperCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException failure) {
            throw new IllegalArgumentException(
                    "MEDIA_S3_REQUEST_CHECKSUM_CALCULATION must be WHEN_SUPPORTED or WHEN_REQUIRED",
                    failure);
        }
    }

    static AutoCloseable installForTesting(Map<String, String> environment) {
        synchronized (LOCK) {
            if (shared != null || references != 0) {
                throw new IllegalStateException("Media provider shared lifecycle is already active");
            }
            shared = new MediaAwsPostgresqlRuntimeState(Map.copyOf(environment), true);
            return () -> {
                synchronized (LOCK) {
                    if (references != 0) {
                        throw new IllegalStateException(
                                "Media provider test lifecycle still has " + references + " reference(s)");
                    }
                    if (shared != null) {
                        shared.close();
                        shared = null;
                    }
                }
            };
        }
    }

    static MediaAwsPostgresqlRuntimeState create(Map<String, String> environment) {
        return new MediaAwsPostgresqlRuntimeState(Map.copyOf(environment), false);
    }

    void release() {
        if (!sharedLifecycle) {
            close();
            return;
        }
        synchronized (LOCK) {
            if (references > 0) references--;
            if (references == 0 && shared == this) {
                close();
                shared = null;
            }
        }
    }

    boolean configured() { return configured && !closed.get(); }
    boolean productionEligible() { return configured() && productionEligible; }
    ObjectMapper mapper() { return mapper; }
    S3Client s3() { ensureConfigured(); return s3; }
    String bucket() { ensureConfigured(); return bucket; }
    String key(String relative) { ensureConfigured(); return prefix + "/" + relative; }

    Connection connection() {
        ensureConfigured();
        try { return dataSource.getConnection(); }
        catch (Exception failure) { throw new IllegalStateException("Media PostgreSQL state is unavailable", failure); }
    }

    boolean ready() {
        if (!configured()) return false;
        try { verifyReady(); return true; }
        catch (RuntimeException failure) { return false; }
    }

    void verifyReady() {
        ensureConfigured();
        try (Connection connection = dataSource.getConnection();
             PreparedStatement uploads = connection.prepareStatement(
                     "SELECT tenant_id FROM media_upload_sessions WHERE 1=0");
             PreparedStatement artifacts = connection.prepareStatement(
                     "SELECT tenant_id FROM media_artifacts WHERE 1=0");
             PreparedStatement jobs = connection.prepareStatement(
                     "SELECT tenant_id FROM media_processing_jobs WHERE 1=0");
             PreparedStatement streams = connection.prepareStatement(
                     "SELECT tenant_id FROM media_stream_sessions WHERE 1=0");
             var uploadResult = uploads.executeQuery();
             var artifactResult = artifacts.executeQuery();
             var jobResult = jobs.executeQuery();
             var streamResult = streams.executeQuery()) {
            // Opening every result set proves that all required runtime tables are queryable.
        } catch (java.sql.SQLException failure) {
            throw new IllegalStateException("Media PostgreSQL schema is not ready", failure);
        }
        try {
            s3.headBucket(HeadBucketRequest.builder().bucket(bucket).build());
        } catch (RuntimeException failure) {
            throw new IllegalStateException("Media S3 bucket is not ready", failure);
        }
    }

    private void ensureConfigured() {
        if (!configured()) throw new IllegalStateException("Media AWS/PostgreSQL providers are not configured");
    }

    void close() {
        if (!closed.compareAndSet(false, true)) return;
        RuntimeException failure = null;
        if (s3 != null) {
            try { s3.close(); } catch (RuntimeException closeFailure) { failure = closeFailure; }
        }
        if (dataSource != null) dataSource.close();
        if (failure != null) throw failure;
    }

    private static void configureStaticCredentials(
            S3ClientBuilder builder, Map<String, String> environment) {
        String accessReference = environment.getOrDefault("MEDIA_S3_ACCESS_KEY_REFERENCE", "").trim();
        String secretReference = environment.getOrDefault("MEDIA_S3_SECRET_KEY_REFERENCE", "").trim();
        if (accessReference.isBlank() && secretReference.isBlank()) return;
        if (accessReference.isBlank() || secretReference.isBlank()) {
            throw new IllegalStateException(
                    "MEDIA_S3_ACCESS_KEY_REFERENCE and MEDIA_S3_SECRET_KEY_REFERENCE must be configured together");
        }
        String accessKey = RuntimeSecretReference.resolveOptionalEnvironment(
                environment, accessReference, "Media S3 access key", true);
        String secretKey = RuntimeSecretReference.resolveOptionalEnvironment(
                environment, secretReference, "Media S3 secret key", true);
        builder.credentialsProvider(StaticCredentialsProvider.create(
                AwsBasicCredentials.create(accessKey, secretKey)));
    }

    private static String normalizePrefix(String value) {
        String normalized = value == null ? "media-runtime" : value.trim();
        normalized = normalized.replaceAll("^/+|/+$", "");
        if (normalized.isBlank() || normalized.contains("..")) {
            throw new IllegalArgumentException("MEDIA_S3_PREFIX is invalid");
        }
        return normalized;
    }

    private static URI absoluteHttpUri(String value, String field) {
        URI uri = URI.create(value.trim());
        if (uri.getScheme() == null || uri.getHost() == null
                || !("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme()))) {
            throw new IllegalArgumentException(field + " must be an absolute HTTP(S) URI");
        }
        return uri;
    }

    private static int integer(
            Map<String, String> environment, String key, int fallback, int minimum, int maximum) {
        try {
            int value = Integer.parseInt(environment.getOrDefault(key, Integer.toString(fallback)).trim());
            if (value < minimum || value > maximum) {
                throw new IllegalArgumentException(key + " must be between " + minimum + " and " + maximum);
            }
            return value;
        } catch (NumberFormatException failure) {
            throw new IllegalArgumentException(key + " must be an integer", failure);
        }
    }

    private static boolean bool(Map<String, String> environment, String key, boolean fallback) {
        String value = environment.get(key);
        if (value == null || value.isBlank()) return fallback;
        if ("true".equalsIgnoreCase(value)) return true;
        if ("false".equalsIgnoreCase(value)) return false;
        throw new IllegalArgumentException(key + " must be true or false");
    }

    private static boolean productionLike(String profile) {
        return "production".equalsIgnoreCase(profile)
                || "staging".equalsIgnoreCase(profile)
                || "sovereign".equalsIgnoreCase(profile);
    }
}
