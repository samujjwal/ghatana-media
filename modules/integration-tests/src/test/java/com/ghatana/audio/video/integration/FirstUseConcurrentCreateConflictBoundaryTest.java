package com.ghatana.audio.video.integration;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import static com.ghatana.media.runtime.MediaProjectTimelineContracts.Created;
import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.media.production.timeline.InMemoryProjectTimelineStore;
import com.ghatana.media.production.timeline.ProjectTimelineEngine;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Concurrent J-01 negative boundary for a create request reused with different content.
 * The in-memory store and synthetic actor are fixtures, not canonical persistence or host identity.
 */
@DisplayName("J-01 concurrent create conflict boundary (fixture only)")
class FirstUseConcurrentCreateConflictBoundaryTest {
    @Test
    void concurrentSameRequestWithDifferentTitlesCreatesOnlyTheWinningProject() throws Exception {
        Actor actor = new Actor("tenant-j01-concurrent-conflict", "creator-j01-concurrent-conflict");
        InMemoryProjectTimelineStore store = new InMemoryProjectTimelineStore();
        AtomicInteger ids = new AtomicInteger();
        ProjectTimelineEngine engine = new ProjectTimelineEngine(
                store, () -> "j01-concurrent-conflict-id-" + ids.incrementAndGet());
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);

        try (ExecutorService workers = Executors.newFixedThreadPool(2)) {
            Future<Attempt> first = workers.submit(() -> createAfterStart(
                    engine, actor, "First cut", ready, start));
            Future<Attempt> second = workers.submit(() -> createAfterStart(
                    engine, actor, "Second cut", ready, start));

            ready.await();
            start.countDown();
            List<Attempt> attempts = List.of(first.get(), second.get());
            List<Created> created = attempts.stream().map(Attempt::created)
                    .filter(result -> result != null).toList();
            List<Boolean> conflicts = attempts.stream().map(Attempt::conflict).toList();

            assertThat(created).hasSize(1);
            assertThat(conflicts).containsExactlyInAnyOrder(false, true);

            Created winner = created.getFirst();
            assertThat(winner.createdNow()).isTrue();
            assertThat(winner.project().title()).isIn("First cut", "Second cut");
            assertThat(winner.project().headRevisionId()).isEqualTo(winner.initialRevision().revisionId());
            assertThat(winner.initialRevision().graph().scenes()).isEmpty();

            Created replay = engine.createProject(actor, winner.project().workspaceId(),
                    winner.project().title(), "j01-concurrent-conflict-request");
            assertThat(replay.createdNow()).isFalse();
            assertThat(replay.project()).isEqualTo(winner.project());
            assertThat(replay.initialRevision()).isEqualTo(winner.initialRevision());
            assertThat(store.project(actor, winner.project().projectId()).headRevisionId())
                    .isEqualTo(winner.initialRevision().revisionId());
        }
    }

    private static Attempt createAfterStart(ProjectTimelineEngine engine, Actor actor, String title,
                                            CountDownLatch ready, CountDownLatch start) throws Exception {
        ready.countDown();
        start.await();
        try {
            return new Attempt(engine.createProject(actor, "workspace-j01-concurrent-conflict", title,
                    "j01-concurrent-conflict-request"), false);
        } catch (com.ghatana.media.runtime.MediaProjectTimelineContracts.IdempotencyConflictException conflict) {
            return new Attempt(null, true);
        }
    }

    private record Attempt(Created created, boolean conflict) { }
}
