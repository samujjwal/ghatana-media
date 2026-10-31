package com.ghatana.media.runtime;

import java.util.Locale;
import java.util.Set;

/**
 * Canonical deployment-profile classification for the Media runtime. Every component that
 * reads {@code MEDIA_RUNTIME_ENVIRONMENT} or {@code MEDIA_PROFILE} must share this one
 * authority: a profile is either production-like, in which case stores, providers, transport
 * security and credentials must fail closed with no synthetic or local fallbacks, or it is a
 * development profile. Unknown names are never treated as production-like by default, and a
 * deployment that requires a supported profile still fails at configuration parsing rather
 * than silently downgrading.
 */
public final class MediaDeploymentProfiles {
    private MediaDeploymentProfiles() { }

    /**
     * Deployed-environment profile names. {@code prod} is the accepted production alias;
     * {@code integration} and {@code e2e} are deployed environments and must satisfy the same
     * durability, transport-security and credential requirements as production.
     */
    private static final Set<String> PRODUCTION_LIKE = Set.of(
            "prod", "production", "staging", "sovereign", "integration", "e2e");

    /** Canonical profile spelling: trimmed, lower-cased, null-safe. */
    public static String canonical(String profile) {
        return profile == null ? "" : profile.trim().toLowerCase(Locale.ROOT);
    }

    /** True when the profile names a deployed environment that must fail closed. */
    public static boolean productionLike(String profile) {
        return PRODUCTION_LIKE.contains(canonical(profile));
    }
}
