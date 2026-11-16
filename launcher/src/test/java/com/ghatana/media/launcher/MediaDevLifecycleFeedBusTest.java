package com.ghatana.media.launcher;

import com.ghatana.messaging.EventEnvelope;
import com.ghatana.messaging.SimpleEventId;
import com.ghatana.media.runtime.HmacMediaLifecycleIdentifierRedactor;
import com.ghatana.media.runtime.MediaDevLifecycleFeedContracts.Entry;
import com.ghatana.media.runtime.MediaDevLifecycleFeedContracts.Feed;
import com.ghatana.media.runtime.MediaDevLifecycleFeedContracts.Page;
import com.ghatana.media.runtime.MediaLifecycleEventType;
import com.ghatana.media.runtime.MediaPublicLifecycleEvent;
import com.ghatana.messaging.util.AsyncOperations;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/** The relay's DEV_ONLY channel: legacy outbox row to public v1 event, skip rules, failure, and the one-shot crash seam. */
class MediaDevLifecycleFeedBusTest {
    private static final HmacMediaLifecycleIdentifierRedactor REDACTOR = new HmacMediaLifecycleIdentifierRedactor(new byte[32]);

    private static final class RecordingFeed implements Feed {
        final List<Entry> entries = new ArrayList<>();
        final List<String> rawAggregates = new ArrayList<>();
        boolean failing;
        @Override public boolean ready() { return true; }
        @Override public Entry append(String tenantId, String outboxEventId, String rawAggregateId, MediaPublicLifecycleEvent event) {
            if (failing) throw new IllegalStateException("feed unavailable");
            Entry entry = new Entry(entries.size() + 1, 1, event);
            entries.add(entry);
            rawAggregates.add(rawAggregateId);
            return entry;
        }
        @Override public Page read(String tenantId, long afterCursor, int limit) { return new Page(entries, afterCursor); }
        @Override public Optional<String> resolveAggregateId(String t, String a, String r) { return Optional.empty(); }
    }

    private static EventEnvelope<Map<String, Object>> envelope(String type, Map<String, Object> payload) {
        String id = UUID.randomUUID().toString();
        return new EventEnvelope<>(SimpleEventId.of(id), payload, 1_700_000_000_000L, "media-lifecycle", type,
                EventEnvelope.DEFAULT_EVENT_VERSION, "media-runtime", "tenant-a", "request-1",
                "urn:ghatana:media-lifecycle-event:v1", "principal-a", id, Map.of("subjectId", "principal-a"),
                "application/json");
    }

    private static Map<String, Object> payload(long version) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("jobId", "job-raw-1");
        payload.put("status", "COMPLETED");
        payload.put("aggregateVersion", version);
        return payload;
    }

    @Test
    void mapsAJobRowOntoTheRedactedNonFinalPublicEventAndKeepsTheRawIdOnlyServerSide() {
        RecordingFeed feed = new RecordingFeed();
        var bus = new MediaDevLifecycleFeedBus(feed, REDACTOR, null, () -> { });
        AsyncOperations.toFuture(bus.publish("media-lifecycle", envelope("MEDIA_JOB_COMPLETED", payload(3)))).join();
        MediaPublicLifecycleEvent event = feed.entries.getFirst().event();
        assertThat(event.eventType()).isEqualTo(MediaLifecycleEventType.JOB_COMPLETED);
        assertThat(event.aggregateVersion()).isEqualTo(3);
        assertThat(event.aggregateRef()).isEqualTo(REDACTOR.redact("aggregate", "job-raw-1"));
        assertThat(event.appendFinality()).isEqualTo(MediaPublicLifecycleEvent.AppendFinality.NON_FINAL_APPEND);
        assertThat(event.terminalReadbackRequired()).isTrue();
        assertThat(event.toPayload().toString()).doesNotContain("job-raw-1").doesNotContain("tenant-a")
                .doesNotContain("principal-a");
        assertThat(feed.rawAggregates).containsExactly("job-raw-1");
        // The strict v1 parser accepts exactly what the feed serves.
        assertThat(MediaPublicLifecycleEvent.fromPayload(event.toPayload())).isEqualTo(event);
    }

    @Test
    void rowsWithoutAPublicTypeOrVersionAreAcknowledgedWithoutAFeedEntry() {
        RecordingFeed feed = new RecordingFeed();
        var bus = new MediaDevLifecycleFeedBus(feed, REDACTOR, null, () -> { });
        AsyncOperations.toFuture(bus.publish("media-lifecycle", envelope("MEDIA_JOB_OUTCOME_UNKNOWN", payload(2)))).join();
        Map<String, Object> legacy = new LinkedHashMap<>(payload(1));
        legacy.remove("aggregateVersion");
        AsyncOperations.toFuture(bus.publish("media-lifecycle", envelope("MEDIA_JOB_ACCEPTED", legacy))).join();
        assertThat(feed.entries).isEmpty();
        assertThat(bus.skipped()).isEqualTo(2);
        assertThat(bus.appended()).isZero();
    }

    @Test
    void aFeedFailureFailsThePublicationSoTheRelayNeverMarksTheRowPublished() {
        RecordingFeed feed = new RecordingFeed();
        feed.failing = true;
        var bus = new MediaDevLifecycleFeedBus(feed, REDACTOR, null, () -> { });
        var result = AsyncOperations.toFuture(bus.publish("media-lifecycle", envelope("MEDIA_JOB_FAILED", payload(2))));
        assertThat(result).isCompletedExceptionally();
        assertThat(bus.appended()).isZero();
    }

    @Test
    void theCrashSeamFiresOnceAfterTheCommittedAppendAndNeverAgain(@TempDir Path dir) {
        RecordingFeed feed = new RecordingFeed();
        AtomicInteger halts = new AtomicInteger();
        Path marker = dir.resolve("fault.marker");
        var bus = new MediaDevLifecycleFeedBus(feed, REDACTOR, marker, halts::incrementAndGet);
        AsyncOperations.toFuture(bus.publish("media-lifecycle", envelope("MEDIA_JOB_COMPLETED", payload(2)))).join();
        AsyncOperations.toFuture(bus.publish("media-lifecycle", envelope("MEDIA_JOB_COMPLETED", payload(3)))).join();
        assertThat(halts).hasValue(1);
        assertThat(feed.entries).hasSize(2); // the append preceded the halt
        assertThat(Files.exists(marker)).isTrue();
    }
}
