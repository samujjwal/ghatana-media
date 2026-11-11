package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class LoggingConfigurationProcessTest {
    private static final String PROBE = "MEDIA_LOG_FORMAT_PROBE";

    @Test
    void routesPlainByDefaultAndJsonWhenOptedInWithoutAppenderErrors() throws Exception {
        assertFormat("plain", Map.of(), false);
        assertFormat("json", Map.of("LOG_FORMAT", "json"), true);
        assertFormat("plain", Map.of("LOG_FORMAT", "json"), false, "plain");
    }

    private static void assertFormat(String expectedFormat, Map<String, String> environment,
                                     boolean json, String... systemProperty) throws Exception {
        Path config = Path.of(LoggingConfigurationProcessTest.class.getResource("/log4j2.xml").toURI());
        String classpath = System.getProperty("media.child.classpath");
        assertThat(classpath).as("test runtime classpath configured for child process").isNotBlank();

        var command = new java.util.ArrayList<>(java.util.List.of(
                Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-Dlog4j.configurationFile=" + config,
                "-Dmedia.log.level=INFO",
                "-cp", classpath,
                LoggingConfigurationProcessTest.class.getName(), "probe", expectedFormat));
        if (systemProperty.length > 0) {
            command.add(1, "-Dmedia.log.format=" + systemProperty[0]);
        }

        ProcessBuilder builder = new ProcessBuilder(command).redirectErrorStream(true);
        builder.environment().remove("LOG_FORMAT");
        builder.environment().putAll(environment);
        Process process = builder.start();
        assertThat(process.waitFor(15, TimeUnit.SECONDS)).as("logging probe exits").isTrue();
        String output = new String(process.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        assertThat(process.exitValue()).as(output).isZero();
        assertThat(output).doesNotContain("Unable to locate appender", "ERROR StatusLogger");
        assertThat(output).contains(PROBE + "_" + expectedFormat.toUpperCase());
        if (json) {
            assertThat(output).contains("\"message\":\"" + PROBE + "_JSON\"");
        } else {
            assertThat(output).contains("- " + PROBE + "_" + expectedFormat.toUpperCase());
            assertThat(output).doesNotContain("\"message\":");
        }
    }

    public static void main(String[] args) {
        if (args.length == 2 && "probe".equals(args[0])) {
            LoggerFactory.getLogger("com.ghatana.media.logging.probe").info(PROBE + "_" + args[1].toUpperCase());
        }
    }
}
