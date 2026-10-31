package com.ghatana.audio.video.vision.scenetext;

import com.ghatana.audio.video.vision.scenetext.DocumentIntelligenceException.Kind;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.regex.Pattern;

/**
 * Reviewed {@code java.net.http} consumer of the frozen DI v1 HTTP API. It performs
 * transport, strict response validation and generation-fenced cancellation only;
 * provider selection and OCR inference stay inside Document Intelligence.
 *
 * @doc.type class
 * @doc.purpose DI v1 HTTP client for Media Vision scene-text
 * @doc.layer product
 * @doc.pattern Adapter
 */
public final class DocumentIntelligenceHttpClient implements DocumentIntelligenceV1 {

    private static final Pattern IDENTIFIER = Pattern.compile("[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}");
    private static final Pattern MODEL_REF = Pattern.compile("[A-Za-z0-9][A-Za-z0-9_.:-]*(/[A-Za-z0-9][A-Za-z0-9_.:-]*)?");
    private static final Pattern GENERATION = Pattern.compile("[0-9a-f]{32}");
    private static final int MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

    private final URI baseUri;
    private final HttpClient http;
    private final ObjectMapper mapper = JsonMapper.builder().build();
    private final Duration catalogTimeout;
    private final long maxUploadBytes;

    public DocumentIntelligenceHttpClient(URI baseUri, HttpClient http, Duration catalogTimeout, long maxUploadBytes) {
        String base = baseUri.toString();
        this.baseUri = URI.create(base.endsWith("/") ? base.substring(0, base.length() - 1) : base);
        if (!"http".equals(this.baseUri.getScheme()) && !"https".equals(this.baseUri.getScheme())) {
            throw new IllegalArgumentException("DI base URI must be http(s)");
        }
        this.http = http;
        this.catalogTimeout = catalogTimeout;
        this.maxUploadBytes = maxUploadBytes;
    }

    @Override
    public ProviderCatalog providers(Cancellation cancellation) throws DocumentIntelligenceException {
        HttpRequest request = HttpRequest.newBuilder(baseUri.resolve(baseUri.getPath() + "/v1/providers"))
                .timeout(catalogTimeout).GET().build();
        JsonNode body = send(request, cancellation, null, null);
        try {
            return catalog(body);
        } catch (RuntimeException invalid) {
            throw DocumentIntelligenceException.of(Kind.INVALID_RESPONSE);
        }
    }

    @Override
    public ParsedDocument parse(ParseRequest request, Cancellation cancellation) throws DocumentIntelligenceException {
        if (!GENERATION.matcher(request.operationGeneration()).matches() || !IDENTIFIER.matcher(request.operationId()).matches()) {
            throw new IllegalArgumentException("invalid DI operation identity");
        }
        byte[] bytes = request.bytes();
        if (bytes.length > maxUploadBytes) throw DocumentIntelligenceException.of(Kind.SOURCE_TOO_LARGE);
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("protocolVersion", PROTOCOL_VERSION);
        metadata.put("operationId", request.operationId());
        metadata.put("operationGeneration", request.operationGeneration());
        metadata.put("providerRef", request.providerRef());
        metadata.put("mediaType", request.mediaType());
        request.languageHint().ifPresent(hint -> metadata.put("languageHint", hint));
        metadata.put("timeoutMs", request.timeoutMs());
        metadata.put("limits", request.limits());
        String boundary = "di-" + UUID.randomUUID();
        HttpRequest httpRequest = HttpRequest.newBuilder(baseUri.resolve(baseUri.getPath() + "/v1/parse"))
                .timeout(Duration.ofMillis(request.timeoutMs()))
                .header("content-type", "multipart/form-data; boundary=" + boundary)
                .header("x-operation-generation", request.operationGeneration())
                .POST(HttpRequest.BodyPublishers.ofByteArray(multipart(boundary, mapper.writeValueAsBytes(metadata), bytes)))
                .build();
        JsonNode body = send(httpRequest, cancellation, request.operationId(), request.operationGeneration());
        ParsedDocument parsed;
        try {
            parsed = parsed(body);
        } catch (RuntimeException invalid) {
            throw DocumentIntelligenceException.of(Kind.INVALID_RESPONSE);
        }
        if (!parsed.operationId().equals(request.operationId()) || !parsed.providerRef().equals(request.providerRef())) {
            throw DocumentIntelligenceException.of(Kind.INVALID_RESPONSE);
        }
        return parsed;
    }

