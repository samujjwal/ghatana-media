"""
Unit tests for model manager runtime gating.

@doc.type test
@doc.purpose Test placeholder-backed model registry entries are blocked
@doc.layer ai-voice
"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src-tauri" / "python"))

from models.model_manager import ModelManager  # noqa: E402


class TestModelManager(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.manager = ModelManager(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_download_blocks_placeholder_rvc_model(self):
        with self.assertRaises(RuntimeError) as context:
            self.manager.download_model('rvc-base')

        self.assertIn('placeholder-backed', str(context.exception).lower())

    def test_load_blocks_placeholder_mosnet_model(self):
        with self.assertRaises(RuntimeError) as context:
            self.manager.load_model('mosnet')

        self.assertIn('placeholder', str(context.exception).lower())


if __name__ == '__main__':
    unittest.main()