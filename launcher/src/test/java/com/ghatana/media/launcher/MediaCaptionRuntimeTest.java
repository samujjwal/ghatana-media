package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaCaptionContracts.CaptionSegment;
import com.ghatana.media.runtime.MediaCaptionContracts.LanguageDisposition;
import com.ghatana.media.runtime.MediaCaptionContracts.MediaCaptionStore;
import com.ghatana.media.runtime.MediaCaptionContracts.ParentClockLookup;
import com.ghatana.media.runtime.MediaCaptionContracts.ParentVersionKind;
import com.ghatana.media.runtime.MediaCaptionContracts.Registered;
import com.ghatana.media.runtime.MediaCaptionContracts.RegistrationAuthority;
import com.ghatana.media.runtime.MediaCaptionContracts.RegistrationError;
import com.ghatana.media.runtime.MediaCaptionContracts.RegistrationRequest;
import com.ghatana.media.runtime.MediaCaptionContracts.RegistrationResult;
import com.ghatana.media.runtime.MediaCaptionContracts.Rejected;
import com.ghatana.media.runtime.MediaCaptionContracts.SegmentOrigin;
import com.ghatana.media.runtime.MediaSourceRightsAdministration;
import com.ghatana.media.runtime.MediaSourceRightsAdministration.SourceRecord;
import com.ghatana.media.runtime.MediaTranscriptContracts.MediaTranscriptStore;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDraft;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptSegment;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptSegmentTiming;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** Registration authority, parent-clock and runtime wiring coverage for caption versions. */
class MediaCaptionRuntimeTest {

    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-10-30T12:00:00Z"), ZoneOffset.UTC);

    private static SourceRecord record(String version, String principal, boolean revoked, boolean expired,
                                       java.util.Set<String> operations) {
        return new SourceRecord("tenant-1", "artifact-1", version, "a".repeat(64), principal, principal,
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                "", operations, Set.of("captions"), Set.of("local"),
                Set.of(com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.NONE),
                "clock-evidence", "provenance", principal, Instant.parse("2026-10-29T00:00:00Z"),
                expired ? Instant.parse("2026-10-30T00:00:00Z") : Instant.parse("2027-01-01T00:00:00Z"),
                1, revoked ? Instant.parse("2026-10-30T01:00:00Z") : null);
    }

    private static MediaSourceRightsAdministration rights(List<SourceRecord> records) {
        return new MediaSourceRightsAdministration() {
            @Override public String administrationId() { return "test-rights"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return true; }
            @Override public SourceRecord register(RegisterRequest request,
                    com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated) {
                throw new UnsupportedOperationException();
            }
            @Override public Optional<SourceRecord> record(String tenantId, String artifactId, String sourceVersion) {
                return records.stream().filter(r -> r.sourceVersion().equals(sourceVersion)).findFirst();
            }
            @Override public List<SourceRecord> currentRecords(String tenantId, String artifactId) { return records; }
            @Override public Optional<SourceRecord> revoke(String tenantId, String artifactId, String sourceVersion,
                    com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated,
                    String correlationId) { return Optional.empty(); }
        };
    }

    private static RegistrationRequest request(String id, ParentVersionKind kind, String parent) {
        return new RegistrationRequest(id, "artifact-1", "sha256:" + "a".repeat(64), kind, parent,
                "clock.v1", 90_000, 9_000_000, LanguageDisposition.DECLARED_BY_USER, Optional.of("en"),
                List.of(CaptionSegment.of("seg-1", "hi", 10, 900, SegmentOrigin.USER_EDITED)), Optional.empty());
    }

