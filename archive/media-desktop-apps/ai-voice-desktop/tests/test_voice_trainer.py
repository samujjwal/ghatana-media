"""
Unit tests for voice trainer dependency enforcement.

@doc.type test
@doc.purpose Verify voice training fails closed when required ML dependencies are unavailable
@doc.layer ai-voice
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

import sys
sys.path.insert(0, str(Path(__file__).parent.parent / "src-tauri" / "python"))

from voice_trainer import TrainingConfig, TrainingDependencyError, VoiceModelTrainer


class TestVoiceTrainer(unittest.TestCase):
    """Dependency and validation tests for the voice trainer."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.trainer = VoiceModelTrainer(
            self.temp_dir.name,
            TrainingConfig(model_name="test-model", epochs=2),
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_preprocess_requires_librosa(self):
        with patch.object(self.trainer, "_require_librosa", side_effect=TrainingDependencyError("missing librosa")):
            with self.assertRaises(TrainingDependencyError):
                self.trainer.preprocess_samples(["sample.wav"])

    def test_train_model_requires_torch(self):
        with patch.object(self.trainer, "_require_torch", side_effect=TrainingDependencyError("missing torch")):
            with self.assertRaises(TrainingDependencyError):
                self.trainer.train_model([{"mel": np.zeros((8, 4), dtype=np.float32), "f0": np.zeros(4, dtype=np.float32)}])

    def test_train_model_rejects_empty_features(self):
        with self.assertRaises(ValueError):
            self.trainer.train_model([])

    def test_train_from_samples_rejects_empty_preprocessing_result(self):
        with patch.object(self.trainer, "preprocess_samples", return_value=[]):
            with self.assertRaises(ValueError):
                self.trainer.train_from_samples(["sample.wav"])


if __name__ == "__main__":
    unittest.main()