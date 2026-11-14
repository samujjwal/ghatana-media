package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaDevRenderAdmission.CapacityExhaustedException;
import com.sun.net.httpserver.HttpServer;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Bounded admission, per-tenant fairness, permit release, config validation and metric hygiene. */
class MediaDevRenderAdmissionTest {

    @Test
    void globalPoolAdmitsExactlyTheBoundAndRejectsWithoutRunningWork() throws Exception {
        MediaDevRenderAdmission admission = new MediaDevRenderAdmission(new SimpleMeterRegistry(), 2, 0);
        CountDownLatch inside = new CountDownLatch(2);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger executed = new AtomicInteger();
        ExecutorService pool = Executors.newFixedThreadPool(8);
        try {
            List<Future<String>> futures = new ArrayList<>();
            for (int i = 0; i < 6; i++) {
                String tenant = "t" + i;
                futures.add(pool.submit(() -> {
                    try {
                        return admission.run("render", "gif", tenant, () -> {
                            executed.incrementAndGet();
                            inside.countDown();
                            await(release);
                            return "ok";
                        });
                    } catch (CapacityExhaustedException refused) {
                        return "refused:" + refused.scope();
                    }
                }));
            }
            assertThat(inside.await(10, TimeUnit.SECONDS)).isTrue();
            // Wait until the four rejected callers have completed, then free the two holders.
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (futures.stream().filter(Future::isDone).count() < 4 && System.nanoTime() < deadline) {
                Thread.sleep(10);
            }
            release.countDown();
            List<String> results = new ArrayList<>();
            for (Future<String> future : futures) results.add(future.get(10, TimeUnit.SECONDS));
            assertThat(results).filteredOn("ok"::equals).hasSize(2);
            assertThat(results).filteredOn("refused:global"::equals).hasSize(4);
            assertThat(executed).hasValue(2);
            assertThat(admission.availableGlobalPermits()).isEqualTo(2);
            assertThat(admission.trackedTenants()).isZero();
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void tenantExhaustingItsBoundDoesNotBlockAnotherTenant() throws Exception {
        MediaDevRenderAdmission admission = new MediaDevRenderAdmission(new SimpleMeterRegistry(), 4, 1);
        CountDownLatch inside = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<String> holder = pool.submit(() -> admission.run("render", "gif", "tenant-a", () -> {
                inside.countDown();
                await(release);
                return "a1";
            }));
            assertThat(inside.await(10, TimeUnit.SECONDS)).isTrue();
            assertThatThrownBy(() -> admission.run("render", "gif", "tenant-a", () -> "a2"))
                    .isInstanceOfSatisfying(CapacityExhaustedException.class,
                            failure -> assertThat(failure.scope()).isEqualTo("tenant"));
            assertThat(admission.run("creative", "simulation", "tenant-b", () -> "b1")).isEqualTo("b1");
            release.countDown();
            assertThat(holder.get(10, TimeUnit.SECONDS)).isEqualTo("a1");
            assertThat(admission.run("render", "gif", "tenant-a", () -> "a3")).isEqualTo("a3");
            assertThat(admission.availableGlobalPermits()).isEqualTo(4);
            assertThat(admission.trackedTenants()).isZero();
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void permitsAreReleasedAfterTypedFailureAndUnexpectedException() {
        MediaDevRenderAdmission admission = new MediaDevRenderAdmission(new SimpleMeterRegistry(), 1, 1);
        assertThatThrownBy(() -> admission.run("render", "mp4", "t", () -> {
            throw new MediaDevProjectRenderRuntime.RenderNotSupportedException("X", "typed");
        })).isInstanceOf(MediaDevProjectRenderRuntime.RenderNotSupportedException.class);
        assertThatThrownBy(() -> admission.run("render", "mp4", "t", () -> {
            throw new IllegalStateException("boom");
        })).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> admission.run("render", "mp4", "t", () -> {
            throw new OutOfMemoryError("simulated");
        })).isInstanceOf(OutOfMemoryError.class);
        assertThat(admission.availableGlobalPermits()).isEqualTo(1);
        assertThat(admission.trackedTenants()).isZero();
        assertThat(admission.run("render", "mp4", "t", () -> "after")).isEqualTo("after");
    }

    @Test
    void configKeysAreValidatedWithSafeDefaults() {
        var defaults = MediaRuntimeConfig.fromEnvironment(java.util.Map.of(
                "MEDIA_RUNTIME_ENABLED", "true", "MEDIA_RUNTIME_ENVIRONMENT", "local",
                "MEDIA_LOCAL_STORES_ENABLED", "true", "MEDIA_LOCAL_PROVIDER_ENABLED", "true"));
        assertThat(defaults.devRenderMaxConcurrent()).isEqualTo(4);
        assertThat(defaults.devRenderMaxConcurrentPerTenant()).isEqualTo(2);
        assertThatThrownBy(() -> env("MEDIA_DEV_RENDER_MAX_CONCURRENT", "0"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("MEDIA_DEV_RENDER_MAX_CONCURRENT");
        assertThatThrownBy(() -> env("MEDIA_DEV_RENDER_MAX_CONCURRENT", "65"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> env("MEDIA_DEV_RENDER_MAX_CONCURRENT_PER_TENANT", "5"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("PER_TENANT");
        assertThatThrownBy(() -> env("MEDIA_DEV_RENDER_MAX_CONCURRENT_PER_TENANT", "-1"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> env("MEDIA_DEV_RENDER_MAX_CONCURRENT", "abc"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("must be an integer");
    }

    private static MediaRuntimeConfig env(String key, String value) {
        return MediaRuntimeConfig.fromEnvironment(java.util.Map.of(
                "MEDIA_RUNTIME_ENABLED", "true", "MEDIA_RUNTIME_ENVIRONMENT", "local",
                "MEDIA_LOCAL_STORES_ENABLED", "true", "MEDIA_LOCAL_PROVIDER_ENABLED", "true", key, value));
    }

    @Test
    void httpRenderRefusesWithTypedRetryable429WithoutArtifactThenRecoversAndExposesBoundedMetrics() throws Exception {
        Path root = Files.createTempDirectory("media-dev-render-capacity-");
        MediaRuntime runtime = MediaDevProjectRenderHttpTest.runtime(root, 1, 1);
        var projectStore = new MediaDevProjectRenderHttpTest.InMemoryManagedStore();
        var projects = new MediaDevProjectTimelineRuntime(projectStore);
        CountDownLatch inside = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger registrations = new AtomicInteger();
        AtomicInteger failuresToInject = new AtomicInteger();
        var canonical = MediaDevProjectRenderRuntime.canonicalRegistrar(runtime);
        MediaDevProjectRenderRuntime.OutputRegistrar registrar = (tenant, principal, request, key, bytes) -> {
            registrations.incrementAndGet();
            if (failuresToInject.getAndUpdate(v -> Math.max(0, v - 1)) > 0) {
                throw new IllegalStateException("injected registration failure");
            }
            if (inside.getCount() > 0 && "render-held".equals(request.metadata().get("requestId"))) {
                inside.countDown();
                await(release);
            }
            return canonical.register(tenant, principal, request, key, bytes);
        };
        HttpServer server = MediaDevProjectRenderHttpTest.server(runtime, projects,
                new MediaDevProjectRenderRuntime(runtime, projects, registrar));
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            String base = MediaDevProjectRenderHttpTest.base(server);
            var fixture = MediaDevProjectRenderHttpTest.twoClipProject(base, runtime, "capacity-project");
            String path = "/dev/v1/projects/" + fixture.projectId() + "/renders";
            Future<HttpResponse<String>> held = pool.submit(() -> MediaDevProjectRenderHttpTest.send(base, "POST", path,
                    MediaDevProjectRenderHttpTest.renderRequest("render-held", fixture.revisionId()),
                    "principal-local", MediaDevProjectRenderHttpTest.RENDER_PERMISSIONS));
            assertThat(inside.await(20, TimeUnit.SECONDS)).isTrue();

            HttpResponse<String> refused = MediaDevProjectRenderHttpTest.send(base, "POST", path,
                    MediaDevProjectRenderHttpTest.renderRequest("render-refused", fixture.revisionId()),
                    "principal-local", MediaDevProjectRenderHttpTest.RENDER_PERMISSIONS);
            assertThat(refused.statusCode()).as(refused.body()).isEqualTo(429);
            assertThat(refused.headers().firstValue("Retry-After")).contains("1");
            var error = MediaDevProjectRenderHttpTest.object(
                    MediaDevProjectRenderHttpTest.read(refused.body()).get("error"));
            assertThat(error).containsEntry("code", "RENDER_CAPACITY_EXHAUSTED").containsEntry("retryable", true);
            // No side effect: the refused request never reached the registrar.
            assertThat(registrations).hasValue(1);

            release.countDown();
            assertThat(held.get(20, TimeUnit.SECONDS).statusCode()).isEqualTo(201);

            // Permit released after a typed failure, then the retried refused request succeeds.
            failuresToInject.set(1);
            HttpResponse<String> failed = MediaDevProjectRenderHttpTest.send(base, "POST", path,
                    MediaDevProjectRenderHttpTest.renderRequest("render-refused", fixture.revisionId()),
                    "principal-local", MediaDevProjectRenderHttpTest.RENDER_PERMISSIONS);
            assertThat(failed.statusCode()).as(failed.body()).isEqualTo(502);
            HttpResponse<String> retried = MediaDevProjectRenderHttpTest.send(base, "POST", path,
                    MediaDevProjectRenderHttpTest.renderRequest("render-refused", fixture.revisionId()),
                    "principal-local", MediaDevProjectRenderHttpTest.RENDER_PERMISSIONS);
            assertThat(retried.statusCode()).as(retried.body()).isEqualTo(201);
            assertThat(runtime.devAdmission().availableGlobalPermits()).isEqualTo(1);

            String scrape = runtime.prometheusMetrics();
            assertThat(scrape)
                    .contains("media_dev_output_requests_total{format=\"gif\",lane=\"render\",outcome=\"success\"")
                    .contains("outcome=\"capacity_exhausted\"")
                    .contains("outcome=\"registration_failed\"")
                    .contains("media_dev_output_duration_seconds_count")
                    .contains("media_dev_output_in_flight{lane=\"render\"")
                    .doesNotContain("tenant-local").doesNotContain("principal-local")
                    .doesNotContain(fixture.projectId()).doesNotContain("render-held");
            scrape.lines().filter(line -> line.startsWith("media_dev_output")).forEach(line ->
                    assertThat(line.replaceAll("^[^{]*\\{([^}]*)}.*$", "$1").split(","))
                            .allMatch(label -> label.startsWith("lane=") || label.startsWith("format=")
                                    || label.startsWith("outcome=") || label.startsWith("application=")
                                    || label.startsWith("component=") || label.isEmpty()
                                    || label.startsWith("quantile=")|| label.startsWith("le="), line));
        } finally {
            release.countDown();
            pool.shutdownNow();
            server.stop(0);
            runtime.close();
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await(30, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }
}
