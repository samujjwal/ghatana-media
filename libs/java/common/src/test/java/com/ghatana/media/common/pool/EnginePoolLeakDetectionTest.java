/**
 * @doc.type test
 * @doc.purpose Tests for resource leak detection and backpressure in EnginePool
 * @doc.layer platform
 */
package com.ghatana.media.common.pool;

import org.junit.jupiter.api.*;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for AV-005: Resource Leak Risk in EnginePool
 */
class EnginePoolLeakDetectionTest {

    private EnginePool<MockEngine> pool;
    private AtomicInteger engineCounter;

    @BeforeEach
    void setUp() { 
        engineCounter = new AtomicInteger(0); 
    }

    @AfterEach
    void tearDown() throws Exception { 
        if (pool != null) { 
            pool.close(); 
        }
    }

    @Test
    @DisplayName("Should detect resource leaks when engines not returned")
    void testLeakDetection() throws Exception { 
        EnginePool.PoolConfig config = EnginePool.PoolConfig.defaults() 
            .minSize(1) 
            .maxSize(5) 
            .leakDetectionThreshold(Duration.ofSeconds(2)); 

        pool = new EnginePool<>( 
            this::createMockEngine,
            engine -> true,
            engine -> { engine.close(); return null; }, 
            config
        );

        // Borrow engines but don't return them
        MockEngine engine1 = pool.borrow(); 
        MockEngine engine2 = pool.borrow(); 

        // Wait for leak detection to trigger
        Thread.sleep(3000); 

        // Check for detected leaks
        List<EnginePool.LeakInfo> leaks = pool.getPotentialLeaks(); 
        assertEquals(2, leaks.size(), "Should detect 2 leaked engines"); 

        EnginePool.PoolStats stats = pool.getStats(); 
        assertTrue(stats.leakDetections >= 2, "Should have leak detections"); 

        // Return engines
        pool.returnEngine(engine1); 
        pool.returnEngine(engine2); 

        // Leaks should be cleared
        leaks = pool.getPotentialLeaks(); 
        assertEquals(0, leaks.size(), "Leaks should be cleared after return"); 
    }

    @Test
    @DisplayName("Should track resource usage metrics")
    void testResourceUsageTracking() throws Exception { 
        EnginePool.PoolConfig config = EnginePool.PoolConfig.defaults() 
            .minSize(2) 
            .maxSize(10); 

        pool = new EnginePool<>( 
            this::createMockEngine,
            engine -> true,
            engine -> { engine.close(); return null; }, 
            config
        );

        // Borrow some engines
        MockEngine e1 = pool.borrow(); 
        MockEngine e2 = pool.borrow(); 
        MockEngine e3 = pool.borrow(); 

        EnginePool.ResourceUsageSnapshot usage = pool.getResourceUsage(); 

        assertNotNull(usage, "Usage snapshot should not be null"); 
        assertEquals(3, usage.inUse, "Should have 3 engines in use"); 
        assertEquals(10, usage.maxSize, "Max size should be 10"); 
        assertEquals(3, usage.trackedBorrows, "Should track 3 borrows"); 
        assertFalse(usage.isExhausted(), "Pool should not be exhausted"); 

        // Return engines
        pool.returnEngine(e1); 
        pool.returnEngine(e2); 
        pool.returnEngine(e3); 

        usage = pool.getResourceUsage(); 
        assertEquals(0, usage.inUse, "No engines should be in use"); 
    }

    @Test
    @DisplayName("Should detect pool exhaustion and apply backpressure")
    void testBackpressureDetection() throws Exception { 
        EnginePool.PoolConfig config = EnginePool.PoolConfig.defaults() 
            .minSize(1) 
            .maxSize(3) 
            .borrowTimeout(Duration.ofMillis(500)); 

        pool = new EnginePool<>( 
            this::createMockEngine,
            engine -> true,
            engine -> { engine.close(); return null; }, 
            config
        );

        // Borrow all available engines
        MockEngine e1 = pool.borrow(); 
        MockEngine e2 = pool.borrow(); 
        MockEngine e3 = pool.borrow(); 

        // Try to borrow one more - should trigger backpressure
        assertThrows(EnginePool.PoolExhaustedException.class, () -> { 
            pool.borrow(); 
        }, "Should throw PoolExhaustedException");

        EnginePool.PoolStats stats = pool.getStats(); 
        assertTrue(stats.backpressureEvents > 0, "Should have backpressure events"); 

        // Return engines
        pool.returnEngine(e1); 
        pool.returnEngine(e2); 
        pool.returnEngine(e3); 
    }

    @Test
    @DisplayName("Should provide detailed leak information with stack traces")
    void testLeakInfoDetails() throws Exception { 
        EnginePool.PoolConfig config = EnginePool.PoolConfig.defaults() 
            .minSize(1) 
            .maxSize(5) 
            .leakDetectionThreshold(Duration.ofSeconds(1)); 

        pool = new EnginePool<>( 
            this::createMockEngine,
            engine -> true,
            engine -> { engine.close(); return null; }, 
            config
        );

        // Borrow engine
        MockEngine engine = pool.borrow(); 

        // Wait for leak detection
        Thread.sleep(2000); 

        List<EnginePool.LeakInfo> leaks = pool.getPotentialLeaks(); 
        assertEquals(1, leaks.size(), "Should detect 1 leak"); 

        EnginePool.LeakInfo leak = leaks.get(0); 
        assertNotNull(leak.engine, "Leak should reference engine"); 
        assertNotNull(leak.borrowTime, "Leak should have borrow time"); 
        assertNotNull(leak.borrowStackTrace, "Leak should have stack trace"); 
        assertTrue(leak.heldDuration.toMillis() >= 1000, "Held duration should be >= 1s"); 

        pool.returnEngine(engine); 
    }

