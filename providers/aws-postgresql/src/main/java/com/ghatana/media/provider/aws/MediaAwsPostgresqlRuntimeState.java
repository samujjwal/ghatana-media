package com.ghatana.media.provider.aws;

import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;
import com.ghatana.launcher.config.RuntimeSecretReference;
import com.ghatana.media.runtime.MediaDeploymentProfiles;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.flywaydb.core.Flyway;
import org.postgresql.PGConnection;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.checksums.RequestChecksumCalculation;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3ClientBuilder;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.HeadBucketRequest;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.UnaryOperator;

/** Shared lifecycle for Media PostgreSQL metadata and S3 object storage. */
final class MediaAwsPostgresqlRuntimeState {
    private static final int MAX_PARALLEL_COMMIT_CANCEL_REQUESTS = 4;
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
    private final UnaryOperator<Connection> connectionDecorator;
    private final ScheduledThreadPoolExecutor commitCancelTimer = new ScheduledThreadPoolExecutor(
            1, runnable -> daemonThread(runnable, "media-postgresql-commit-deadline"));
    private final ThreadPoolExecutor commitCancelWorkers = new ThreadPoolExecutor(
            MAX_PARALLEL_COMMIT_CANCEL_REQUESTS, MAX_PARALLEL_COMMIT_CANCEL_REQUESTS,
            0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(MAX_PARALLEL_COMMIT_CANCEL_REQUESTS),
            runnable -> daemonThread(runnable, "media-postgresql-cancel-io"));
    private final Semaphore commitCancelPermits = new Semaphore(MAX_PARALLEL_COMMIT_CANCEL_REQUESTS);
    private final AtomicBoolean closed = new AtomicBoolean(false);

    private MediaAwsPostgresqlRuntimeState(
            Map<String, String> environment, boolean sharedLifecycle, UnaryOperator<S3Client> s3Decorator,
            UnaryOperator<Connection> connectionDecorator) {
        this.sharedLifecycle = sharedLifecycle;
        this.connectionDecorator = connectionDecorator;
        commitCancelTimer.setRemoveOnCancelPolicy(true);
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
        // Keep the bounded cancel workers from remaining stuck on one cancel socket for the pgjdbc default 10s.
        pool.addDataSourceProperty("cancelSignalTimeout", "1");
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
        S3Client builtClient = builder.build();
        s3 = s3Decorator == null ? builtClient : s3Decorator.apply(builtClient);

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
                shared = new MediaAwsPostgresqlRuntimeState(System.getenv(), true, null, null);
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
        return installForTesting(environment, null);
    }

    /** Test-only S3 client decoration for deterministic provider fault injection. */
    static AutoCloseable installForTesting(
            Map<String, String> environment, UnaryOperator<S3Client> s3Decorator) {
        return installForTesting(environment, s3Decorator, null);
    }

    /** Test-only JDBC connection decoration for deterministic commit-boundary faults. */
    static AutoCloseable installForTesting(
            Map<String, String> environment,
            UnaryOperator<S3Client> s3Decorator,
            UnaryOperator<Connection> connectionDecorator) {
        synchronized (LOCK) {
            if (shared != null || references != 0) {
                throw new IllegalStateException("Media provider shared lifecycle is already active");
            }
            shared = new MediaAwsPostgresqlRuntimeState(
                    Map.copyOf(environment), true, s3Decorator, connectionDecorator);
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
        return new MediaAwsPostgresqlRuntimeState(Map.copyOf(environment), false, null, null);
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
        try {
            Connection connection = dataSource.getConnection();
            if (connectionDecorator == null) return connection;
            try {
                Connection decorated = connectionDecorator.apply(connection);
                return (Connection) Proxy.newProxyInstance(MediaAwsPostgresqlRuntimeState.class.getClassLoader(),
                        new Class<?>[] {Connection.class, PooledConnectionHandle.class}, (proxy, method, arguments) -> {
                            if (method.getDeclaringClass() == PooledConnectionHandle.class) return connection;
                            try {
                                return method.invoke(decorated, arguments);
                            } catch (InvocationTargetException failure) {
                                throw failure.getCause();
                            }
                        });
            } catch (RuntimeException failure) {
                try { connection.close(); } catch (SQLException closeFailure) { failure.addSuppressed(closeFailure); }
                throw failure;
            }
        }
        catch (Exception failure) { throw new IllegalStateException("Media PostgreSQL state is unavailable", failure); }
    }

    void evictConnection(Connection connection) {
        ensureConfigured();
        Connection pooledConnection = connection instanceof PooledConnectionHandle handle
                ? handle.pooledConnection() : connection;
        dataSource.evictConnection(pooledConnection);
    }

    CommitCancelTask scheduleCommitCancel(Connection connection, long delayNanos) {
        try {
            PGConnection pgConnection = connection.unwrap(PGConnection.class);
            return new CommitCancelTask(pgConnection, Math.max(0, delayNanos));
        } catch (SQLException | RuntimeException unavailable) {
            return null;
        }
    }

    final class CommitCancelTask {
        private final Object lock = new Object();
        private final ScheduledFuture<?> timer;
        private boolean finished;
        private boolean requested;

        private CommitCancelTask(PGConnection pgConnection, long delayNanos) {
            timer = commitCancelTimer.schedule(() -> {
                synchronized (lock) {
                    if (finished || !commitCancelPermits.tryAcquire()) return;
                    requested = true;
                    try {
                        commitCancelWorkers.execute(() -> {
                            try {
                                pgConnection.cancelQuery();
                            } catch (SQLException | RuntimeException ignored) {
                                // Best effort only. COMMIT result and durable readback decide finality.
                            } finally {
                                commitCancelPermits.release();
                            }
                        });
                    } catch (RuntimeException rejected) {
                        requested = false;
                        commitCancelPermits.release();
                    }
                }
            }, delayNanos, TimeUnit.NANOSECONDS);
        }

        boolean requested() {
            synchronized (lock) { return requested; }
        }

        void finish(Connection connection) {
            boolean evict;
            synchronized (lock) {
                finished = true;
                timer.cancel(false);
                evict = requested;
            }
            // Even after a successful COMMIT ack, a cancel request can be in flight. Do not return
            // that physical session to the pool where the request might hit a later borrower.
            if (evict) evictConnection(connection);
        }
    }

    private interface PooledConnectionHandle {
        Connection pooledConnection();
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
        commitCancelTimer.shutdownNow();
        commitCancelWorkers.shutdownNow();
        RuntimeException failure = null;
        if (s3 != null) {
            try { s3.close(); } catch (RuntimeException closeFailure) { failure = closeFailure; }
        }
        if (dataSource != null) dataSource.close();
        if (failure != null) throw failure;
    }

    private static Thread daemonThread(Runnable runnable, String name) {
        Thread thread = new Thread(runnable, name);
        thread.setDaemon(true);
        return thread;
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
        return MediaDeploymentProfiles.productionLike(profile);
    }
}
