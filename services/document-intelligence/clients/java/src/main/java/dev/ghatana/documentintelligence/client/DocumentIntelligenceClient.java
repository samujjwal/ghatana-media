package dev.ghatana.documentintelligence.client;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Pattern;

/** Source-free Java transport for the frozen Document Intelligence v1 worker API. */
public final class DocumentIntelligenceClient {
    public static final String PROTOCOL_VERSION = "document-intelligence.v1";
    private static final Pattern IDENTIFIER = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$");
    private static final Pattern GENERATION = Pattern.compile("^[0-9a-f]{32}$");
    private static final Pattern SHA256 = Pattern.compile("^sha256:[0-9a-f]{64}$");
    private static final Set<String> DEFAULT_MEDIA_TYPES = Set.of("application/pdf", "image/png", "image/jpeg");

    /** Caller verified identity, kept local and never serialized into the frozen v1 body. */
    public record Scope(String tenantId, String principalId) {
        public Scope {
            tenantId = text(tenantId, "tenantId");
            principalId = text(principalId, "principalId");
        }
    }

    /** Immutable source binding supplied by the caller's source authority; no rights claims are carried here. */
    public record SourceBinding(String tenantId, String principalId, String sourceRef,
                                String sourceVersion, String sha256) {
        public SourceBinding {
            tenantId = text(tenantId, "source tenantId");
            principalId = text(principalId, "source principalId");
            sourceRef = text(sourceRef, "sourceRef");
            sourceVersion = text(sourceVersion, "sourceVersion");
            if (!SHA256.matcher(sha256 == null ? "" : sha256).matches()) {
                throw new IllegalArgumentException("source digest must be canonical sha256:<64 lowercase hex>");
            }
        }
    }

    public record ParseRequest(Scope scope, SourceBinding source, String operationId,
                               String operationGeneration, String providerRef, String mediaType,
                               String languageHint, Duration timeout, Map<String, Integer> limits,
                               byte[] bytes) {
        public ParseRequest {
            scope = Objects.requireNonNull(scope, "scope");
            source = Objects.requireNonNull(source, "source");
            operationId = identifier(operationId, "operationId");
            if (operationGeneration != null && !GENERATION.matcher(operationGeneration).matches()) {
                throw new IllegalArgumentException("operationGeneration must be 32 lowercase hex characters");
            }
            providerRef = identifier(providerRef, "providerRef");
            mediaType = text(mediaType, "mediaType");
            if (!DEFAULT_MEDIA_TYPES.contains(mediaType)) throw new IllegalArgumentException("mediaType is not admitted by document-intelligence.v1");
            if (languageHint != null && !Set.of("en", "hi", "mr", "ne").contains(languageHint)) {
                throw new IllegalArgumentException("languageHint is not admitted by this client profile");
            }
            timeout = Objects.requireNonNull(timeout, "timeout");
            if (timeout.isZero() || timeout.isNegative() || timeout.compareTo(Duration.ofMinutes(2)) > 0) {
                throw new IllegalArgumentException("timeout must be between 1 ms and 120000 ms");
            }
            Objects.requireNonNull(limits, "limits");
            if (limits.size() > 32) throw new IllegalArgumentException("limits contains too many entries");
            var copied = new LinkedHashMap<String, Integer>();
            limits.forEach((key, value) -> {
                if (key == null || !IDENTIFIER.matcher(key).matches() || value == null || value < 1) {
                    throw new IllegalArgumentException("limits must contain bounded positive integer entries");
                }
                copied.put(key, value);
            });
            limits = Collections.unmodifiableMap(copied);
            bytes = Objects.requireNonNull(bytes, "bytes").clone();
        }
        @Override public byte[] bytes() { return bytes.clone(); }
    }

    public enum State { SUCCEEDED, FAILED, CANCELLED, UNKNOWN }

    /** UNKNOWN is a truthful result when v1 has no status endpoint or transport finality is ambiguous. */
    public record OperationResult(String operationId, String operationGeneration, State state,
                                  Map<String, Object> parsedDocument, String failureCode,
                                  boolean retryable) { }

