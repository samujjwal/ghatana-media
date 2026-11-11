package com.ghatana.media.common.lifecycle;

import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
 * Purpose: fence native-model use against disposal with fair, thread-owned leases.
 * Consumers: the local Whisper and Piper native model wrappers in this library.
 * Non-goals: this does not own model loading, rights, provider admission, inference quality,
 *             or cross-process worker fencing.
 * Change policy: preserve one-shot fail-closed disposal; never reopen a model after an
 *                 uncertain native disposer failure or retry a potentially partial close.
 */
public final class NativeModelLifecycle {
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock(true);
    private final ThreadLocal<Integer> leasesOwnedByCurrentThread = ThreadLocal.withInitial(() -> 0);
    private final String closedMessage;
    private boolean closed;

    public NativeModelLifecycle(String closedMessage) {
        this.closedMessage = Objects.requireNonNull(closedMessage, "closedMessage");
        if (closedMessage.isBlank()) throw new IllegalArgumentException("closedMessage must be nonblank");
    }

    public Lease acquire() {
        lock.readLock().lock();
        if (closed) {
            lock.readLock().unlock();
            throw new IllegalStateException(closedMessage);
        }
        leasesOwnedByCurrentThread.set(leasesOwnedByCurrentThread.get() + 1);
        return new Lease();
    }

    /**
     * Stops admitting readers, waits for active leases, and disposes once. The
     * owner of a current-thread lease cannot upgrade the read lock to the write
     * lock, so that call is rejected before it can self-deadlock.
     */
    public void close(Runnable disposer) {
        Objects.requireNonNull(disposer, "disposer");
        if (leasesOwnedByCurrentThread.get() > 0) {
            throw new IllegalStateException("Cannot close native model while holding an active lease");
        }
        lock.writeLock().lock();
        try {
            if (!closed) {
                closed = true;
                disposer.run();
            }
        } finally {
            lock.writeLock().unlock();
        }
    }

    public final class Lease implements AutoCloseable {
        // Read locks are thread-owned; keep a bad cross-thread close from consuming the release.
        private final Thread owner = Thread.currentThread();
        private final AtomicBoolean released = new AtomicBoolean();

        @Override
        public void close() {
            if (Thread.currentThread() != owner) {
                throw new IllegalMonitorStateException("Native model lease must be released by its acquiring thread");
            }
            if (released.compareAndSet(false, true)) releaseLease();
        }
    }

    private void releaseLease() {
        int active = leasesOwnedByCurrentThread.get();
        if (active < 1) throw new IllegalStateException("Native model lease count is inconsistent");
        if (active == 1) leasesOwnedByCurrentThread.remove();
        else leasesOwnedByCurrentThread.set(active - 1);
        lock.readLock().unlock();
    }
}
