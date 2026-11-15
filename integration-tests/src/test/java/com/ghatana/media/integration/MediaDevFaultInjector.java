package com.ghatana.media.integration;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

/**
 * Test-only failure injection for the DEV_ONLY provider outage journeys (J-27). Nothing here is part of the product
 * runtime and nothing fakes a provider's answer: it only makes REAL providers fail in the ways a host sees.
 *
 * <ul>
 *   <li>{@link ModeScript}: a wrapper executable placed where the launcher expects FFmpeg or the Kokoro interpreter. It
 *       execs the real tool unless a mode file next to it asks for a fault: {@code crash} (the process dies with
 *       SIGSEGV, exit 139, while encoding), {@code hang} (it never finishes), {@code refuse} (it cannot start). The mode
 *       is read on every invocation, so it can change while the launcher keeps running;</li>
 *   <li>{@link #removeAway}/{@link #restore}: the binary disappears and comes back (process absent);</li>
 *   <li>{@link #signal}: SIGSEGV (GPU or driver crash), SIGSTOP (hung or saturated process: the port stays open but
 *       nothing answers), SIGCONT, SIGKILL to a process the test itself started or a descendant of its launcher;</li>
 *   <li>{@link #awaitDescendant}: finds a real worker or tool process that belongs to the launcher under test, so a
 *       fault never lands on another agent's process.</li>
 * </ul>
 */
final class MediaDevFaultInjector {
    private MediaDevFaultInjector() { }

    /** A wrapper script whose behaviour is switched by writing a mode word to its mode file. */
    static final class ModeScript {
        private final Path script;
        private final Path modeFile;
        private final Path away;

        private ModeScript(Path script, Path modeFile) {
            this.script = script;
            this.modeFile = modeFile;
            this.away = script.resolveSibling(script.getFileName() + ".away");
        }

        /**
         * FFmpeg wrapper: {@code crash} and {@code hang} apply only to an encode (an argument list that names
         * {@code -c:v}); {@code -version}, {@code -encoders} and decoding always reach the real binary so the catalog
         * probe and frame extraction stay truthful.
         */
        static ModeScript ffmpeg(Path dir, Path real) throws IOException {
            Path script = dir.resolve("ffmpeg");
            Path mode = dir.resolve("ffmpeg.mode");
            Files.writeString(mode, "ok");
            write(script, "#!/bin/sh\n"
                    + "mode=$(/bin/cat '" + mode + "' 2>/dev/null || echo ok)\n"
                    + "case \"$mode\" in\n"
                    + "  crash) case \" $* \" in *' -c:v '*) kill -SEGV $$ ;; esac ;;\n"
                    + "  hang) case \" $* \" in *' -c:v '*) exec /bin/sleep 3600 ;; esac ;;\n"
                    + "esac\n"
                    + "exec '" + real + "' \"$@\"\n");
            return new ModeScript(script, mode);
        }

        /** Python wrapper for the Kokoro worker: {@code refuse} makes the interpreter fail to start. */
        static ModeScript python(Path dir, Path real) throws IOException {
            Path script = dir.resolve("python-kokoro");
            Path mode = dir.resolve("python.mode");
            Files.writeString(mode, "ok");
            write(script, "#!/bin/sh\n"
                    + "mode=$(/bin/cat '" + mode + "' 2>/dev/null || echo ok)\n"
                    + "if [ \"$mode\" = refuse ]; then exit 3; fi\n"
                    + "exec '" + real + "' \"$@\"\n");
            return new ModeScript(script, mode);
        }

        Path path() { return script; }

        void mode(String value) throws IOException { Files.writeString(modeFile, value, StandardCharsets.UTF_8); }

        void removeAway() throws IOException { Files.move(script, away, StandardCopyOption.ATOMIC_MOVE); }

        void restore() throws IOException { Files.move(away, script, StandardCopyOption.ATOMIC_MOVE); }

        private static void write(Path script, String text) throws IOException {
            Files.writeString(script, text, StandardCharsets.UTF_8);
            Files.setPosixFilePermissions(script, PosixFilePermissions.fromString("rwxr-xr-x"));
        }
    }

    /** A private copy of a real executable (same bytes, same digest) that the test may delete and restore. */
    static final class MovableBinary {
        private final Path path;
        private final Path away;

        MovableBinary(Path source, Path dir, String name) throws IOException {
            this.path = dir.resolve(name);
            this.away = dir.resolve(name + ".away");
            Files.copy(source, path, StandardCopyOption.REPLACE_EXISTING);
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rwxr-xr-x"));
        }

        Path path() { return path; }

        void removeAway() throws IOException { Files.move(path, away, StandardCopyOption.ATOMIC_MOVE); }

        void restore() throws IOException { Files.move(away, path, StandardCopyOption.ATOMIC_MOVE); }
    }

    /** Sends a signal by name ({@code SEGV}, {@code STOP}, {@code CONT}, {@code KILL}) to one process. */
    static void signal(ProcessHandle target, String name) throws IOException, InterruptedException {
        Process kill = new ProcessBuilder("kill", "-" + name, Long.toString(target.pid())).redirectErrorStream(true).start();
        kill.getInputStream().readAllBytes();
        if (!kill.waitFor(10, TimeUnit.SECONDS) || kill.exitValue() != 0) {
            throw new AssertionError("could not send SIG" + name + " to pid " + target.pid());
        }
    }

    /** The newest live descendant of {@code root} whose command line contains {@code needle}. */
    static Optional<ProcessHandle> findDescendant(Process root, String needle) {
        return root.toHandle().descendants()
                .filter(handle -> handle.isAlive() && handle.info().commandLine().orElse("").contains(needle))
                .reduce((first, second) -> second);
    }

    /** Polls (10 ms) until a descendant of {@code root} with the needle in its command line exists. */
    static ProcessHandle awaitDescendant(Process root, String needle, Duration timeout) throws InterruptedException {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            Optional<ProcessHandle> found = findDescendant(root, needle);
            if (found.isPresent()) return found.get();
            Thread.sleep(10);
        }
        throw new AssertionError("no process containing '" + needle + "' appeared under the launcher within " + timeout);
    }

    /** Waits until no descendant of {@code root} contains the needle: the abandoned work was really stopped. */
    static void awaitNoDescendant(Process root, String needle, Duration timeout) throws InterruptedException {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            if (findDescendant(root, needle).isEmpty()) return;
            Thread.sleep(100);
        }
        throw new AssertionError("a process containing '" + needle + "' is still running under the launcher after "
                + timeout + ": " + root.toHandle().descendants().map(h -> h.info().commandLine().orElse("?")).toList());
    }

    static List<ProcessHandle> descendants(Process root) {
        return root.toHandle().descendants().toList();
    }
}
