package com.ghatana.media.provider.aws;

import com.ghatana.governance.PolicyDecisionOutcome;
import com.ghatana.governance.PolicyDecisionRecord;
import com.ghatana.governance.PolicyEvaluationContext;
import com.ghatana.governance.PolicyEvaluationRequest;
import com.ghatana.governance.PolicyReasonCode;
import com.ghatana.governance.VerifiedPolicyContext;
import com.ghatana.security.identity.PrincipalIdentity;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class PostgresqlMediaSourceAuthorizationPolicyBindingTest {
    @Test
    void allowMustAttestToTheExactSourceRequestNotOnlyTheSameIdentity() {
        PolicyEvaluationRequest request = request();

        assertThat(PostgresqlMediaSourceAuthorizationAuthority.matchesPolicyEvaluation(
                decision(request, request.targetId(), request.attributes()), request)).isTrue();
        assertThat(PostgresqlMediaSourceAuthorizationAuthority.matchesPolicyEvaluation(
                decision(request, "another-artifact", request.attributes()), request)).isFalse();
        assertThat(PostgresqlMediaSourceAuthorizationAuthority.matchesPolicyEvaluation(
                decision(request, request.targetId(), Map.of("sourceVersion", "sha256:other")), request)).isFalse();
    }

    private static PolicyEvaluationRequest request() {
        String correlationId = "correlation-1";
        VerifiedPolicyContext verified = VerifiedPolicyContext.from(
                new PrincipalIdentity("tenant-1", "principal-1", null, Set.of(), Instant.now()),
                correlationId);
        return PolicyEvaluationRequest.builder()
                .principalId("principal-1")
                .tenantId("tenant-1")
                .actionClass("CALL_EXTERNAL")
                .targetType("MEDIA_SOURCE_ARTIFACT")
                .targetId("artifact-1")
                .criticality("HIGH")
                .reversibility("IRREVERSIBLE")
                .attributes(Map.of("sourceVersion", "sha256:version-1", "purpose", "transcription"))
                .correlationId(correlationId)
                .verifiedContext(verified)
                .build();
    }

    private static PolicyDecisionRecord decision(
            PolicyEvaluationRequest request, String targetId, Map<String, String> attributes) {
        PolicyEvaluationContext context = new PolicyEvaluationContext(
                request.principalId(), request.tenantId(), request.actionClass(), request.targetType(),
                targetId, request.toolId(), request.criticality(), request.reversibility(), attributes,
                Instant.now(), request.correlationId(), request.verifiedContext());
        return new PolicyDecisionRecord(
                "decision-1", PolicyDecisionOutcome.ALLOW, List.of("policy-v1:allow"),
                List.of("allow"), List.of("allowed"), context, Instant.now(), null,
                "policy-v1", List.of(PolicyReasonCode.POLICY_ALLOWED));
    }
}
