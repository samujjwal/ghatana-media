/**
 * @doc.type class
 * @doc.purpose Unit tests for Media security envelope validator
 * @doc.layer product
 * @doc.pattern Test
 */
package com.ghatana.media.security;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.assertThatNoException;

@DisplayName("Media Security Envelope Validation")
class MediaSecurityEnvelopeValidatorTest {

    private static final String VALID_TENANT = "tenant-media-123";
    private static final String VALID_PRINCIPAL = "media-principal-456";
    private static final String VALID_CORR_ID = "corr-media-abc";
    private static final String VALID_REQ_ID = "req-media-def";

    @Test
    void acceptsValidMediaOperation() {
        assertThatNoException()
                .isThrownBy(() ->
                        MediaSecurityEnvelopeValidator.validateMediaOperation(
                                VALID_TENANT,
                                VALID_PRINCIPAL,
                                VALID_CORR_ID,
                                VALID_REQ_ID));
    }

    @Test
    void rejectsNullTenant() {
        assertThatThrownBy(() ->
                MediaSecurityEnvelopeValidator.validateMediaOperation(
                        null,
                        VALID_PRINCIPAL,
                        VALID_CORR_ID,
                        VALID_REQ_ID))
                .isInstanceOf(NullPointerException.class);
    }

    @Test
    void rejectsNullPrincipal() {
        assertThatThrownBy(() ->
                MediaSecurityEnvelopeValidator.validateMediaOperation(
                        VALID_TENANT,
                        null,
                        VALID_CORR_ID,
                        VALID_REQ_ID))
                .isInstanceOf(NullPointerException.class);
    }

    @Test
    void rejectsNullCorrelationId() {
        assertThatThrownBy(() ->
                MediaSecurityEnvelopeValidator.validateMediaOperation(
                        VALID_TENANT,
                        VALID_PRINCIPAL,
                        null,
                        VALID_REQ_ID))
                .isInstanceOf(NullPointerException.class);
    }

    @Test
    void rejectsNullRequestId() {
        assertThatThrownBy(() ->
                MediaSecurityEnvelopeValidator.validateMediaOperation(
                        VALID_TENANT,
                        VALID_PRINCIPAL,
                        VALID_CORR_ID,
                        null))
                .isInstanceOf(NullPointerException.class);
    }
}