    public record Provider(String providerRef, String providerVersion, List<String> mediaTypes,
                           List<String> languages, boolean loaded, boolean ready) { }

    public record ProviderCatalog(List<Provider> providers) { }

    @FunctionalInterface
    public interface CredentialProvider {
        /** Supplies only the transport credential; source rights/consent are never sent as headers. */
        String bearerToken(Scope scope);
    }

    public record Config(URI endpoint, Duration connectTimeout, int maxUploadBytes,
                         int maxResponseBytes, int maxOperations) {
        public Config {
            endpoint = Objects.requireNonNull(endpoint, "endpoint");
            if (endpoint.getHost() == null || endpoint.getUserInfo() != null
                    || endpoint.getQuery() != null || endpoint.getFragment() != null) {
                throw new IllegalArgumentException("endpoint must be an absolute URI without credentials/query/fragment");
            }
            boolean loopback = Set.of("localhost", "127.0.0.1", "::1").contains(endpoint.getHost().toLowerCase());
            if (!"https".equalsIgnoreCase(endpoint.getScheme())
                    && !("http".equalsIgnoreCase(endpoint.getScheme()) && loopback)) {
                throw new IllegalArgumentException("non-loopback Document Intelligence endpoints require HTTPS");
            }
            connectTimeout = Objects.requireNonNull(connectTimeout, "connectTimeout");
            if (connectTimeout.isZero() || connectTimeout.isNegative()) throw new IllegalArgumentException("connectTimeout must be positive");
            if (maxUploadBytes < 1 || maxUploadBytes > 32 * 1024 * 1024) throw new IllegalArgumentException("maxUploadBytes must be in [1,32 MiB]");
            if (maxResponseBytes < 1 || maxResponseBytes > 32 * 1024 * 1024) throw new IllegalArgumentException("maxResponseBytes must be in [1,32 MiB]");
            if (maxOperations < 1 || maxOperations > 10_000) throw new IllegalArgumentException("maxOperations must be in [1,10000]");
        }
    }

    private record OperationKey(String tenantId, String principalId, String operationId) { }
    private record OperationEntry(String fingerprint, String generation, OperationResult result) { }

    private final Config config;
    private final CredentialProvider credentials;
    private final HttpClient http;
    private final ObjectMapper mapper = JsonMapper.builder().build();
    private final SecureRandom secureRandom = new SecureRandom();
    private final Map<OperationKey, OperationEntry> operations = new ConcurrentHashMap<>();
    private final URI baseUri;

    public DocumentIntelligenceClient(Config config, CredentialProvider credentials) {
        this(config, credentials, HttpClient.newBuilder().connectTimeout(config.connectTimeout())
                .version(HttpClient.Version.HTTP_1_1)
                .followRedirects(HttpClient.Redirect.NEVER).build());
    }

    DocumentIntelligenceClient(Config config, CredentialProvider credentials, HttpClient http) {
        this.config = Objects.requireNonNull(config, "config");
        this.credentials = Objects.requireNonNull(credentials, "credentials");
        this.http = Objects.requireNonNull(http, "http");
        if (http.followRedirects() != HttpClient.Redirect.NEVER) throw new IllegalArgumentException("DI transport must not follow redirects");
        String normalized = config.endpoint().toString().replaceAll("/+$", "");
        this.baseUri = URI.create(normalized);
    }

    public ProviderCatalog providers(Scope scope, Duration timeout) {
        String token = credential(scope);
        try {
            HttpRequest request = HttpRequest.newBuilder(baseUri.resolve("/v1/providers"))
                    .timeout(boundedTimeout(timeout)).header("Authorization", "Bearer " + token).GET().build();
            HttpResponse<InputStream> response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
            byte[] body = readBounded(response.body());
            if (response.statusCode() / 100 != 2) throw new ClientException("PROVIDER_UNAVAILABLE", true);
            JsonNode root = mapper.readTree(body);
            if (!PROTOCOL_VERSION.equals(root.path("protocolVersion").stringValue()) || !root.path("providers").isArray()) {
                throw new ClientException("INVALID_RESPONSE", false);
            }
            var providers = new ArrayList<Provider>();
            if (root.path("providers").size() > 256) throw new ClientException("INVALID_RESPONSE", false);
            for (JsonNode row : root.path("providers")) {
                String providerRef = requiredString(row, "providerRef");
                String providerVersion = requiredString(row, "providerVersion");
                providers.add(new Provider(providerRef, providerVersion, strings(row.path("mediaTypes")),
                        strings(row.path("languages")), row.path("loaded").booleanValue(), row.path("ready").booleanValue()));
            }
            return new ProviderCatalog(List.copyOf(providers));
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new ClientException("UNKNOWN_OUTCOME", true);
        } catch (IOException | RuntimeException failure) {
            if (failure instanceof ClientException known) throw known;
            throw new ClientException("UNKNOWN_OUTCOME", true);
        }
    }

