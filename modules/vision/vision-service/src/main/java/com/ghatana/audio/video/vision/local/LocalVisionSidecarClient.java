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
import java.util.UUID;

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
        /**
         * How far the call got. {@code NOT_REACHED}: the connection was refused or never established, so nothing ran.
         * {@code TIMED_OUT}: the request was sent and no answer arrived within the deadline. The client asks the
         * sidecar to cancel that operation, but cancellation is cooperative and the late result is never used.
         * {@code CONNECTION_LOST}: the request may have been processed (the process died or reset the connection
         * mid-call), so the outcome is unknown; the client also makes a best-effort cancellation request.
         */
        public enum Reach { NOT_REACHED, TIMED_OUT, CONNECTION_LOST }

        private final Reach reach;

        public SidecarUnavailableException(String message, Throwable cause) { this(message, cause, Reach.CONNECTION_LOST); }

        public SidecarUnavailableException(String message, Throwable cause, Reach reach) {
            super(message, cause);
            this.reach = Objects.requireNonNull(reach, "reach");
        }

        public Reach reach() { return reach; }
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

    public record TranslateResponse(String translation) { }

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

    /** Outcome of one bounded health probe: reachability class plus the sidecar's own body when it answered. */
    public record Health(State state, long elapsedMillis, Map<String, Object> body) {
        public enum State { UP, UNREACHABLE, TIMED_OUT, REJECTED }
    }

    /**
     * One authenticated {@code /v1/health} probe bounded by {@code timeout}. A refused connection is UNREACHABLE (no
     * process listening), a response that does not arrive in time is TIMED_OUT (hung or saturated) and any non-200
     * answer is REJECTED. The body is the sidecar's own report (loaded models, the device torch actually reports).
     */
    public Health health(Duration timeout) {
        long started = System.nanoTime();
        try {
            HttpResponse<byte[]> response = http.send(
                    HttpRequest.newBuilder(base.resolve("/v1/health")).timeout(timeout)
                            .header("Authorization", "Bearer " + token).GET().build(),
                    HttpResponse.BodyHandlers.ofByteArray());
            long elapsed = (System.nanoTime() - started) / 1_000_000;
            if (response.statusCode() != 200) return new Health(Health.State.REJECTED, elapsed, Map.of());
            Map<String, Object> body;
            try {
                body = JSON.readValue(response.body(), new tools.jackson.core.type.TypeReference<Map<String, Object>>() { });
            } catch (RuntimeException malformed) {
                body = Map.of();
            }
            return new Health(Health.State.UP, elapsed, body == null ? Map.of() : body);
        } catch (java.net.http.HttpTimeoutException timedOut) {
            return new Health(Health.State.TIMED_OUT, (System.nanoTime() - started) / 1_000_000, Map.of());
        } catch (IOException | RuntimeException unreachable) {
            return new Health(Health.State.UNREACHABLE, (System.nanoTime() - started) / 1_000_000, Map.of());
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return new Health(Health.State.UNREACHABLE, (System.nanoTime() - started) / 1_000_000, Map.of());
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

    /** Text-only machine translation (no image); the sidecar admits only the pairs it names (en/es). */
    public TranslateResponse translate(String text, String sourceLanguage, String targetLanguage, int maxNewTokens) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("text", text);
        body.put("sourceLanguage", sourceLanguage);
        body.put("targetLanguage", targetLanguage);
        body.put("maxNewTokens", maxNewTokens);
        JsonNode response = post("/v1/translate", body);
        JsonNode translation = response.get("translation");
        if (translation == null || !translation.isString()) {
            throw new SidecarRejectedException(502, "MALFORMED_RESPONSE");
        }
        return new TranslateResponse(translation.asString());
    }

    private JsonNode post(String path, Map<String, Object> body) {
        String operationId = UUID.randomUUID().toString();
        final byte[] payload = JSON.writeValueAsBytes(body);
        final HttpResponse<byte[]> response;
        try {
            response = http.send(HttpRequest.newBuilder(base.resolve(path)).timeout(timeout)
                            .header("Authorization", "Bearer " + token)
                            .header("X-Ghatana-Operation-Id", operationId)
                            .header("Content-Type", "application/json")
                            .POST(HttpRequest.BodyPublishers.ofByteArray(payload)).build(),
                    HttpResponse.BodyHandlers.ofByteArray());
        } catch (java.net.http.HttpConnectTimeoutException | java.net.ConnectException e) {
            throw new SidecarUnavailableException("local vision sidecar could not be reached", e,
                    SidecarUnavailableException.Reach.NOT_REACHED);
        } catch (java.net.http.HttpTimeoutException e) {
            requestCancellation(operationId);
            throw new SidecarUnavailableException("local vision sidecar timed out", e,
                    SidecarUnavailableException.Reach.TIMED_OUT);
        } catch (IOException e) {
            requestCancellation(operationId);
            throw new SidecarUnavailableException("local vision sidecar connection was lost", e,
                    SidecarUnavailableException.Reach.CONNECTION_LOST);
        } catch (InterruptedException e) {
            requestCancellation(operationId);
            Thread.currentThread().interrupt();
            throw new SidecarUnavailableException("local vision sidecar call interrupted", e,
                    SidecarUnavailableException.Reach.CONNECTION_LOST);
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

    /**
     * Best-effort cancellation for an inference whose reply could not be observed. The sidecar may still be inside a
     * native/model step; it treats this as a cooperative stop request, not proof that the computation has ended.
     * Sending asynchronously keeps timeout and interrupted-call handling bounded and does not expose request content.
     */
    private void requestCancellation(String operationId) {
        try {
            HttpRequest request = HttpRequest.newBuilder(base.resolve("/v1/operations/" + operationId))
                    .timeout(Duration.ofSeconds(2))
                    .header("Authorization", "Bearer " + token)
                    .DELETE()
                    .build();
            http.sendAsync(request, HttpResponse.BodyHandlers.discarding());
        } catch (RuntimeException ignored) {
            // The original provider outcome remains UNKNOWN; cancellation is only a resource-release request.
        }
    }
}
