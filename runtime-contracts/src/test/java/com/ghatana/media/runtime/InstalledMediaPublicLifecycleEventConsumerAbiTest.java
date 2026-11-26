package com.ghatana.media.runtime;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Purpose: compile and run an installed-style public-event consumer against the built runtime-contracts JAR.
 * Consumers: public Media lifecycle event ABI consumers.
 * Non-goals: broker delivery, principal mapping, or event finality.
 * Change policy: keep the child classpath limited to the owning archive and declared runtime JARs.
 */
class InstalledMediaPublicLifecycleEventConsumerAbiTest {
    private static final int MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
    private static final String OUTPUT_TRUNCATED = "\n[process output truncated after 65536 bytes]";

    private static final String CONSUMER_SOURCE = """
            package consumer;

            import com.ghatana.media.runtime.MediaLifecycleEventType;
            import com.ghatana.media.runtime.MediaPublicLifecycleEvent;
            import tools.jackson.databind.ObjectMapper;

            import java.time.Instant;
            import java.util.Map;

            public final class InstalledConsumer {
                public static void main(String[] args) throws Exception {
                    String payloadJson = \"\"\"
                            {
                              "schemaVersion": "1.0.0",
                              "eventRef": "r1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                              "eventType": "media.job.completed",
                              "tenantRef": "r1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                              "principalRef": "r1_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                              "correlationRef": "r1_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                              "causationRef": "r1_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                              "aggregateType": "job",
                              "aggregateRef": "r1_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                              "aggregateVersion": 7,
                              "classification": "CONFIDENTIAL",
                              "occurredAt": "2026-11-25T17:30:00Z",
                              "appendFinality": "NON_FINAL_APPEND",
                              "terminalReadbackRequired": true
                            }
                            \"\"\";
                    Map<?, ?> payload = new ObjectMapper().readValue(payloadJson, Map.class);
                    MediaPublicLifecycleEvent event = MediaPublicLifecycleEvent.fromPayload(payload);

                    require("urn:ghatana:media-public-lifecycle-event:v1".equals(
                            MediaPublicLifecycleEvent.SCHEMA_URI), "schema URI changed");
                    require("1.0.0".equals(event.schemaVersion()), "schema version changed");
                    require("r1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                                    .equals(event.eventRef()), "eventRef changed");
                    require(event.eventType() == MediaLifecycleEventType.JOB_COMPLETED,
                            "eventType did not parse from the public wire name");
                    require("r1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                                    .equals(event.tenantRef()), "tenantRef changed");
                    require("r1_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                                    .equals(event.principalRef()), "principalRef changed");
                    require("r1_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                                    .equals(event.correlationRef()), "correlationRef changed");
                    require("r1_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
                                    .equals(event.causationRef()), "causationRef changed");
                    require("job".equals(event.aggregateType()), "aggregateType changed");
                    require("r1_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
                                    .equals(event.aggregateRef()), "aggregateRef changed");
                    require(event.aggregateVersion() == 7, "aggregateVersion changed");
                    require("CONFIDENTIAL".equals(event.classification()), "classification changed");
                    require(Instant.parse("2026-11-25T17:30:00Z").equals(event.occurredAt()),
                            "occurredAt changed");
                    require(event.eventRef().matches("r1_[0-9a-f]{64}"), "eventRef is not redacted");
                    require(event.tenantRef().matches("r1_[0-9a-f]{64}"), "tenantRef is not redacted");
                    require(event.principalRef().matches("r1_[0-9a-f]{64}"), "principalRef is not redacted");
                    require(event.correlationRef().matches("r1_[0-9a-f]{64}"), "correlationRef is not redacted");
                    require(event.causationRef().matches("r1_[0-9a-f]{64}"), "causationRef is not redacted");
                    require(event.aggregateRef().matches("r1_[0-9a-f]{64}"), "aggregateRef is not redacted");
                    require(event.appendFinality() == MediaPublicLifecycleEvent.AppendFinality.NON_FINAL_APPEND,
                            "append finality changed");
                    require(event.terminalReadbackRequired(), "terminal event lost its readback requirement");
                }

                private static void require(boolean condition, String message) {
                    if (!condition) throw new AssertionError(message);
                }
            }
            """;

