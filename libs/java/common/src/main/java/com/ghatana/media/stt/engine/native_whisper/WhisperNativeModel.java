package com.ghatana.media.stt.engine.native_whisper;

import com.ghatana.media.common.lifecycle.NativeModelLifecycle;

import java.util.Objects;
import java.util.function.LongConsumer;

/** Keeps native Whisper pointer access and disposal behind the same lifecycle lease. */
final class WhisperNativeModel {
    private final long pointer;
    private final LongConsumer disposer;
    private final NativeModelLifecycle lifecycle = new NativeModelLifecycle("Whisper engine is closed");

    WhisperNativeModel(long pointer, LongConsumer disposer) {
        if (pointer == 0) throw new IllegalArgumentException("Whisper model pointer must be nonzero");
        this.pointer = pointer;
        this.disposer = Objects.requireNonNull(disposer, "disposer");
    }

    Use acquire() {
        return new Use(lifecycle.acquire(), pointer);
    }

    void close(Runnable beforeDispose) {
        Objects.requireNonNull(beforeDispose, "beforeDispose");
        lifecycle.close(() -> {
            beforeDispose.run();
            disposer.accept(pointer);
        });
    }

    static final class Use implements AutoCloseable {
        private final NativeModelLifecycle.Lease lease;
        private final long pointer;
        private final Thread owner = Thread.currentThread();
        private boolean closed;

        private Use(NativeModelLifecycle.Lease lease, long pointer) {
            this.lease = lease;
            this.pointer = pointer;
        }

        long pointer() {
            if (Thread.currentThread() != owner) {
                throw new IllegalMonitorStateException("Whisper model pointer must be used by its lease owner");
            }
            if (closed) throw new IllegalStateException("Whisper model use is closed");
            return pointer;
        }

        @Override
        public void close() {
            if (closed) return;
            // The underlying lease checks thread ownership. Mark this view closed
            // only after release succeeds so a wrong-thread attempt is recoverable.
            lease.close();
            closed = true;
        }
    }
}
