package com.ghatana.audiovideo.observability.performance;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

class MediaResourceProfileHarnessTest {
    @Test
    void profilesBoundedLocalFixtureAtRegisteredConcurrencyLevels() throws IOException, InterruptedException {
        List<MediaResourceProfileHarness.Report> reports = new ArrayList<>();
        for (int concurrency : MediaResourceProfileHarness.REQUIRED_CONCURRENCY_LEVELS) {
            reports.add(MediaResourceProfileHarness.measure(concurrency, 96, Duration.ofSeconds(5), index ->
                    TimeUnit.MILLISECONDS.sleep(1)));
        }

        for (int i = 0; i < reports.size(); i++) {
            MediaResourceProfileHarness.Report report = reports.get(i);
            assertThat(report.concurrency())
                    .isEqualTo(MediaResourceProfileHarness.REQUIRED_CONCURRENCY_LEVELS[i]);
            assertThat(report.outcome()).isEqualTo(MediaResourceProfileHarness.Outcome.COMPLETED);
            assertThat(report.workerPoolTerminated()).isTrue();
            assertThat(report.requestedOperations()).isEqualTo(96);
            assertThat(report.completedOperations()).isEqualTo(96);
            assertThat(report.failedOperations()).isZero();
            assertThat(report.incompleteOperations()).isZero();
            assertThat(report.throughputOperationsPerSecond()).isPositive();
            assertThat(report.p50Millis()).isGreaterThanOrEqualTo(0.0);
            assertThat(report.p95Millis()).isGreaterThanOrEqualTo(report.p50Millis());
            assertThat(report.p99Millis()).isGreaterThanOrEqualTo(report.p95Millis());
            assertThat(report.resources().get(MediaResourceProfileHarness.Resource.HEAP_PEAK_BYTES).state())
                    .isEqualTo(MediaResourceProfileHarness.State.MEASURED);
            String operatingSystem = report.environment().operatingSystem().toLowerCase(java.util.Locale.ROOT);
            MediaResourceProfileHarness.Reading processRss = report.resources()
                    .get(MediaResourceProfileHarness.Resource.PROCESS_RSS_BYTES);
            if (operatingSystem.contains("linux") || operatingSystem.contains("mac")
                    || operatingSystem.contains("darwin")) {
                assertThat(processRss.state()).isEqualTo(MediaResourceProfileHarness.State.MEASURED);
                assertThat(processRss.value()).isPositive();
            } else {
                assertThat(processRss.state()).isEqualTo(MediaResourceProfileHarness.State.NOT_MEASURED);
                assertThat(processRss.reason()).isNotBlank();
            }
            assertThat(report.resources().get(MediaResourceProfileHarness.Resource.THREAD_PEAK).state())
                    .isEqualTo(MediaResourceProfileHarness.State.MEASURED);
            for (MediaResourceProfileHarness.Resource resource : EnumSet.of(
                    MediaResourceProfileHarness.Resource.GPU_MEMORY_BYTES,
                    MediaResourceProfileHarness.Resource.NATIVE_MEMORY_BYTES,
                    MediaResourceProfileHarness.Resource.CONNECTION_POOL_SIZE,
                    MediaResourceProfileHarness.Resource.NETWORK_BYTES,
                    MediaResourceProfileHarness.Resource.FFMPEG_CHILD_PROCESSES,
                    MediaResourceProfileHarness.Resource.MODEL_REAL_TIME_FACTOR,
                    MediaResourceProfileHarness.Resource.VIDEO_FRAMES_PER_SECOND)) {
                assertThat(report.resources().get(resource).state())
                        .as("unwired external resource %s stays explicitly unmeasured", resource)
                        .isEqualTo(MediaResourceProfileHarness.State.NOT_MEASURED);
            }
            for (MediaResourceProfileHarness.Resource resource : EnumSet.of(
                    MediaResourceProfileHarness.Resource.CONTAINER_MEMORY_LIMIT_BYTES,
                    MediaResourceProfileHarness.Resource.CONTAINER_CPU_LIMIT_CORES,
                    MediaResourceProfileHarness.Resource.CONTAINER_PROCESS_LIMIT)) {
                MediaResourceProfileHarness.Reading reading = report.resources().get(resource);
                if (reading.state() == MediaResourceProfileHarness.State.NOT_MEASURED) {
                    assertThat(reading.reason()).as("unavailable cgroup value has a reason").isNotBlank();
                    assertThat(report.toTsv()).contains("NOT_MEASURED:" + reading.reason());
                } else {
                    assertThat(reading.value()).as("observed cgroup limit is nonnegative").isGreaterThanOrEqualTo(0.0);
                }
            }
            assertThat(report.environment().modelProfile()).isEqualTo("NOT_CONFIGURED");
            assertThat(report.environment().corpusProfile()).isEqualTo("NOT_CONFIGURED");
            assertThat(report.toTsv()).startsWith("local-test-workload-no-provider\t");
            assertThat(report.toTsv()).contains("NOT_ADMITTED", "NOT_MEASURED");
        }

        String artifactPath = System.getenv("MEDIA_RESOURCE_PROFILE_OUTPUT");
        if (artifactPath != null && !artifactPath.isBlank()) {
            Path output = Path.of(artifactPath).toAbsolutePath();
            Path parent = output.getParent();
            if (parent != null) Files.createDirectories(parent);
            String contents = MediaResourceProfileHarness.Report.tsvHeader() + "\n"
                    + reports.stream().map(MediaResourceProfileHarness.Report::toTsv)
                            .collect(java.util.stream.Collectors.joining("\n"))
                    + "\n";
            Files.writeString(output, contents);
        }
    }

