package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaCaptionContracts.MediaCaptionStore;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaSourceRightsAdministration;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** Verifies exact opaque source identity parsing on the caption-version read route. */
class MediaHttpCaptionVersionReadTest {
    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-11-07T12:00:00Z"), ZoneOffset.UTC);

    @Test
    void captionVersionReadPreservesLiteralAndPercentEncodedPlusInSourceIdentities() throws Exception {
        var root = Files.createTempDirectory("media-caption-version-read-");
        MediaRuntime runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "test", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                List.of(new LocalMediaRuntimeSupport.DiagnosticProcessor()),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        MediaCaptionStore captionStore = mock(MediaCaptionStore.class);
        when(captionStore.ready()).thenReturn(true);
        when(captionStore.versions(anyString(), anyString(), anyString(), anyString()))
                .thenReturn(List.of());
        MediaSourceRightsAdministration rights = mock(MediaSourceRightsAdministration.class);
        when(rights.ready()).thenReturn(true);
        MediaCaptionRuntime captions = new MediaCaptionRuntime(captionStore, rights, null, CLOCK);

        try {
            MediaHttpHandler handler = new MediaHttpHandler(runtime, null, captions);

            ExchangeResult rawPlus = request(handler,
                    "/api/v1/caption-versions?sourceArtifactId=source+one&sourceArtifactVersionId=version+one");
            ExchangeResult escapedPlus = request(handler,
                    "/api/v1/caption-versions?sourceArtifactId=source%2Bone&sourceArtifactVersionId=version%2Bone");

            assertThat(rawPlus.status()).as(rawPlus.body()).isEqualTo(200);
            assertThat(escapedPlus.status()).as(escapedPlus.body()).isEqualTo(200);
            org.mockito.ArgumentCaptor<String> artifactIds = org.mockito.ArgumentCaptor.forClass(String.class);
            org.mockito.ArgumentCaptor<String> versionIds = org.mockito.ArgumentCaptor.forClass(String.class);
            org.mockito.Mockito.verify(captionStore, org.mockito.Mockito.times(2))
                    .versions(org.mockito.ArgumentMatchers.eq("tenant-a"),
                            org.mockito.ArgumentMatchers.eq("principal-a"), artifactIds.capture(), versionIds.capture());
            assertThat(artifactIds.getAllValues()).containsExactly("source+one", "source+one");
            assertThat(versionIds.getAllValues()).containsExactly("version+one", "version+one");
        } finally {
            captions.close();
            runtime.close();
            try (var paths = Files.walk(root)) {
                for (var path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) {
                    Files.deleteIfExists(path);
                }
            }
        }
    }

    @Test
    void captionVersionReadRejectsDuplicateOpaqueIdentityWhenOneOccurrenceHasNoValue() throws Exception {
        var root = Files.createTempDirectory("media-caption-version-read-duplicate-");
        MediaRuntime runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "test", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(), null,
                List.of(new LocalMediaRuntimeSupport.DiagnosticProcessor()),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        MediaCaptionStore captionStore = mock(MediaCaptionStore.class);
        when(captionStore.ready()).thenReturn(true);
        MediaSourceRightsAdministration rights = mock(MediaSourceRightsAdministration.class);
        when(rights.ready()).thenReturn(true);
        MediaCaptionRuntime captions = new MediaCaptionRuntime(captionStore, rights, null, CLOCK);

        try {
            MediaHttpHandler handler = new MediaHttpHandler(runtime, null, captions);
            ExchangeResult result = request(handler,
                    "/api/v1/caption-versions?sourceArtifactId=source-a&sourceArtifactId"
                            + "&sourceArtifactVersionId=version-a");

            assertThat(result.status()).as(result.body()).isEqualTo(400);
            org.mockito.Mockito.verify(captionStore, org.mockito.Mockito.never())
                    .versions(anyString(), anyString(), anyString(), anyString());
        } finally {
            captions.close();
            runtime.close();
            try (var paths = Files.walk(root)) {
                for (var path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) {
                    Files.deleteIfExists(path);
                }
            }
        }
    }

    private static ExchangeResult request(MediaHttpHandler handler, String pathAndQuery) throws IOException {
        HttpExchange exchange = mock(HttpExchange.class);
        Headers requestHeaders = new Headers();
        Headers responseHeaders = new Headers();
        ByteArrayOutputStream responseBody = new ByteArrayOutputStream();
        AtomicInteger status = new AtomicInteger();
        when(exchange.getRequestURI()).thenReturn(URI.create("http://localhost" + pathAndQuery));
        when(exchange.getRequestMethod()).thenReturn("GET");
        when(exchange.getRequestHeaders()).thenReturn(requestHeaders);
        when(exchange.getAttribute(MediaSecurityFilter.AUTHENTICATED_PRINCIPAL_ATTRIBUTE))
                .thenReturn(new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                        "tenant-a", "principal-a", CLOCK.instant()));
        when(exchange.getResponseHeaders()).thenReturn(responseHeaders);
        when(exchange.getResponseBody()).thenReturn(responseBody);
        doAnswer(invocation -> {
            status.set((Integer) invocation.getArgument(0));
            return null;
        }).when(exchange).sendResponseHeaders(anyInt(), anyLong());

        handler.handle(exchange);
        return new ExchangeResult(status.get(), responseBody.toString(java.nio.charset.StandardCharsets.UTF_8));
    }

    private record ExchangeResult(int status, String body) { }
}
