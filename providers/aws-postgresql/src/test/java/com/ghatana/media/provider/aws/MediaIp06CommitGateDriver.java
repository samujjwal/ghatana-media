package com.ghatana.media.provider.aws;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverPropertyInfo;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.Properties;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.logging.Logger;

/** Test-only JDBC wrapper that gates PostgreSQL commit boundaries for child-process crash probes. */
public final class MediaIp06CommitGateDriver implements Driver {
    private final Driver delegate;

    public MediaIp06CommitGateDriver() {
        try {
            delegate = (Driver) Class.forName("org.postgresql.Driver").getDeclaredConstructor().newInstance();
        } catch (ReflectiveOperationException failure) {
            throw new IllegalStateException("PostgreSQL JDBC driver is unavailable to the test proxy", failure);
        }
    }

    @Override
    public Connection connect(String url, Properties properties) throws SQLException {
        Connection connection = delegate.connect(url, properties);
        if (connection == null) return null;
        String markerPath = System.getenv("MEDIA_IP06_COMMIT_GATE_MARKER");
        if (markerPath == null || markerPath.isBlank()) return connection;
        String gateMode = System.getenv().getOrDefault("MEDIA_IP06_COMMIT_GATE_MODE", "AFTER_COMMIT");
        AtomicBoolean jobInsertExecuted = new AtomicBoolean();
        return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(),
                new Class<?>[] {Connection.class}, (proxy, method, args) -> {
                    if (method.getName().equals("prepareStatement") && args != null && args.length > 0
                            && args[0] instanceof String sql
                            && sql.toLowerCase(java.util.Locale.ROOT).contains("insert into media_processing_jobs")) {
                        PreparedStatement statement = (PreparedStatement) invoke(method, connection, args);
                        return Proxy.newProxyInstance(PreparedStatement.class.getClassLoader(),
                                new Class<?>[] {PreparedStatement.class}, (statementProxy, statementMethod,
                                        statementArgs) -> {
                                    Object result = invoke(statementMethod, statement, statementArgs);
                                    if (statementMethod.getName().startsWith("execute")) {
                                        jobInsertExecuted.set(true);
                                    }
                                    return result;
                                });
                    }
                    if (method.getName().equals("commit") && jobInsertExecuted.get()) {
                        if ("BEFORE_COMMIT".equals(gateMode)) {
                            writeMarker(Path.of(markerPath), "PRE_COMMIT");
                            awaitProcessKill(); // Leave the transaction open for abrupt child termination.
                            return null;
                        }
                        invoke(method, connection, args); // Real commit has returned successfully.
                        writeMarker(Path.of(markerPath), "POSTGRES_COMMITTED_RETURNED");
                        awaitProcessKill(); // Deliberately never return to PostgresqlMediaJobStore.create().
                        return null;
                    }
                    return invoke(method, connection, args);
                });
    }

    private static Object invoke(java.lang.reflect.Method method, Object target, Object[] args) throws Throwable {
        try {
            return method.invoke(target, args);
        } catch (InvocationTargetException failure) {
            throw failure.getCause();
        }
    }

    private static void writeMarker(Path marker, String state) throws Exception {
        Files.writeString(marker, state, StandardCharsets.UTF_8);
    }

    private static void awaitProcessKill() throws InterruptedException {
        while (true) Thread.sleep(60_000);
    }

    @Override public boolean acceptsURL(String url) throws SQLException { return delegate.acceptsURL(url); }
    @Override public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) throws SQLException {
        return delegate.getPropertyInfo(url, info);
    }
    @Override public int getMajorVersion() { return delegate.getMajorVersion(); }
    @Override public int getMinorVersion() { return delegate.getMinorVersion(); }
    @Override public boolean jdbcCompliant() { return delegate.jdbcCompliant(); }
    @Override public Logger getParentLogger() throws SQLFeatureNotSupportedException {
        return delegate.getParentLogger();
    }
}
