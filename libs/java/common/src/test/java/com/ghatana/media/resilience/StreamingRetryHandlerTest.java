/**
 * @doc.type test
 * @doc.purpose Tests for streaming retry handler
 * @doc.layer platform
 */
package com.ghatana.media.resilience;

import com.ghatana.media.config.TimeoutConfig;

import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;

import java.time.Duration;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Tests for AV-007: Streaming retry logic
 */
class StreamingRetryHandlerTest {

    @Test
    @DisplayName("Should succeed on first attempt without retry")
    void testNoRetryOnSuccess() { 
        StreamingRetryHandler handler = StreamingRetryHandler.defaults(); 
        AtomicInteger calls = new AtomicInteger(0); 

        String result = handler.executeWithRetry(() -> { 
            calls.incrementAndGet(); 
            return "success";
        }, "test operation");

        assertEquals("success", result); 
        assertEquals(1, calls.get()); 
    }

    @Test
    @DisplayName("Should retry on retryable exception")
    void testRetryOnRetryableException() { 
        StreamingRetryHandler handler = StreamingRetryHandler.builder() 
            .maxRetries(3) 
            .initialDelay(Duration.ofMillis(10)) 
            .build(); 

        AtomicInteger calls = new AtomicInteger(0); 

        String result = handler.executeWithRetry(() -> { 
            int call = calls.incrementAndGet(); 
            if (call < 3) { 
                throw new RuntimeException("try again failure");
            }
            return "success";
        }, "test operation");

        assertEquals("success", result); 
        assertEquals(3, calls.get()); 
    }

    @Test
    @DisplayName("Should throw after max retries exhausted")
    void testThrowsAfterMaxRetries() { 
        StreamingRetryHandler handler = StreamingRetryHandler.builder() 
            .maxRetries(2) 
            .initialDelay(Duration.ofMillis(1)) 
            .build(); 

        assertThrows(StreamingRetryHandler.StreamingRetryExhaustedException.class, () -> { 
            handler.executeWithRetry(() -> { 
                throw new RuntimeException("try again");
            }, "failing operation");
        });
    }

    @Test
    @DisplayName("Should use fallback when retries exhausted")
    void testFallbackOnExhaustion() { 
        StreamingRetryHandler handler = StreamingRetryHandler.builder() 
            .maxRetries(2) 
            .initialDelay(Duration.ofMillis(1)) 
            .build(); 

        String result = handler.executeWithFallback(() -> { 
            throw new RuntimeException("try again");
        }, "fallback", "failing operation");

        assertEquals("fallback", result); 
    }

    @Test
    @DisplayName("Should retry on socket timeout")
    void testRetryOnSocketTimeout() { 
        StreamingRetryHandler handler = StreamingRetryHandler.builder() 
            .maxRetries(2) 
            .initialDelay(Duration.ofMillis(1)) 
            .build(); 

        AtomicInteger calls = new AtomicInteger(0); 

        String result = handler.executeWithRetry(() -> { 
            int call = calls.incrementAndGet(); 
            if (call == 1) { 
                throw new RuntimeException("try again");
            }
            return "success";
        }, "test operation");

        assertEquals("success", result); 
        assertEquals(2, calls.get()); 
    }

    @Test
    @DisplayName("Should not retry on non-retryable exception")
    void testNoRetryOnNonRetryable() { 
        StreamingRetryHandler handler = StreamingRetryHandler.defaults(); 
        AtomicInteger calls = new AtomicInteger(0); 

        assertThrows(StreamingRetryHandler.StreamingRetryExhaustedException.class, () -> { 
            handler.executeWithRetry(() -> { 
                calls.incrementAndGet(); 
                throw new IllegalArgumentException("Invalid argument"); // Non-retryable
            }, "test operation");
        });

        assertEquals(1, calls.get()); // Only one attempt 
    }