    @Override
    public void cancel(String operationId, String operationGeneration) {
        if (!GENERATION.matcher(operationGeneration).matches()) throw new IllegalArgumentException("invalid generation");
        HttpRequest request = HttpRequest.newBuilder(baseUri.resolve(baseUri.getPath() + "/v1/operations/"
                        + URLEncoder.encode(operationId, StandardCharsets.UTF_8)))
                .timeout(catalogTimeout).header("x-operation-generation", operationGeneration).DELETE().build();
        // Cancellation is idempotent per generation; transport errors must not surface.
        http.sendAsync(request, HttpResponse.BodyHandlers.discarding()).exceptionally(error -> null);
    }

    private JsonNode send(HttpRequest request, Cancellation cancellation, String operationId, String generation)
            throws DocumentIntelligenceException {
        if (cancellation.isCancelled()) throw DocumentIntelligenceException.of(Kind.CANCELLED);
        CompletableFuture<HttpResponse<byte[]>> pending = http.sendAsync(request, HttpResponse.BodyHandlers.ofByteArray());
        Runnable unregister = cancellation.onCancel(() -> pending.cancel(true));
        HttpResponse<byte[]> response;
        try {
            response = pending.get();
        } catch (CancellationException | InterruptedException cancelled) {
            if (cancelled instanceof InterruptedException) Thread.currentThread().interrupt();
            if (generation != null) cancel(operationId, generation);
            throw DocumentIntelligenceException.of(Kind.CANCELLED);
        } catch (ExecutionException failure) {
            if (cancellation.isCancelled()) {
                if (generation != null) cancel(operationId, generation);
                throw DocumentIntelligenceException.of(Kind.CANCELLED);
            }
            throw DocumentIntelligenceException.of(failure.getCause() instanceof java.net.http.HttpTimeoutException
                    ? Kind.TIMEOUT : Kind.UNAVAILABLE);
        } finally {
            unregister.run();
        }
        if (cancellation.isCancelled()) {
            if (generation != null) cancel(operationId, generation);
            throw DocumentIntelligenceException.of(Kind.CANCELLED);
        }
        byte[] raw = response.body();
        if (raw == null || raw.length > MAX_RESPONSE_BYTES) throw DocumentIntelligenceException.of(Kind.INVALID_RESPONSE);
        JsonNode body;
        try {
            body = mapper.readTree(raw);
        } catch (RuntimeException malformed) {
            body = null;
        }
        if (response.statusCode() / 100 != 2) throw workerError(body);
        if (body == null || !body.isObject()) throw DocumentIntelligenceException.of(Kind.INVALID_RESPONSE);
        return body;
    }

    private static DocumentIntelligenceException workerError(JsonNode body) {
        try {
            keys(body, Set.of("protocolVersion", "operationId", "code", "retryable", "providerRef"),
                    Set.of("protocolVersion", "operationId", "code", "retryable"));
            if (!PROTOCOL_VERSION.equals(text(body, "protocolVersion")) || !body.get("retryable").isBoolean()) {
                throw new IllegalArgumentException();
            }
            String code = identifier(body, "code", 64);
            return new DocumentIntelligenceException(Kind.WORKER_ERROR, code, body.get("retryable").booleanValue());
        } catch (RuntimeException unrecognized) {
            return DocumentIntelligenceException.of(Kind.INVALID_RESPONSE);
        }
    }

