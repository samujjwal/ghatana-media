import importlib.util
from pathlib import Path
import unittest

SCRIPT = Path(__file__).with_name("measure-speech-audio-rss.py")
SPEC = importlib.util.spec_from_file_location("measure_speech_audio_rss", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
RSS_HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RSS_HELPER)
EXPECTED_CHILD_OUTPUT = RSS_HELPER.EXPECTED_CHILD_OUTPUT
parse_child_output = RSS_HELPER.parse_child_output


class ProbeOutputTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