    @Test
    void authorityAdmitsOnlyCurrentScopedRecordWithOperation() {
        var admitted = new MediaCaptionRegistrationAuthority(
                rights(List.of(record("sha256:" + "a".repeat(64), "principal-1", false, false,
                        Set.of("caption_version_write")))), CLOCK);
        var check = new RegistrationAuthority.AuthorityCheck("tenant-1", "principal-1", "artifact-1",
                "sha256:" + "a".repeat(64), ParentVersionKind.TRANSCRIPT_VERSION, "transcript-1");
        assertThat(admitted.check(check)).isEqualTo(RegistrationAuthority.Decision.ADMITTED);

        var deniedScope = new MediaCaptionRegistrationAuthority(
                rights(List.of(record("sha256:" + "a".repeat(64), "principal-1", false, false,
                        Set.of("speech_to_text")))), CLOCK);
        assertThat(deniedScope.check(check)).isEqualTo(RegistrationAuthority.Decision.DENIED);

        var deniedPrincipal = new MediaCaptionRegistrationAuthority(
                rights(List.of(record("sha256:" + "a".repeat(64), "other", false, false,
                        Set.of("caption_version_write")))), CLOCK);
        assertThat(deniedPrincipal.check(check)).isEqualTo(RegistrationAuthority.Decision.DENIED);

        var revoked = new MediaCaptionRegistrationAuthority(
                rights(List.of(record("sha256:" + "a".repeat(64), "principal-1", true, false,
                        Set.of("caption_version_write")))), CLOCK);
        assertThat(revoked.check(check)).isEqualTo(RegistrationAuthority.Decision.DENIED);

        var staleVersion = new MediaCaptionRegistrationAuthority(
                rights(List.of(record("sha256:" + "b".repeat(64), "principal-1", false, false,
                        Set.of("caption_version_write")))), CLOCK);
        assertThat(staleVersion.check(check)).isEqualTo(RegistrationAuthority.Decision.DENIED);

        var unavailable = new MediaCaptionRegistrationAuthority(new MediaSourceRightsAdministration() {
            @Override public String administrationId() { return "down"; }
            @Override public boolean ready() { return false; }
            @Override public boolean productionEligible() { return false; }
            @Override public SourceRecord register(RegisterRequest r,
                    com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal a) {
                throw new UnsupportedOperationException();
            }
            @Override public Optional<SourceRecord> record(String t, String a, String v) { return Optional.empty(); }
            @Override public Optional<SourceRecord> revoke(String t, String a, String v,
                    com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal au,
                    String c) { return Optional.empty(); }
        }, CLOCK);
        assertThat(unavailable.check(check)).isEqualTo(RegistrationAuthority.Decision.UNAVAILABLE);
    }

    @Test
    void transcriptParentClockRequiresSourceClockBoundLatestRevisionInScope() {
        MediaTranscriptStore transcripts = new MediaTranscriptStore() {
            @Override public TranscriptRevision append(TranscriptDraft draft) { throw new UnsupportedOperationException(); }
            @Override public List<TranscriptRevision> revisions(String t, String i) { return List.of(); }
            @Override public List<TranscriptRevision> revisions(String t, String p, String i) {
                if (!"transcript-1".equals(i)) return List.of();
                var draft = new TranscriptDraft(t, p, i, "artifact-1", "sha256:" + "a".repeat(64), "a".repeat(64),
                        "job-1", "profile-1", "provider-1", "model-1", "en", "SOURCE_TICKS", "hello",
                        "consent-1", "rights-1", "policy-1", "purpose-1", "captions",
                        List.of(new TranscriptSegment("s1", "hello", "RECOGNIZED",
                                TranscriptSegmentTiming.sourceTicks(10, 900, "clock.v1", 90_000, 9_000_000))));
                return List.of(new TranscriptRevision(draft, 1, 0, "ADMITTED"));
            }
            @Override public boolean productionEligible() { return true; }
            @Override public boolean ready() { return true; }
            @Override public void close() { }
        };
        var lookup = new MediaCaptionParentClockLookup("tenant-1", "principal-1", transcripts,
                new MediaCaptionRuntimeTest.FakeCaptionStore());
        var facts = lookup.resolve(ParentVersionKind.TRANSCRIPT_VERSION, "transcript-1",
                "artifact-1", "sha256:" + "a".repeat(64));
        assertThat(facts).isPresent();
        assertThat(facts.get().sourceClockId()).isEqualTo("clock.v1");
        assertThat(facts.get().ticksPerSecond()).isEqualTo(90_000);
        assertThat(lookup.resolve(ParentVersionKind.TRANSCRIPT_VERSION, "transcript-1",
                "artifact-1", "sha256:" + "b".repeat(64))).isEmpty();
        assertThat(lookup.resolve(ParentVersionKind.TRANSCRIPT_VERSION, "missing",
                "artifact-1", "sha256:" + "a".repeat(64))).isEmpty();
    }

