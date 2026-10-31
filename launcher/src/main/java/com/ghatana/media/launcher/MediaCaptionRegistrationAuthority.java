package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaCaptionContracts.RegistrationAuthority;
import com.ghatana.media.runtime.MediaSourceRightsAdministration;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/**
 * {@link RegistrationAuthority} backed by the canonical Media source-rights records.
 *
 * <p>Admission requires exactly one current registered source record for the requested
 * immutable source version whose registered principal equals the authenticated caller and
 * whose declared operation scope contains {@value #OPERATION_TOKEN}. A missing, revoked,
 * expired, ambiguous, or out-of-scope record denies; an unreadable or unready rights
 * administration reports {@link Decision#UNAVAILABLE}. Caller-supplied request fields are
 * lookup inputs only — the registered record is the authority.</p>
 */
final class MediaCaptionRegistrationAuthority implements RegistrationAuthority {
    /** Canonical registered operation-scope token for caption-version writes. */
    static final String OPERATION_TOKEN = "caption_version_write";

    private final MediaSourceRightsAdministration administration;
    private final Clock clock;

    MediaCaptionRegistrationAuthority(MediaSourceRightsAdministration administration, Clock clock) {
        this.administration = Objects.requireNonNull(administration, "administration");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    @Override
    public Decision check(AuthorityCheck check) {
        Objects.requireNonNull(check, "check");
        List<MediaSourceRightsAdministration.SourceRecord> records;
        try {
            if (!administration.ready()) return Decision.UNAVAILABLE;
            records = administration.currentRecords(check.tenantId(), check.sourceArtifactId());
        } catch (RuntimeException unavailable) {
            return Decision.UNAVAILABLE;
        }
        if (records == null || records.isEmpty()) return Decision.DENIED;
        List<MediaSourceRightsAdministration.SourceRecord> matching = new ArrayList<>();
        Instant now = clock.instant();
        for (MediaSourceRightsAdministration.SourceRecord record : records) {
            if (check.sourceArtifactVersionId().equals(record.sourceVersion())
                    && !record.revoked() && !record.expiredAt(now)) {
                matching.add(record);
            }
        }
        // Zero current records for the requested version covers absent, revoked and expired;
        // more than one is ambiguous and fails closed rather than silently selecting one.
        if (matching.isEmpty()) return Decision.DENIED;
        if (matching.size() > 1) return Decision.UNAVAILABLE;
        MediaSourceRightsAdministration.SourceRecord record = matching.get(0);
        if (!record.principalId().equals(check.principalId())
                || !record.allowedOperations().contains(OPERATION_TOKEN)) {
            return Decision.DENIED;
        }
        return Decision.ADMITTED;
    }
}
