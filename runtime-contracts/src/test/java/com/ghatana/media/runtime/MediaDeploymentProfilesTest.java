package com.ghatana.media.runtime;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** One canonical deployed-environment classification for every Media component. */
class MediaDeploymentProfilesTest {

    @Test
    void deployedProfilesAreProductionLike() {
        for (String profile : new String[] {
                "prod", "production", "staging", "sovereign", "integration", "e2e"}) {
            assertThat(MediaDeploymentProfiles.productionLike(profile))
                    .as(profile + " is production-like").isTrue();
        }
    }

    @Test
    void developmentProfilesAndUnknownNamesAreNotProductionLike() {
        for (String profile : new String[] {
                "local", "dev", "development", "test", "ci", "", "unknown", "prodution"}) {
            assertThat(MediaDeploymentProfiles.productionLike(profile))
                    .as(profile + " is not production-like").isFalse();
        }
    }

    @Test
    void canonicalizationIsNullSafeAndCaseInsensitive() {
        assertThat(MediaDeploymentProfiles.productionLike(null)).isFalse();
        assertThat(MediaDeploymentProfiles.productionLike(" PRODUCTION ")).isTrue();
        assertThat(MediaDeploymentProfiles.productionLike("Staging")).isTrue();
        assertThat(MediaDeploymentProfiles.canonical(null)).isEmpty();
    }
}