    static ProviderCatalog catalog(JsonNode body) {
        keys(body, Set.of("protocolVersion", "workerCapabilityVersion", "providers"), Set.of("protocolVersion", "providers"));
        if (!PROTOCOL_VERSION.equals(text(body, "protocolVersion"))) throw new IllegalArgumentException("protocol");
        JsonNode providers = body.get("providers");
        if (!providers.isArray() || providers.size() > 256) throw new IllegalArgumentException("providers");
        List<ProviderEntry> entries = new ArrayList<>();
        for (JsonNode provider : providers) {
            if (!provider.isObject() || !provider.has("providerRef") || !provider.has("providerVersion")
                    || !provider.has("promotionStatus") || !provider.has("loaded") || !provider.has("ready")) {
                throw new IllegalArgumentException("provider entry");
            }
            String status = text(provider, "promotionStatus");
            if (!"ACCEPTED".equals(status) && !"UNPROMOTED".equals(status)) throw new IllegalArgumentException("promotion");
            if (!provider.get("loaded").isBoolean() || !provider.get("ready").isBoolean()) throw new IllegalArgumentException("flags");
            Optional<String> modelRef = optionalModelRef(provider);
            Optional<String> modelVersion = optionalIdentifier(provider, "modelVersion", 128);
            if (modelRef.isPresent() != modelVersion.isPresent()) throw new IllegalArgumentException("model identity");
            entries.add(new ProviderEntry(identifier(provider, "providerRef", 256), identifier(provider, "providerVersion", 128),
                    modelRef, modelVersion, strings(provider, "mediaTypes"), strings(provider, "supportedLanguages"),
                    status, provider.get("loaded").booleanValue(), provider.get("ready").booleanValue()));
        }
        String worker = body.has("workerCapabilityVersion") ? text(body, "workerCapabilityVersion") : null;
        return new ProviderCatalog(PROTOCOL_VERSION, worker, entries);
    }

    static ParsedDocument parsed(JsonNode body) {
        keys(body, Set.of("protocolVersion", "operationId", "providerRef", "pages", "providerProvenance", "quality", "languageTag"),
                Set.of("protocolVersion", "operationId", "providerRef", "pages", "providerProvenance", "quality"));
        if (!PROTOCOL_VERSION.equals(text(body, "protocolVersion"))) throw new IllegalArgumentException("protocol");
        String providerRef = identifier(body, "providerRef", 256);
        JsonNode provenanceNode = body.get("providerProvenance");
        keys(provenanceNode, Set.of("providerRef", "providerVersion", "modelRef", "modelVersion"), Set.of("providerRef", "providerVersion"));
        Optional<String> modelRef = optionalModelRef(provenanceNode);
        Optional<String> modelVersion = optionalIdentifier(provenanceNode, "modelVersion", 128);
        if (modelRef.isPresent() != modelVersion.isPresent()) throw new IllegalArgumentException("model identity");
        Provenance provenance = new Provenance(identifier(provenanceNode, "providerRef", 256),
                identifier(provenanceNode, "providerVersion", 128), modelRef, modelVersion);
        if (!provenance.providerRef().equals(providerRef)) throw new IllegalArgumentException("provenance mismatch");
        JsonNode pages = body.get("pages");
        if (!pages.isArray() || pages.size() > 500) throw new IllegalArgumentException("pages");
        List<Page> parsedPages = new ArrayList<>();
        for (JsonNode page : pages) {
            keys(page, Set.of("pageNumber", "blocks", "tables", "languageTag"), Set.of("pageNumber", "blocks", "tables"));
            JsonNode blocks = page.get("blocks");
            if (!page.get("pageNumber").isIntegralNumber() || page.get("pageNumber").intValue() < 1
                    || !blocks.isArray() || !page.get("tables").isArray()) {
                throw new IllegalArgumentException("page");
            }
            List<Block> parsedBlocks = new ArrayList<>();
            for (JsonNode block : blocks) {
                keys(block, Set.of("blockId", "kind", "boundingRegion", "lines", "confidence", "languageTag"),
                        Set.of("blockId", "kind", "boundingRegion", "lines"));
                JsonNode lines = block.get("lines");
                if (!lines.isArray() || lines.size() > 2_000) throw new IllegalArgumentException("lines");
                List<Line> parsedLines = new ArrayList<>();
                for (JsonNode line : lines) {
                    keys(line, Set.of("lineId", "text", "boundingRegion", "confidence", "languageTag"),
                            Set.of("lineId", "text", "boundingRegion"));
                    JsonNode text = line.get("text");
                    if (!text.isString() || text.stringValue().length() > 1_000_000) throw new IllegalArgumentException("text");
                    parsedLines.add(new Line(boundedText(line, "lineId", 256), text.stringValue(), box(line.get("boundingRegion")),
                            optionalUnit(line, "confidence"), optionalText(line, "languageTag", 64)));
                }
                parsedBlocks.add(new Block(boundedText(block, "blockId", 256), boundedText(block, "kind", 256),
                        box(block.get("boundingRegion")), parsedLines));
            }
            parsedPages.add(new Page(page.get("pageNumber").intValue(), parsedBlocks, page.get("tables").size()));
        }
        return new ParsedDocument(PROTOCOL_VERSION, identifier(body, "operationId", 256), providerRef, provenance, parsedPages);
    }