    @Test
    @DisplayName("Should handle concurrent borrows and returns safely")
    void testConcurrentLeakDetection() throws Exception { 
        EnginePool.PoolConfig config = EnginePool.PoolConfig.defaults() 
            .minSize(2) 
            .maxSize(20) 
            .leakDetectionThreshold(Duration.ofSeconds(3)); 

        pool = new EnginePool<>( 
            this::createMockEngine,
            engine -> true,
            engine -> { engine.close(); return null; }, 
            config
        );

        int threadCount = 10;
        CountDownLatch latch = new CountDownLatch(threadCount); 
        ExecutorService executor = Executors.newFixedThreadPool(threadCount); 

        for (int i = 0; i < threadCount; i++) { 
            final int threadId = i;
            executor.submit(() -> { 
                try {
                    MockEngine engine = pool.borrow(); 
                    Thread.sleep(100); 

                    // Half the threads don't return (simulate leak) 
                    if (threadId % 2 == 0) { 
                        pool.returnEngine(engine); 
                    }
                } catch (Exception e) { 
                    // Ignore
                } finally {
                    latch.countDown(); 
                }
            });
        }

        latch.await(5, TimeUnit.SECONDS); 
        executor.shutdown(); 

        // Wait for leak detection
        Thread.sleep(4000); 

        List<EnginePool.LeakInfo> leaks = pool.getPotentialLeaks(); 
        assertEquals(5, leaks.size(), "Should detect 5 leaked engines"); 

        EnginePool.PoolStats stats = pool.getStats(); 
        assertTrue(stats.leakDetections >= 5, "Should have leak detections"); 
    }

    @Test
    @DisplayName("Should report pool exhaustion in resource usage")
    void testExhaustionDetection() throws Exception { 
        EnginePool.PoolConfig config = EnginePool.PoolConfig.defaults() 
            .minSize(1) 
            .maxSize(2); 

        pool = new EnginePool<>( 
            this::createMockEngine,
            engine -> true,
            engine -> { engine.close(); return null; }, 
            config
        );

        // Borrow all engines
        MockEngine e1 = pool.borrow(); 
        MockEngine e2 = pool.borrow(); 

        EnginePool.ResourceUsageSnapshot usage = pool.getResourceUsage(); 
        assertTrue(usage.isExhausted(), "Pool should be exhausted"); 
        assertEquals(0, usage.available, "No engines should be available"); 
        assertEquals(2, usage.inUse, "All engines should be in use"); 

        pool.returnEngine(e1); 
        pool.returnEngine(e2); 
    }

    @Test
    @DisplayName("Should log leaked engines on pool close")
    void testLeakLoggingOnClose() throws Exception { 
        EnginePool.PoolConfig config = EnginePool.PoolConfig.defaults() 
            .minSize(1) 
            .maxSize(5); 

        pool = new EnginePool<>( 
            this::createMockEngine,
            engine -> true,
            engine -> { engine.close(); return null; }, 
            config
        );

        // Borrow engines and don't return
        pool.borrow(); 
        pool.borrow(); 

        // Close pool - should log leaks
        pool.close(); 
        pool = null; // Prevent double close in tearDown

        // Test passes if no exceptions thrown
    }

    @Test
    @DisplayName("Should track utilization percentage")
    void testUtilizationTracking() throws Exception { 
        EnginePool.PoolConfig config = EnginePool.PoolConfig.defaults() 
            .minSize(2) 
            .maxSize(10); 

        pool = new EnginePool<>( 
            this::createMockEngine,
            engine -> true,
            engine -> { engine.close(); return null; }, 
            config
        );

        // Initially low utilization
        EnginePool.ResourceUsageSnapshot usage = pool.getResourceUsage(); 
        assertTrue(usage.utilizationPercent < 0.5, "Initial utilization should be low"); 

        // Borrow 8 engines
        MockEngine[] engines = new MockEngine[8];
        for (int i = 0; i < 8; i++) { 
            engines[i] = pool.borrow(); 
        }

        usage = pool.getResourceUsage(); 
        assertTrue(usage.utilizationPercent >= 0.8, "Utilization should be high"); 

        // Return engines
        for (MockEngine engine : engines) { 
            pool.returnEngine(engine); 
        }
    }

    @Test
    @DisplayName("Should clear leak tracking when engines returned")
    void testLeakTrackingCleanup() throws Exception { 
        EnginePool.PoolConfig config = EnginePool.PoolConfig.defaults() 
            .minSize(1) 
            .maxSize(5) 
            .leakDetectionThreshold(Duration.ofSeconds(2)); 

        pool = new EnginePool<>( 
            this::createMockEngine,
            engine -> true,
            engine -> { engine.close(); return null; }, 
            config
        );

        MockEngine engine = pool.borrow(); 

        EnginePool.ResourceUsageSnapshot usage = pool.getResourceUsage(); 
        assertEquals(1, usage.trackedBorrows, "Should track 1 borrow"); 

        pool.returnEngine(engine); 

        usage = pool.getResourceUsage(); 
        assertEquals(0, usage.trackedBorrows, "Tracking should be cleared"); 
    }

    private MockEngine createMockEngine() { 
        return new MockEngine(engineCounter.incrementAndGet()); 
    }

    private static class MockEngine {
        private final int id;
        private boolean closed = false;

        MockEngine(int id) { 
            this.id = id;
        }

        void close() { 
            closed = true;
        }

        boolean isClosed() { 
            return closed;
        }

        @Override
        public String toString() { 
            return "MockEngine{id=" + id + ", closed=" + closed + "}";
        }
    }
}
