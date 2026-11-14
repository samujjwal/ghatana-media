package com.ghatana.media.launcher.oidc;

import com.ghatana.media.launcher.oidc.OidcTestSupport.FakeIdp;
import com.ghatana.media.launcher.oidc.OidcTestSupport.TestClock;
import com.ghatana.media.runtime.MediaVerifiedIdentityContracts;
import com.ghatana.media.runtime.MediaVerifiedIdentityContracts.AssuranceSource;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.jwk.ECKey;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jwt.JWTClaimsSet;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.Date;
import java.util.List;
import java.util.Map;

import static com.ghatana.media.launcher.oidc.OidcTestSupport.AUDIENCE;
import static com.ghatana.media.launcher.oidc.OidcTestSupport.ISSUER;
import static com.ghatana.media.launcher.oidc.OidcTestSupport.NOW;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@DisplayName("OIDC access token verifier")
class OidcAccessTokenVerifierTest {
    private RSAKey rsa;
    private ECKey ec;
    private FakeIdp idp;
    private TestClock clock;
    private OidcAccessTokenVerifier verifier;

    @BeforeEach
    void setUp() {
        rsa = OidcTestSupport.rsa("rsa-1");
        ec = OidcTestSupport.ec("ec-1");
        idp = new FakeIdp(OidcTestSupport.jwks(rsa.toPublicJWK(), ec.toPublicJWK()));
        clock = new TestClock();
        verifier = new OidcAccessTokenVerifier(OidcConfig.of(ISSUER, AUDIENCE, null),
                new OidcJwksCache(OidcConfig.of(ISSUER, AUDIENCE, null), idp, clock), clock);
    }

    private JWTClaimsSet.Builder claims() { return OidcTestSupport.claims(NOW); }

    private OidcAccessTokenVerifier.Result verify(String token) { return verifier.verifyToken(token); }

    @Test
    void acceptsRs256TokenAndMapsIssuerSubjectTenantAndPermissions() {
        var result = verify(OidcTestSupport.signRs256(rsa, claims().build()));

        assertThat(result.verified()).isTrue();
        var identity = result.identity();
        assertThat(identity.assurance()).isEqualTo(AssuranceSource.OIDC_VERIFIED);
        assertThat(identity.issuer()).isEqualTo(ISSUER);
        assertThat(identity.subject()).isEqualTo("5b6c1c1e-0000-4000-8000-000000000001");
        assertThat(identity.tenantId()).isEqualTo("tenant-a");
        assertThat(identity.authenticatedAt()).isEqualTo(NOW);
        assertThat(identity.principalId())
                .isEqualTo(MediaVerifiedIdentityContracts.oidcPrincipalId(ISSUER, identity.subject()))
                .startsWith("oidc:");
        assertThat(result.permissions()).containsExactlyInAnyOrder(
                "media:job:read", "media:artifact:read", "media:job:cancel");
    }

    @Test
    void acceptsEs256Token() {
        assertThat(verify(OidcTestSupport.signEs256(ec, claims().build())).verified()).isTrue();
    }

    @Test
    void emailIsNeverTheIdentity() {
        var result = verify(OidcTestSupport.signRs256(rsa,
                claims().claim("email", "someone@example.test").claim("preferred_username", "someone").build()));

        assertThat(result.identity().subject()).doesNotContain("@");
        assertThat(result.identity().principalId()).doesNotContain("someone");
    }

    @Test
    void principalIdIsIssuerQualifiedSoTheSameSubjectFromAnotherIssuerDiffers() {
        assertThat(MediaVerifiedIdentityContracts.oidcPrincipalId(ISSUER, "sub-1"))
                .isNotEqualTo(MediaVerifiedIdentityContracts.oidcPrincipalId("https://other.example.test", "sub-1"));
    }

    @Test
    void rejectsSignatureFromADifferentKeyWithTheSameKid() {
        RSAKey forger = OidcTestSupport.rsa("rsa-1");
        assertThat(verify(OidcTestSupport.signRs256(forger, claims().build())).reason()).isEqualTo("SIGNATURE_INVALID");
    }

