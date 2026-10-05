/**
 * @doc.type class
 * @doc.purpose Centralized configuration management for audio-video platform
 * @doc.layer platform
 * @doc.pattern Configuration, Singleton
 */
package com.ghatana.media.config;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Centralized configuration management for the audio-video platform.
 *
 * <p>Addresses DC-003: Consolidates scattered configuration management into a single
 * provider with support for environment variables, system properties, and config files.</p>
 *
 * <p>Configuration hierarchy (highest to lowest priority):
 * <ol>
 *   <li>Environment variables (GHATANA_* prefix)</li>
 *   <li>System properties (-Dghatana.*)</li>
 *   <li>Application config file (ghatana-media.properties)</li>
 *   <li>Default values</li>
 * </ol></p>
 *
 * @since 2026-03-27
 */
public final class ConfigurationProvider {

    private static final Logger LOG = Logger.getLogger(ConfigurationProvider.class.getName());
    private static final String CONFIG_FILE_NAME = "ghatana-media.properties";
    private static final String ENV_PREFIX = "GHATANA_";
    private static final String PROP_PREFIX = "ghatana.";

    private static volatile ConfigurationProvider instance;
    private static final Object lock = new Object();

    private final Map<String, String> configCache = new ConcurrentHashMap<>();
    private final Properties fileProperties = new Properties();
    private volatile boolean initialized = false;

    private ConfigurationProvider() {}

    /**
     * Gets the singleton configuration provider instance.
     */
    public static ConfigurationProvider getInstance() {
        if (instance == null) {
            synchronized (lock) {
                if (instance == null) {
                    instance = new ConfigurationProvider();
                    instance.initialize();
                }
            }
        }
        return instance;
    }

    /**
     * Resets the singleton (useful for testing).
     */
    @SuppressWarnings("PMD.NullAssignment")
    public static void reset() {
        synchronized (lock) {
            instance = null;
        }
    }

    private void initialize() {
        if (initialized) return;

        // Load from config file
        loadConfigFile();

        // Cache environment variables and system properties
        cacheEnvironmentAndProperties();

        initialized = true;
        LOG.info("Configuration provider initialized with " + configCache.size() + " entries");
    }

    private void loadConfigFile() {
        // Try multiple locations
        Path[] configPaths = {
            Paths.get(CONFIG_FILE_NAME),
            Paths.get(System.getProperty("user.home"), ".ghatana", CONFIG_FILE_NAME),
            Paths.get("/etc", "ghatana", CONFIG_FILE_NAME),
            Paths.get(System.getenv().getOrDefault("GHATANA_CONFIG_PATH", ""), CONFIG_FILE_NAME)
        };

        for (Path path : configPaths) {
            if (Files.exists(path)) {
                try (InputStream is = Files.newInputStream(path)) {
                    fileProperties.load(is);
                    LOG.info("Loaded configuration from: " + path);
                    return;
                } catch (IOException e) {
                    LOG.log(Level.WARNING, "Failed to load config from " + path, e);
                }
            }
        }

        // Try classpath
        try (InputStream is = getClass().getClassLoader().getResourceAsStream(CONFIG_FILE_NAME)) {
            if (is != null) {
                fileProperties.load(is);
                LOG.info("Loaded configuration from classpath");
            }
        } catch (IOException e) {
            LOG.log(Level.FINE, "No config file found in classpath");
        }
    }

    private void cacheEnvironmentAndProperties() {
        // Environment variables with GHATANA_ prefix
        System.getenv().forEach((key, value) -> {
            if (key.startsWith(ENV_PREFIX)) {
                String configKey = key.substring(ENV_PREFIX.length()).toLowerCase().replace('_', '.');
                configCache.put(configKey, value);
            }
        });

        // System properties with ghatana. prefix
        System.getProperties().forEach((key, value) -> {
            String keyStr = key.toString();
            if (keyStr.startsWith(PROP_PREFIX)) {
                String configKey = keyStr.substring(PROP_PREFIX.length());
                configCache.put(configKey, value.toString());
            }
        });
    }

