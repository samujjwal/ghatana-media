package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRightsConsentAuthority;
import com.ghatana.media.runtime.MediaRightsConsentContracts.AssurancePolicy;
import com.ghatana.media.runtime.MediaRightsConsentContracts.AttestationStore;
import com.ghatana.media.runtime.MediaRightsConsentContracts.AttestationStoreFactory;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Clock;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.ServiceLoader;
import java.util.Set;
import java.util.function.Supplier;

/**
 * Canonical (non-DEV) composition of the rights and consent authority (owner decision, 2026-11-14: the uploader
 * states rights and consent for each source version, a second person confirms before any voice or likeness use or
 * external delivery, every statement records who/when/which exact file and can be revoked).
 *
 * <p><b>Selection.</b> {@code MEDIA_RIGHTS_AUTHORITY=postgresql} selects the production-capable PostgreSQL
 * attestation store over the canonical runtime datasource. In production-like profiles an unset selector is not a
 * way to skip the gate: the canonically selected source-authorization authority is wrapped with an unavailable
 * resolver, so every admission is UNAVAILABLE ({@code RIGHTS_AUTHORITY_UNAVAILABLE}). Non-production profiles
 * without the selector keep the previous behaviour (no attestation gate); the DEV lane composes its own.</p>
 *
 * <p><b>Gating.</b> The selected authority is wrapped with
 * {@link MediaRightsConsentAuthority#gate(MediaSourceAuthorizationContracts.Authority, RightsConsentResolver,
 * java.util.function.Function)}. The delegate's Shared-policy evidence is returned unchanged, only when the
 * resolver ADMITS the exact artifact version and digest; evidence is never synthesised here. Scope mapping:
 * {@link Scope#PROCESSING} for speech-to-text, vision, multimodal and analysis jobs on a source version;
 * {@link Scope#VOICE_OR_LIKENESS_USE} for any job whose parameters carry a voice or likeness reference;
 * {@link Scope#EXTERNAL_DELIVERY} for delivery, export or publish operations.</p>
 *
 * <p><b>Identity.</b> {@link #administration} builds the statement-recording authority with an
 * {@link AssurancePolicy} derived from the profile: production-like profiles accept an OIDC verified principal
 * only; DEV-issued and other identities may give, confirm or revoke statements only in non-production profiles.
 * No canonical HTTP route exposes it yet (the canonical route manifest and OpenAPI are PDP-owned); the existing
 * routes stay DEV_ONLY.</p>
 *
 * @doc.type class
 * @doc.purpose Canonical composition and scope mapping of the rights and consent authority
 * @doc.layer product
 * @doc.pattern Composition
 */
final class MediaRightsConsentComposition {
    static final String SELECTOR = "MEDIA_RIGHTS_AUTHORITY";
    static final String POSTGRESQL = "postgresql";

    private static final Logger log = LoggerFactory.getLogger(MediaRightsConsentComposition.class);
    /** Parameter names that carry a voice or likeness reference; their presence selects VOICE_OR_LIKENESS_USE. */
    static final Set<String> VOICE_OR_LIKENESS_PARAMETERS = Set.of(
            "voiceReference", "voiceReferenceArtifactId", "voiceSampleArtifactId", "referenceAudioArtifactId",
            "voiceCloneReference", "speakerReference", "likenessReference", "likenessArtifactId",
            "faceReferenceArtifactId", "referenceImageArtifactId");

    private static final ThreadLocal<Boolean> VOICE_OR_LIKENESS = new ThreadLocal<>();

    private MediaRightsConsentComposition() { }

    /** The composed authority and, when a durable store was selected, the statement-recording authority over it. */
    record Composed(MediaSourceAuthorizationContracts.Authority authority,
                    Optional<MediaRightsConsentAuthority> administration) { }

    /** Wraps {@code selected} (null stays null: no source authority means nothing to gate). */
    static Composed compose(MediaSourceAuthorizationContracts.Authority selected, Map<String, String> environment,
                            boolean productionLike, Clock clock) {
        if (selected == null) return new Composed(null, Optional.empty());
        String mode = environment.getOrDefault(SELECTOR, "").trim().toLowerCase(Locale.ROOT);
        if (mode.isEmpty()) {
            if (!productionLike) return new Composed(selected, Optional.empty());
            return new Composed(new Gated(selected, RightsConsentResolver.unavailable(), null), Optional.empty());
        }
        if (!POSTGRESQL.equals(mode)) {
            throw new IllegalArgumentException(SELECTOR + " must be unset or '" + POSTGRESQL + "'");
        }
        String profile = environment.getOrDefault("MEDIA_RUNTIME_ENVIRONMENT",
                environment.getOrDefault("MEDIA_PROFILE", ""));
        AttestationStore store = openStore(environment);
        if (store == null) {
            return new Composed(new Gated(selected, RightsConsentResolver.unavailable(), null), Optional.empty());
        }
        return composeWithStore(selected, store, profile, clock);
    }

