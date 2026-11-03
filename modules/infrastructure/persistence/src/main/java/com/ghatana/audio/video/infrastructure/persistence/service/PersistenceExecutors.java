package com.ghatana.audio.video.infrastructure.persistence.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Bounded database execution resources owned by persistence services. */
final class PersistenceExecutors {

    static final int MAX_CONCURRENT_DATABASE_OPERATIONS = 8;
    private static final int QUEUE_CAPACITY = 128;
    static final int MAX_OUTSTANDING_OPERATIONS = MAX_CONCURRENT_DATABASE_OPERATIONS + QUEUE_CAPACITY;

    private PersistenceExecutors() { }

    static ThreadPoolExecutor newDatabaseExecutor(String serviceName) {
        int threads = Math.max(1,
            Math.min(MAX_CONCURRENT_DATABASE_OPERATIONS, Runtime.getRuntime().availableProcessors()));
        AtomicInteger sequence = new AtomicInteger();
        ThreadFactory threadFactory = task -> {
            Thread thread = new Thread(task, "media-" + serviceName + "-db-" + sequence.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        };
        return new ThreadPoolExecutor(threads, threads, 0, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(QUEUE_CAPACITY), threadFactory, new ThreadPoolExecutor.AbortPolicy());
    }
}
