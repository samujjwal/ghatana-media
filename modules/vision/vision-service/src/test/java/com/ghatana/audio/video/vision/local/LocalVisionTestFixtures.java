package com.ghatana.audio.video.vision.local;

import com.sun.net.httpserver.HttpServer;

import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BiFunction;

/** Clearly named FIXTURE_ONLY helpers: synthetic model directories, a fake loopback sidecar, a generated image. */
final class LocalVisionTestFixtures {
    static final String FIXTURE_TOKEN = "fixture-only-token-0123456789abcdef";

    private LocalVisionTestFixtures() { }

    static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    /** Writes FIXTURE_ONLY files plus a matching manifest; the "weights" are a few bytes, never a model. */
    static Path modelDir(Path parent, String name, String modelId, String role, String spdx) throws IOException {
        Path dir = Files.createDirectory(parent.resolve(name));
        byte[] weights = ("FIXTURE_ONLY weights for " + name).getBytes(StandardCharsets.UTF_8);
        byte[] license = ("FIXTURE_ONLY licence text " + spdx).getBytes(StandardCharsets.UTF_8);
        Files.write(dir.resolve("model.safetensors"), weights);
        Files.write(dir.resolve("LICENSE"), license);
        List<String> entries = new ArrayList<>();
        entries.add(entry("LICENSE", license));
        entries.add(entry("model.safetensors", weights));
        String fileSet = sha256(("LICENSE:" + sha256(license) + "\nmodel.safetensors:" + sha256(weights) + "\n")
                .getBytes(StandardCharsets.UTF_8));
        String manifest = "{\"schemaVersion\":\"ghatana.media.local-model-manifest.v1\",\"modelId\":\"" + modelId
                + "\",\"role\":\"" + role + "\",\"sourceUrl\":\"https://example.invalid/fixture\",\"revision\":\""
                + "a".repeat(40) + "\",\"spdxLicense\":\"" + spdx + "\",\"licenseFile\":{\"path\":\"LICENSE\","
                + "\"sha256\":\"" + sha256(license) + "\",\"source\":\"fixture\"},\"files\":[" + String.join(",", entries)
                + "],\"fileSetSha256\":\"" + fileSet + "\",\"remoteCode\":{\"required\":false,\"files\":[]},"
                + "\"runtime\":{\"kind\":\"fixture\",\"quantization\":\"none\"},\"ownerDecision\":{\"quote\":\"fixture\","
                + "\"decidedOn\":\"2026-11-14\",\"channel\":\"user chat\"},\"attribution\":\"fixture\",\"obligations\":[]}";
        Files.writeString(dir.resolve(LocalModelManifest.MANIFEST_FILE), manifest);
        return dir;
    }

    private static String entry(String path, byte[] bytes) {
        return "{\"path\":\"" + path + "\",\"sha256\":\"" + sha256(bytes) + "\",\"sizeBytes\":" + bytes.length + "}";
    }

    static LocalModelAdmission florence(Path dir) {
        return new LocalModelAdmission(dir, LocalVisionEngine.FLORENCE_MODEL_ID, "VISION", "MIT");
    }

    static LocalModelAdmission qwen(Path dir) {
        return new LocalModelAdmission(dir, LocalVisionEngine.QWEN_MODEL_ID, "MULTIMODAL_QA", "Apache-2.0");
    }

    /** A loopback server standing in for the sidecar; the handler maps (path, body) to a JSON response. */
    static final class FakeSidecar implements AutoCloseable {
        final HttpServer server;
        final AtomicInteger inferenceCalls = new AtomicInteger();

        FakeSidecar(BiFunction<String, String, String> responder) throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", exchange -> {
                String auth = exchange.getRequestHeaders().getFirst("Authorization");
                String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                String path = exchange.getRequestURI().getPath();
                int status = 200;
                String response;
                if (!("Bearer " + FIXTURE_TOKEN).equals(auth)) {
                    status = 401;
                    response = "{\"error\":\"UNAUTHORIZED\"}";
                } else if (path.equals("/v1/health")) {
                    response = "{\"status\":\"UP\"}";
                } else {
                    inferenceCalls.incrementAndGet();
                    response = responder.apply(path, body);
                    if (response.startsWith("HTTP")) {
                        status = Integer.parseInt(response.substring(4, 7));
                        response = response.substring(8);
                    }
                }
                byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(status, bytes.length);
                exchange.getResponseBody().write(bytes);
                exchange.close();
            });
            server.start();
        }

        LocalVisionSidecarClient client() {
            return new LocalVisionSidecarClient(URI.create("http://127.0.0.1:" + server.getAddress().getPort()),
                    FIXTURE_TOKEN, Duration.ofSeconds(10));
        }

        @Override public void close() { server.stop(0); }
    }

    /** Renders text and two shapes with Java2D so OCR/VQA have something real to read. */
    static byte[] testImagePng() throws IOException {
        BufferedImage image = new BufferedImage(640, 480, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = image.createGraphics();
        try {
            g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
            g.setColor(Color.WHITE);
            g.fillRect(0, 0, 640, 480);
            g.setColor(new Color(220, 30, 30));
            g.fillRect(40, 160, 240, 240);
            g.setColor(new Color(30, 60, 220));
            g.fillOval(340, 180, 240, 240);
            g.setColor(Color.BLACK);
            g.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 56));
            g.drawString("HELLO GHATANA", 60, 95);
        } finally {
            g.dispose();
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "png", out);
        return out.toByteArray();
    }
}