    public OperationResult parse(ParseRequest request) {
        Objects.requireNonNull(request, "request");
        verifyLocalSourceBinding(request);
        if (request.bytes.length > config.maxUploadBytes()) return failure(request, generationFor(request), State.FAILED, "SOURCE_TOO_LARGE", false);
        String generation = generationFor(request);
        String fingerprint = fingerprint(request);
        OperationKey key = key(request.scope(), request.operationId());
        OperationResult reservationOutcome = reserve(request, key, fingerprint, generation);
        if (reservationOutcome != null) return reservationOutcome;
        try {
            String token = credential(request.scope());
            String boundary = "ghatana-di-" + randomHex(16);
            byte[] body = multipart(boundary, metadata(request, generation), request.bytes);
            HttpRequest httpRequest = HttpRequest.newBuilder(baseUri.resolve("/v1/parse"))
                    .timeout(request.timeout()).header("Authorization", "Bearer " + token)
                    .header("X-Operation-Generation", generation)
                    .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                    .POST(HttpRequest.BodyPublishers.ofByteArray(body)).build();
            HttpResponse<InputStream> response = http.send(httpRequest, HttpResponse.BodyHandlers.ofInputStream());
            byte[] responseBody = readBounded(response.body());
            OperationResult result;
            if (response.statusCode() >= 500) {
                result = failure(request, generation, State.UNKNOWN, "UNKNOWN_OUTCOME", true);
            } else if (response.statusCode() / 100 != 2) {
                result = errorResponse(responseBody, request, generation);
            } else {
                result = successResponse(responseBody, request, generation);
            }
            return store(key, fingerprint, generation, result);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return store(key, fingerprint, generation, failure(request, generation, State.UNKNOWN, "UNKNOWN_OUTCOME", true));
        } catch (IOException | RuntimeException failure) {
            return store(key, fingerprint, generation, failure(request, generation, State.UNKNOWN, "UNKNOWN_OUTCOME", true));
        }
    }

    /** Atomically reserves one scoped operation before its network POST can be dispatched. */
    private OperationResult reserve(ParseRequest request, OperationKey key, String fingerprint, String generation) {
        synchronized (operations) {
            OperationEntry prior = operations.get(key);
            if (prior != null) {
                if (!prior.fingerprint().equals(fingerprint)
                        || request.operationGeneration() != null
                                && !prior.generation().equals(request.operationGeneration())) {
                    return failure(request, generation, State.FAILED, "IDEMPOTENCY_CONFLICT", false);
                }
                if (prior.result() != null) return prior.result();
                return failure(request, prior.generation(), State.UNKNOWN, "OPERATION_IN_PROGRESS", true);
            }
            if (operations.size() >= config.maxOperations()) {
                return failure(request, generation, State.FAILED, "UNAVAILABLE", true);
            }
            operations.put(key, new OperationEntry(fingerprint, generation, null));
            return null;
        }
    }

    /** v1 exposes no status GET; status reports only this bounded client process's known outcome. */
    public OperationResult status(Scope scope, String operationId) {
        OperationEntry entry = operations.get(key(scope, identifier(operationId, "operationId")));
        return entry == null || entry.result() == null
                ? new OperationResult(operationId, entry == null ? null : entry.generation(), State.UNKNOWN,
                        Map.of(), "OPERATION_UNKNOWN", true)
                : entry.result();
    }

