/**
 * @doc.type class
 * @doc.purpose Service registry for standardized audio-video service interfaces
 * @doc.layer platform
 * @doc.pattern Registry, ServiceLocator
 */
package com.ghatana.media.service;

import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.tts.api.TtsEngine;
import com.ghatana.media.common.pool.EnginePool;

import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;
import java.util.logging.Logger;

/**
 * Centralized service registry for audio-video engine management.
 *
 * <p>Addresses CONS-007: Provides standardized service interface registration
 * and discovery for STT/TTS engines with consistent lifecycle management.</p>
 *
 * <p>Features:
 * <ul>
 *   <li>Named service registration</li>
 *   <li>Lazy initialization with supplier-based factories</li>
 *   <li>Service lifecycle management</li>
 *   <li>Health check aggregation</li>
 * </ul></p>
 *
 * @since 2026-03-27
 */
public class AudioVideoServiceRegistry {

    private static final Logger LOG = Logger.getLogger(AudioVideoServiceRegistry.class.getName());

    private final Map<String, ServiceEntry<?>> services = new ConcurrentHashMap<>();
    private final Map<String, EnginePool<SttEngine>> sttPools = new ConcurrentHashMap<>();
    private final Map<String, EnginePool<TtsEngine>> ttsPools = new ConcurrentHashMap<>();

    private static volatile AudioVideoServiceRegistry instance;
    private static final Object lock = new Object();

    private AudioVideoServiceRegistry() {}

    /**
     * Gets the singleton registry instance.
     */
    public static AudioVideoServiceRegistry getInstance() {
        if (instance == null) {
            synchronized (lock) {
                if (instance == null) {
                    instance = new AudioVideoServiceRegistry();
                }
            }
        }
        return instance;
    }

    /**
     * Resets the registry (useful for testing).
     */
    public static void reset() {
        synchronized (lock) {
            if (instance != null) {
                instance.closeAll();
            }
            instance = null;
        }
    }

    /**
     * Registers a named STT engine pool.
     *
     * @param name service name
     * @param pool the engine pool
     */
    public void registerSttPool(String name, EnginePool<SttEngine> pool) {
        sttPools.put(name, pool);
        LOG.info("Registered STT pool: " + name);
    }

    /**
     * Registers a named TTS engine pool.
     *
     * @param name service name
     * @param pool the engine pool
     */
    public void registerTtsPool(String name, EnginePool<TtsEngine> pool) {
        ttsPools.put(name, pool);
        LOG.info("Registered TTS pool: " + name);
    }

    /**
     * Gets an STT engine from the named pool.
     *
     * @param poolName pool name
     * @return engine from pool
     * @throws com.ghatana.media.common.pool.EnginePool.PoolExhaustedException if pool exhausted
     */
    public SttEngine borrowSttEngine(String poolName) throws com.ghatana.media.common.pool.EnginePool.PoolExhaustedException {
        EnginePool<SttEngine> pool = sttPools.get(poolName);
        if (pool == null) {
            throw new IllegalArgumentException("STT pool not found: " + poolName);
        }
        return pool.borrow();
    }

    /**
     * Returns an STT engine to its pool.
     *
     * @param poolName pool name
     * @param engine engine to return
     */
    public void returnSttEngine(String poolName, SttEngine engine) {
        EnginePool<SttEngine> pool = sttPools.get(poolName);
        if (pool != null && engine != null) {
            pool.returnEngine(engine);
        }
    }

    /**
     * Gets a TTS engine from the named pool.
     *
     * @param poolName pool name
     * @return engine from pool
     * @throws com.ghatana.media.common.pool.EnginePool.PoolExhaustedException if pool exhausted
     */
    public TtsEngine borrowTtsEngine(String poolName) throws com.ghatana.media.common.pool.EnginePool.PoolExhaustedException {
        EnginePool<TtsEngine> pool = ttsPools.get(poolName);
        if (pool == null) {
            throw new IllegalArgumentException("TTS pool not found: " + poolName);
        }
        return pool.borrow();
    }

    /**
     * Returns a TTS engine to its pool.
     *
     * @param poolName pool name
     * @param engine engine to return
     */
    public void returnTtsEngine(String poolName, TtsEngine engine) {
        EnginePool<TtsEngine> pool = ttsPools.get(poolName);
        if (pool != null && engine != null) {
            pool.returnEngine(engine);
        }
    }

    /**
     * Gets pool statistics.
     *
     * @param poolName pool name
     * @return statistics or null if pool not found
     */
    public Optional<EnginePool.PoolStats> getPoolStats(String poolName) {
        EnginePool<?> pool = sttPools.get(poolName);
        if (pool == null) {
            pool = ttsPools.get(poolName);
        }
        return pool != null ? Optional.of(pool.getStats()) : Optional.empty();
    }

    /**
     * Lists all registered service names.
     *
     * @return array of service names
     */
    public String[] listServices() {
        return services.keySet().toArray(new String[0]);
    }

    /**
     * Lists all registered pool names.
     *
     * @return array of pool names
     */
    public String[] listPools() {
        var pools = new java.util.ArrayList<String>();
        pools.addAll(sttPools.keySet());
        pools.addAll(ttsPools.keySet());
        return pools.toArray(new String[0]);
    }

    /**
     * Checks health of all registered services.
     *
     * @return health status map
     */
    public Map<String, Boolean> checkHealth() {
        Map<String, Boolean> health = new ConcurrentHashMap<>();

        sttPools.forEach((name, pool) -> {
            try {
                SttEngine engine = pool.borrow();
                try {
                    health.put("stt:" + name, engine.getStatus().state() == com.ghatana.media.common.EngineStatus.State.READY);
                } finally {
                    pool.returnEngine(engine);
                }
            } catch (Exception e) {
                health.put("stt:" + name, false);
            }
        });

        ttsPools.forEach((name, pool) -> {
            try {
                TtsEngine engine = pool.borrow();
                try {
                    health.put("tts:" + name, engine.getStatus().state() == com.ghatana.media.common.EngineStatus.State.READY);
                } finally {
                    pool.returnEngine(engine);
                }
            } catch (Exception e) {
                health.put("tts:" + name, false);
            }
        });

        return health;
    }

    /**
     * Closes all registered services and pools.
     */
    public void closeAll() {
        LOG.info("Closing all services and pools");

        sttPools.values().forEach(pool -> {
            try {
                pool.close();
            } catch (Exception e) {
                LOG.warning("Error closing STT pool: " + e.getMessage());
            }
        });
        sttPools.clear();

        ttsPools.values().forEach(pool -> {
            try {
                pool.close();
            } catch (Exception e) {
                LOG.warning("Error closing TTS pool: " + e.getMessage());
            }
        });
        ttsPools.clear();

        services.clear();
    }

    /**
     * Service entry for generic service registration.
     */
    private static class ServiceEntry<T> {
        final String name;
        final Class<T> type;
        final Supplier<T> factory;
        volatile T instance;

        ServiceEntry(String name, Class<T> type, Supplier<T> factory) {
            this.name = name;
            this.type = type;
            this.factory = factory;
        }

        T get() {
            if (instance == null) {
                synchronized (this) {
                    if (instance == null) {
                        instance = factory.get();
                    }
                }
            }
            return instance;
        }
    }
}