    /**
     * Gets a string configuration value.
     *
     * @param key the configuration key
     * @return the value, or null if not found
     */
    public String getString(String key) {
        // Check cache first (environment/property)
        String value = configCache.get(key);
        if (value != null) return value;

        // Fall back to file properties
        value = fileProperties.getProperty(key);
        if (value != null) return value;

        // Try legacy keys for backward compatibility
        return fileProperties.getProperty(key.replace('.', '_'));
    }

    /**
     * Gets a string configuration value with default.
     *
     * @param key the configuration key
     * @param defaultValue default if not found
     * @return the value or default
     */
    public String getString(String key, String defaultValue) {
        String value = getString(key);
        return value != null ? value : defaultValue;
    }

    /**
     * Gets an integer configuration value.
     *
     * @param key the configuration key
     * @param defaultValue default if not found or invalid
     * @return the value or default
     */
    public int getInt(String key, int defaultValue) {
        String value = getString(key);
        if (value == null) return defaultValue;
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException e) {
            LOG.warning("Invalid integer value for key " + key + ": " + value);
            return defaultValue;
        }
    }

    /**
     * Gets a long configuration value.
     *
     * @param key the configuration key
     * @param defaultValue default if not found or invalid
     * @return the value or default
     */
    public long getLong(String key, long defaultValue) {
        String value = getString(key);
        if (value == null) return defaultValue;
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException e) {
            LOG.warning("Invalid long value for key " + key + ": " + value);
            return defaultValue;
        }
    }

    /**
     * Gets a boolean configuration value.
     *
     * @param key the configuration key
     * @param defaultValue default if not found
     * @return the value or default
     */
    public boolean getBoolean(String key, boolean defaultValue) {
        String value = getString(key);
        if (value == null) return defaultValue;
        return Boolean.parseBoolean(value);
    }

    /**
     * Gets a double configuration value.
     *
     * @param key the configuration key
     * @param defaultValue default if not found or invalid
     * @return the value or default
     */
    public double getDouble(String key, double defaultValue) {
        String value = getString(key);
        if (value == null) return defaultValue;
        try {
            return Double.parseDouble(value);
        } catch (NumberFormatException e) {
            LOG.warning("Invalid double value for key " + key + ": " + value);
            return defaultValue;
        }
    }

    /**
     * Sets a configuration value at runtime.
     *
     * @param key the configuration key
     * @param value the value to set
     */
    public void set(String key, String value) {
        configCache.put(key, value);
        LOG.fine("Set configuration: " + key + " = " + value);
    }

    /**
     * Gets all configuration keys.
     *
     * @return map of all configuration entries
     */
    public Map<String, String> getAll() {
        Map<String, String> all = new ConcurrentHashMap<>(fileProperties.size() + configCache.size());
        fileProperties.forEach((k, v) -> all.put(k.toString(), v.toString()));
        all.putAll(configCache);
        return all;
    }

    /**
     * Reloads configuration from files and environment.
     */
    public void reload() {
        synchronized (lock) {
            fileProperties.clear();

            initialized = false;
            initialize();
            LOG.info("Configuration reloaded");
        }
    }

    // Convenience methods for common audio-video configurations

    public TimeoutConfig getTimeoutConfig() {
        return TimeoutConfig.builder()
            .connectionTimeout(java.time.Duration.ofMillis(getLong("timeout.connection.ms", 5000)))
            .operationTimeout(java.time.Duration.ofMillis(getLong("timeout.operation.ms", 30000)))
            .streamingTimeout(java.time.Duration.ofMillis(getLong("timeout.streaming.ms", 300000)))
            .healthCheckTimeout(java.time.Duration.ofMillis(getLong("timeout.health.ms", 5000)))
            .initializationTimeout(java.time.Duration.ofMillis(getLong("timeout.init.ms", 60000)))
            .shutdownTimeout(java.time.Duration.ofMillis(getLong("timeout.shutdown.ms", 10000)))
            .build();
    }

    public int getMaxConcurrentRequests() {
        return getInt("av.max.concurrent.requests", 100);
    }

    public int getMaxAudioLengthSeconds() {
        return getInt("av.max.audio.length.seconds", 300);
    }

    public String getModelPath() {
        return getString("model.path", System.getProperty("user.home") + "/.ghatana/models");
    }

    public boolean isGpuEnabled() {
        return getBoolean("av.gpu.enabled", false);
    }

    public String getLogLevel() {
        return getString("log.level", "INFO");
    }
}
