package com.ghatana.audio.video.common;

import com.ghatana.audio.video.common.observability.MetricsServerInterceptor;
import com.ghatana.audio.video.common.observability.TracingServerInterceptor;
import com.ghatana.audio.video.common.resilience.CircuitBreakerServerInterceptor;
import com.ghatana.audio.video.common.resilience.RateLimitingServerInterceptor;
import com.ghatana.audio.video.common.security.AudioVideoRequestContextInterceptor;
import com.ghatana.audio.video.common.security.InputValidationServerInterceptor;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import io.grpc.ServerInterceptor;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The interceptor chain has a documented security ordering invariant: the list
 * is innermost-first, so JWT (index 2) must execute before RBAC (index 1), and
 * input validation (index 0) is the last wall before the service. A reordered
 * chain would let authorization run before authentication or let oversized
 * payloads reach validators.
 */
@DisplayName("gRPC Interceptor Chain Ordering Tests")
class GrpcInterceptorChainTest {

    private static final String TEST_JWT_SECRET = "chain-order-test-secret-0123456789abcdef";

    private static List<ServerInterceptor> buildChain() {
        // JwtServerInterceptor fails closed without a signing secret; the
        // documented System-property fallback is the test seam.
        String previous = System.getProperty("AV_JWT_SECRET");
        System.setProperty("AV_JWT_SECRET", TEST_JWT_SECRET);
        try {
            return GrpcInterceptorChain.build();
        } finally {
            if (previous == null) {
                System.clearProperty("AV_JWT_SECRET");
            } else {
                System.setProperty("AV_JWT_SECRET", previous);
            }
        }
    }

    @Test
    @DisplayName("Chain order is exactly the documented innermost-first sequence")
    void chainPreservesDocumentedOrder() {
        List<ServerInterceptor> chain = buildChain();

        assertThat(chain).hasSize(7);
        assertThat(chain.get(0)).isInstanceOf(InputValidationServerInterceptor.class);
        assertThat(chain.get(1)).isInstanceOf(AudioVideoRequestContextInterceptor.class);
        assertThat(chain.get(2)).isInstanceOf(JwtServerInterceptor.class);
        assertThat(chain.get(3)).isInstanceOf(CircuitBreakerServerInterceptor.class);
        assertThat(chain.get(4)).isInstanceOf(RateLimitingServerInterceptor.class);
        assertThat(chain.get(5)).isInstanceOf(MetricsServerInterceptor.class);
        assertThat(chain.get(6)).isInstanceOf(TracingServerInterceptor.class);
    }

    @Test
    @DisplayName("RBAC executes after JWT: its index stays below the JWT index")
    void rbacIsInnerThanJwt() {
        List<ServerInterceptor> chain = buildChain();
        int rbac = indexOf(chain, AudioVideoRequestContextInterceptor.class);
        int jwt = indexOf(chain, JwtServerInterceptor.class);
        int validation = indexOf(chain, InputValidationServerInterceptor.class);

        assertThat(rbac).isLessThan(jwt);
        assertThat(validation).isLessThan(rbac);
    }

    private static int indexOf(
            List<ServerInterceptor> chain, Class<? extends ServerInterceptor> type) {
        for (int i = 0; i < chain.size(); i++) {
            if (type.isInstance(chain.get(i))) {
                return i;
            }
        }
        return -1;
    }
}
