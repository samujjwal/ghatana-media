package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaCaptionContracts;
import com.ghatana.media.runtime.MediaCaptionContracts.CaptionSegment;
import com.ghatana.media.runtime.MediaCaptionContracts.LanguageDisposition;
import com.ghatana.media.runtime.MediaCaptionContracts.MediaCaptionStore;
import com.ghatana.media.runtime.MediaCaptionContracts.ParentClockLookup;
import com.ghatana.media.runtime.MediaCaptionContracts.ParentVersionKind;
import com.ghatana.media.runtime.MediaCaptionContracts.RegistrationAuthority;
import com.ghatana.media.runtime.MediaCaptionContracts.RegistrationRequest;
import com.ghatana.media.runtime.MediaCaptionContracts.RegistrationResult;
import com.ghatana.media.runtime.MediaCaptionContracts.Rejected;
import com.ghatana.media.runtime.MediaCaptionContracts.SegmentOrigin;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaSourceRightsAdministration;
import com.ghatana.media.runtime.MediaTranscriptContracts.MediaTranscriptStore;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDraft;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptSegment;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptSegmentTiming;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Tag;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/** J-03 source-bound unknown registration and rights-revocation recovery scenario. */
@Tag("integration")
class J03CaptionUnknownRevocationScenarioTest {
    private static final String TENANT = "tenant-j03";
    private static final String PRINCIPAL = "principal-j03";
    private static final String ARTIFACT = "audio-j03";
    private static final String SOURCE_VERSION = "sha256:" + "a".repeat(64);
    private static final String TRANSCRIPT_VERSION = "transcript:v1:exact";
    private static final String CLOCK_ID = "source-clock-v1";
    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-11-07T12:00:00Z"), ZoneOffset.UTC);

    @Test
    void unknownCaptionWriteStaysOnExactTranscriptAndRevocationBlocksRetry() {
        AtomicBoolean revoked = new AtomicBoolean();
        AtomicInteger writeCalls = new AtomicInteger();
        AtomicInteger authorizedUnknowns = new AtomicInteger();
        RecordingCaptionStore captions = new RecordingCaptionStore(writeCalls, authorizedUnknowns);
        MediaCaptionRuntime runtime = new MediaCaptionRuntime(captions, rights(revoked), transcriptStore(), CLOCK);
        RegistrationRequest request = request("j03-caption-req-1");

        RegistrationResult first = runtime.register(TENANT, PRINCIPAL, request);

        assertThat(first).isInstanceOf(Rejected.class);
        assertThat(((Rejected) first).error()).isEqualTo(MediaCaptionContracts.RegistrationError.UNKNOWN_OUTCOME);
        assertThat(((Rejected) first).requestId()).isEqualTo(request.requestId());
        assertThat(captions.lastAuthority).isEqualTo(new RegistrationAuthority.AuthorityCheck(
                TENANT, PRINCIPAL, ARTIFACT, SOURCE_VERSION, ParentVersionKind.TRANSCRIPT_VERSION,
                TRANSCRIPT_VERSION));
        assertThat(captions.lastParentFacts).isEqualTo(new ParentClockLookup.ParentFacts(CLOCK_ID, 90_000, 9_000_000));
        assertThat(writeCalls).hasValue(1);
        assertThat(authorizedUnknowns).hasValue(1);

        // An explicit same-request reconciliation/retry is checked against current rights.
        revoked.set(true);
        RegistrationResult retry = runtime.register(TENANT, PRINCIPAL, request);

        assertThat(retry).isInstanceOf(Rejected.class);
        assertThat(((Rejected) retry).error()).isEqualTo(MediaCaptionContracts.RegistrationError.ACCESS_DENIED);
        assertThat(((Rejected) retry).requestId()).isEqualTo(request.requestId());
        assertThat(writeCalls).hasValue(2);
        assertThat(authorizedUnknowns).hasValue(1);
        assertThat(captions.lastAuthority.sourceArtifactVersionId()).isEqualTo(SOURCE_VERSION);
        assertThat(captions.lastAuthority.parentVersionId()).isEqualTo(TRANSCRIPT_VERSION);
    }

    private static RegistrationRequest request(String requestId) {
        return new RegistrationRequest(requestId, ARTIFACT, SOURCE_VERSION,
                ParentVersionKind.TRANSCRIPT_VERSION, TRANSCRIPT_VERSION, CLOCK_ID, 90_000, 9_000_000,
                LanguageDisposition.DECLARED_BY_USER, Optional.of("en"),
                List.of(CaptionSegment.of("segment-1", "fixture correction", 10, 900, SegmentOrigin.USER_EDITED)),
                Optional.of("J-03 fixture scenario"));
    }