    /** Gates {@code selected} with the resolver over an already opened store (owned by the result). */
    static Composed composeWithStore(MediaSourceAuthorizationContracts.Authority selected, AttestationStore store,
                                     String profile, Clock clock) {
        MediaRightsConsentAuthority administration = administration(store, clock, profile);
        return new Composed(new Gated(selected, administration, store), Optional.of(administration));
    }

    /** Statement-recording authority whose accepted identity assurance follows the profile. */
    static MediaRightsConsentAuthority administration(AttestationStore store, Clock clock, String profile) {
        return new MediaRightsConsentAuthority(store, clock, AssurancePolicy.forProfile(profile));
    }

    /** Null when no usable factory/store can be created: the caller then fails closed. */
    private static AttestationStore openStore(Map<String, String> environment) {
        List<AttestationStoreFactory> factories = ServiceLoader.load(AttestationStoreFactory.class).stream()
                .map(ServiceLoader.Provider::get)
                .filter(factory -> POSTGRESQL.equals(factory.factoryId()))
                .toList();
        if (factories.size() != 1) {
            log.error("MEDIA_RIGHTS_AUTHORITY_UNAVAILABLE reason=expected-exactly-one-factory found={}",
                    factories.size());
            return null;
        }
        try {
            return factories.getFirst().createCanonical(Map.copyOf(environment));
        } catch (RuntimeException failure) {
            log.error("MEDIA_RIGHTS_AUTHORITY_UNAVAILABLE reason=store-creation-failed failureType={}",
                    failure.getClass().getSimpleName());
            return null;
        }
    }

    /** Scope for one source-authorization request; the voice or likeness hint is set around the call. */
    static Scope scopeFor(MediaSourceAuthorizationContracts.Request request) {
        if (Boolean.TRUE.equals(VOICE_OR_LIKENESS.get())) return Scope.VOICE_OR_LIKENESS_USE;
        String operation = request.operation().toLowerCase(Locale.ROOT);
        if (operation.matches(".*(deliver|export|publish).*")) return Scope.EXTERNAL_DELIVERY;
        return Scope.PROCESSING;
    }

    static boolean referencesVoiceOrLikeness(Map<String, Object> parameters) {
        if (parameters == null) return false;
        for (String name : VOICE_OR_LIKENESS_PARAMETERS) {
            Object value = parameters.get(name);
            if (value != null && !(value instanceof CharSequence text && text.toString().isBlank())) return true;
        }
        return false;
    }

    /** Runs {@code call} so that an authority consulted inside it maps the request to the right scope. */
    static <T> T withJobParameters(Map<String, Object> parameters, Supplier<T> call) {
        Boolean previous = VOICE_OR_LIKENESS.get();
        VOICE_OR_LIKENESS.set(referencesVoiceOrLikeness(parameters));
        try {
            return call.get();
        } finally {
            if (previous == null) VOICE_OR_LIKENESS.remove();
            else VOICE_OR_LIKENESS.set(previous);
        }
    }

    /** The gated authority; closing it also closes the attestation store it owns. */
    private static final class Gated implements MediaSourceAuthorizationContracts.Authority {
        private final MediaSourceAuthorizationContracts.Authority gated;
        private final AttestationStore store;

        Gated(MediaSourceAuthorizationContracts.Authority delegate, RightsConsentResolver resolver,
              AttestationStore store) {
            this.gated = MediaRightsConsentAuthority.gate(delegate, resolver,
                    MediaRightsConsentComposition::scopeFor);
            this.store = store;
        }

        @Override public String authorityId() { return gated.authorityId(); }
        @Override public boolean ready() { return gated.ready(); }
        @Override public boolean productionEligible() { return gated.productionEligible(); }

        @Override public MediaSourceAuthorizationContracts.Decision resolve(
                MediaSourceAuthorizationContracts.Request request, AuthenticatedPrincipal authenticated) {
            return gated.resolve(request, authenticated);
        }

        @Override public MediaSourceAuthorizationContracts.Decision revalidate(
                MediaSourceAuthorizationContracts.Request request,
                MediaSourceAuthorizationContracts.Evidence expected, AuthenticatedPrincipal authenticated) {
            return gated.revalidate(request, expected, authenticated);
        }

        @Override public void close() {
            RuntimeException failure = null;
            try { gated.close(); } catch (RuntimeException closeFailure) { failure = closeFailure; }
            if (store != null) {
                try { store.close(); }
                catch (Exception closeFailure) {
                    if (failure == null) failure = new IllegalStateException("rights store close failed", closeFailure);
                    else failure.addSuppressed(closeFailure);
                }
            }
            if (failure != null) throw failure;
        }
    }
}
