package com.ghatana.media.runtime;

import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Objects;

/**
 * Per-language STT qualification registry (MED-07: English and Nepali are admitted separately).
 *
 * <p>A profile-level QUALIFIED flag says nothing about an individual language. A language is admitted
 * only by its own exact-tag, unexpired QUALIFIED entry that names the same profile id, version and
 * configuration digest as the server-owned profile and carries qualification evidence. Qualifying
 * {@code en-US} never admits {@code ne} (or {@code en-GB}); there is no prefix inheritance. The
 * registry is supplied by a trusted runtime source; the default is empty, i.e. nothing is admitted.
 * This type records qualification facts; it never creates them.</p>
 */
public final class MediaSttLanguageQualification {
    private MediaSttLanguageQualification() { }

    public enum Status { NOT_QUALIFIED, QUALIFIED }

    public record Entry(
            String languageTag, Status status, String profileId, String profileVersion,
            String configurationDigest, String evidenceRef, Instant evaluatedAt, Instant validUntil) {
        public Entry {
            languageTag = required(languageTag, "languageTag").toLowerCase(Locale.ROOT);
            status = Objects.requireNonNull(status, "status");
            profileId = required(profileId, "profileId");
            profileVersion = required(profileVersion, "profileVersion");
            configurationDigest = required(configurationDigest, "configurationDigest");
            if (!configurationDigest.matches("sha256:[a-f0-9]{64}")) {
                throw new IllegalArgumentException("configurationDigest must be sha256:<lowercase hex>");
            }
            evidenceRef = evidenceRef == null ? "" : evidenceRef;
            evaluatedAt = Objects.requireNonNull(evaluatedAt, "evaluatedAt");
            validUntil = Objects.requireNonNull(validUntil, "validUntil");
            if (!validUntil.isAfter(evaluatedAt)) {
                throw new IllegalArgumentException("validUntil must follow evaluatedAt");
            }
            if (status == Status.QUALIFIED && evidenceRef.isBlank()) {
                throw new IllegalArgumentException("a QUALIFIED language entry requires qualification evidence");
            }
        }

        boolean admits(MediaSpeechToTextAdmission.Profile profile, String requestedTag, Instant now) {
            return status == Status.QUALIFIED
                    && languageTag.equals(requestedTag.toLowerCase(Locale.ROOT))
                    && profileId.equals(profile.profileId())
                    && profileVersion.equals(profile.profileVersion())
                    && configurationDigest.equals(profile.configurationDigest())
                    && !now.isBefore(evaluatedAt) && now.isBefore(validUntil);
        }
    }

    public record Registry(List<Entry> entries) {
        private static final Registry EMPTY = new Registry(List.of());

        public Registry {
            entries = List.copyOf(entries == null ? List.of() : entries);
        }

        /** Nothing qualified; every language is refused. */
        public static Registry empty() { return EMPTY; }

        public boolean admits(MediaSpeechToTextAdmission.Profile profile, String languageTag, Instant now) {
            if (profile == null || languageTag == null || languageTag.isBlank() || now == null) return false;
            return entries.stream().anyMatch(entry -> entry.admits(profile, languageTag, now));
        }
    }

    private static String required(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
        return value;
    }
}