    @Test
    void rejectsUnboundedOrNonPlanConcurrencyBeforeRunningOperations() {
        assertThatIllegalArgumentException().isThrownBy(() -> MediaResourceProfileHarness.measure(
                8, 1, Duration.ofSeconds(1), index -> { throw new AssertionError("must not run"); }));
        assertThatIllegalArgumentException().isThrownBy(() -> MediaResourceProfileHarness.measure(
                64, MediaResourceProfileHarness.MAX_OPERATIONS + 1, Duration.ofSeconds(1),
                index -> { throw new AssertionError("must not run"); }));
        assertThatIllegalArgumentException().isThrownBy(() -> MediaResourceProfileHarness.measure(
                64, 1, Duration.ofSeconds(31), index -> { throw new AssertionError("must not run"); }));
    }

    @Test
    void reportsRuntimeIdentityAndKeepsUnconfiguredProviderProfileExplicit() throws Exception {
        MediaResourceProfileHarness.Report report = MediaResourceProfileHarness.measure(
                1, 1, Duration.ofSeconds(1), index -> { });

        assertThat(report.environment().javaVersion()).isEqualTo(Runtime.version().toString());
        assertThat(report.environment().javaVendor()).isEqualTo(System.getProperty("java.vendor", "unknown"));
        assertThat(report.environment().runtimeName()).isEqualTo(
                java.lang.management.ManagementFactory.getRuntimeMXBean().getVmName());
        assertThat(report.environment().operatingSystem()).isEqualTo(System.getProperty("os.name", "unknown"));
        assertThat(report.environment().operatingSystemVersion()).isEqualTo(System.getProperty("os.version", "unknown"));
        assertThat(report.environment().architecture()).isEqualTo(System.getProperty("os.arch", "unknown"));
        assertThat(report.environment().availableProcessors()).isEqualTo(Runtime.getRuntime().availableProcessors());
        assertThat(report.environment().modelProfile()).isEqualTo("NOT_CONFIGURED");
        assertThat(report.environment().corpusProfile()).isEqualTo("NOT_CONFIGURED");
        assertThat(report.resources().get(MediaResourceProfileHarness.Resource.PROCESS_CPU_TIME_NANOS).unit())
                .isEqualTo("ns");
        assertThat(report.resources().get(MediaResourceProfileHarness.Resource.HEAP_PEAK_BYTES).unit())
                .isEqualTo("bytes");
        assertThat(report.resources().get(MediaResourceProfileHarness.Resource.THREAD_PEAK).unit())
                .isEqualTo("threads");
        assertThat(report.resources().get(MediaResourceProfileHarness.Resource.MODEL_REAL_TIME_FACTOR).unit())
                .isEqualTo("ratio");
        assertThat(report.resources().get(MediaResourceProfileHarness.Resource.VIDEO_FRAMES_PER_SECOND).unit())
                .isEqualTo("frames/s");
        assertThat(report.toTsv()).contains("NOT_ADMITTED", "NOT_MEASURED", "NOT_CONFIGURED");
    }

    @Test
    void tsvRuntimeIdentityCannotInjectColumnsOrRows() {
        var environment = new MediaResourceProfileHarness.Environment(
                "JDK 27", "Vendor\tforged", "runtime\nforged", "macOS\tforged\nrow",
                "version\rforged", "arm64\rforged", 10,
                "NOT_CONFIGURED\tinjected", "NOT_CONFIGURED\nsecond-row");
        var report = new MediaResourceProfileHarness.Report(
                1, 1, 1, 0, 0, MediaResourceProfileHarness.Outcome.COMPLETED, true,
                1_000_000, 1_000_000, 1.0, 1.0, 1.0, 1.0, environment, java.util.Map.of());

        String[] fields = report.toTsv().split("\\t", -1);

        assertThat(fields).hasSize(MediaResourceProfileHarness.Report.tsvHeader().split("\\t", -1).length);
        assertThat(fields[30]).isEqualTo("Vendor forged");
        assertThat(fields[31]).isEqualTo("runtime forged");
        assertThat(fields[32]).isEqualTo("macOS forged row");
        assertThat(fields[33]).isEqualTo("version forged");
        assertThat(fields[34]).isEqualTo("arm64 forged");
        assertThat(fields[36]).isEqualTo("NOT_CONFIGURED injected");
        assertThat(fields[37]).isEqualTo("NOT_CONFIGURED second-row");
        assertThat(report.toTsv()).doesNotContain("\n", "\r");
    }

