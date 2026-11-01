package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamState;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Unit coverage for the local store's lease compare-and-set primitive. */
class MediaStreamLeaseRenewalTest {
    private static final String TOKEN_HASH = "a".repeat(64);

    @Test
    void acceptsOnlyTheExactNextSequenceAndExtendsTheLease() {
        var fixture = connectedFixture(-1, Instant.now().minus(Duration.ofHours(23)));
        Instant renewedExpiry = Instant.now().plus(Duration.ofMinutes(30));

        StreamSession renewed = fixture.store().renewLease(
                fixture.session(), TOKEN_HASH, 0, renewedExpiry);

        assertThat(renewed.leaseExpiresAt())
                .isEqualTo(renewedExpiry.truncatedTo(java.time.temporal.ChronoUnit.MILLIS));
        assertThat(renewed.lastSequence()).isEqualTo(-1);
        assertThat(renewed.version()).isEqualTo(fixture.session().version() + 1);
        assertThat(renewed.state()).isEqualTo(StreamState.CONNECTED);
        assertThat(fixture.store().find("tenant-a", "stream-a")).contains(renewed);
    }

    @Test
    void rejectsSkippedOrRepeatedSequenceStarts() {
        var fixture = connectedFixture(4, Instant.now().minus(Duration.ofMinutes(5)));

        assertThatThrownBy(() -> fixture.store().renewLease(
                fixture.session(), TOKEN_HASH, 4, Instant.now().plusSeconds(120)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("exact next sequence");
        assertThatThrownBy(() -> fixture.store().renewLease(
                fixture.session(), TOKEN_HASH, 6, Instant.now().plusSeconds(120)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("exact next sequence");
    }

    @Test
    void rejectsWrongTokenWithoutChangingStoredSession() {
        var fixture = connectedFixture(0, Instant.now().minus(Duration.ofMinutes(5)));

        assertThatThrownBy(() -> fixture.store().renewLease(
                fixture.session(), "b".repeat(64), 1, Instant.now().plusSeconds(120)))
                .isInstanceOf(SecurityException.class)
                .hasMessageContaining("Invalid media stream connection token");
        assertThat(fixture.store().find("tenant-a", "stream-a")).contains(fixture.session());
    }

    @Test
    void rejectsNonConnectedStatesExpiredLeasesTerminalFinalityAndInFlightFrames() {
        var fixture = connectedFixture(0, Instant.now().minus(Duration.ofMinutes(5)));
        Instant requestedExpiry = Instant.now().plusSeconds(120);

        assertThatThrownBy(() -> fixture.store().renewLease(
                with(fixture.session(), StreamState.DRAINING, fixture.session().leaseExpiresAt(),
                        StreamFinality.NONE, null, ""), TOKEN_HASH, 1, requestedExpiry))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Only a connected");
        assertThatThrownBy(() -> fixture.store().renewLease(
                with(fixture.session(), StreamState.CONNECTED, Instant.now().minusSeconds(1),
                        StreamFinality.NONE, null, ""), TOKEN_HASH, 1, requestedExpiry))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Expired");
        assertThatThrownBy(() -> fixture.store().renewLease(
                with(fixture.session(), StreamState.CONNECTED, fixture.session().leaseExpiresAt(),
                        StreamFinality.UNKNOWN, null, ""), TOKEN_HASH, 1, requestedExpiry))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("terminal or unresolved");
        assertThatThrownBy(() -> fixture.store().renewLease(
                with(fixture.session(), StreamState.CONNECTED, fixture.session().leaseExpiresAt(),
                        StreamFinality.NONE, 1L, "attempt-a"), TOKEN_HASH, 1, requestedExpiry))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("terminal or unresolved");
    }

    @Test
    void enforcesOneHourExtensionAndTwentyFourHourSessionHorizon() {
        var recentFixture = connectedFixture(0, Instant.now().minus(Duration.ofMinutes(5)));
        assertThatThrownBy(() -> recentFixture.store().renewLease(
                recentFixture.session(), TOKEN_HASH, 1, Instant.now().plus(Duration.ofHours(2))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("bounded horizon");

        var oldFixture = connectedFixture(
                0, Instant.now().minus(Duration.ofHours(23)).minus(Duration.ofMinutes(30)));
        assertThatThrownBy(() -> oldFixture.store().renewLease(
                oldFixture.session(), TOKEN_HASH, 1, Instant.now().plus(Duration.ofMinutes(45))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("bounded horizon");
    }

    @Test
    void persistsMillisecondNormalizedExpiryAndRejectsCandidateThatTruncatesToCurrentExpiry() {
        Instant currentExpiry = Instant.now().plus(Duration.ofMinutes(5)).truncatedTo(java.time.temporal.ChronoUnit.MILLIS);
        var fixture = connectedFixture(0, Instant.now().minus(Duration.ofMinutes(5)), currentExpiry);
        Instant subMillisecondCandidate = currentExpiry.plusSeconds(30).plusNanos(765_432);

        StreamSession renewed = fixture.store().renewLease(
                fixture.session(), TOKEN_HASH, 1, subMillisecondCandidate);

        assertThat(renewed.leaseExpiresAt())
                .isEqualTo(subMillisecondCandidate.truncatedTo(java.time.temporal.ChronoUnit.MILLIS));

        var truncatingFixture = connectedFixture(0, Instant.now().minus(Duration.ofMinutes(5)), currentExpiry);
        Instant candidateTruncatingToCurrent = currentExpiry.plusNanos(900_000);
        assertThatThrownBy(() -> truncatingFixture.store().renewLease(
                truncatingFixture.session(), TOKEN_HASH, 1, candidateTruncatingToCurrent))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("extend the current expiry");
    }

    @Test
    void concurrentRenewalsFromSameVersionAllowOnlyOneCompareAndSet() throws Exception {
        Instant currentExpiry = Instant.now().plus(Duration.ofSeconds(30));
        var fixture = connectedFixture(0, Instant.now().minus(Duration.ofMinutes(5)), currentExpiry);
        int contenderCount = 2;
        var ready = new CountDownLatch(contenderCount);
        var start = new CountDownLatch(1);
        var successes = new AtomicInteger();
        var conflicts = new AtomicInteger();
        ExecutorService executor = Executors.newFixedThreadPool(contenderCount);
        try {
            Future<?> first = executor.submit(() -> compete(
                    fixture, ready, start, successes, conflicts, Instant.now().plusSeconds(120)));
            Future<?> second = executor.submit(() -> compete(
                    fixture, ready, start, successes, conflicts, Instant.now().plusSeconds(180)));

            assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            first.get(5, TimeUnit.SECONDS);
            second.get(5, TimeUnit.SECONDS);

            assertThat(successes).hasValue(1);
            assertThat(conflicts).hasValue(1);
            assertThat(fixture.store().find("tenant-a", "stream-a").orElseThrow().version())
                    .isEqualTo(fixture.session().version() + 1);
        } finally {
            start.countDown();
            executor.shutdownNow();
        }
    }

    private static void compete(
            Fixture fixture,
            CountDownLatch ready,
            CountDownLatch start,
            AtomicInteger successes,
            AtomicInteger conflicts,
            Instant expiry) {
        ready.countDown();
        try {
            if (!start.await(5, TimeUnit.SECONDS)) throw new AssertionError("contenders did not start");
            fixture.store().renewLease(fixture.session(), TOKEN_HASH, fixture.session().lastSequence() + 1, expiry);
            successes.incrementAndGet();
        } catch (IllegalStateException expectedStaleVersion) {
            conflicts.incrementAndGet();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError("contender interrupted", interrupted);
        }
    }

    private static Fixture connectedFixture(long lastSequence, Instant createdAt) {
        Instant now = Instant.now();
        return connectedFixture(lastSequence, createdAt, now.plus(Duration.ofMinutes(5)));
    }

    private static Fixture connectedFixture(long lastSequence, Instant createdAt, Instant leaseExpiresAt) {
        Instant now = Instant.now();
        StreamSession session = new StreamSession(
                "tenant-a", "stream-a", "principal-a", StreamKind.AUDIO, "provider-a",
                StreamState.CONNECTED, lastSequence, 0, 128, 0,
                leaseExpiresAt, createdAt, now, null, Map.of(), 1,
                TOKEN_HASH, 0, StreamFinality.NONE, null, "");
        var store = new LocalMediaRuntimeSupport.StreamStore();
        return new Fixture(store, store.create(session, TOKEN_HASH));
    }

    private static StreamSession with(
            StreamSession source,
            StreamState state,
            Instant expiry,
            StreamFinality finality,
            Long inFlightSequence,
            String inFlightAttemptId) {
        return new StreamSession(source.tenantId(), source.sessionId(), source.principalId(),
                source.streamKind(), source.providerId(), state, source.lastSequence(), source.bufferedBytes(),
                source.maximumBufferedBytes(), source.reconnectCount(), expiry, source.createdAt(),
                source.updatedAt(), source.closedAt(), source.metadata(), source.version(),
                source.sequenceTokenHash(), source.acknowledgementRevision(), finality,
                inFlightSequence, inFlightAttemptId);
    }

    private record Fixture(LocalMediaRuntimeSupport.StreamStore store, StreamSession session) {}
}