    @Test
    void builtArchiveCompilesAndRunsFromAnInstalledConsumerProcess(@TempDir Path work) throws Exception {
        Path projectDir = Path.of(System.getProperty("user.dir")).toRealPath();
        Path archive = Path.of(System.getProperty("media.public.events.consumer.archive")).toRealPath();
        assertThat(archive).isRegularFile();
        assertThat(archive.toString()).endsWith(".jar");

        Path mainClasses = projectDir.resolve("build/classes/java/main").toAbsolutePath().normalize();
        List<Path> classpathEntries = new ArrayList<>();
        classpathEntries.add(archive);
        String declaredRuntimeClasspath = System.getProperty("media.public.events.consumer.runtimeClasspath", "");
        for (String entry : declaredRuntimeClasspath.split(java.util.regex.Pattern.quote(File.pathSeparator))) {
            if (entry.isBlank()) continue;
            Path path = Path.of(entry).toRealPath();
            assertThat(Files.isRegularFile(path)).as("declared runtime dependency artifact %s", path).isTrue();
            assertThat(path.toString()).endsWith(".jar");
            assertThat(path).isNotEqualTo(mainClasses);
            classpathEntries.add(path);
        }
        String consumerClasspath = classpathEntries.stream().map(Path::toString)
                .collect(java.util.stream.Collectors.joining(File.pathSeparator));
        assertThat(List.of(consumerClasspath.split(java.util.regex.Pattern.quote(File.pathSeparator))))
                .doesNotContain(mainClasses.toString());

        Path source = work.resolve("consumer/InstalledConsumer.java");
        Path classes = work.resolve("classes");
        Files.createDirectories(source.getParent());
        Files.createDirectories(classes);
        Files.writeString(source, CONSUMER_SOURCE, StandardCharsets.UTF_8);

        Path javaHome = Path.of(System.getProperty("java.home"));
        Path javac = javaHome.resolve("bin/javac");
        Path java = javaHome.resolve("bin/java");
        run(List.of(javac.toString(), "-proc:none", "-classpath", consumerClasspath,
                "-d", classes.toString(), source.toString()), work);
        run(List.of(java.toString(), "-classpath", classes + File.pathSeparator + consumerClasspath,
                "consumer.InstalledConsumer"), work);
    }

    private static void run(List<String> command, Path workingDirectory) throws Exception {
        Process process = new ProcessBuilder(command).directory(workingDirectory.toFile())
                .redirectErrorStream(true).start();
        ByteArrayOutputStream capturedOutput = new ByteArrayOutputStream(MAX_PROCESS_OUTPUT_BYTES);
        AtomicReference<IOException> outputReadFailure = new AtomicReference<>();
        AtomicReference<Boolean> outputWasTruncated = new AtomicReference<>(false);
        Thread outputReader = new Thread(
                () -> drainOutput(process.getInputStream(), capturedOutput, outputWasTruncated, outputReadFailure),
                "installed-public-event-consumer-output-reader");
        outputReader.setDaemon(true);
        outputReader.start();
        boolean exited = process.waitFor(30, TimeUnit.SECONDS);
        if (!exited) {
            process.destroyForcibly();
            process.waitFor(2, TimeUnit.SECONDS);
        }
        outputReader.join(2_000);
        if (outputReader.isAlive()) {
            process.getInputStream().close();
            outputReader.join(2_000);
        }
        assertThat(outputReader.isAlive()).as("consumer process output reader stopped").isFalse();
        String output = capturedOutput.toString(StandardCharsets.UTF_8)
                + (outputWasTruncated.get() ? OUTPUT_TRUNCATED : "");
        assertThat(outputReadFailure.get()).as("consumer process output was readable").isNull();
        if (!exited) throw new AssertionError("consumer process timed out: " + command + "\n" + output);
        assertThat(process.exitValue()).withFailMessage("command failed: %s\n%s", command, output).isZero();
    }

    private static void drainOutput(InputStream input, ByteArrayOutputStream captured,
                                    AtomicReference<Boolean> wasTruncated,
                                    AtomicReference<IOException> readFailure) {
        byte[] buffer = new byte[8 * 1024];
        int retained = 0;
        try (input) {
            int read;
            while ((read = input.read(buffer)) != -1) {
                int keep = Math.min(read, MAX_PROCESS_OUTPUT_BYTES - retained);
                if (keep > 0) {
                    captured.write(buffer, 0, keep);
                    retained += keep;
                }
                if (keep < read) wasTruncated.set(true);
            }
        } catch (IOException failure) {
            readFailure.set(failure);
        }
    }
}
