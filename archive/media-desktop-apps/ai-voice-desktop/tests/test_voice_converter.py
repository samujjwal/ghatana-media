"""
Unit tests for the legacy voice_converter module.

@doc.type test
@doc.purpose Test fail-closed legacy voice conversion behavior
@doc.layer ai-voice
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent / "src-tauri" / "python"))

from voice_converter import ConversionConfig, ConversionDependencyError, VoiceConverter  # noqa: E402


class TestVoiceConverter(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.model_path = Path(self.temp_dir.name) / "model.pt"
        self.model_path.write_text("placeholder")

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_load_model_fails_closed(self):
        with self.assertRaises(ConversionDependencyError):
            VoiceConverter(str(self.model_path))

    def test_extract_features_requires_librosa(self):
        converter = VoiceConverter.__new__(VoiceConverter)
        converter.model_path = self.model_path
        converter.sample_rate = 40000
        converter.model = None

        original_import = __import__

        def guarded_import(name, *args, **kwargs):
            if name == "librosa":
                raise ImportError("missing librosa")
            return original_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=guarded_import):
            with self.assertRaises(ConversionDependencyError):
                converter.extract_features(np.ones(1024, dtype=np.float32))


if __name__ == "__main__":
    unittest.main()