    @Test
    void captionVersionParentClockReadsOwnStoreAndRegistrationPassesThrough() {
        var store = new FakeCaptionStore();
        var runtime = new MediaCaptionRuntime(store,
                rights(List.of(record("sha256:" + "a".repeat(64), "principal-1", false, false,
                        Set.of("caption_version_write")))), null, CLOCK);
        RegistrationResult result = runtime.register("tenant-1", "principal-1",
                request("req-1", ParentVersionKind.CAPTION_VERSION, "capv-parent"));
        assertThat(result).isInstanceOf(Registered.class);
        assertThat(store.lastLookup).isNotNull();
        assertThat(store.lastLookup.kind).isEqualTo(ParentVersionKind.CAPTION_VERSION);
        assertThat(store.lastAuthority).isNotNull();
    }

    @Test
    void rejectedOutcomesPropagateTypedErrors() {
        var store = new FakeCaptionStore();
        store.next = new Rejected("req-9", "f".repeat(64), RegistrationError.IDEMPOTENCY_CONFLICT, false);
        var runtime = new MediaCaptionRuntime(store,
                rights(List.of(record("sha256:" + "a".repeat(64), "principal-1", false, false,
                        Set.of("caption_version_write")))), null, CLOCK);
        RegistrationResult result = runtime.register("tenant-1", "principal-1",
                request("req-9", ParentVersionKind.CAPTION_VERSION, "capv-parent"));
        assertThat(((Rejected) result).error()).isEqualTo(RegistrationError.IDEMPOTENCY_CONFLICT);
    }

    static final class FakeCaptionStore implements MediaCaptionStore {
        RegistrationResult next = new Registered("req-1", "f".repeat(64), "capv-1", "capreg-1",
                "artifact-1", "sha256:" + "a".repeat(64), ParentVersionKind.CAPTION_VERSION,
                "capv-parent", LanguageDisposition.DECLARED_BY_USER, "clock.v1", 1);
        RegistrationAuthority.AuthorityCheck lastAuthority;
        LookupCall lastLookup;
        List<Registered> stored = new ArrayList<>();

        record LookupCall(ParentVersionKind kind, String parentId, String sourceId, String versionId) { }

        @Override public RegistrationResult register(String t, String p, RegistrationRequest request,
                RegistrationAuthority authority, ParentClockLookup parentLookup) {
            lastAuthority = new RegistrationAuthority.AuthorityCheck(t, p, request.sourceArtifactId(),
                    request.sourceArtifactVersionId(), request.parentVersionKind(), request.parentVersionId());
            var facts = parentLookup.resolve(request.parentVersionKind(), request.parentVersionId(),
                    request.sourceArtifactId(), request.sourceArtifactVersionId());
            if (facts.isEmpty()) {
                return new Rejected(request.requestId(), null, RegistrationError.SOURCE_NOT_READY, true);
            }
            return next;
        }
        @Override public List<Registered> versions(String t, String p, String a, String v) { return stored; }
        @Override public Optional<ParentClockLookup.ParentFacts> parentClock(String t, String p,
                String captionVersionId, String sourceArtifactId, String sourceArtifactVersionId) {
            lastLookup = new LookupCall(ParentVersionKind.CAPTION_VERSION, captionVersionId,
                    sourceArtifactId, sourceArtifactVersionId);
            return Optional.of(new ParentClockLookup.ParentFacts("clock.v1", 90_000, 9_000_000));
        }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return true; }
        @Override public void close() { }
    }
}
