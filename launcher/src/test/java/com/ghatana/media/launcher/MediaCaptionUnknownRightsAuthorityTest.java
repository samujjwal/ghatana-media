package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaCaptionContracts.ParentVersionKind;
import com.ghatana.media.runtime.MediaCaptionContracts.RegistrationAuthority;
import com.ghatana.media.runtime.MediaSourceRightsAdministration;
import com.ghatana.media.runtime.MediaSourceRightsAdministration.SourceRecord;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** Unknown or ambiguous source-rights state must never admit a caption write. */
class MediaCaptionUnknownRightsAuthorityTest {

    private static final String SOURCE_VERSION = "sha256:" + "a".repeat(64);
    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-11-06T12:00:00Z"), ZoneOffset.UTC);

    @Test
    void ambiguousCurrentSourceRightsRecordsAreUnavailableRatherThanAdmitted() {
        SourceRecord first = sourceRecord("principal-1");
        SourceRecord conflicting = sourceRecord("principal-2");
        var authority = new MediaCaptionRegistrationAuthority(rights(List.of(first, conflicting)), CLOCK);
        var request = new RegistrationAuthority.AuthorityCheck("tenant-1", "principal-1", "artifact-1",
                SOURCE_VERSION, ParentVersionKind.TRANSCRIPT_VERSION, "transcript:v1:exact");

        assertThat(authority.check(request)).isEqualTo(RegistrationAuthority.Decision.UNAVAILABLE);
    }

    private static SourceRecord sourceRecord(String principal) {
        return new SourceRecord("tenant-1", "artifact-1", SOURCE_VERSION, "a".repeat(64), principal,
                principal, com.ghatana.media.runtime.MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                com.ghatana.media.runtime.MediaSourceAuthorizationContracts.HumanConsentDisposition
                        .NOT_APPLICABLE_HUMAN_CONSENT,
                "", Set.of("caption_version_write"), Set.of("captions"), Set.of("local"),
                Set.of(com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention.NONE),
                "clock-evidence", "provenance", principal, Instant.parse("2026-10-29T00:00:00Z"),
                Instant.parse("2027-01-01T00:00:00Z"), 1, null);
    }

    private static MediaSourceRightsAdministration rights(List<SourceRecord> records) {
        return new MediaSourceRightsAdministration() {
            @Override public String administrationId() { return "ambiguous-test-rights"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return true; }
            @Override public SourceRecord register(RegisterRequest request,
                    com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal principal) {
                throw new UnsupportedOperationException();
            }
            @Override public Optional<SourceRecord> record(String tenantId, String artifactId, String sourceVersion) {
                return records.stream().filter(record -> record.sourceVersion().equals(sourceVersion)).findFirst();
            }
            @Override public List<SourceRecord> currentRecords(String tenantId, String artifactId) { return records; }
            @Override public Optional<SourceRecord> revoke(String tenantId, String artifactId, String sourceVersion,
                    com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal principal,
                    String correlationId) { return Optional.empty(); }
        };
    }
}
