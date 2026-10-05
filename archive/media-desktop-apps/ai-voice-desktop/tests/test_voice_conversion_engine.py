"""
Unit tests for fail-closed voice conversion engine behavior.

@doc.type test
@doc.purpose Test voice conversion runtime contracts
@doc.layer ai-voice
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent / "src-tauri" / "python"))

from voice_conversion_engine import (  # noqa: E402
    ConversionConfig,
    ConversionDependencyError,
    VoiceConverter,
)


class TestVoiceConversionEngine(unittest.TestCase):
    def setUp(self):
        self.config = ConversionConfig(
            source_audio="input.wav",
            target_voice="voice-a",
            output_path="output.wav",
        )
        self.converter = VoiceConverter(self.config)

    def test_apply_voice_model_fails_closed(self):
        with self.assertRaises(ConversionDependencyError):
            self.converter._apply_voice_model(np.ones(1024, dtype=np.float32), np.ones(32, dtype=np.float32))

    def test_convert_surfaces_placeholder_model_error(self):
        with patch.object(self.converter, "_load_audio", return_value=(np.ones(22050, dtype=np.float32), 22050)):
            with patch.object(self.converter.pitch_extractor, "extract_f0", return_value=np.zeros(128, dtype=np.float32)):
                result = self.converter.convert()

        self.assertFalse(result.success)
        self.assertIn("Placeholder conversion output is blocked", result.error)

    def test_convert_success_uses_computed_quality_score(self):
        audio = np.full(22050, 0.5, dtype=np.float32)

        with patch.object(self.converter, "_load_audio", return_value=(audio, 22050)):
            with patch.object(self.converter.pitch_extractor, "extract_f0", return_value=np.zeros(128, dtype=np.float32)):
                with patch.object(self.converter, "_apply_voice_model", return_value=audio):
                    with patch.object(self.converter, "_save_audio"):
                        result = self.converter.convert()

        self.assertTrue(result.success)
        self.assertGreaterEqual(result.quality_score, 0.0)
        self.assertLessEqual(result.quality_score, 1.0)
        self.assertNotEqual(result.quality_score, 0.85)


if __name__ == "__main__":
    unittest.main()