    public OperationResult cancel(Scope scope, String operationId) {
        OperationKey key = key(scope, identifier(operationId, "operationId"));
        OperationEntry entry = operations.get(key);
        if (entry == null || entry.result() != null && entry.result().state() != State.UNKNOWN) {
            return entry == null ? new OperationResult(operationId, null, State.UNKNOWN, Map.of(), "OPERATION_UNKNOWN", true) : entry.result();
        }
        try {
            String token = credential(scope);
            HttpRequest request = HttpRequest.newBuilder(baseUri.resolve("/v1/operations/" + encodePath(operationId)))
                    .timeout(Duration.ofSeconds(10)).header("Authorization", "Bearer " + token)
                    .header("X-Operation-Generation", entry.generation()).DELETE().build();
            HttpResponse<InputStream> response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
            JsonNode ack = mapper.readTree(readBounded(response.body()));
            boolean matches = response.statusCode() / 100 == 2
                    && PROTOCOL_VERSION.equals(ack.path("protocolVersion").stringValue())
                    && operationId.equals(ack.path("operationId").stringValue())
                    && entry.generation().equals(ack.path("operationGeneration").stringValue());
            if (!matches || !ack.path("cancelled").booleanValue()) {
                return store(key, entry.fingerprint(), entry.generation(), failure(operationId, entry.generation(), State.UNKNOWN, "UNKNOWN_OUTCOME", true));
            }
            return store(key, entry.fingerprint(), entry.generation(), failure(operationId, entry.generation(), State.CANCELLED, "CANCELLED", false));
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return store(key, entry.fingerprint(), entry.generation(), failure(operationId, entry.generation(), State.UNKNOWN, "UNKNOWN_OUTCOME", true));
        } catch (IOException | RuntimeException failure) {
            return store(key, entry.fingerprint(), entry.generation(), failure(operationId, entry.generation(), State.UNKNOWN, "UNKNOWN_OUTCOME", true));
        }
    }

    private OperationResult successResponse(byte[] body, ParseRequest request, String generation) {
        try {
            JsonNode root = mapper.readTree(body);
            if (!PROTOCOL_VERSION.equals(root.path("protocolVersion").stringValue())
                    || !request.operationId().equals(root.path("operationId").stringValue())
                    || !request.providerRef().equals(root.path("providerRef").stringValue())) {
                return failure(request, generation, State.UNKNOWN, "INVALID_RESPONSE", true);
            }
            JsonNode pages = root.path("pages");
            if (!pages.isArray() || pages.size() > maxPages(request)) return failure(request, generation, State.UNKNOWN, "INVALID_RESPONSE", true);
            String provenanceProvider = requiredString(root.path("providerProvenance"), "providerRef");
            requiredString(root.path("providerProvenance"), "providerVersion");
            if (!request.providerRef().equals(provenanceProvider)) return failure(request, generation, State.UNKNOWN, "INVALID_RESPONSE", true);
            validateParsedBounds(root, request);
            Map<String, Object> value = mapper.readValue(body, new TypeReference<>() { });
            return new OperationResult(request.operationId(), generation, State.SUCCEEDED, deepImmutableMap(value), null, false);
        } catch (Exception invalid) {
            return failure(request, generation, State.UNKNOWN, "INVALID_RESPONSE", true);
        }
    }

    private OperationResult errorResponse(byte[] body, ParseRequest request, String generation) {
        try {
            JsonNode error = mapper.readTree(body);
            if (!PROTOCOL_VERSION.equals(error.path("protocolVersion").stringValue())
                    || !request.operationId().equals(error.path("operationId").stringValue())) {
                return failure(request, generation, State.UNKNOWN, "INVALID_RESPONSE", true);
            }
            String code = requiredString(error, "code");
            boolean retryable = error.path("retryable").booleanValue();
            return failure(request, generation, State.FAILED, code, retryable);
        } catch (Exception invalid) {
            return failure(request, generation, State.UNKNOWN, "UNKNOWN_OUTCOME", true);
        }
    }

