"""
Unit tests for cloned voice synthesizer.

@doc.type test
@doc.purpose Test TTS synthesis with cloned voices
@doc.layer ai-voice
"""

import unittest
import numpy as np
from pathlib import Path
import tempfile
import sys
from unittest.mock import patch

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src-tauri" / "python"))

from cloned_voice_synthesizer import (
    ClonedVoiceSynthesizer,
    SynthesisConfig,
    SynthesisDependencyError,
    SynthesisResult,
)


class TestClonedVoiceSynthesizer(unittest.TestCase):
    """Test cloned voice synthesizer."""

    def setUp(self):
        """Set up test fixtures."""
        self.synthesizer = ClonedVoiceSynthesizer()
        self.temp_dir = tempfile.mkdtemp()

    def tearDown(self):
        """Clean up test fixtures."""
        import shutil
        if Path(self.temp_dir).exists():
            shutil.rmtree(self.temp_dir)

    def test_initialization(self):
        """Test synthesizer initialization."""
        self.assertIsNotNone(self.synthesizer)
        self.assertEqual(len(self.synthesizer.loaded_voices), 0)

    def test_load_base_models(self):
        """Test loading base models."""
        with self.assertRaises(SynthesisDependencyError):
            self.synthesizer.load_base_models()

    def test_load_voice_missing_files(self):
        """Test loading voice with missing files."""
        voice_id = "test_voice"
        model_path = "/nonexistent/model.pt"
        embedding_path = "/nonexistent/embedding.npy"

        result = self.synthesizer.load_voice(voice_id, model_path, embedding_path)
        self.assertFalse(result)

    def test_load_voice_missing_model_rejected_even_with_embedding(self):
        """Test loading voice fails when the model file is missing."""
        voice_id = "test_voice"
        embedding_path = Path(self.temp_dir) / "embedding.npy"
        np.save(embedding_path, np.random.randn(256).astype(np.float32))

        result = self.synthesizer.load_voice(
            voice_id,
            "/nonexistent/model.pt",
            str(embedding_path),
        )

        self.assertFalse(result)

    def test_load_voice_success(self):
        """Test successfully loading a voice."""
        voice_id = "test_voice_123"

        # Create mock files
        model_path = Path(self.temp_dir) / "model.pt"
        embedding_path = Path(self.temp_dir) / "embedding.npy"

        model_path.write_text("mock_model")
        np.save(embedding_path, np.random.randn(256).astype(np.float32))

        result = self.synthesizer.load_voice(
            voice_id,
            str(model_path),
            str(embedding_path)
        )

        self.assertTrue(result)
        self.assertIn(voice_id, self.synthesizer.loaded_voices)

    def test_unload_voice(self):
        """Test unloading a voice."""
        voice_id = "test_voice"

        # Create and load mock voice
        model_path = Path(self.temp_dir) / "model.pt"
        embedding_path = Path(self.temp_dir) / "embedding.npy"

        model_path.write_text("mock_model")
        np.save(embedding_path, np.random.randn(256).astype(np.float32))

        self.synthesizer.load_voice(voice_id, str(model_path), str(embedding_path))
        self.assertIn(voice_id, self.synthesizer.loaded_voices)

        # Unload
        self.synthesizer.unload_voice(voice_id)
        self.assertNotIn(voice_id, self.synthesizer.loaded_voices)

    def test_synthesize_voice_not_loaded(self):
        """Test synthesizing with unloaded voice."""
        with self.assertRaises(ValueError):
            self.synthesizer.synthesize("Hello world", "nonexistent_voice")

    def test_synthesize_success(self):
        """Test successful synthesis."""
        voice_id = "test_voice"

        # Create and load mock voice
        model_path = Path(self.temp_dir) / "model.pt"
        embedding_path = Path(self.temp_dir) / "embedding.npy"

        model_path.write_text("mock_model")
        np.save(embedding_path, np.random.randn(256).astype(np.float32))

        self.synthesizer.load_voice(voice_id, str(model_path), str(embedding_path))

        config = SynthesisConfig(speed=1.0, pitch_shift=0.0)
        with patch.object(self.synthesizer, "_generate_mel", return_value=np.ones((80, 16), dtype=np.float32)):
            with patch.object(self.synthesizer, "_vocoder_inference", return_value=np.ones(22050, dtype=np.float32)):
                result = self.synthesizer.synthesize("Hello world", voice_id, config)

        self.assertIsInstance(result, SynthesisResult)
        self.assertIsInstance(result.audio, np.ndarray)
        self.assertGreater(result.duration_seconds, 0)
        self.assertEqual(result.sample_rate, config.output_sample_rate)

    def test_synthesize_with_progress(self):
        """Test synthesis with progress callback."""
        voice_id = "test_voice"

        # Create and load mock voice
        model_path = Path(self.temp_dir) / "model.pt"
        embedding_path = Path(self.temp_dir) / "embedding.npy"

        model_path.write_text("mock_model")
        np.save(embedding_path, np.random.randn(256).astype(np.float32))

        self.synthesizer.load_voice(voice_id, str(model_path), str(embedding_path))

        # Track progress
        progress_values = []
        def progress_callback(progress):
            progress_values.append(progress)

        with patch.object(self.synthesizer, "_generate_mel", return_value=np.ones((80, 16), dtype=np.float32)):
            with patch.object(self.synthesizer, "_vocoder_inference", return_value=np.ones(22050, dtype=np.float32)):
                result = self.synthesizer.synthesize(
                    "Hello world",
                    voice_id,
                    progress_callback=progress_callback
                )

        self.assertGreater(len(progress_values), 0)
        self.assertEqual(progress_values[-1], 1.0)

    def test_synthesize_streaming(self):
        """Test streaming synthesis."""
        voice_id = "test_voice"

        # Create and load mock voice
        model_path = Path(self.temp_dir) / "model.pt"
        embedding_path = Path(self.temp_dir) / "embedding.npy"

        model_path.write_text("mock_model")
        np.save(embedding_path, np.random.randn(256).astype(np.float32))

        self.synthesizer.load_voice(voice_id, str(model_path), str(embedding_path))

        # Synthesize with multiple sentences
        text = "Hello world. This is a test. How are you?"
        with patch.object(self.synthesizer, "_generate_mel", return_value=np.ones((80, 16), dtype=np.float32)):
            with patch.object(self.synthesizer, "_vocoder_inference", return_value=np.ones(22050, dtype=np.float32)):
                chunks = list(self.synthesizer.synthesize_streaming(text, voice_id))

        self.assertGreater(len(chunks), 0)

        # Check last chunk is marked as final
        self.assertTrue(chunks[-1].is_final)

    def test_synthesis_config_defaults(self):
        """Test SynthesisConfig default values."""
        config = SynthesisConfig()

        self.assertEqual(config.speed, 1.0)
        self.assertEqual(config.pitch_shift, 0.0)
        self.assertEqual(config.energy, 1.0)
        self.assertEqual(config.language, "en")
        self.assertEqual(config.output_sample_rate, 22050)
        self.assertFalse(config.streaming)

    def test_text_processing(self):
        """Test text preprocessing."""
        text = "  Hello world!  "
        processed, phonemes = self.synthesizer._process_text(text, "en")

        self.assertEqual(processed, "Hello world!")
        self.assertIsInstance(phonemes, list)

    def test_split_sentences(self):
        """Test sentence splitting."""
        text = "Hello world. This is a test! How are you?"
        sentences = self.synthesizer._split_sentences(text)

        self.assertEqual(len(sentences), 3)
        self.assertEqual(sentences[0], "Hello world.")
        self.assertEqual(sentences[1], "This is a test!")
        self.assertEqual(sentences[2], "How are you?")

    def test_postprocess_normalization(self):
        """Test audio post-processing."""
        # Create audio with values outside -1 to 1
        audio = np.array([2.0, -2.0, 1.5, -1.5], dtype=np.float32)
        config = SynthesisConfig()

        processed = self.synthesizer._postprocess(audio, config)

        # Should be clipped to -1 to 1
        self.assertTrue(np.all(processed >= -1.0))
        self.assertTrue(np.all(processed <= 1.0))

    def test_postprocess_energy_scaling(self):
        """Test energy scaling in post-processing."""
        audio = np.array([0.5, -0.5, 0.3, -0.3], dtype=np.float32)
        config = SynthesisConfig(energy=0.5)

        processed = self.synthesizer._postprocess(audio, config)

        # Should be scaled down
        self.assertTrue(np.all(np.abs(processed) <= np.abs(audio)))

    def test_get_loaded_voices(self):
        """Test getting list of loaded voices."""
        voices = self.synthesizer.get_loaded_voices()
        self.assertIsInstance(voices, list)
        self.assertEqual(len(voices), 0)

        # Load a voice
        voice_id = "test_voice"
        model_path = Path(self.temp_dir) / "model.pt"
        embedding_path = Path(self.temp_dir) / "embedding.npy"

        model_path.write_text("mock_model")
        np.save(embedding_path, np.random.randn(256).astype(np.float32))

        self.synthesizer.load_voice(voice_id, str(model_path), str(embedding_path))

        voices = self.synthesizer.get_loaded_voices()
        self.assertEqual(len(voices), 1)
        self.assertIn(voice_id, voices)

    def test_synthesize_fails_without_base_models(self):
        """Test synthesis fails explicitly when base models are unavailable."""
        voice_id = "test_voice"
        model_path = Path(self.temp_dir) / "model.pt"
        embedding_path = Path(self.temp_dir) / "embedding.npy"

        model_path.write_text("mock_model")
        np.save(embedding_path, np.random.randn(256).astype(np.float32))

        self.synthesizer.load_voice(voice_id, str(model_path), str(embedding_path))

        with self.assertRaises(SynthesisDependencyError):
            self.synthesizer.synthesize("Hello world", voice_id)


class TestSynthesisResult(unittest.TestCase):
    """Test SynthesisResult dataclass."""

    def test_creation(self):
        """Test creating a SynthesisResult."""
        audio = np.random.randn(22050).astype(np.float32)
        result = SynthesisResult(
            audio=audio,
            sample_rate=22050,
            duration_seconds=1.0,
            text_processed="Hello world"
        )

        self.assertEqual(result.audio.shape, (22050,))
        self.assertEqual(result.sample_rate, 22050)
        self.assertEqual(result.duration_seconds, 1.0)
        self.assertEqual(result.text_processed, "Hello world")


if __name__ == '__main__':
    unittest.main()

