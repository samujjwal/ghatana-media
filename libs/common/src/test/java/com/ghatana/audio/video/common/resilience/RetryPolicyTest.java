package com.ghatana.audio.video.common.resilience;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Unit tests for {@link RetryPolicy}.
 *
 * @doc.type class
 * @doc.purpose Unit tests for the retry policy with exponential back-off
 * @doc.layer product
 * @doc.pattern TestCase
 */
@DisplayName("RetryPolicy")
class RetryPolicyTest {

    // ─────────────────────────────────────────────────────────────────────────
    // Defaults
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("defaults: creates policy with sensible defaults")
    void defaults_hasSensibleConfiguration() { 
        // Should not throw
        RetryPolicy policy = RetryPolicy.defaults(); 
        assertThat(policy).isNotNull(); 
    }

    @Test
    @DisplayName("defaults: ambiguous failure is attempted once")
    void defaults_ambiguousFailureIsNotRetried() {
        AtomicInteger calls = new AtomicInteger();

        assertThatThrownBy(() -> RetryPolicy.defaults().executeWithResult(() -> {
            calls.incrementAndGet();
            throw new IllegalStateException("outcome unknown");
        }))
            .isInstanceOf(RetryPolicy.RetryExhaustedException.class)
            .satisfies(ex -> {
                RetryPolicy.RetryExhaustedException retryEx = (RetryPolicy.RetryExhaustedException) ex;
                assertThat(retryEx.getAttemptsMade()).isEqualTo(1);
                assertThat(retryEx.getCause()).isInstanceOf(IllegalStateException.class);
            });

        assertThat(calls.get()).isEqualTo(1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // executeWithResult — success on first attempt
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("executeWithResult: success on first attempt → returns result")
    void executeWithResult_successFirstAttempt_returnsResult() throws InterruptedException { 
        RetryPolicy policy = RetryPolicy.builder().maxAttempts(3).build(); 

        String result = policy.executeWithResult(() -> "hello"); 

        assertThat(result).isEqualTo("hello");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // executeWithResult — succeeds after failures
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("executeWithResult: fails twice then succeeds → result returned")
    void executeWithResult_failsTwiceThenSucceeds_returnsResult() throws InterruptedException { 
        AtomicInteger calls = new AtomicInteger(0); 
        RetryPolicy policy = RetryPolicy.builder() 
            .maxAttempts(3) 
            .initialDelay(Duration.ofMillis(1)) 
            .jitterFactor(0) 
            // The injected failures model a known no-effect transient operation.
            .retryOn(t -> true)
            .build(); 

        String result = policy.executeWithResult(() -> { 
            if (calls.incrementAndGet() < 3) { 
                throw new RuntimeException("transient error");
            }
            return "success";
        });

        assertThat(result).isEqualTo("success");
        assertThat(calls.get()).isEqualTo(3); 
    }

    // ─────────────────────────────────────────────────────────────────────────
    // executeWithResult — exhausted
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("executeWithResult: all attempts fail → RetryExhaustedException thrown")
    void executeWithResult_allAttemptsFail_throwsRetryExhausted() { 
        AtomicInteger calls = new AtomicInteger(0); 
        RetryPolicy policy = RetryPolicy.builder() 
            .maxAttempts(3) 
            .initialDelay(Duration.ofMillis(1)) 
            .jitterFactor(0) 
            // The injected failures model a known no-effect transient operation.
            .retryOn(t -> true)
            .build(); 

        assertThatThrownBy(() -> policy.executeWithResult(() -> { 
            calls.incrementAndGet(); 
            throw new RuntimeException("always fails");
        }))
            .isInstanceOf(RetryPolicy.RetryExhaustedException.class) 
            .satisfies(ex -> { 
                RetryPolicy.RetryExhaustedException retryEx = (RetryPolicy.RetryExhaustedException) ex; 
                assertThat(retryEx.getAttemptsMade()).isEqualTo(3); 
                assertThat(retryEx.getCause()).hasMessage("always fails");
            });

        assertThat(calls.get()).isEqualTo(3); 
    }

    @Test
    @DisplayName("executeWithResult: elapsed budget prevents a retry beyond the deadline")
    void executeWithResult_elapsedBudgetStopsBeforeBackoff() {
        AtomicInteger calls = new AtomicInteger();
        RetryPolicy policy = RetryPolicy.builder()
            .maxAttempts(100)
            .initialDelay(Duration.ofSeconds(1))
            .maxElapsed(Duration.ofMillis(10))
            .jitterFactor(0)
            // The injected failure is known to have had no effect; only the budget is under test.
            .retryOn(t -> true)
            .build();

        assertThatThrownBy(() -> policy.executeWithResult(() -> {
            calls.incrementAndGet();
            throw new RuntimeException("provider secret-value");
        }))
            .isInstanceOf(RetryPolicy.RetryExhaustedException.class)
            .hasMessageContaining("after 1 attempts")
            .hasMessageNotContaining("secret-value");
        assertThat(calls.get()).isEqualTo(1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Non-retryable exception
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("executeWithResult: non-retryable exception → throws immediately without retry")
    void executeWithResult_nonRetryable_throwsImmediately() { 
        AtomicInteger calls = new AtomicInteger(0); 
        RetryPolicy policy = RetryPolicy.builder() 
            .maxAttempts(5) 
            .retryOnlyOn(RuntimeException.class) // only retry RuntimeException 
            .initialDelay(Duration.ofMillis(1)) 
            .build(); 

        assertThatThrownBy(() -> policy.executeWithResult(() -> { 
            calls.incrementAndGet(); 
            throw new IOException("not retryable");
        }))
            .isInstanceOf(RetryPolicy.RetryExhaustedException.class) 
            .satisfies(ex -> { 
                RetryPolicy.RetryExhaustedException retryEx = (RetryPolicy.RetryExhaustedException) ex; 
                assertThat(retryEx.getAttemptsMade()).isEqualTo(1);
            });
        assertThat(calls.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("executeWithResult: retryOn predicate excludes specific type → immediate failure")
    void executeWithResult_customRetryPredicate_excludesSpecificType() { 
        AtomicInteger calls = new AtomicInteger(0); 
        RetryPolicy policy = RetryPolicy.builder() 
            .maxAttempts(5) 
            .initialDelay(Duration.ofMillis(1)) 
            .retryOn(t -> !(t instanceof UnsupportedOperationException)) 
            .build(); 

        assertThatThrownBy(() -> policy.executeWithResult(() -> { 
            calls.incrementAndGet(); 
            throw new UnsupportedOperationException("not supported");
        }))
            .isInstanceOf(RetryPolicy.RetryExhaustedException.class) 
            .satisfies(ex -> { 
                RetryPolicy.RetryExhaustedException retryEx = (RetryPolicy.RetryExhaustedException) ex; 
                assertThat(retryEx.getAttemptsMade()).isEqualTo(1); // no retry on UnsupportedOperationException 
            });

        assertThat(calls.get()).isEqualTo(1); 
    }

    // ─────────────────────────────────────────────────────────────────────────
    // execute (void variant) 
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("execute: action succeeds → no exception thrown")
    void execute_success_noException() throws InterruptedException { 
        AtomicInteger calls = new AtomicInteger(0); 
        RetryPolicy policy = RetryPolicy.builder().maxAttempts(1).build(); 

        policy.execute(() -> calls.incrementAndGet()); 

        assertThat(calls.get()).isEqualTo(1); 
    }

    @Test
    @DisplayName("execute: all attempts fail → RetryExhaustedException thrown")
    void execute_allFail_throwsRetryExhausted() { 
        RetryPolicy policy = RetryPolicy.builder() 
            .maxAttempts(2) 
            .initialDelay(Duration.ofMillis(1)) 
            .jitterFactor(0) 
            // The injected failures model a known no-effect transient operation.
            .retryOn(t -> true)
            .build(); 

        assertThatThrownBy(() -> policy.execute(() -> { 
            throw new RuntimeException("failed");
        }))
            .isInstanceOf(RetryPolicy.RetryExhaustedException.class); 
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Builder validation
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("builder: maxAttempts < 1 → IllegalArgumentException")
    void builder_invalidMaxAttempts_throwsException() { 
        assertThatThrownBy(() -> RetryPolicy.builder().maxAttempts(0).build()) 
            .isInstanceOf(IllegalArgumentException.class) 
            .hasMessageContaining("maxAttempts");
    }

    @Test
    @DisplayName("builder: retry work has finite hard limits")
    void builder_retryLimits_areBounded() {
        assertThatThrownBy(() -> RetryPolicy.builder().maxAttempts(RetryPolicy.MAX_ATTEMPTS + 1))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("maxAttempts");
        assertThatThrownBy(() -> RetryPolicy.builder().maxDelay(RetryPolicy.MAX_DELAY.plusMillis(1)))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("maxDelay");
        assertThatThrownBy(() -> RetryPolicy.builder().maxElapsed(RetryPolicy.MAX_ELAPSED.plusMillis(1)))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("maxElapsed");

        assertThat(RetryPolicy.builder().maxAttempts(RetryPolicy.MAX_ATTEMPTS)
            .maxDelay(RetryPolicy.MAX_DELAY).maxElapsed(RetryPolicy.MAX_ELAPSED).build())
            .isNotNull();
    }

    @Test
    @DisplayName("builder: multiplier < 1.0 → IllegalArgumentException")
    void builder_invalidMultiplier_throwsException() { 
        assertThatThrownBy(() -> RetryPolicy.builder().multiplier(0.5).build()) 
            .isInstanceOf(IllegalArgumentException.class) 
            .hasMessageContaining("multiplier");
    }

    @Test
    @DisplayName("builder: non-finite multiplier and jitter values are rejected")
    void builder_nonFiniteBackoffValues_areRejected() {
        for (double value : new double[] {Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY}) {
            assertThatThrownBy(() -> RetryPolicy.builder().multiplier(value))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("multiplier");
            assertThatThrownBy(() -> RetryPolicy.builder().jitterFactor(value))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("jitterFactor");
        }
    }

    @Test
    @DisplayName("builder: retry durations must fit millisecond precision and range")
    void builder_unrepresentableRetryDurations_areRejected() {
        Duration subMillisecond = Duration.ofNanos(999_999);
        assertThatThrownBy(() -> RetryPolicy.builder().initialDelay(subMillisecond))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("initialDelay");
        assertThatThrownBy(() -> RetryPolicy.builder().maxDelay(subMillisecond))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("maxDelay");
        assertThatThrownBy(() -> RetryPolicy.builder().maxElapsed(subMillisecond))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("maxElapsed");

        Duration overflow = Duration.ofSeconds(Long.MAX_VALUE);
        assertThatThrownBy(() -> RetryPolicy.builder().initialDelay(overflow))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("initialDelay")
            .hasMessageContaining("range");
        assertThatThrownBy(() -> RetryPolicy.builder().maxDelay(overflow))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("maxDelay")
            .hasMessageContaining("range");
        assertThatThrownBy(() -> RetryPolicy.builder().maxElapsed(overflow))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("maxElapsed")
            .hasMessageContaining("range");
    }

    @Test
    @DisplayName("large positive jitter saturates instead of wrapping the delay")
    void jitter_largePositiveDelaySaturates() {
        assertThat(RetryPolicy.applyJitter(Long.MAX_VALUE, 1.0, Math.nextDown(1.0)))
            .isEqualTo(Long.MAX_VALUE);
        assertThat(RetryPolicy.applyJitter(100, 0.1, 0.25))
            .isEqualTo(95);
    }

    @Test
    @DisplayName("maxDelay caps initial and jittered retry delays")
    void retryDelay_isCappedAfterJitterIncludingInitialDelay() {
        assertThat(RetryPolicy.boundedDelay(500, 100, 0, 0.5)).isEqualTo(100);
        assertThat(RetryPolicy.boundedDelay(80, 100, 1.0, Math.nextDown(1.0)))
            .isEqualTo(100);
        assertThat(RetryPolicy.boundedDelay(80, 100, 1.0, 0.0)).isEqualTo(0);
    }

    @Test
    @DisplayName("retry budget: elapsed deadline prevents starting another attempt")
    void retryBudgetExpired_checksBeforeAttemptAtDeadline() {
        long startedNanos = 1_000_000L;
        long budgetMs = 25L;

        assertThat(RetryPolicy.retryBudgetExpired(startedNanos,
                startedNanos + budgetMs * 1_000_000L - 1, budgetMs)).isFalse();
        assertThat(RetryPolicy.retryBudgetExpired(startedNanos,
                startedNanos + budgetMs * 1_000_000L, budgetMs)).isTrue();
        assertThat(RetryPolicy.retryBudgetExpired(startedNanos,
                startedNanos + (budgetMs + 1) * 1_000_000L, budgetMs)).isTrue();
    }

    @Test
    @DisplayName("builder: jitterFactor out of [0,1] → IllegalArgumentException")
    void builder_invalidJitterFactor_throwsException() { 
        assertThatThrownBy(() -> RetryPolicy.builder().jitterFactor(1.5).build()) 
            .isInstanceOf(IllegalArgumentException.class) 
            .hasMessageContaining("jitterFactor");
    }

    @Test
    @DisplayName("builder: non-positive maxElapsed is rejected")
    void builder_invalidMaxElapsed_throwsException() {
        assertThatThrownBy(() -> RetryPolicy.builder().maxElapsed(Duration.ZERO))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("maxElapsed");
    }

    @Test
    @DisplayName("builder: null retryOn → IllegalArgumentException")
    void builder_nullRetryOn_throwsException() { 
        assertThatThrownBy(() -> RetryPolicy.builder().retryOn(null).build()) 
            .isInstanceOf(IllegalArgumentException.class) 
            .hasMessageContaining("retryOn");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RetryExhaustedException
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("RetryExhaustedException: getAttemptsMade returns constructor value")
    void retryExhaustedException_getAttemptsMade_returnsValue() { 
        RetryPolicy.RetryExhaustedException ex =
            new RetryPolicy.RetryExhaustedException("test", new RuntimeException("cause"), 5);

        assertThat(ex.getAttemptsMade()).isEqualTo(5); 
        assertThat(ex.getMessage()).isEqualTo("test");
        assertThat(ex.getCause()).hasMessage("cause");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // maxAttempts=1 (no retry) 
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("maxAttempts=1: single failure → immediate exhaustion")
    void maxAttempts_one_immediateExhaustion() { 
        RetryPolicy policy = RetryPolicy.builder().maxAttempts(1).build(); 

        assertThatThrownBy(() -> policy.executeWithResult(() -> { 
            throw new RuntimeException("error");
        }))
            .isInstanceOf(RetryPolicy.RetryExhaustedException.class) 
            .satisfies(ex -> { 
                RetryPolicy.RetryExhaustedException retryEx = (RetryPolicy.RetryExhaustedException) ex; 
                assertThat(retryEx.getAttemptsMade()).isEqualTo(1); 
            });
    }
}