    private void validateParsedBounds(JsonNode root, ParseRequest request) {
        int maxPages = maxPages(request);
        int pages = 0;
        int lines = 0;
        for (JsonNode page : root.path("pages")) {
            pages++;
            for (JsonNode block : page.path("blocks")) {
                for (JsonNode line : block.path("lines")) {
                    if (++lines > 200_000 || !line.path("text").isTextual()
                            || line.path("text").stringValue().length() > 2_000_000) {
                        throw new IllegalArgumentException("parsed response exceeds limits");
                    }
                    validateBox(line.path("boundingRegion"));
                }
                validateBox(block.path("boundingRegion"));
            }
            for (JsonNode table : page.path("tables")) validateBox(table.path("boundingRegion"));
        }
        if (pages > maxPages) throw new IllegalArgumentException("parsed response exceeds page limit");
    }

    private static void validateBox(JsonNode box) {
        double x = finite(box.path("x")); double y = finite(box.path("y"));
        double width = finite(box.path("width")); double height = finite(box.path("height"));
        if (x < 0 || y < 0 || width < 0 || height < 0 || x + width > 1 || y + height > 1) {
            throw new IllegalArgumentException("invalid normalized bounding box");
        }
    }

    private static double finite(JsonNode value) {
        if (!value.isNumber() || !Double.isFinite(value.doubleValue())) throw new IllegalArgumentException("invalid coordinate");
        return value.doubleValue();
    }

    private int maxPages(ParseRequest request) { return request.limits().getOrDefault("maxPages", 500); }

    private OperationResult store(OperationKey key, String fingerprint, String generation, OperationResult result) {
        operations.compute(key, (ignored, current) -> {
            if (current == null || !current.generation().equals(generation)) return current;
            if (current.result() != null && current.result().state() == State.CANCELLED
                    && result.state() != State.CANCELLED) return current;
            return new OperationEntry(fingerprint, generation, result);
        });
        return status(new Scope(key.tenantId(), key.principalId()), key.operationId());
    }

    private static OperationResult failure(ParseRequest request, String generation, State state, String code, boolean retryable) {
        return failure(request.operationId(), generation, state, code, retryable);
    }

    private static OperationResult failure(String id, String generation, State state, String code, boolean retryable) {
        return new OperationResult(id, generation, state, Map.of(), code, retryable);
    }

    private static void verifyLocalSourceBinding(ParseRequest request) {
        if (!request.scope().tenantId().equals(request.source().tenantId())
                || !request.scope().principalId().equals(request.source().principalId())) {
            throw new IllegalArgumentException("source tenant/principal does not match caller scope");
        }
        if (!request.source().sourceVersion().equals(request.source().sourceVersion().trim())) {
            throw new IllegalArgumentException("sourceVersion is not canonical");
        }
        String actual = sha256(request.bytes);
        if (!request.source().sha256().equals("sha256:" + actual)) throw new IllegalArgumentException("source digest mismatch");
    }

    private String credential(Scope scope) {
        String token = credentials.bearerToken(scope);
        if (token == null || token.isBlank() || token.chars().anyMatch(Character::isWhitespace)) {
            throw new IllegalStateException("service credential is unavailable");
        }
        return token;
    }

    private String generationFor(ParseRequest request) {
        if (request.operationGeneration() != null) return request.operationGeneration();
        OperationEntry prior = operations.get(key(request.scope(), request.operationId()));
        return prior == null ? randomHex(16) : prior.generation();
    }

    private String fingerprint(ParseRequest request) {
        String sourceDigest = sha256(request.bytes);
        String fields = String.join("\n", request.scope().tenantId(), request.scope().principalId(),
                request.source().sourceRef(), request.source().sourceVersion(), sourceDigest,
                request.providerRef(), request.mediaType(), String.valueOf(request.languageHint()),
                String.valueOf(request.timeout().toMillis()), request.limits().toString());
        return sha256(fields.getBytes(StandardCharsets.UTF_8));
    }