    @Test
    @DisplayName("Cancellation is never retried or converted to fallback")
    void cancellationIsTerminalEvenWhenRetryPredicateAcceptsEveryFailure() {
        StreamingRetryHandler handler = StreamingRetryHandler.builder()
            .maxRetries(3)
            .initialDelay(Duration.ofMillis(1))
            .build();
        AtomicInteger calls = new AtomicInteger();

        CancellationException cancellation = assertThrows(CancellationException.class,
            () -> handler.executeWithFallback(() -> {
                calls.incrementAndGet();
                throw new CancellationException("cancelled by caller");
            }, "fallback", "cancelled operation"));

        assertEquals("cancelled by caller", cancellation.getMessage());
        assertEquals(1, calls.get());

        AtomicInteger customPredicateCalls = new AtomicInteger();
        assertThrows(CancellationException.class, () -> handler.executeWithRetry(() -> {
            customPredicateCalls.incrementAndGet();
            throw new CancellationException("cancelled by caller");
        }, "cancelled operation", ignored -> true));
        assertEquals(1, customPredicateCalls.get(), "custom retry policy must not retry cancellation");
    }

    @Test
    @DisplayName("Shared platform cancellation is terminal and is not converted to fallback")
    void sharedCancellationIsTerminalEvenWhenRetryPredicateAcceptsEveryFailure() {
        StreamingRetryHandler handler = StreamingRetryHandler.builder()
            .maxRetries(3)
            .initialDelay(Duration.ofMillis(1))
            .build();
        AtomicInteger calls = new AtomicInteger();
        com.ghatana.core.exception.CancellationException cancellation =
            new com.ghatana.core.exception.CancellationException("platform cancelled");

        com.ghatana.core.exception.CancellationException thrown = assertThrows(
            com.ghatana.core.exception.CancellationException.class,
            () -> handler.executeWithRetry(() -> {
                calls.incrementAndGet();
                throw cancellation;
            }, "cancelled operation", ignored -> true));

        assertSame(cancellation, thrown, "platform cancellation identity should be preserved");
        assertEquals(1, calls.get(), "platform cancellation must not trigger retry");

        assertThrows(com.ghatana.core.exception.CancellationException.class,
            () -> handler.executeWithFallback(() -> {
                calls.incrementAndGet();
                throw cancellation;
            }, "fallback", "cancelled operation"));
        assertEquals(2, calls.get(), "platform cancellation must not be converted to fallback");
    }

    @Test
    @DisplayName("Interrupting retry backoff stops retries and preserves interruption")
    void interruptDuringBackoffStopsRetriesAndDoesNotReturnFallback() throws Exception {
        StreamingRetryHandler handler = StreamingRetryHandler.builder()
            .maxRetries(3)
            .initialDelay(Duration.ofSeconds(30))
            .build();
        AtomicInteger calls = new AtomicInteger();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        AtomicReference<Boolean> interruptPreserved = new AtomicReference<>(false);
        CountDownLatch firstAttempt = new CountDownLatch(1);

        Thread worker = new Thread(() -> {
            try {
                handler.executeWithFallback(() -> {
                    calls.incrementAndGet();
                    firstAttempt.countDown();
                    throw new RuntimeException("try again");
                }, "fallback", "interrupted operation");
            } catch (Throwable thrown) {
                failure.set(thrown);
                interruptPreserved.set(Thread.currentThread().isInterrupted());
            }
        });
        worker.start();

        assertTrue(firstAttempt.await(1, TimeUnit.SECONDS), "first attempt should start");
        long waitDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
        while (worker.getState() != Thread.State.TIMED_WAITING && System.nanoTime() < waitDeadline) {
            Thread.yield();
        }
        assertEquals(Thread.State.TIMED_WAITING, worker.getState(), "worker should be in retry backoff");
        worker.interrupt();
        worker.join(1_000);

        assertFalse(worker.isAlive(), "interrupted backoff should finish promptly");
        assertInstanceOf(CancellationException.class, failure.get());
        assertTrue(interruptPreserved.get());
        assertEquals(1, calls.get(), "cancellation must prevent another attempt");
    }

