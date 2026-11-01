package com.ghatana.media.common.pool;

import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class EnginePoolLifecycleTest {
    private static final class Engine {
        final AtomicInteger closes = new AtomicInteger();
        // Deliberately equal objects are still separate physical engine handles.
        @Override public boolean equals(Object other) { return other instanceof Engine; }
        @Override public int hashCode() { return 1; }
    }

    private static EnginePool.PoolConfig config() {
        return EnginePool.PoolConfig.defaults().minSize(0).maxSize(2)
                .borrowTimeout(Duration.ofSeconds(3));
    }

    @Test
    void equalEngineValuesRemainIndependentAndForeignReturnsDoNotDestroy() throws Exception {
        try (var pool = new EnginePool<>(Engine::new, engine -> true,
                engine -> { engine.closes.incrementAndGet(); return null; }, config())) {
            Engine first = pool.borrow();
            Engine second = pool.borrow();
            Engine foreign = new Engine();
            pool.returnEngine(foreign);
            assertThat(foreign.closes).hasValue(0);
            assertThat(pool.getStats().inUse).isEqualTo(2);
            pool.returnEngine(first);
            pool.returnEngine(first); // duplicate before another borrow is ignored
            assertThat(first.closes).hasValue(0);
            assertThat(second.closes).hasValue(0);
            assertThat(pool.getStats().inUse).isEqualTo(1);
            pool.returnEngine(second);
        }
    }

    @Test
    void closeDefersDestructionUntilBorrowerReturns() throws Exception {
        var pool = new EnginePool<>(Engine::new, engine -> true,
                engine -> { engine.closes.incrementAndGet(); return null; }, config());
        Engine borrowed = pool.borrow();
        pool.close();
        assertThat(borrowed.closes).hasValue(0);
        assertThat(pool.getStats().inUse).isEqualTo(1);
        pool.returnEngine(borrowed);
        assertThat(borrowed.closes).hasValue(1);
        pool.returnEngine(borrowed);
        pool.close();
        assertThat(borrowed.closes).hasValue(1);
        assertThatThrownBy(pool::borrow).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void waitingBorrowObservesCloseWithoutWaitingForFullTimeout() throws Exception {
        var pool = new EnginePool<>(Engine::new, engine -> true,
                engine -> { engine.closes.incrementAndGet(); return null; }, config().maxSize(1));
        Engine held = pool.borrow();
        var started = new CountDownLatch(1);
        try (var executor = Executors.newSingleThreadExecutor()) {
            var waiting = executor.submit(() -> { started.countDown(); return pool.borrow(); });
            assertThat(started.await(1, TimeUnit.SECONDS)).isTrue();
            pool.close();
            assertThatThrownBy(() -> waiting.get(1, TimeUnit.SECONDS))
                    .hasCauseInstanceOf(IllegalStateException.class);
        } finally {
            pool.returnEngine(held);
            pool.close();
        }
    }

    @Test
    void executeReturnsLeaseWhenActionFails() throws Exception {
        try (var pool = new EnginePool<>(Engine::new, engine -> true,
                engine -> { engine.closes.incrementAndGet(); return null; }, config().maxSize(1))) {
            assertThatThrownBy(() -> pool.execute(engine -> { throw new IllegalArgumentException("failed"); }))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThat(pool.getStats().inUse).isZero();
            try (var lease = pool.borrowLease()) {
                assertThat(lease.engine()).isNotNull();
            }
        }
    }

    @Test
    void tokenizedLeaseRejectsRawAndStaleReturns() throws Exception {
        try (var pool = new EnginePool<>(Engine::new, engine -> true,
                engine -> { engine.closes.incrementAndGet(); return null; }, config().maxSize(1))) {
            var first = pool.borrowLease();
            Engine handle = first.engine();
            assertThatThrownBy(() -> pool.returnEngine(handle)).isInstanceOf(IllegalStateException.class);
            assertThat(pool.getStats().inUse).isEqualTo(1);
            first.close();
            var second = pool.borrowLease();
            assertThat(second.engine()).isSameAs(handle);
            first.close();
            assertThat(pool.getStats().inUse).isEqualTo(1);
            assertThatThrownBy(first::engine).isInstanceOf(IllegalStateException.class);
            second.close();
            assertThat(pool.getStats().inUse).isZero();
        }
    }

    @Test
    void failedDestructionIsVisibleAndCapacityRemainsReserved() throws Exception {
        var healthy = new java.util.concurrent.atomic.AtomicBoolean(true);
        var pool = new EnginePool<>(Engine::new, engine -> healthy.get(),
                engine -> { throw new IllegalStateException("native close failed"); },
                config().maxSize(1).borrowTimeout(Duration.ofMillis(150)));
        try {
            var lease = pool.borrowLease();
            healthy.set(false);
            lease.close();
            assertThat(pool.getFailedDestructionCount()).isEqualTo(1);
            assertThat(pool.getStats().available).isZero();
            assertThat(pool.getStats().inUse).isZero();
            assertThatThrownBy(pool::borrow).isInstanceOf(EnginePool.PoolExhaustedException.class);
        } finally {
            pool.close();
        }
    }

    @Test
    void blockingReturnHealthCheckDoesNotBlockPoolClose() throws Exception {
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var checks = new AtomicInteger();
        Engine engine = new Engine();
        var pool = new EnginePool<>(() -> engine, resource -> {
            if (checks.incrementAndGet() > 1) {
                entered.countDown();
                try {
                    if (!release.await(3, TimeUnit.SECONDS)) throw new IllegalStateException("health timeout");
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(interrupted);
                }
            }
            return true;
        }, resource -> { resource.closes.incrementAndGet(); return null; }, config().maxSize(1));
        var lease = pool.borrowLease();
        try (var executor = Executors.newFixedThreadPool(2)) {
            var returning = executor.submit(lease::close);
            assertThat(entered.await(1, TimeUnit.SECONDS)).isTrue();
            var closing = executor.submit(pool::close);
            closing.get(1, TimeUnit.SECONDS);
            release.countDown();
            returning.get(1, TimeUnit.SECONDS);
            assertThat(engine.closes).hasValue(1);
        } finally {
            release.countDown();
            lease.close();
            pool.close();
        }
    }

    @Test
    void blockingDestroyerDoesNotBlockOtherBorrowRegistration() throws Exception {
        Engine first = new Engine();
        Engine second = new Engine();
        var count = new AtomicInteger();
        var healthy = new java.util.concurrent.atomic.AtomicBoolean(true);
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var pool = new EnginePool<>(() -> count.getAndIncrement() == 0 ? first : second,
                engine -> engine != first || healthy.get(), engine -> {
                    if (engine == first) {
                        entered.countDown();
                        try {
                            if (!release.await(3, TimeUnit.SECONDS)) throw new IllegalStateException("destroy timeout");
                        } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                            throw new IllegalStateException(interrupted);
                        }
                    }
                    engine.closes.incrementAndGet();
                    return null;
                }, config());
        var lease = pool.borrowLease();
        healthy.set(false);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var returning = executor.submit(lease::close);
            assertThat(entered.await(1, TimeUnit.SECONDS)).isTrue();
            var other = executor.submit(pool::borrowLease).get(1, TimeUnit.SECONDS);
            assertThat(other.engine()).isSameAs(second);
            other.close();
            release.countDown();
            returning.get(1, TimeUnit.SECONDS);
        } finally {
            release.countDown();
            lease.close();
            pool.close();
        }
    }

    @Test
    void waitingBorrowCreatesReplacementWhenReturnedEngineIsUnhealthy() throws Exception {
        Engine first = new Engine();
        Engine replacement = new Engine();
        var created = new AtomicInteger();
        var healthy = new java.util.concurrent.atomic.AtomicBoolean(true);
        var pool = new EnginePool<>(() -> created.getAndIncrement() == 0 ? first : replacement,
                engine -> engine != first || healthy.get(),
                engine -> { engine.closes.incrementAndGet(); return null; }, config().maxSize(1));
        Engine held = pool.borrow();
        try (var executor = Executors.newSingleThreadExecutor()) {
            var started = new CountDownLatch(1);
            var pending = executor.submit(() -> { started.countDown(); return pool.borrow(); });
            assertThat(started.await(1, TimeUnit.SECONDS)).isTrue();
            healthy.set(false);
            pool.returnEngine(held);
            Engine acquired = pending.get(2, TimeUnit.SECONDS);
            assertThat(acquired).isSameAs(replacement);
            assertThat(first.closes).hasValue(1);
            pool.returnEngine(acquired);
        } finally {
            pool.close();
        }
    }

    @Test
    void poolCloseDuringFactoryCreationNeverHandsOutOrLeaksNewEngine() throws Exception {
        Engine created = new Engine();
        var factoryEntered = new CountDownLatch(1);
        var releaseFactory = new CountDownLatch(1);
        var pool = new EnginePool<>(() -> {
            factoryEntered.countDown();
            try {
                if (!releaseFactory.await(2, TimeUnit.SECONDS)) throw new IllegalStateException("factory timeout");
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(interrupted);
            }
            return created;
        }, engine -> true, engine -> { engine.closes.incrementAndGet(); return null; }, config());
        try (var executor = Executors.newSingleThreadExecutor()) {
            var pending = executor.submit(pool::borrow);
            assertThat(factoryEntered.await(1, TimeUnit.SECONDS)).isTrue();
            pool.close();
            releaseFactory.countDown();
            assertThatThrownBy(() -> pending.get(1, TimeUnit.SECONDS))
                    .hasCauseInstanceOf(IllegalStateException.class);
            assertThat(created.closes).hasValue(1);
            assertThat(pool.getStats().inUse).isZero();
        } finally {
            releaseFactory.countDown();
            pool.close();
        }
    }

    @Test
    void factoryCannotLendTheSameInstanceToTwoBorrowers() throws Exception {
        Engine shared = new Engine();
        try (var pool = new EnginePool<>(() -> shared, engine -> true,
                engine -> { engine.closes.incrementAndGet(); return null; },
                config().borrowTimeout(Duration.ofMillis(150)))) {
            Engine first = pool.borrow();
            assertThatThrownBy(pool::borrow).isInstanceOf(EnginePool.PoolExhaustedException.class);
            assertThat(first.closes).hasValue(0);
            pool.returnEngine(first);
        }
        assertThat(shared.closes).hasValue(1);
    }

    @Test
    void duplicateFactoryInstancesDuringPrepopulationDoNotConsumeExtraCapacity() throws Exception {
        Engine shared = new Engine();
        try (var pool = new EnginePool<>(() -> shared, engine -> true,
                engine -> { engine.closes.incrementAndGet(); return null; },
                config().minSize(2).borrowTimeout(Duration.ofMillis(150)))) {
            assertThat(pool.getStats().available).isEqualTo(1);
            Engine first = pool.borrow();
            assertThatThrownBy(pool::borrow).isInstanceOf(EnginePool.PoolExhaustedException.class);
            assertThat(first.closes).hasValue(0);
            pool.returnEngine(first);
        }
        assertThat(shared.closes).hasValue(1);
    }

    @Test
    void fatalFactoryFailureReleasesItsCapacityReservation() throws Exception {
        var calls = new AtomicInteger();
        try (var pool = new EnginePool<>(() -> {
            if (calls.getAndIncrement() == 0) throw new AssertionError("factory failed");
            return new Engine();
        }, engine -> true, engine -> { engine.closes.incrementAndGet(); return null; }, config().maxSize(1))) {
            assertThatThrownBy(pool::borrow).isInstanceOf(AssertionError.class);
            try (var lease = pool.borrowLease()) {
                assertThat(lease.engine()).isNotNull();
            }
        }
    }

    @Test
    void rejectedConfigurationDoesNotStartPool() {
        assertThatThrownBy(() -> new EnginePool<>(Engine::new, engine -> true, engine -> null,
                config().maxSize(0))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new EnginePool<>(Engine::new, engine -> true, engine -> null,
                config().idleTimeout(Duration.ofMillis(1)))).isInstanceOf(IllegalArgumentException.class);
    }
}
