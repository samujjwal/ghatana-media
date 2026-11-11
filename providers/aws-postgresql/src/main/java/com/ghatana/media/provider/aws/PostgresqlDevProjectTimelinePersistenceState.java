package com.ghatana.media.provider.aws;

import com.ghatana.launcher.config.RuntimeSecretReference;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.flywaydb.core.Flyway;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Isolated PostgreSQL state for the DEV_ONLY project timeline lane.
 * It has a distinct loopback URL and schema and runs only the explicit project
 * development migration; it never participates in the canonical runtime migration.
 */
final class PostgresqlDevProjectTimelinePersistenceState implements ProjectTimelinePersistenceState {
    private static final String MIGRATION_LOCATION = "classpath:db/media-project-timeline-dev";
    private final ObjectMapper mapper = JsonMapper.builder()
            .addModules(tools.jackson.databind.cfg.MapperBuilder.findModules()).build();
    private final HikariDataSource dataSource;
    private final AtomicBoolean closed = new AtomicBoolean();

    private PostgresqlDevProjectTimelinePersistenceState(Map<String, String> environment) {
        requireDevOnlyEnvironment(environment);
        String jdbcUrl = required(environment, "MEDIA_PROJECT_TIMELINE_POSTGRES_JDBC_URL");
        loopbackPostgresUri(jdbcUrl);
        String schema = required(environment, "MEDIA_PROJECT_TIMELINE_SCHEMA");
        if (!schema.matches("media_dev_[a-z0-9_]{1,48}")) {
            throw new IllegalArgumentException(
                    "MEDIA_PROJECT_TIMELINE_SCHEMA must use the isolated media_dev_ prefix and lowercase identifiers");
        }
        String username = required(environment, "MEDIA_PROJECT_TIMELINE_POSTGRES_USER");
        String passwordReference = required(environment, "MEDIA_PROJECT_TIMELINE_POSTGRES_PASSWORD_REFERENCE");
        String password = RuntimeSecretReference.resolveOptionalEnvironment(
                environment, passwordReference, "Media DEV_ONLY project timeline PostgreSQL password", false);
        if (password.isBlank()) {
            throw new IllegalArgumentException("local project timeline PostgreSQL password must resolve to a non-empty value");
        }

        createIsolatedSchema(jdbcUrl, username, password, schema);
        HikariConfig pool = new HikariConfig();
        pool.setJdbcUrl(jdbcUrl);
        pool.setUsername(username);
        pool.setPassword(password);
        pool.setDriverClassName("org.postgresql.Driver");
        pool.setMaximumPoolSize(8);
        pool.setMinimumIdle(0);
        pool.setConnectionTimeout(5_000);
        pool.setPoolName("media-dev-project-timeline");
        pool.setConnectionInitSql("SET search_path TO \"" + schema + "\"");
        HikariDataSource created = new HikariDataSource(pool);
        try {
            Flyway.configure()
                    .dataSource(created)
                    .schemas(schema)
                    .defaultSchema(schema)
                    .createSchemas(false)
                    .locations(MIGRATION_LOCATION)
                    .validateMigrationNaming(true)
                    .load()
                    .migrate();
            this.dataSource = created;
        } catch (RuntimeException failure) {
            created.close();
            throw new IllegalStateException("DEV_ONLY project timeline schema could not be initialized", failure);
        }
    }

    static PostgresqlDevProjectTimelinePersistenceState create(Map<String, String> environment) {
        return new PostgresqlDevProjectTimelinePersistenceState(Map.copyOf(environment));
    }

    @Override public Connection connection() {
        if (closed.get()) throw new IllegalStateException("DEV_ONLY project timeline store is closed");
        try { return dataSource.getConnection(); }
        catch (SQLException failure) {
            throw new IllegalStateException("DEV_ONLY project timeline PostgreSQL is unavailable", failure);
        }
    }

    @Override public ObjectMapper mapper() { return mapper; }
    @Override public void release() { close(); }
    @Override public void close() { if (closed.compareAndSet(false, true)) dataSource.close(); }

    private static void requireDevOnlyEnvironment(Map<String, String> environment) {
        String profile = environment.getOrDefault("MEDIA_RUNTIME_ENVIRONMENT",
                environment.getOrDefault("MEDIA_PROFILE", "")).trim().toLowerCase(java.util.Locale.ROOT);
        if (!"dev".equals(profile)
                || !"true".equalsIgnoreCase(environment.getOrDefault("MEDIA_DEV_IDENTITY_ENABLED", "false"))
                || !"true".equalsIgnoreCase(environment.getOrDefault("MEDIA_PROJECT_TIMELINE_DEV_ENABLED", "false"))) {
            throw new IllegalArgumentException(
                    "DEV_ONLY project timeline storage requires profile=dev, MEDIA_DEV_IDENTITY_ENABLED=true, and MEDIA_PROJECT_TIMELINE_DEV_ENABLED=true");
        }
    }

    private static URI loopbackPostgresUri(String jdbcUrl) {
        if (!jdbcUrl.startsWith("jdbc:postgresql://")
                || jdbcUrl.toLowerCase(java.util.Locale.ROOT).contains("currentschema")) {
            throw new IllegalArgumentException(
                    "DEV_ONLY project timeline JDBC URL must be PostgreSQL without an embedded schema override");
        }
        URI uri;
        try { uri = URI.create(jdbcUrl.substring("jdbc:".length())); }
        catch (IllegalArgumentException failure) {
            throw new IllegalArgumentException("DEV_ONLY project timeline JDBC URL is invalid", failure);
        }
        String host = uri.getHost();
        if (uri.getUserInfo() != null || host == null
                || !(host.equalsIgnoreCase("localhost") || host.equals("127.0.0.1") || host.equals("::1"))) {
            throw new IllegalArgumentException(
                    "DEV_ONLY project timeline PostgreSQL must be reached through a loopback host with separate credentials");
        }
        return uri;
    }

    private static void createIsolatedSchema(String jdbcUrl, String username, String password, String schema) {
        try (Connection connection = DriverManager.getConnection(jdbcUrl, username, password);
             var statement = connection.createStatement()) {
            statement.execute("CREATE SCHEMA IF NOT EXISTS \"" + schema + "\"");
        } catch (SQLException failure) {
            throw new IllegalStateException("DEV_ONLY project timeline schema cannot be created", failure);
        }
    }

    private static String required(Map<String, String> environment, String key) {
        String value = environment.get(key);
        if (value == null || value.isBlank() || !value.equals(value.strip())) {
            throw new IllegalArgumentException(key + " must be configured without surrounding whitespace");
        }
        return value;
    }
}