    @Test
    @DisplayName("Should apply exponential backoff")
    void testExponentialBackoff() { 
        long[] delays = new long[3];

        StreamingRetryHandler handler = StreamingRetryHandler.builder() 
            .maxRetries(3) 
            .initialDelay(Duration.ofMillis(100)) 
            .backoffMultiplier(2.0) 
            .addJitter(false) 
            .build(); 

        AtomicInteger calls = new AtomicInteger(0); 

        assertThrows(StreamingRetryHandler.StreamingRetryExhaustedException.class, () -> { 
            handler.executeWithRetry(() -> { 
                calls.incrementAndGet(); 
                throw new RuntimeException("try again");
            }, "test");
        });

        // Should have made 4 attempts (initial + 3 retries) 
        assertEquals(4, calls.get()); 
    }

    @Test
    @DisplayName("Should cap delay at max delay")
    void testMaxDelayCap() { 
        StreamingRetryHandler handler = StreamingRetryHandler.builder() 
            .maxRetries(10) 
            .initialDelay(Duration.ofMillis(100)) 
            .maxDelay(Duration.ofMillis(200)) 
            .backoffMultiplier(10.0) // Would exceed max without cap 
            .addJitter(false) 
            .build(); 

        // Even with high multiplier, delay should not exceed maxDelay
        assertTrue(handler.getMaxDelay().toMillis() <= 200); 
    }

    @Test
    @DisplayName("Should respect timeout limit")
    void testTimeoutRespected() { 
        TimeoutConfig timeoutConfig = TimeoutConfig.builder() 
            .streamingTimeout(Duration.ofMillis(100)) // Very short timeout 
            .build(); 

        StreamingRetryHandler handler = StreamingRetryHandler.builder() 
            .maxRetries(100) // Would take too long without timeout 
            .initialDelay(Duration.ofMillis(50)) 
            .timeoutConfig(timeoutConfig) 
            .build(); 

        assertThrows(StreamingRetryHandler.StreamingRetryExhaustedException.class, () -> { 
            handler.executeWithRetry(() -> { 
                throw new RuntimeException("try again");
            }, "test");
        });
    }

    @Test
    @DisplayName("Should create aggressive retry handler")
    void testAggressiveHandler() { 
        StreamingRetryHandler handler = StreamingRetryHandler.aggressive(); 

        assertEquals(5, handler.getMaxRetries()); 
        assertEquals(Duration.ofMillis(100), handler.getInitialDelay()); 
        assertTrue(handler.isJitterEnabled()); 
    }

    @Test
    @DisplayName("Should create conservative retry handler")
    void testConservativeHandler() { 
        StreamingRetryHandler handler = StreamingRetryHandler.conservative(); 

        assertEquals(10, handler.getMaxRetries()); 
        assertEquals(Duration.ofMillis(500), handler.getInitialDelay()); 
        assertEquals(Duration.ofSeconds(30), handler.getMaxDelay()); 
    }

    @Test
    @DisplayName("Should track attempt count in exception")
    void testExceptionAttemptCount() { 
        StreamingRetryHandler handler = StreamingRetryHandler.builder() 
            .maxRetries(2) 
            .initialDelay(Duration.ofMillis(1)) 
            .build(); 

        StreamingRetryHandler.StreamingRetryExhaustedException exception =
            assertThrows(StreamingRetryHandler.StreamingRetryExhaustedException.class, () -> { 
                handler.executeWithRetry(() -> { 
                    throw new RuntimeException("try again");
                }, "test");
            });

        // 3 attempts (initial + 2 retries) 
        assertEquals(3, exception.getAttemptsMade()); 
        assertNotNull(exception.getLastException()); 
    }
}