    private static MediaSourceRightsAdministration rights(AtomicBoolean revoked) {
        return new MediaSourceRightsAdministration() {
            @Override public String administrationId() { return "j03-fixture-rights"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public SourceRecord register(RegisterRequest request,
                    MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated) {
                throw new UnsupportedOperationException("fixture only");
            }
            @Override public Optional<SourceRecord> record(String tenantId, String artifactId, String sourceVersion) {
                if (!TENANT.equals(tenantId) || !ARTIFACT.equals(artifactId) || !SOURCE_VERSION.equals(sourceVersion)) {
                    return Optional.empty();
                }
                return Optional.of(new SourceRecord(TENANT, ARTIFACT, SOURCE_VERSION, "a".repeat(64), PRINCIPAL,
                        PRINCIPAL, MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                        MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                        "", Set.of("caption_version_write"), Set.of("captions"), Set.of("local"),
                        Set.of(com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.NONE),
                        "fixture-clock-evidence", "fixture-provenance", PRINCIPAL,
                        Instant.parse("2026-11-01T00:00:00Z"), Instant.parse("2026-12-01T00:00:00Z"), 1,
                        revoked.get() ? Instant.parse("2026-11-07T12:00:01Z") : null));
            }
            @Override public List<SourceRecord> currentRecords(String tenantId, String artifactId) {
                return record(tenantId, artifactId, SOURCE_VERSION).stream().toList();
            }
            @Override public Optional<SourceRecord> revoke(String tenantId, String artifactId, String sourceVersion,
                    MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated, String correlationId) {
                revoked.set(true);
                return record(tenantId, artifactId, sourceVersion);
            }
        };
    }

    private static MediaTranscriptStore transcriptStore() {
        return new MediaTranscriptStore() {
            @Override public TranscriptRevision append(TranscriptDraft draft) {
                throw new UnsupportedOperationException("fixture transcript is immutable");
            }
            @Override public List<TranscriptRevision> revisions(String tenantId, String transcriptId) {
                return List.of();
            }
            @Override public List<TranscriptRevision> revisions(String tenantId, String principalId,
                                                                 String transcriptId) {
                return List.of();
            }
            @Override public Optional<TranscriptRevision> revisionByVersionRef(String tenantId, String principalId,
                                                                                  String versionRef) {
                if (!TENANT.equals(tenantId) || !PRINCIPAL.equals(principalId)
                        || !TRANSCRIPT_VERSION.equals(versionRef)) return Optional.empty();
                TranscriptDraft draft = new TranscriptDraft(TENANT, PRINCIPAL, "transcript-j03", ARTIFACT,
                        SOURCE_VERSION, "a".repeat(64), "job-j03", "profile-fixture", "provider-fixture",
                        "model-fixture", "en", "SOURCE_TICKS", "recognized fixture text", "consent-fixture",
                        "rights-fixture", "policy-fixture", "purpose-fixture", "captions",
                        List.of(new TranscriptSegment("segment-1", "recognized fixture text", "RECOGNIZED",
                                TranscriptSegmentTiming.sourceTicks(10, 900, CLOCK_ID, 90_000, 9_000_000))));
                return Optional.of(new TranscriptRevision(draft, 1, 1, "ADMITTED"));
            }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public void close() { }
        };
    }

    private static final class RecordingCaptionStore implements MediaCaptionStore {
        private final AtomicInteger writeCalls;
        private final AtomicInteger authorizedUnknowns;
        private RegistrationAuthority.AuthorityCheck lastAuthority;
        private ParentClockLookup.ParentFacts lastParentFacts;

        private RecordingCaptionStore(AtomicInteger writeCalls, AtomicInteger authorizedUnknowns) {
            this.writeCalls = writeCalls;
            this.authorizedUnknowns = authorizedUnknowns;
        }

        @Override public RegistrationResult register(String tenantId, String principalId,
                RegistrationRequest request, RegistrationAuthority authority, ParentClockLookup parentLookup) {
            writeCalls.incrementAndGet();
            lastAuthority = new RegistrationAuthority.AuthorityCheck(tenantId, principalId,
                    request.sourceArtifactId(), request.sourceArtifactVersionId(), request.parentVersionKind(),
                    request.parentVersionId());
            RegistrationAuthority.Decision decision = authority.check(lastAuthority);
            if (decision != RegistrationAuthority.Decision.ADMITTED) {
                return new Rejected(request.requestId(), MediaCaptionContracts.fingerprint(tenantId, principalId,
                        request), MediaCaptionContracts.RegistrationError.ACCESS_DENIED, false);
            }
            Optional<ParentClockLookup.ParentFacts> facts = parentLookup.resolve(request.parentVersionKind(),
                    request.parentVersionId(), request.sourceArtifactId(), request.sourceArtifactVersionId());
            lastParentFacts = facts.orElse(null);
            if (facts.isEmpty()) {
                return new Rejected(request.requestId(), MediaCaptionContracts.fingerprint(tenantId, principalId,
                        request), MediaCaptionContracts.RegistrationError.SOURCE_NOT_READY, true);
            }
            authorizedUnknowns.incrementAndGet();
            return new Rejected(request.requestId(), MediaCaptionContracts.fingerprint(tenantId, principalId,
                    request), MediaCaptionContracts.RegistrationError.UNKNOWN_OUTCOME, true);
        }
        @Override public List<MediaCaptionContracts.Registered> versions(String t, String p, String a, String v) {
            return List.of();
        }
        @Override public Optional<MediaCaptionContracts.CaptionVersionSnapshot> version(String t, String p, String id) {
            return Optional.empty();
        }
        @Override public Optional<ParentClockLookup.ParentFacts> parentClock(String t, String p, String captionId,
                String sourceId, String sourceVersionId) { return Optional.empty(); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public void close() { }
    }
}
