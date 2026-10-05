package com.ghatana.media.launcher;

import com.sun.net.httpserver.HttpExchange;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** Verifies bounded optional bodies for end-of-stream frames. */
class MediaHttpTerminalFrameBodyTest {

    @Test
    void terminalFrameAllowsEmptyBodyWithoutContentLength() throws Exception {
        HttpExchange exchange = exchange(new byte[0]);

        assertThat(MediaHttpHandler.boundedBody(exchange, 1024, true)).isEmpty();
    }

    @Test
    void ordinaryFrameStillRequiresPayload() {
        HttpExchange exchange = exchange(new byte[0]);

        assertThatThrownBy(() -> MediaHttpHandler.boundedBody(exchange, 1024, false))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Request body is required");
    }

    @Test
    void terminalFrameRemainsBounded() {
        HttpExchange exchange = exchange(new byte[] {1, 2, 3});

        assertThatThrownBy(() -> MediaHttpHandler.boundedBody(exchange, 2, true))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("exceeds 2 bytes");
    }

    private HttpExchange exchange(byte[] body) {
        HttpExchange exchange = mock(HttpExchange.class);
        when(exchange.getRequestBody()).thenReturn(new ByteArrayInputStream(body));
        return exchange;
    }
}
