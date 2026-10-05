/**
 * @doc.type test
 * @doc.purpose Tests for unified configuration management
 * @doc.layer platform
 */
package com.ghatana.media.config;

import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;

import java.time.Duration;

/**
 * Tests for AV-008: Timeout configuration and DC-003: Configuration management
 */
class ConfigurationProviderTest {

    @BeforeEach
    void setUp() { 
        ConfigurationProvider.reset(); 
    }

    @AfterEach
    void tearDown() { 
        ConfigurationProvider.reset(); 
    }

    @Test
    @DisplayName("Should get string configuration with default")
    void testGetStringWithDefault() { 
        ConfigurationProvider config = ConfigurationProvider.getInstance(); 

        assertEquals("default", config.getString("nonexistent.key", "default")); 

        config.set("test.key", "value"); 
        assertEquals("value", config.getString("test.key", "default")); 
    }

    @Test
    @DisplayName("Should get integer configuration")
    void testGetInt() { 
        ConfigurationProvider config = ConfigurationProvider.getInstance(); 

        assertEquals(42, config.getInt("nonexistent", 42)); 

        config.set("test.int", "100"); 
        assertEquals(100, config.getInt("test.int", 0)); 

        // Invalid integer returns default
        config.set("test.invalid", "not-a-number"); 
        assertEquals(42, config.getInt("test.invalid", 42)); 
    }

    @Test
    @DisplayName("Should get boolean configuration")
    void testGetBoolean() { 
        ConfigurationProvider config = ConfigurationProvider.getInstance(); 

        assertTrue(config.getBoolean("nonexistent", true)); 
        assertFalse(config.getBoolean("nonexistent", false)); 

        config.set("test.bool", "true"); 
        assertTrue(config.getBoolean("test.bool", false)); 

        config.set("test.bool", "false"); 
        assertFalse(config.getBoolean("test.bool", true)); 
    }

    @Test
    @DisplayName("Should get double configuration")
    void testGetDouble() { 
        ConfigurationProvider config = ConfigurationProvider.getInstance(); 

        assertEquals(3.14, config.getDouble("nonexistent", 3.14), 0.001); 

        config.set("test.double", "2.718"); 
        assertEquals(2.718, config.getDouble("test.double", 0), 0.001); 
    }

    @Test
    @DisplayName("Should get timeout configuration with defaults")
    void testTimeoutConfig() { 
        ConfigurationProvider config = ConfigurationProvider.getInstance(); 
        TimeoutConfig timeoutConfig = config.getTimeoutConfig(); 

        assertNotNull(timeoutConfig); 
        assertEquals(Duration.ofSeconds(5), timeoutConfig.connectionTimeout()); 
        assertEquals(Duration.ofSeconds(30), timeoutConfig.operationTimeout()); 
        assertEquals(Duration.ofMinutes(5), timeoutConfig.streamingTimeout()); 
    }

    @Test
    @DisplayName("Should create high latency timeout config")
    void testHighLatencyConfig() { 
        TimeoutConfig config = TimeoutConfig.highLatency(); 

        assertTrue(config.connectionTimeout().getSeconds() >= 10); 
        assertTrue(config.operationTimeout().getSeconds() >= 60); 
    }

    @Test
    @DisplayName("Should create low latency timeout config")
    void testLowLatencyConfig() { 
        TimeoutConfig config = TimeoutConfig.lowLatency(); 

        assertTrue(config.connectionTimeout().getSeconds() <= 5); 
        assertTrue(config.operationTimeout().getSeconds() <= 15); 
    }

    @Test
    @DisplayName("Should build custom timeout config")
    void testCustomTimeoutConfig() { 
        TimeoutConfig config = TimeoutConfig.builder() 
            .connectionTimeout(Duration.ofSeconds(10)) 
            .operationTimeout(Duration.ofSeconds(45)) 
            .build(); 

        assertEquals(Duration.ofSeconds(10), config.connectionTimeout()); 
        assertEquals(Duration.ofSeconds(45), config.operationTimeout()); 
        // Others use defaults
        assertEquals(Duration.ofMinutes(5), config.streamingTimeout()); 
    }

    @Test
    @DisplayName("Should reload configuration")
    void testReload() { 
        ConfigurationProvider config = ConfigurationProvider.getInstance(); 
        config.set("test.reload", "before"); 

        config.reload(); 

        // After reload, custom value should be preserved if it was set via set() 
        // (set() updates the cache which is preserved across reloads) 
        assertEquals("before", config.getString("test.reload", "default")); 
    }

    @Test
    @DisplayName("Should provide all configuration entries")
    void testGetAll() { 
        ConfigurationProvider config = ConfigurationProvider.getInstance(); 
        config.set("key1", "value1"); 
        config.set("key2", "value2"); 

        var all = config.getAll(); 

        assertTrue(all.size() >= 2); 
        assertEquals("value1", all.get("key1"));
        assertEquals("value2", all.get("key2"));
    }

    @Test
    @DisplayName("Should return default timeout config")
    void testDefaultTimeoutConfig() { 
        TimeoutConfig config = TimeoutConfig.defaults(); 

        assertEquals(5000L, config.connectionTimeoutMs()); 
        assertEquals(30000L, config.operationTimeoutMs()); 
        assertEquals(300000L, config.streamingTimeoutMs()); 
        assertEquals(5000L, config.healthCheckTimeoutMs()); 
        assertEquals(60000L, config.initializationTimeoutMs()); 
        assertEquals(10000L, config.shutdownTimeoutMs()); 
    }

    @Test
    @DisplayName("Timeout config should have proper equals and hashCode")
    void testTimeoutConfigEquality() { 
        TimeoutConfig config1 = TimeoutConfig.defaults(); 
        TimeoutConfig config2 = TimeoutConfig.defaults(); 
        TimeoutConfig config3 = TimeoutConfig.highLatency(); 

        assertEquals(config1, config2); 
        assertEquals(config1.hashCode(), config2.hashCode()); 
        assertNotEquals(config1, config3); 
    }

    @Test
    @DisplayName("Timeout config should have meaningful toString")
    void testTimeoutConfigToString() { 
        TimeoutConfig config = TimeoutConfig.defaults(); 
        String str = config.toString(); 

        assertTrue(str.contains("TimeoutConfig"));
        assertTrue(str.contains("connection"));
        assertTrue(str.contains("operation"));
    }
}