    @Test
    void parsesLinuxCgroupV2ResourceCapsAndLeavesUnlimitedValuesUnmeasured() {
        assertThat(MediaResourceProfileHarness.parseMemoryLimit("8589934592").value())
                .isEqualTo(8_589_934_592.0);
        assertThat(MediaResourceProfileHarness.parseMemoryLimit("max").state())
                .isEqualTo(MediaResourceProfileHarness.State.NOT_MEASURED);

        assertThat(MediaResourceProfileHarness.parseCpuLimit("400000 100000").value()).isEqualTo(4.0);
        assertThat(MediaResourceProfileHarness.parseCpuLimit("max 100000").state())
                .isEqualTo(MediaResourceProfileHarness.State.NOT_MEASURED);

        assertThat(MediaResourceProfileHarness.parseProcessLimit("256").value()).isEqualTo(256.0);
        assertThat(MediaResourceProfileHarness.parseProcessLimit("max").state())
                .isEqualTo(MediaResourceProfileHarness.State.NOT_MEASURED);
        assertThat(MediaResourceProfileHarness.parseProcessLimit("not-a-limit").reason()).isNotBlank();
    }

    @Test
    void unknownHeapSamplesRemainUnmeasuredInsteadOfBecomingZero() {
        var unavailable = MediaResourceProfileHarness.summarizeHeapPeak(-1, -1);
        var mixed = MediaResourceProfileHarness.summarizeHeapPeak(0, -1, 128);

        assertThat(unavailable.state()).isEqualTo(MediaResourceProfileHarness.State.NOT_MEASURED);
        assertThat(unavailable.value()).isNaN();
        assertThat(unavailable.reason()).contains("sample was unavailable");
        assertThat(mixed.state()).isEqualTo(MediaResourceProfileHarness.State.NOT_MEASURED);
        assertThat(mixed.value()).isNaN();
        assertThat(mixed.reason()).contains("sample was unavailable");
    }

    @Test
    void processRssAdaptersParseUnitsAndKeepUnavailableSamplesUnknown() {
        assertThat(MediaResourceProfileHarness.parseLinuxProcessRss("Name:\tjava\nVmRSS:\t1024 kB\n")
                .value()).isEqualTo(1_048_576.0);
        assertThat(MediaResourceProfileHarness.parseLinuxProcessRss("Name:\tjava\n")
                .state()).isEqualTo(MediaResourceProfileHarness.State.NOT_MEASURED);
        assertThat(MediaResourceProfileHarness.parsePsProcessRss(" 256\n").value()).isEqualTo(262_144.0);
        assertThat(MediaResourceProfileHarness.parsePsProcessRss("not-rss").state())
                .isEqualTo(MediaResourceProfileHarness.State.NOT_MEASURED);
        assertThat(MediaResourceProfileHarness.summarizeProcessRss(128, -1, 256).state())
                .isEqualTo(MediaResourceProfileHarness.State.NOT_MEASURED);
        assertThat(MediaResourceProfileHarness.summarizeProcessRss(128, 256).value()).isEqualTo(256.0);
    }

    @Test
    void unavailableHeapPeakRemainsNotMeasuredInReportAndTsv() {
        var resources = new java.util.EnumMap<MediaResourceProfileHarness.Resource,
                MediaResourceProfileHarness.Reading>(MediaResourceProfileHarness.Resource.class);
        resources.put(MediaResourceProfileHarness.Resource.HEAP_PEAK_BYTES,
                MediaResourceProfileHarness.summarizeHeapPeak(4096, -1, 8192));
        var report = new MediaResourceProfileHarness.Report(
                1, 1, 1, 0, 0, MediaResourceProfileHarness.Outcome.COMPLETED, true,
                1_000_000, 1_000_000, 1.0, 1.0, 1.0, 1.0,
                new MediaResourceProfileHarness.Environment("JDK 27", "Vendor", "runtime", "macOS", "version",
                        "arm64", 1,
                        "NOT_CONFIGURED", "NOT_CONFIGURED"), resources);

        String[] fields = report.toTsv().split("\\t", -1);

        assertThat(fields[16]).startsWith("NOT_MEASURED:")
                .contains("heap sample was unavailable");
    }

    @Test
    void timeoutCancelsCooperativeWorkersAndReportsAbortInsteadOfASuccessfulBaseline() throws Exception {
        MediaResourceProfileHarness.Report report = MediaResourceProfileHarness.measure(
                1, 1, Duration.ofMillis(20), index -> TimeUnit.SECONDS.sleep(10));

        assertThat(report.outcome()).isEqualTo(MediaResourceProfileHarness.Outcome.ABORTED);
        assertThat(report.workerPoolTerminated()).isTrue();
        assertThat(report.completedOperations() + report.incompleteOperations())
                .isLessThanOrEqualTo(report.requestedOperations());
        assertThat(report.toTsv()).contains("ABORTED");
    }
}
