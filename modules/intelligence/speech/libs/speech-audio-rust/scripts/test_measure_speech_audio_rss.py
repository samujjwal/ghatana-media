import errno
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("measure-speech-audio-rss.py")
SPEC = importlib.util.spec_from_file_location("measure_speech_audio_rss", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
RSS_HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RSS_HELPER)
EXPECTED_CHILD_OUTPUT = RSS_HELPER.EXPECTED_CHILD_OUTPUT
parse_child_output = RSS_HELPER.parse_child_output
collect_child = RSS_HELPER.collect_child


class ProbeOutputTests(unittest.TestCase):
    def test_platform_ru_maxrss_units(self):
        with patch.object(RSS_HELPER.sys, "platform", "darwin"):
            self.assertEqual(RSS_HELPER.rss_unit(), "bytes")
        with patch.object(RSS_HELPER.sys, "platform", "linux"):
            self.assertEqual(RSS_HELPER.rss_unit(), "KiB")
        with patch.object(RSS_HELPER.sys, "platform", "freebsd14"):
            with self.assertRaisesRegex(ValueError, "unsupported platform"):
                RSS_HELPER.rss_unit()

    def test_parses_decode_report_and_peak_rss(self):
        output = f"{EXPECTED_CHILD_OUTPUT}\npeak_rss_bytes=123456 measurement=process_getrusage\n"
        self.assertEqual(parse_child_output(output, 2), 123456)

    def test_parses_fixed_high_water_profile_and_rejects_profile_mismatch(self):
        expected = RSS_HELPER.expected_child_output("high-water")
        self.assertIn("input_bytes=32000044", expected)
        self.assertIn("samples=16000000", expected)
        self.assertIn("max_input_bytes=33554476", expected)
        output = f"{expected}\npeak_rss_bytes=70000000 measurement=process_getrusage\n"
        self.assertEqual(parse_child_output(output, 2, "high-water"), 70_000_000)
        with self.assertRaisesRegex(ValueError, "output mismatch"):
            parse_child_output(output, 2, "baseline")

    def test_parses_exact_hard_cap_profile_and_real_ceilings(self):
        expected = RSS_HELPER.expected_child_output("hard-cap")
        self.assertIn("duration_seconds=6000", expected)
        self.assertIn("samples=96000000", expected)
        self.assertIn("input_bytes=192000044", expected)
        self.assertIn("max_input_bytes=536870912", expected)
        self.assertIn("max_decoded_samples=96000000", expected)
        output = f"{expected}\npeak_rss_bytes=450000000 measurement=process_getrusage\n"
        self.assertEqual(parse_child_output(output, 1, "hard-cap"), 450_000_000)
        with self.assertRaisesRegex(ValueError, "output mismatch"):
            parse_child_output(output, 1, "high-water")

    def test_closed_profile_validation_rejects_unknown_name_and_invalid_bounds(self):
        with self.assertRaisesRegex(ValueError, "unknown closed probe profile"):
            RSS_HELPER.expected_child_output("samples-999999999")
        invalid = dict(RSS_HELPER.PROFILES["baseline"])
        invalid["max_input_bytes"] = invalid["input_bytes"] - 1
        with self.assertRaisesRegex(ValueError, "selected input or decoded-sample cap"):
            RSS_HELPER.validate_profile("baseline", invalid)
        invalid = dict(RSS_HELPER.PROFILES["baseline"])
        invalid["max_decoded_samples"] = RSS_HELPER.GLOBAL_MAX_DECODED_SAMPLES + 1
        with self.assertRaisesRegex(ValueError, "global high-water ceilings"):
            RSS_HELPER.validate_profile("baseline", invalid)

    def test_rejects_old_single_line_probe_output(self):
        with self.assertRaisesRegex(ValueError, "output mismatch"):
            parse_child_output(EXPECTED_CHILD_OUTPUT, 1)

    def test_rejects_unavailable_or_malformed_rss_measurement(self):
        for measurement in (
            "peak_rss_bytes=UNAVAILABLE measurement=unsupported_platform",
            "peak_rss_bytes=0 measurement=process_getrusage",
            "peak_rss_bytes=12KiB measurement=process_getrusage",
        ):
            with self.subTest(measurement=measurement):
                output = f"{EXPECTED_CHILD_OUTPUT}\n{measurement}\n"
                with self.assertRaisesRegex(ValueError, "RSS measurement is malformed"):
                    parse_child_output(output, 3)

    def test_rejects_extra_child_output(self):
        output = (
            f"{EXPECTED_CHILD_OUTPUT}\n"
            "diagnostic=unexpected\n"
            "peak_rss_bytes=123456 measurement=process_getrusage\n"
        )
        with self.assertRaisesRegex(ValueError, "output mismatch"):
            parse_child_output(output, 4)


