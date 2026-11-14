package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.sun.net.httpserver.HttpExchange;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DEV_ONLY exact-byte artifact read, {@code GET /dev/v1/artifacts/{artifactId}/content}, outside the canonical
 * manifest/OpenAPI. The caller must name the exact immutable version ({@code version=sha256:<hex>} query and/or
 * {@code If-Match}); the whole object is verified (owner, version, size, SHA-256) before any byte is released, so a
 * failed verification yields a typed error and no content. Full reads and each range are bounded by a ceiling
 * ({@value #CEILING_ENV}); larger objects must be read through a single {@code Range: bytes=a-b | a- | -n}.
 */
final class MediaDevArtifactContentRoutes {
    static final String CEILING_ENV = "MEDIA_DEV_ARTIFACT_CONTENT_MAX_BYTES";
    static final long DEFAULT_CEILING_BYTES = 8L * 1024 * 1024;
    static final long MAX_CEILING_BYTES = 256L * 1024 * 1024;
    /** Content types safe to render inline; everything else is served as an attachment. */
    static final Set<String> INLINE_SAFE_TYPES = Set.of(
            "image/png", "image/gif", "image/jpeg", "video/mp4", "audio/wav");
    private static final Pattern PATH = Pattern.compile("^/dev/v1/artifacts/([^/]+)/content$");
    private static final Pattern RANGE = Pattern.compile("^bytes=(\\d{1,18})-(\\d{0,18})$");
    private static final Pattern SUFFIX = Pattern.compile("^bytes=-(\\d{1,18})$");

    private final MediaRuntime runtime;
    private final long ceilingBytes;

    MediaDevArtifactContentRoutes(MediaRuntime runtime, long ceilingBytes) {
        if (ceilingBytes < 1 || ceilingBytes > MAX_CEILING_BYTES) {
            throw new IllegalArgumentException(CEILING_ENV + " must be between 1 and " + MAX_CEILING_BYTES);
        }
        this.runtime = runtime;
        this.ceilingBytes = ceilingBytes;
    }

    static long ceilingFrom(Map<String, String> environment) {
        String raw = environment.get(CEILING_ENV);
        if (raw == null || raw.isBlank()) return DEFAULT_CEILING_BYTES;
        try {
            return Long.parseLong(raw.trim());
        } catch (NumberFormatException failure) {
            throw new IllegalArgumentException(CEILING_ENV + " must be an integer", failure);
        }
    }

    static boolean handles(String path) {
        return PATH.matcher(path).matches();
    }

    static boolean inlineSafe(String contentType) {
        String base = contentType.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        return INLINE_SAFE_TYPES.contains(base);
    }

    void handle(HttpExchange exchange, String path, String method, String tenantId, String principalId,
                MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        Matcher match = PATH.matcher(path);
        if (!match.matches()) {
            out.error(exchange, 404, "NOT_FOUND", "Artifact content route not found", Map.of());
            return;
        }
        if (!"GET".equals(method)) {
            exchange.getResponseHeaders().set("Allow", "GET");
            out.error(exchange, 405, "METHOD_NOT_ALLOWED", "Method not allowed", Map.of());
            return;
        }
        if (!MediaSecurityFilter.hasDevOnlyPermission(exchange, "media:artifact:read")) {
            runtime.recordDeniedRequest();
            out.error(exchange, 403, "ARTIFACT_PERMISSION_REQUIRED",
                    "DEV_ONLY artifact read permission is required", Map.of());
            return;
        }
        String artifactId = segment(match.group(1));
        Optional<ArtifactVersion> expected = expectedVersion(exchange, out);
        if (expected == null) return;
        if (expected.isEmpty()) {
            out.error(exchange, 400, "ARTIFACT_VERSION_REQUIRED",
                    "An explicit expected version (query version=sha256:<hex> or If-Match) is required", Map.of());
            return;
        }
        Optional<MediaArtifact> found;
        try {
            found = runtime.artifact(tenantId, principalId, artifactId);
        } catch (IllegalStateException failure) {
            out.error(exchange, 409, "ARTIFACT_CONTENT_INTEGRITY_FAILED",
                    "Artifact record does not match its immutable version; no bytes were released", Map.of());
            return;
        }
        if (found.isEmpty()) {
            out.error(exchange, 404, "ARTIFACT_NOT_FOUND", "Artifact is not available in this tenant and owner scope",
                    Map.of());
            return;
        }
        MediaArtifact artifact = found.get();
        if (!artifact.version().equals(expected.get())) {
            out.error(exchange, 412, "ARTIFACT_VERSION_MISMATCH",
                    "The artifact's immutable version does not match the expected version", Map.of());
            return;
        }
        long total = artifact.sizeBytes();
        String rangeHeader = exchange.getRequestHeaders().getFirst("Range");
        long offset = 0;
        long length = total;
        boolean ranged = rangeHeader != null;
        if (ranged) {
            long[] window = parseRange(rangeHeader.trim(), total);
            if (window == null) {
                exchange.getResponseHeaders().set("Content-Range", "bytes */" + total);
                out.error(exchange, 416, "RANGE_NOT_SATISFIABLE",
                        "Range must be a single satisfiable bytes=a-b, bytes=a- or bytes=-n", Map.of("totalSize", total));
                return;
            }
            offset = window[0];
            length = window[1];
        }
        if (length > ceilingBytes) {
            out.error(exchange, 413, "ARTIFACT_CONTENT_TOO_LARGE",
                    "The requested content exceeds the DEV_ONLY read ceiling; use a smaller Range request",
                    Map.of("maxBytes", ceilingBytes, "totalSize", total));
            return;
        }
        ByteArrayOutputStream buffer = new ByteArrayOutputStream((int) Math.min(length, 1 << 20));
        try {
            if (ranged) {
                var receipt = runtime.copyArtifactContentRange(tenantId, principalId, artifactId, expected.get(),
                        offset, length, buffer, ceilingBytes);
                if (receipt.isEmpty()) { notFound(exchange, out); return; }
                if (receipt.get().totalSize() != total || receipt.get().bytesCopied() != length) {
                    throw new IOException("Range receipt does not match the artifact record");
                }
            } else {
                var receipt = runtime.copyArtifactContent(tenantId, principalId, artifactId, expected.get(),
                        buffer, ceilingBytes);
                if (receipt.isEmpty()) { notFound(exchange, out); return; }
                if (receipt.get().bytesCopied() != total) {
                    throw new IOException("Content receipt does not match the artifact record");
                }
            }
        } catch (IOException failure) {
            // Nothing has been written to the exchange: verification failed before any byte was released.
            out.error(exchange, 500, "ARTIFACT_CONTENT_INTEGRITY_FAILED",
                    "Artifact content could not be verified; no bytes were released", Map.of());
            return;
        } catch (IllegalStateException failure) {
            // The store detected digest/size drift of the immutable object; nothing has been written.
            out.error(exchange, 409, "ARTIFACT_CONTENT_INTEGRITY_FAILED",
                    "Artifact content does not match its immutable version; no bytes were released", Map.of());
            return;
        } catch (IllegalArgumentException failure) {
            String message = String.valueOf(failure.getMessage());
            if (message.contains("RANGE_NOT_SATISFIABLE")) {
                exchange.getResponseHeaders().set("Content-Range", "bytes */" + total);
                out.error(exchange, 416, "RANGE_NOT_SATISFIABLE", "Range is not satisfiable", Map.of("totalSize", total));
                return;
            }
            if (message.contains("READ_LIMIT") || message.contains("RANGE_LIMIT")) {
                out.error(exchange, 413, "ARTIFACT_CONTENT_TOO_LARGE",
                        "The requested content exceeds the DEV_ONLY read ceiling; use a smaller Range request",
                        Map.of("maxBytes", ceilingBytes, "totalSize", total));
                return;
            }
            throw failure;
        }
        byte[] bytes = buffer.toByteArray();
        var headers = exchange.getResponseHeaders();
        headers.set("Content-Type", artifact.contentType());
        headers.set("ETag", "\"" + artifact.version().value() + "\"");
        headers.set("Accept-Ranges", "bytes");
        headers.set("Cache-Control", "private, no-store");
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
        headers.set("Content-Disposition", inlineSafe(artifact.contentType()) ? "inline"
                : "attachment; filename=\"" + asciiFileName(artifact.fileName()) + "\"");
        if (ranged) {
            headers.set("Content-Range", "bytes " + offset + "-" + (offset + bytes.length - 1) + "/" + total);
        }
        exchange.sendResponseHeaders(ranged ? 206 : 200, bytes.length);
        try (var output = exchange.getResponseBody()) { output.write(bytes); }
    }

    private void notFound(HttpExchange exchange, MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        out.error(exchange, 404, "ARTIFACT_NOT_FOUND", "Artifact is not available in this tenant and owner scope",
                Map.of());
    }

    /** Returns {@code null} after writing a typed 400/412 error, otherwise the (possibly empty) expected version. */
    private Optional<ArtifactVersion> expectedVersion(HttpExchange exchange,
                                                      MediaDevCreativeOutputRoutes.Responder out) throws IOException {
        ArtifactVersion fromQuery = null;
        String query = exchange.getRequestURI().getRawQuery();
        if (query != null && !query.isEmpty()) {
            for (String pair : query.split("&")) {
                int eq = pair.indexOf('=');
                String key = eq < 0 ? pair : pair.substring(0, eq);
                if (!"version".equals(key)) {
                    out.error(exchange, 400, "ARTIFACT_CONTENT_QUERY_INVALID",
                            "Only the version query parameter is supported", Map.of());
                    return null;
                }
                if (fromQuery != null) {
                    out.error(exchange, 400, "ARTIFACT_VERSION_INVALID", "version must appear at most once", Map.of());
                    return null;
                }
                fromQuery = parseVersion(eq < 0 ? "" : URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8));
                if (fromQuery == null) {
                    out.error(exchange, 400, "ARTIFACT_VERSION_INVALID",
                            "version must be sha256:<64 lowercase hex>", Map.of());
                    return null;
                }
            }
        }
        ArtifactVersion fromHeader = null;
        List<String> ifMatch = exchange.getRequestHeaders().get("If-Match");
        if (ifMatch != null) {
            if (ifMatch.size() != 1) {
                out.error(exchange, 400, "ARTIFACT_VERSION_INVALID", "If-Match must appear once", Map.of());
                return null;
            }
            String raw = ifMatch.get(0).trim();
            if (raw.length() >= 2 && raw.startsWith("\"") && raw.endsWith("\"")) raw = raw.substring(1, raw.length() - 1);
            fromHeader = parseVersion(raw);
            if (fromHeader == null) {
                out.error(exchange, 400, "ARTIFACT_VERSION_INVALID",
                        "If-Match must be one strong ETag sha256:<64 lowercase hex>", Map.of());
                return null;
            }
        }
        if (fromQuery != null && fromHeader != null && !fromQuery.equals(fromHeader)) {
            out.error(exchange, 412, "ARTIFACT_VERSION_MISMATCH",
                    "version and If-Match name different versions", Map.of());
            return null;
        }
        return Optional.ofNullable(fromQuery != null ? fromQuery : fromHeader);
    }

    private static ArtifactVersion parseVersion(String value) {
        try {
            return new ArtifactVersion(value);
        } catch (IllegalArgumentException invalid) {
            return null;
        }
    }

    /** {@code [offset, length]} or {@code null} when malformed, multi-range or unsatisfiable. */
    static long[] parseRange(String header, long total) {
        Matcher suffix = SUFFIX.matcher(header);
        if (suffix.matches()) {
            long n = Long.parseLong(suffix.group(1));
            if (n < 1) return null;
            long length = Math.min(n, total);
            return new long[] {total - length, length};
        }
        Matcher range = RANGE.matcher(header);
        if (!range.matches()) return null;
        long start = Long.parseLong(range.group(1));
        if (start >= total) return null;
        long end = range.group(2).isEmpty() ? total - 1 : Math.min(Long.parseLong(range.group(2)), total - 1);
        if (end < start) return null;
        return new long[] {start, end - start + 1};
    }

    private static String asciiFileName(String name) {
        StringBuilder safe = new StringBuilder();
        for (char c : name.toCharArray()) {
            safe.append(c >= 0x20 && c < 0x7f && c != '"' && c != '\\' && c != '%' ? c : '_');
        }
        return safe.length() == 0 ? "artifact" : safe.toString();
    }

    private static String segment(String raw) {
        String decoded = URLDecoder.decode(raw.replace("+", "%2B"), StandardCharsets.UTF_8);
        if (decoded.indexOf('/') >= 0 || decoded.indexOf('\\') >= 0) {
            throw new IllegalArgumentException("Path identifier must not contain a separator");
        }
        return decoded;
    }
}
