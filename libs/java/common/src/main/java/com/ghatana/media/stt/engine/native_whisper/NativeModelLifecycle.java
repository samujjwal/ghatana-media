package com.ghatana.media.stt.engine.native_whisper;

import java.util.concurrent.locks.ReentrantReadWriteLock;

/** Fences native model use against disposal. A lease must cover every native call. */
final class NativeModelLifecycle {
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock(true);
    private boolean closed;

    Lease acquire() {
        lock.readLock().lock();
        if (closed) {
            lock.readLock().unlock();
            throw new IllegalStateException("Whisper engine is closed");
        }
        return new Lease();
    }

    void close(Runnable disposer) {
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

    final class Lease implements AutoCloseable {
        private boolean released;

        @Override
        public void close() {
            if (!released) {
                released = true;
                lock.readLock().unlock();
            }
        }
    }
}