    private static Box box(JsonNode node) {
        keys(node, Set.of("x", "y", "width", "height"), Set.of("x", "y", "width", "height"));
        double x = unit(node.get("x"));
        double y = unit(node.get("y"));
        double width = unit(node.get("width"));
        double height = unit(node.get("height"));
        if (x + width > 1 || y + height > 1) throw new IllegalArgumentException("box");
        return new Box(x, y, width, height);
    }

    private static double unit(JsonNode node) {
        if (node == null || !node.isNumber() || !Double.isFinite(node.doubleValue()) || node.doubleValue() < 0 || node.doubleValue() > 1) {
            throw new IllegalArgumentException("unit");
        }
        return node.doubleValue();
    }

    private static Optional<Double> optionalUnit(JsonNode node, String key) {
        return node.has(key) ? Optional.of(unit(node.get(key))) : Optional.empty();
    }

    private static void keys(JsonNode node, Set<String> allowed, Set<String> required) {
        if (node == null || !node.isObject()) throw new IllegalArgumentException("object");
        for (String name : node.propertyNames()) if (!allowed.contains(name)) throw new IllegalArgumentException("unknown key");
        for (String name : required) if (!node.has(name)) throw new IllegalArgumentException("missing key");
    }

    private static String text(JsonNode node, String key) {
        JsonNode value = node.get(key);
        if (value == null || !value.isString() || value.stringValue().isEmpty()) throw new IllegalArgumentException(key);
        return value.stringValue();
    }

    private static String boundedText(JsonNode node, String key, int limit) {
        String value = text(node, key);
        if (value.length() > limit) throw new IllegalArgumentException(key);
        return value;
    }

    private static Optional<String> optionalText(JsonNode node, String key, int limit) {
        return node.has(key) ? Optional.of(boundedText(node, key, limit)) : Optional.empty();
    }

    private static String identifier(JsonNode node, String key, int limit) {
        String value = text(node, key);
        if (value.length() > limit || !IDENTIFIER.matcher(value).matches()) throw new IllegalArgumentException(key);
        return value;
    }

    private static Optional<String> optionalIdentifier(JsonNode node, String key, int limit) {
        return node.has(key) ? Optional.of(identifier(node, key, limit)) : Optional.empty();
    }

    private static Optional<String> optionalModelRef(JsonNode node) {
        if (!node.has("modelRef")) return Optional.empty();
        String value = text(node, "modelRef");
        if (value.length() > 256 || !MODEL_REF.matcher(value).matches()) throw new IllegalArgumentException("modelRef");
        return Optional.of(value);
    }

    private static List<String> strings(JsonNode node, String key) {
        if (!node.has(key)) return List.of();
        JsonNode values = node.get(key);
        if (!values.isArray()) throw new IllegalArgumentException(key);
        List<String> out = new ArrayList<>();
        for (JsonNode value : values) {
            if (!value.isString() || value.stringValue().isEmpty() || value.stringValue().length() > 256) throw new IllegalArgumentException(key);
            out.add(value.stringValue());
        }
        return out;
    }

    private static byte[] multipart(String boundary, byte[] metadata, byte[] file) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(file.length + metadata.length + 512);
        String crlf = "\r\n";
        out.writeBytes(("--" + boundary + crlf + "Content-Disposition: form-data; name=\"metadata\"" + crlf
                + "Content-Type: application/json" + crlf + crlf).getBytes(StandardCharsets.UTF_8));
        out.writeBytes(metadata);
        out.writeBytes((crlf + "--" + boundary + crlf + "Content-Disposition: form-data; name=\"file\"; filename=\"upload.bin\"" + crlf
                + "Content-Type: application/octet-stream" + crlf + crlf).getBytes(StandardCharsets.UTF_8));
        out.writeBytes(file);
        out.writeBytes((crlf + "--" + boundary + "--" + crlf).getBytes(StandardCharsets.UTF_8));
        return out.toByteArray();
    }
}