class ChildCollectionTests(unittest.TestCase):
    def run_script(self, source, **kwargs):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "synthetic-child"
            pid_file = Path(directory) / "child.pid"
            marker = f"Path({str(pid_file)!r}).write_text(str(os.getpid()))\n"
            executable.write_text(
                f"#!{sys.executable}\nfrom pathlib import Path\nimport os\n"
                f"{marker}{source}",
                encoding="utf-8",
            )
            executable.chmod(0o700)
            try:
                return collect_child(str(executable), 1, **kwargs)
            except RuntimeError:
                child_pid = int(pid_file.read_text(encoding="utf-8"))
                with self.assertRaises(ChildProcessError):
                    os.waitpid(child_pid, os.WNOHANG)
                raise

    def test_drains_and_measures_expected_child_output(self):
        stdout, stderr, returncode, usage = self.run_script(
            "print(" + repr(EXPECTED_CHILD_OUTPUT) + ")\n"
            "print('peak_rss_bytes=123456 measurement=process_getrusage')"
        )
        self.assertEqual(returncode, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(parse_child_output(stdout, 1), 123456)
        self.assertGreater(usage.ru_maxrss, 0)

    def test_passes_the_closed_high_water_profile_to_the_child(self):
        expected = RSS_HELPER.expected_child_output("high-water")
        stdout, stderr, returncode, _ = self.run_script(
            "import sys\n"
            "assert sys.argv[1:] == ['--profile', 'high-water']\n"
            f"print({expected!r})\n"
            "print('peak_rss_bytes=123456 measurement=process_getrusage')",
            profile="high-water",
        )
        self.assertEqual(returncode, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(parse_child_output(stdout, 1, "high-water"), 123456)

    def test_passes_the_closed_hard_cap_profile_to_the_child(self):
        expected = RSS_HELPER.expected_child_output("hard-cap")
        stdout, stderr, returncode, _ = self.run_script(
            "import sys\n"
            "assert sys.argv[1:] == ['--profile', 'hard-cap']\n"
            f"print({expected!r})\n"
            "print('peak_rss_bytes=123456 measurement=process_getrusage')",
            profile="hard-cap",
        )
        self.assertEqual(returncode, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(parse_child_output(stdout, 1, "hard-cap"), 123456)

    def test_kills_and_reaps_child_that_exceeds_output_bound(self):
        with self.assertRaisesRegex(RuntimeError, "output exceeded"):
            self.run_script("print('x' * 100000)", timeout_seconds=2)

    def test_kills_and_reaps_timed_out_child(self):
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            self.run_script("import time\ntime.sleep(5)", timeout_seconds=1)

    def test_group_kill_permission_error_preserves_timeout_and_kills_child(self):
        with patch.object(RSS_HELPER.os, "killpg", side_effect=PermissionError(1, "denied")):
            with self.assertRaisesRegex(RuntimeError, "timed out.*EPERM"):
                self.run_script("import time\ntime.sleep(5)", timeout_seconds=1)

    def test_failed_group_and_child_kill_returns_bounded_unconfirmed_pid(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "unresponsive-child"
            executable.write_text(
                f"#!{sys.executable}\nimport time\ntime.sleep(30)\n",
                encoding="utf-8",
            )
            executable.chmod(0o700)
            real_killpg = RSS_HELPER.os.killpg
            real_kill = RSS_HELPER.os.kill
            real_popen = RSS_HELPER.subprocess.Popen
            spawned = []

            def record_popen(*args, **kwargs):
                child = real_popen(*args, **kwargs)
                spawned.append(child)
                return child

            started = time.monotonic()
            try:
                with patch.object(RSS_HELPER.subprocess, "Popen", side_effect=record_popen):
                    with patch.object(
                        RSS_HELPER.os,
                        "killpg",
                        side_effect=PermissionError(errno.EPERM, "injected group denial"),
                    ) as mocked_killpg, patch.object(
                        RSS_HELPER.os,
                        "kill",
                        side_effect=PermissionError(errno.EPERM, "injected child denial"),
                    ) as mocked_kill:
                        with self.assertRaisesRegex(
                            RuntimeError,
                            r"timed out.*child_pid_unconfirmed=\d+.*direct-child SIGKILL failed",
                        ) as raised:
                            collect_child(str(executable), 1, timeout_seconds=0.2)
                        self.assertGreaterEqual(mocked_killpg.call_count, 1)
                        self.assertGreaterEqual(mocked_kill.call_count, 1)
                        self.assertIn("child_process", raised.exception.__dict__)
                self.assertLess(time.monotonic() - started, 6)
            finally:
                self.assertEqual(len(spawned), 1)
                child_pid = spawned[0].pid
                try:
                    real_killpg(child_pid, RSS_HELPER.signal.SIGKILL)
                except PermissionError:
                    # Some sandbox profiles deny group signaling even for a
                    # test-owned process; fall back to its direct child PID.
                    try:
                        real_kill(child_pid, RSS_HELPER.signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                except ProcessLookupError:
                    pass
                try:
                    waited_pid, _ = os.waitpid(child_pid, 0)
                except ChildProcessError:
                    # The wrapper may have reaped the process before the
                    # injected cleanup failure was observed.
                    waited_pid = child_pid
                self.assertEqual(waited_pid, child_pid)
                spawned[0].returncode = -RSS_HELPER.signal.SIGKILL

    def test_unavailable_wait_status_terminates_without_rss_claim(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "wait-status-child"
            executable.write_text(
                f"#!{sys.executable}\nimport time\ntime.sleep(30)\n",
                encoding="utf-8",
            )
            executable.chmod(0o700)
            real_killpg = RSS_HELPER.os.killpg
            real_wait4 = RSS_HELPER.os.wait4
            real_popen = RSS_HELPER.subprocess.Popen
            spawned = []

            def record_popen(*args, **kwargs):
                child = real_popen(*args, **kwargs)
                spawned.append(child)
                return child

            kill_sent_at = [None]

            def unavailable_after_cleanup(pid, options):
                if (
                    kill_sent_at[0] is not None
                    and time.monotonic() - kill_sent_at[0]
                    >= RSS_HELPER.CHILD_CLEANUP_SECONDS
                ):
                    raise ChildProcessError()
                return 0, 0, None

            def record_killpg(pid, sig):
                try:
                    real_killpg(pid, sig)
                finally:
                    kill_sent_at[0] = time.monotonic()

            started = time.monotonic()
            try:
                with patch.object(RSS_HELPER.subprocess, "Popen", side_effect=record_popen):
                    with patch.object(RSS_HELPER.os, "wait4", side_effect=unavailable_after_cleanup):
                        with patch.object(RSS_HELPER, "CHILD_CLEANUP_SECONDS", 0.05):
                            with patch.object(RSS_HELPER.os, "killpg", side_effect=record_killpg):
                                with self.assertRaisesRegex(
                                    RuntimeError,
                                    r"child wait status unavailable.*ru_maxrss unavailable.*child_pid_unconfirmed=\d+",
                                ) as raised:
                                    collect_child(str(executable), 1, timeout_seconds=0.05)
                    self.assertIn("child_process", raised.exception.__dict__)
                self.assertLess(time.monotonic() - started, 2)
            finally:
                self.assertEqual(len(spawned), 1)
                child_pid = spawned[0].pid
                try:
                    real_killpg(child_pid, RSS_HELPER.signal.SIGKILL)
                except PermissionError:
                    try:
                        RSS_HELPER.os.kill(child_pid, RSS_HELPER.signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                except ProcessLookupError:
                    pass
                try:
                    waited_pid, child_status, _ = real_wait4(child_pid, 0)
                    self.assertEqual(waited_pid, child_pid)
                    spawned[0].returncode = os.waitstatus_to_exitcode(child_status)
                except ChildProcessError:
                    spawned[0].returncode = -RSS_HELPER.signal.SIGKILL

    def test_bounds_drain_when_descendant_inherits_output_pipes(self):
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            self.run_script(
                "import subprocess, sys\n"
                "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(20)'])",
                timeout_seconds=1,
            )
        self.assertLess(time.monotonic() - started, 3)


if __name__ == "__main__":
    unittest.main()
