package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import com.ghatana.media.runtime.MediaVerifiedIdentityContracts.AssuranceSource;
import com.ghatana.media.runtime.MediaVerifiedIdentityContracts.VerifiedIdentity;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaVerifiedIdentityContractsTest {
    private static final Instant NOW = Instant.parse("2026-11-14T10:00:00Z");

    @Test
    void oidcPrincipalIsIssuerQualifiedBoundedAndStable() {
        String a = MediaVerifiedIdentityContracts.oidcPrincipalId("https://idp-a.example", "sub-1");
        assertThat(a).isEqualTo(MediaVerifiedIdentityContracts.oidcPrincipalId("https://idp-a.example", "sub-1"))
                .startsWith(MediaVerifiedIdentityContracts.OIDC_PRINCIPAL_PREFIX).endsWith(":sub-1");
        assertThat(a).isNotEqualTo(MediaVerifiedIdentityContracts.oidcPrincipalId("https://idp-b.example", "sub-1"));
        assertThat(a.length()).isLessThan(512);
    }

    @Test
    void onlyOidcVerifiedIdentitiesAreIdentityProviderBacked() {
        for (AssuranceSource source : AssuranceSource.values()) {
            VerifiedIdentity identity = new VerifiedIdentity("urn:issuer", "sub", "tenant", NOW, source);
            assertThat(identity.idpVerified()).isEqualTo(source == AssuranceSource.OIDC_VERIFIED);
            assertThat(identity.toAuthenticatedPrincipal().idpVerified()).isEqualTo(source == AssuranceSource.OIDC_VERIFIED);
            assertThat(identity.toAuthenticatedPrincipal().assurance()).isEqualTo(source);
        }
        assertThat(new VerifiedIdentity("https://idp.example", "sub", "tenant", NOW, AssuranceSource.OIDC_VERIFIED)
                .principalId()).startsWith("oidc:");
        assertThat(new VerifiedIdentity("urn:dev", "dev-user", "tenant", NOW, AssuranceSource.DEV_ISSUED)
                .principalId()).isEqualTo("dev-user");
    }

    @Test
    void aBoundaryThatStatesNoAssuranceIsNeverIdentityProviderBacked() {
        AuthenticatedPrincipal legacy = new AuthenticatedPrincipal("tenant", "principal", NOW);
        assertThat(legacy.assurance()).isEqualTo(AssuranceSource.UNSPECIFIED);
        assertThat(legacy.idpVerified()).isFalse();
    }

    @Test
    void identityFieldsAreBounded() {
        assertThatThrownBy(() -> new VerifiedIdentity(" ", "sub", "tenant", NOW, AssuranceSource.OIDC_VERIFIED))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new VerifiedIdentity("iss", "a".repeat(256), "tenant", NOW, AssuranceSource.OIDC_VERIFIED))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new VerifiedIdentity("iss", "sub\n", "tenant", NOW, AssuranceSource.OIDC_VERIFIED))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
