package com.ghatana.audio.video.vision.local;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.net.InetAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Client for the loopback-only local vision sidecar ({@code tools/model-runtimes/vision/vision_sidecar.py}).
 * The endpoint must be an {@code http} URL whose host is a loopback literal; a non-loopback address is
 * refused at construction so media can never be sent off this machine. Every call carries a bearer
 * token and a hard timeout, and the response size is bounded. Failures are typed; request content is
 * never placed in an exception message.
 *
 * @doc.type class
 * @doc.purpose Loopback sidecar client for local vision and multimodal inference
 * @doc.layer product
 * @doc.pattern Adapter
 */
public final class LocalVisionSidecarClient {

    private static final int MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    /** The sidecar cannot be reached or timed out; the effect may or may not have happened. */
    public static final class SidecarUnavailableException extends RuntimeException {
        public SidecarUnavailableException(String message, Throwable cause) { super(message, cause); }
    }

    /** The sidecar answered with a definite refusal or failure. */
    public static final class SidecarRejectedException extends RuntimeException {
        private final int status;
        private final String code;
        public SidecarRejectedException(int status, String code) {
            super("local vision sidecar rejected the request: " + code);
            this.status = status;
            this.code = code;
        }
        public int status() { return status; }
        public String code() { return code; }
    }

    public record AnalyzeResponse(Map<String, Object> results, int width, int height) { }

    public record AskResponse(String answer, int width, int height) { }

    private final URI base;
    private final String token;
    private final Duration timeout;
    private final HttpClient http;

    public LocalVisionSidecarClient(URI base, String token, Duration timeout) {
        Objects.requireNonNull(base, "base");
        if (!"http".equals(base.getScheme()) || base.getHost() == null || !loopback(base.getHost())) {
            throw new IllegalArgumentException("local vision sidecar must be an http loopback address");
        }
        if (token == null || token.length() < 24) {
            throw new IllegalArgumentException("local vision sidecar token must be at least 24 characters");
        }
        if (timeout == null || timeout.isNegative() || timeout.isZero() || timeout.compareTo(Duration.ofMinutes(10)) > 0) {
            throw new IllegalArgumentException("timeout must be within (0, 10 minutes]");
        }
        this.base = base;
        this.token = token;
        this.timeout = timeout;
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5))
                .followRedirects(HttpClient.Redirect.NEVER).build();
    }

    private static boolean loopback(String host) {
        if (host.equals("localhost")) return true;
        String literal = host.startsWith("[") ? host.substring(1, host.length() - 1) : host;
        if (!literal.matches("[0-9a-fA-F:.]+")) return false;
        try {
            return InetAddress.getByName(literal).isLoopbackAddress();
        } catch (java.net.UnknownHostException e) {
            return false;
        }
    }

    public boolean healthy() {
        try {
            HttpResponse<byte[]> response = http.send(
                    HttpRequest.newBuilder(base.resolve("/v1/health")).timeout(Duration.ofSeconds(5))
                            .header("Authorization", "Bearer " + token).GET().build(),
                    HttpResponse.BodyHandlers.ofByteArray());
            return response.statusCode() == 200;
        } catch (IOException | RuntimeException e) {
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    public AnalyzeResponse analyze(byte[] image, List<String> tasks, int maxNewTokens) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("imageBase64", Base64.getEncoder().encodeToString(image));
        body.put("tasks", tasks);
        body.put("maxNewTokens", maxNewTokens);
        JsonNode response = post("/v1/analyze", body);
        Map<String, Object> results = JSON.convertValue(response.get("results"),
                new tools.jackson.core.type.TypeReference<LinkedHashMap<String, Object>>() { });
        return new AnalyzeResponse(results, response.path("imageSize").path("width").asInt(),
                response.path("imageSize").path("height").asInt());
    }

    public AskResponse ask(byte[] image, String question, int maxNewTokens) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("imageBase64", Base64.getEncoder().encodeToString(image));
        body.put("question", question);
        body.put("maxNewTokens", maxNewTokens);
        JsonNode response = post("/v1/ask", body);
        JsonNode answer = response.get("answer");
        if (answer == null || !answer.isString()) {
            throw new SidecarRejectedException(502, "MALFORMED_RESPONSE");
        }
        return new AskResponse(answer.asString(), response.path("imageSize").path("width").asInt(),
                response.path("imageSize").path("height").asInt());
    }

    private JsonNode post(String path, Map<String, Object> body) {
        final byte[] payload = JSON.writeValueAsBytes(body);
        final HttpResponse<byte[]> response;
        try {
            response = http.send(HttpRequest.newBuilder(base.resolve(path)).timeout(timeout)
                            .header("Authorization", "Bearer " + token)
                            .header("Content-Type", "application/json")
                            .POST(HttpRequest.BodyPublishers.ofByteArray(payload)).build(),
                    HttpResponse.BodyHandlers.ofByteArray());
        } catch (IOException e) {
            throw new SidecarUnavailableException("local vision sidecar is unreachable or timed out", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new SidecarUnavailableException("local vision sidecar call interrupted", e);
        }
        byte[] data = response.body();
        if (data.length > MAX_RESPONSE_BYTES) throw new SidecarRejectedException(502, "RESPONSE_TOO_LARGE");
        JsonNode json;
        try {
            json = JSON.readTree(new String(data, StandardCharsets.UTF_8));
        } catch (RuntimeException malformed) {
            throw new SidecarRejectedException(response.statusCode(), "MALFORMED_RESPONSE");
        }
        if (response.statusCode() != 200) {
            String code = json != null && json.path("error").isString() ? json.path("error").asString() : "ERROR";
            throw new SidecarRejectedException(response.statusCode(), code.replaceAll("[^A-Z0-9_]", "_"));
        }
        return json;
    }
}