    private static byte[] metadata(ParseRequest request, String generation) {
        var body = new LinkedHashMap<String, Object>();
        body.put("protocolVersion", PROTOCOL_VERSION);
        body.put("operationId", request.operationId());
        body.put("operationGeneration", generation);
        body.put("providerRef", request.providerRef());
        body.put("mediaType", request.mediaType());
        if (request.languageHint() != null) body.put("languageHint", request.languageHint());
        body.put("timeoutMs", request.timeout().toMillis());
        body.put("limits", request.limits());
        try { return JsonMapper.builder().build().writeValueAsBytes(body); }
        catch (Exception impossible) { throw new IllegalStateException("unable to encode request metadata", impossible); }
    }

    private byte[] multipart(String boundary, byte[] metadata, byte[] bytes) throws IOException {
        var out = new ByteArrayOutputStream(metadata.length + bytes.length + 256);
        out.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json; charset=utf-8\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(metadata);
        out.write(("\r\n--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"upload.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(bytes);
        out.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        return out.toByteArray();
    }

    private byte[] readBounded(InputStream stream) throws IOException {
        try (stream; var out = new ByteArrayOutputStream(Math.min(config.maxResponseBytes(), 16_384))) {
            byte[] buffer = new byte[8192];
            int total = 0;
            while (true) {
                int count = stream.read(buffer, 0, Math.min(buffer.length, config.maxResponseBytes() + 1 - total));
                if (count < 0) break;
                total += count;
                if (total > config.maxResponseBytes()) throw new IOException("DI response exceeds configured bound");
                out.write(buffer, 0, count);
            }
            return out.toByteArray();
        }
    }

    private Duration boundedTimeout(Duration timeout) {
        if (timeout == null || timeout.isZero() || timeout.isNegative() || timeout.compareTo(Duration.ofMinutes(2)) > 0) {
            throw new IllegalArgumentException("timeout must be in [1 ms,120000 ms]");
        }
        return timeout;
    }

    private static OperationKey key(Scope scope, String operationId) {
        return new OperationKey(scope.tenantId(), scope.principalId(), operationId);
    }

    private static String requiredString(JsonNode node, String key) {
        JsonNode value = node.path(key);
        if (!value.isTextual() || value.stringValue().isBlank()) throw new IllegalArgumentException("missing response field");
        return value.stringValue();
    }

    private static List<String> strings(JsonNode node) {
        if (node.isMissingNode() || node.isNull()) return List.of();
        if (!node.isArray() || node.size() > 128) throw new IllegalArgumentException("invalid response list");
        var values = new ArrayList<String>();
        for (JsonNode value : node) {
            if (!value.isTextual() || value.stringValue().length() > 128) throw new IllegalArgumentException("invalid response string");
            values.add(value.stringValue());
        }
        return List.copyOf(values);
    }

    private String randomHex(int byteCount) {
        byte[] bytes = new byte[byteCount]; secureRandom.nextBytes(bytes); return HexFormat.of().formatHex(bytes);
    }

    private static String encodePath(String value) { return java.net.URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20"); }
    private static String sha256(byte[] value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value)); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private static String text(String value, String name) {
        if (value == null || value.isBlank() || value.length() > 1024) throw new IllegalArgumentException(name + " is required and bounded");
        return value.trim();
    }
    private static String identifier(String value, String name) {
        if (value == null || !IDENTIFIER.matcher(value).matches()) throw new IllegalArgumentException(name + " is invalid");
        return value;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> deepImmutableMap(Map<String, Object> value) {
        var copy = new LinkedHashMap<String, Object>();
        value.forEach((key, item) -> copy.put(key, deepImmutable(item)));
        return Collections.unmodifiableMap(copy);
    }
    private static Object deepImmutable(Object value) {
        if (value instanceof Map<?, ?> map) {
            var copy = new LinkedHashMap<String, Object>();
            map.forEach((key, item) -> copy.put(String.valueOf(key), deepImmutable(item)));
            return Collections.unmodifiableMap(copy);
        }
        if (value instanceof List<?> list) return list.stream().map(DocumentIntelligenceClient::deepImmutable).toList();
        return value;
    }

    public static final class ClientException extends RuntimeException {
        private final String code;
        private final boolean retryable;
        public ClientException(String code, boolean retryable) { super(code); this.code = code; this.retryable = retryable; }
        public String code() { return code; }
        public boolean retryable() { return retryable; }
    }
}
