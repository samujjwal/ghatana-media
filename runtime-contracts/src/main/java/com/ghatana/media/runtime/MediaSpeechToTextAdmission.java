package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;

/**
 * Fail-closed admission decision for the source-version-bound STT path.
 *
 * <p>Positive admission is conditional on a server-owned, verified profile, immutable artifact,
 * current source rights and consent, source-clock proof and production-eligible transcript store.
 * Missing any such source remains NOT_ADMITTED. Provider metadata, environment variables or
 * request fields alone never constitute authority. The current Media runtime still has no
 * production rights resolver or admitted transcript store, so it remains fail-closed.</p>
 */
public final class MediaSpeechToTextAdmission {
    private MediaSpeechToTextAdmission() { }

    public enum Disposition { ADMITTED, NOT_ADMITTED }

    public enum Reason {
        EXACT_SOURCE_VERSION_REQUIRED,
        SOURCE_VERSION_STALE_OR_NOT_FOUND,
        SOURCE_SCOPE_DENIED,
        PROFILE_ABSENT,
        PROFILE_NOT_QUALIFIED,
        PROFILE_IDENTITY_MISMATCH,
        LANGUAGE_INTENT_REQUIRED,
        LANGUAGE_TAG_REQUIRED,
        LANGUAGE_UNSUPPORTED,
        LANGUAGE_SUPPORT_UNVERIFIED,
        TIMING_NOT_QUALIFIED,
        SOURCE_CLOCK_NOT_QUALIFIED,
        CONSENT_NOT_ADMITTED,
        RIGHTS_AUTHORITY_UNAVAILABLE,
        TRANSCRIPT_VERSION_STORE_NOT_ADMITTED
    }

    public enum LanguageMode { EXPLICIT, AUTO_REQUESTED }

    public enum ProfileQualification { NOT_QUALIFIED, QUALIFIED }

    public enum TimingDisposition { NOT_SUPPLIED, PROVIDER_TIME_UNQUALIFIED, SOURCE_CLOCK_BOUND }

    /** Request fields are parsed from trusted runtime input; caller identity is not included. */
    public record Request(
            String expectedArtifactVersion,
            String profileId,
            String profileVersion,
            String profileConfigurationDigest,
            LanguageMode languageMode,
            String languageTag) {
        public Request {
            expectedArtifactVersion = optional(expectedArtifactVersion);
            profileId = optional(profileId);
            profileVersion = optional(profileVersion);
            profileConfigurationDigest = optional(profileConfigurationDigest);
            languageTag = optional(languageTag);
        }
    }

    /** Candidate profile facts supplied by a server-owned provider adapter. */
    public record Profile(
            String providerId,
            String providerVersion,
            String profileId,
            String profileVersion,
            String configurationDigest,
            ProfileQualification qualification,
            Set<String> supportedLanguageTags,
            boolean autoDetectionQualified,
            TimingDisposition timingDisposition,
            String qualificationEvidenceRef) {
        public Profile {
            providerId = required(providerId, "providerId");
            providerVersion = required(providerVersion, "providerVersion");
            profileId = required(profileId, "profileId");
            profileVersion = required(profileVersion, "profileVersion");
            configurationDigest = required(configurationDigest, "configurationDigest");
            if (!configurationDigest.matches("sha256:[a-f0-9]{64}")) {
                throw new IllegalArgumentException("configurationDigest must be sha256:<lowercase hex>");
            }
            qualification = Objects.requireNonNull(qualification, "qualification");
            supportedLanguageTags = Set.copyOf(supportedLanguageTags == null ? Set.of() : supportedLanguageTags);
            timingDisposition = Objects.requireNonNull(timingDisposition, "timingDisposition");
            qualificationEvidenceRef = optional(qualificationEvidenceRef);
            if (qualification == ProfileQualification.QUALIFIED && qualificationEvidenceRef.isBlank()) {
                throw new IllegalArgumentException("qualified speech profile requires qualification evidence");
            }
        }
    }

    public record Decision(Disposition disposition, List<Reason> reasons) {
        public Decision {
            disposition = Objects.requireNonNull(disposition, "disposition");
            reasons = List.copyOf(reasons == null ? List.of() : reasons);
            if (disposition == Disposition.NOT_ADMITTED && reasons.isEmpty()) {
                throw new IllegalArgumentException("NOT_ADMITTED requires at least one reason");
            }
            if (disposition == Disposition.ADMITTED && !reasons.isEmpty()) {
                throw new IllegalArgumentException("ADMITTED cannot contain rejection reasons");
            }
        }
    }

    /** Typed, inspectable refusal that is raised before a job or provider effect exists. */
    public static final class NotAdmittedException extends MediaCapabilityNotAdmittedException {
        private static final long serialVersionUID = 1L;
        private final Decision decision;

        public NotAdmittedException(Decision decision) {
            super(Reason.NOT_ADMITTED, "SPEECH_TO_TEXT",
                    "Speech-to-text request is NOT_ADMITTED: "
                            + Objects.requireNonNull(decision, "decision").reasons());
            if (decision.disposition() != Disposition.NOT_ADMITTED) {
                throw new IllegalArgumentException("NotAdmittedException requires a refused decision");
            }
            this.decision = decision;
        }

