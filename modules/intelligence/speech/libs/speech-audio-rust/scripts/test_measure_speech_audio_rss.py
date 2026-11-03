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