    @Test
    void rejectsTamperedPayload() {
        String token = OidcTestSupport.signRs256(rsa, claims().build());
        String[] parts = token.split("\\.");
        String forgedPayload = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                claims().claim("tenant_id", "tenant-b").build().toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));

        assertThat(verify(parts[0] + "." + forgedPayload + "." + parts[2]).reason()).isEqualTo("SIGNATURE_INVALID");
    }

    @Test
    void rejectsWrongIssuer() {
        assertThat(verify(OidcTestSupport.signRs256(rsa, claims().issuer("https://evil.example.test").build())).reason())
                .isEqualTo("ISSUER_MISMATCH");
    }

    @Test
    void rejectsWrongAndMissingAudience() {
        assertThat(verify(OidcTestSupport.signRs256(rsa, claims().audience("some-other-api").build())).reason())
                .isEqualTo("AUDIENCE_MISMATCH");
        assertThat(verify(OidcTestSupport.signRs256(rsa, claims().audience((String) null).build())).reason())
                .isEqualTo("AUDIENCE_MISMATCH");
    }

    @Test
    void acceptsTokenWhoseAudienceListIncludesMedia() {
        assertThat(verify(OidcTestSupport.signRs256(rsa, claims().audience(List.of("account", AUDIENCE)).build()))
                .verified()).isTrue();
    }

    @Test
    void rejectsExpiredTokenBeyondSkewButToleratesSmallSkew() {
        String token = OidcTestSupport.signRs256(rsa, claims().expirationTime(Date.from(NOW.minusSeconds(10))).build());
        assertThat(verify(token).verified()).as("10 seconds past exp is inside the 30 second skew").isTrue();

        String stale = OidcTestSupport.signRs256(rsa, claims().expirationTime(Date.from(NOW.minusSeconds(31))).build());
        assertThat(verify(stale).reason()).isEqualTo("TOKEN_EXPIRED");
    }

    @Test
    void rejectsTokenWithoutExpiry() {
        assertThat(verify(OidcTestSupport.signRs256(rsa, claims().expirationTime(null).build())).reason())
                .isEqualTo("TOKEN_EXPIRED");
    }

    @Test
    void rejectsNotYetValidTokenBeyondSkew() {
        assertThat(verify(OidcTestSupport.signRs256(rsa, claims().notBeforeTime(Date.from(NOW.plusSeconds(120))).build()))
                .reason()).isEqualTo("TOKEN_NOT_YET_VALID");
        assertThat(verify(OidcTestSupport.signRs256(rsa, claims().notBeforeTime(Date.from(NOW.plusSeconds(10))).build()))
                .verified()).isTrue();
        assertThat(verify(OidcTestSupport.signRs256(rsa, claims().issueTime(Date.from(NOW.plusSeconds(600))).build()))
                .reason()).isEqualTo("TOKEN_NOT_YET_VALID");
    }

    @Test
    void tokenExpiresAsTheClockAdvances() {
        String token = OidcTestSupport.signRs256(rsa, claims().build());
        assertThat(verify(token).verified()).isTrue();
        clock.advance(Duration.ofSeconds(331));
        assertThat(verify(token).reason()).isEqualTo("TOKEN_EXPIRED");
    }

    @Test
    void rejectsAlgNone() {
        assertThat(verify(OidcTestSupport.algNone(claims().build())).status())
                .isEqualTo(OidcAccessTokenVerifier.Status.REJECTED);
    }

    @Test
    void rejectsHmacTokensEvenWhenTheKidMatchesAPublishedKey() {
        var result = verify(OidcTestSupport.hmac(claims().build(), "rsa-1"));
        assertThat(result.reason()).isEqualTo("ALGORITHM_NOT_ALLOWED");
        assertThat(idp.jwksRequests).as("an inadmissible algorithm never reaches key lookup").isZero();
    }

    @Test
    void rejectsKeyTypeConfusion() {
        // ES256 header signed by an RSA kid is not verifiable: the key type must match the algorithm.
        String token = OidcTestSupport.sign(ec, JWSAlgorithm.ES256, claims().build())
                .replaceFirst("^[^.]+", java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                        "{\"alg\":\"ES256\",\"kid\":\"rsa-1\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        assertThat(verify(token).reason()).isEqualTo("SIGNATURE_INVALID");
    }

    @Test
    void rejectsIdTokensAndTokensWithoutTenantOrSubject() {
        assertThat(verify(OidcTestSupport.signRs256(rsa, claims().claim("typ", "ID").build())).reason())
                .isEqualTo("NOT_AN_ACCESS_TOKEN");
        assertThat(verify(OidcTestSupport.signRs256(rsa, claims().claim("tenant_id", null).build())).reason())
                .isEqualTo("TENANT_CLAIM_MISSING");
        assertThat(verify(OidcTestSupport.signRs256(rsa, claims().subject(null).build())).reason())
                .isEqualTo("SUBJECT_INVALID");
    }

    @Test
    void rejectsMalformedAndOversizedTokens() {
        assertThat(verify(null).reason()).isEqualTo("TOKEN_MALFORMED");
        assertThat(verify("not-a-jwt").reason()).isEqualTo("TOKEN_MALFORMED");
        assertThat(verify("a".repeat(OidcAccessTokenVerifier.MAX_TOKEN_CHARS + 1)).reason()).isEqualTo("TOKEN_MALFORMED");
        assertThat(idp.jwksRequests).isZero();
    }

    @Test
    void rejectsTokenWithoutKid() {
        String token = OidcTestSupport.signRs256(rsa, claims().build())
                .replaceFirst("^[^.]+", java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                        "{\"alg\":\"RS256\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        assertThat(verify(token).reason()).isEqualTo("KEY_ID_REQUIRED");
    }

    @Test
    void unknownKidTriggersExactlyOneRefetchAndPicksUpARotatedKey() {
        assertThat(verify(OidcTestSupport.signRs256(rsa, claims().build())).verified()).isTrue();
        assertThat(idp.jwksRequests).isEqualTo(1);

        RSAKey rotated = OidcTestSupport.rsa("rsa-2");
        idp.jwks = OidcTestSupport.jwks(rsa.toPublicJWK(), rotated.toPublicJWK());
        clock.advance(Duration.ofSeconds(31));

        assertThat(verify(OidcTestSupport.signRs256(rotated, claims().build())).verified()).isTrue();
        assertThat(idp.jwksRequests).as("one refetch for the unknown kid").isEqualTo(2);
        assertThat(verify(OidcTestSupport.signRs256(rotated, claims().build())).verified()).isTrue();
        assertThat(idp.jwksRequests).as("the rotated key is now cached").isEqualTo(2);
    }

    @Test
    void unknownKidThatStaysUnknownIsRejectedAndRefetchesAreRateLimited() {
        assertThat(verify(OidcTestSupport.signRs256(rsa, claims().build())).verified()).isTrue();
        RSAKey stranger = OidcTestSupport.rsa("never-published");
        clock.advance(Duration.ofSeconds(31));

        assertThat(verify(OidcTestSupport.signRs256(stranger, claims().build())).reason()).isEqualTo("KEY_UNKNOWN");
        assertThat(idp.jwksRequests).isEqualTo(2);
        for (int attempt = 0; attempt < 10; attempt++) {
            assertThat(verify(OidcTestSupport.signRs256(stranger, claims().build())).reason()).isEqualTo("KEY_UNKNOWN");
        }
        assertThat(idp.jwksRequests).as("unauthenticated callers cannot amplify requests to the IdP").isEqualTo(2);
    }

    @Test
    void jwksUnreachableOnColdStartFailsClosed() {
        idp.unreachable = true;
        var result = verify(OidcTestSupport.signRs256(rsa, claims().build()));
        assertThat(result.status()).isEqualTo(OidcAccessTokenVerifier.Status.UNAVAILABLE);
        assertThat(result.verified()).isFalse();
        assertThat(result.identity()).isNull();
    }

    @Test
    void jwksOutageIsServedFromCacheOnlyInsideTheStaleGraceThenFailsClosed() {
        String token = OidcTestSupport.signRs256(rsa, claims().expirationTime(Date.from(NOW.plus(Duration.ofHours(2)))).build());
        assertThat(verify(token).verified()).isTrue();
        idp.unreachable = true;

        clock.advance(Duration.ofMinutes(6));
        assertThat(verify(token).verified()).as("TTL passed, inside the two minute stale-if-error grace").isTrue();

        clock.advance(Duration.ofMinutes(2));
        assertThat(verify(token).status()).isEqualTo(OidcAccessTokenVerifier.Status.UNAVAILABLE);
    }

    @Test
    void cacheRecoversWhenTheProviderReturns() {
        idp.unreachable = true;
        String token = OidcTestSupport.signRs256(rsa, claims().build());
        assertThat(verify(token).status()).isEqualTo(OidcAccessTokenVerifier.Status.UNAVAILABLE);
        idp.unreachable = false;
        assertThat(verify(token).status()).as("inside the backoff window no new fetch is attempted")
                .isEqualTo(OidcAccessTokenVerifier.Status.UNAVAILABLE);
        clock.advance(Duration.ofSeconds(31));
        assertThat(verify(token).verified()).isTrue();
    }

    @Test
    void malformedOrEmptyJwksFailsClosed() {
        idp.jwks = "{\"keys\":[]}";
        assertThat(verify(OidcTestSupport.signRs256(rsa, claims().build())).status())
                .isEqualTo(OidcAccessTokenVerifier.Status.UNAVAILABLE);
        idp.jwks = "not json";
        clock.advance(Duration.ofSeconds(31));
        assertThat(verify(OidcTestSupport.signRs256(rsa, claims().build())).status())
                .isEqualTo(OidcAccessTokenVerifier.Status.UNAVAILABLE);
    }

    @Test
    void discoveryIssuerMismatchFailsClosed() {
        idp.discoveredIssuer = "https://evil.example.test";
        assertThat(verify(OidcTestSupport.signRs256(rsa, claims().build())).status())
                .isEqualTo(OidcAccessTokenVerifier.Status.UNAVAILABLE);
        assertThat(idp.jwksRequests).isZero();
    }

    @Test
    void explicitJwksUriSkipsDiscovery() {
        var config = OidcConfig.of(ISSUER, AUDIENCE, java.net.URI.create("https://idp.example.test/custom/jwks"));
        var custom = new OidcAccessTokenVerifier(config, new OidcJwksCache(config, idp, clock), clock);
        assertThat(custom.verifyToken(OidcTestSupport.signRs256(rsa, claims().build())).verified()).isTrue();
        assertThat(idp.discoveryRequests).isZero();
    }

    @Test
    void customClaimMappingsAreProviderNeutral() {
        var config = new OidcConfig(ISSUER, AUDIENCE, null, "https://example.test/tenant",
                List.of("permissions", "scope"), Duration.ofSeconds(30), Duration.ofMinutes(5),
                Duration.ofSeconds(30), Duration.ofMinutes(2), Duration.ofSeconds(5));
        var custom = new OidcAccessTokenVerifier(config, new OidcJwksCache(config, idp, clock), clock);
        var token = OidcTestSupport.signRs256(rsa, claims()
                .claim("https://example.test/tenant", "tenant-z")
                .claim("permissions", List.of("media:job:read"))
                .claim("scope", "openid media:artifact:read")
                .build());

        var result = custom.verifyToken(token);

        assertThat(result.identity().tenantId()).isEqualTo("tenant-z");
        assertThat(result.permissions()).containsExactlyInAnyOrder("media:job:read", "openid", "media:artifact:read");
    }

    @Test
    void nestedPathsResolveWithoutDottedKeyAmbiguity() {
        assertThat(OidcAccessTokenVerifier.resolve(Map.of("a", Map.of("b", Map.of("c", "v"))), "a.b.c")).isEqualTo("v");
        assertThat(OidcAccessTokenVerifier.resolve(Map.of("a.b", "flat"), "a.b")).isEqualTo("flat");
        assertThat(OidcAccessTokenVerifier.resolve(Map.of("a", "scalar"), "a.b")).isNull();
    }

    @Test
    void configurationRejectsInsecureOrIncompleteSettings() {
        assertThatThrownBy(() -> OidcConfig.of("http://idp.example.test/realms/x", AUDIENCE, null))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(OidcConfig.of("http://localhost:8080/realms/x", AUDIENCE, null).issuer()).startsWith("http://localhost");
        assertThatThrownBy(() -> OidcConfig.fromEnvironment(Map.of(OidcConfig.ISSUER, ISSUER)))
                .as("issuer without audience must not silently disable verification")
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(OidcConfig.fromEnvironment(Map.of())).isEmpty();
        var config = OidcConfig.fromEnvironment(Map.of(OidcConfig.ISSUER, ISSUER, OidcConfig.AUDIENCE, AUDIENCE)).orElseThrow();
        assertThat(config.permissionClaims()).containsExactly("realm_access.roles", "resource_access.ghatana-media.roles");
        assertThat(config.tenantClaim()).isEqualTo("tenant_id");
        assertThatThrownBy(() -> OidcConfig.of(ISSUER, AUDIENCE, java.net.URI.create("http://idp.example.test/jwks")))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