        public Decision decision() { return decision; }
    }

    /**
     * Reports blockers from source facts without allowing caller-supplied fields to create
     * qualification. Rights and transcript persistence are explicit external/runtime gates.
     */
    public static Decision evaluate(
            Request request,
            MediaArtifact artifact,
            Profile profile,
            boolean consentVerified,
            boolean rightsAuthorityAvailable,
            boolean exactSourceClockMetadataAvailable) {
        // The legacy entrypoint has no authority to prove a production transcript store.
        // Preserve its historical fail-closed contract even if all other flags are true.
        return evaluate(request, artifact, profile, consentVerified,
                rightsAuthorityAvailable, exactSourceClockMetadataAvailable, false);
    }

    /**
     * Only the server-owned runtime composition may supply a truthful store-admission fact.
     * The admission method itself performs no provider, database or remote effects.
     * Before using ADMITTED, the runtime must revalidate source ownership, revocation,
     * policy version and exact store availability at dispatch time.
     */
    public static Decision evaluate(
            Request request,
            MediaArtifact artifact,
            Profile profile,
            boolean consentVerified,
            boolean rightsAuthorityAvailable,
            boolean exactSourceClockMetadataAvailable,
            boolean transcriptVersionStoreReady) {
        Objects.requireNonNull(request, "request");
        List<Reason> reasons = new ArrayList<>();
        if (request.expectedArtifactVersion().isBlank()) {
            reasons.add(Reason.EXACT_SOURCE_VERSION_REQUIRED);
        } else if (artifact == null
                || !request.expectedArtifactVersion().equals(artifact.version().value())) {
            reasons.add(Reason.SOURCE_VERSION_STALE_OR_NOT_FOUND);
        }

        if (artifact != null && !request.expectedArtifactVersion().isBlank()
                && !request.expectedArtifactVersion().equals(artifact.version().value())) {
            reasons.add(Reason.SOURCE_VERSION_STALE_OR_NOT_FOUND);
        }
        if (profile == null) {
            reasons.add(Reason.PROFILE_ABSENT);
        } else {
            if (profile.qualification() != ProfileQualification.QUALIFIED
                    || profile.qualificationEvidenceRef().isBlank()) {
                reasons.add(Reason.PROFILE_NOT_QUALIFIED);
            }
            if (!profile.profileId().equals(request.profileId())
                    || !profile.profileVersion().equals(request.profileVersion())
                    || !profile.configurationDigest().equals(request.profileConfigurationDigest())) {
                reasons.add(Reason.PROFILE_IDENTITY_MISMATCH);
            }
        }

        if (request.languageMode() == null) {
            reasons.add(Reason.LANGUAGE_INTENT_REQUIRED);
        } else if (request.languageMode() == LanguageMode.EXPLICIT) {
            if (request.languageTag().isBlank()) {
                reasons.add(Reason.LANGUAGE_TAG_REQUIRED);
            } else if (profile == null) {
                reasons.add(Reason.LANGUAGE_SUPPORT_UNVERIFIED);
            } else if (profile.qualification() != ProfileQualification.QUALIFIED) {
                reasons.add(Reason.LANGUAGE_SUPPORT_UNVERIFIED);
            } else if (profile.supportedLanguageTags().stream()
                    .map(tag -> tag.toLowerCase(Locale.ROOT))
                    .noneMatch(tag -> tag.equals(request.languageTag().toLowerCase(Locale.ROOT)))) {
                reasons.add(Reason.LANGUAGE_UNSUPPORTED);
            }
        } else if (profile == null || profile.qualification() != ProfileQualification.QUALIFIED
                || !profile.autoDetectionQualified()) {
            reasons.add(Reason.LANGUAGE_SUPPORT_UNVERIFIED);
        }

        if (profile == null || profile.qualification() != ProfileQualification.QUALIFIED
                || profile.timingDisposition() == TimingDisposition.NOT_SUPPLIED) {
            reasons.add(Reason.TIMING_NOT_QUALIFIED);
        }
        if (profile == null || profile.qualification() != ProfileQualification.QUALIFIED
                || profile.timingDisposition() != TimingDisposition.SOURCE_CLOCK_BOUND
                || !exactSourceClockMetadataAvailable) {
            reasons.add(Reason.SOURCE_CLOCK_NOT_QUALIFIED);
        }
        if (!consentVerified) reasons.add(Reason.CONSENT_NOT_ADMITTED);
        if (!rightsAuthorityAvailable) reasons.add(Reason.RIGHTS_AUTHORITY_UNAVAILABLE);

        if (!transcriptVersionStoreReady) {
            reasons.add(Reason.TRANSCRIPT_VERSION_STORE_NOT_ADMITTED);
        }
        List<Reason> blockers = reasons.stream().distinct().toList();
        return blockers.isEmpty()
                ? new Decision(Disposition.ADMITTED, List.of())
                : new Decision(Disposition.NOT_ADMITTED, blockers);
    }

    private static String required(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
        return value;
    }

    private static String optional(String value) {
        return value == null ? "" : value;
    }
}
