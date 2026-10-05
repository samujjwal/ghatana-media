"""
Unit tests for voice cloning pipeline.

@doc.type test
@doc.purpose Test voice cloning functionality
@doc.layer ai-voice
"""

import unittest
import numpy as np
from pathlib import Path
import tempfile
import json
import sys
from unittest.mock import patch

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src-tauri" / "python"))

from voice_cloner import VoiceCloner, CloningConfig, CloningDependencyError, CloningResult
from speaker_embedding import SpeakerEmbeddingExtractor


class MockModelManager:
    """Mock ModelManager for testing."""

    def ensure_model(self, model_id):
        """Mock ensure_model method."""
        return Path("/mock/model/path")


class MockEmbeddingExtractor:
    """Mock embedding extractor for testing."""

    def extract_batch(self, audio_paths):
        """Mock batch extraction."""
        from speaker_embedding import EmbeddingResult
        return [
            EmbeddingResult(
                embedding=np.random.randn(256).astype(np.float32),
                confidence=0.9,
                duration_seconds=3.0,
                sample_rate=16000
            )
            for _ in audio_paths
        ]

    def average_embedding(self, results):
        """Mock average embedding."""
        embeddings = np.array([r.embedding for r in results if r is not None])
        return np.mean(embeddings, axis=0)

    def extract(self, audio_path):
        """Mock single extraction."""
        from speaker_embedding import EmbeddingResult
        seed = abs(hash(audio_path)) % (2**32)
        rng = np.random.default_rng(seed)
        embedding = rng.normal(size=256).astype(np.float32)
        return EmbeddingResult(
            embedding=embedding,
            confidence=0.95,
            duration_seconds=3.0,
            sample_rate=16000,
        )

    def compute_similarity(self, embedding1, embedding2):
        """Mock cosine similarity."""
        emb1_norm = embedding1 / (np.linalg.norm(embedding1) + 1e-8)
        emb2_norm = embedding2 / (np.linalg.norm(embedding2) + 1e-8)
        return float((np.dot(emb1_norm, emb2_norm) + 1.0) / 2.0)


class TestVoiceCloner(unittest.TestCase):
    """Test voice cloning pipeline."""

    def setUp(self):
        """Set up test fixtures."""
        self.model_manager = MockModelManager()
        self.embedding_extractor = MockEmbeddingExtractor()
        self.cloner = VoiceCloner(self.model_manager, self.embedding_extractor)

        # Create temporary directory for testing
        self.temp_dir = tempfile.mkdtemp()

    def tearDown(self):
        """Clean up test fixtures."""
        import shutil
        if Path(self.temp_dir).exists():
            shutil.rmtree(self.temp_dir)

    def test_initialization(self):
        """Test cloner initialization."""
        self.assertIsNotNone(self.cloner)
        self.assertFalse(self.cloner._loaded)

    def test_voice_id_generation(self):
        """Test voice ID generation."""
        voice_id1 = self.cloner._generate_voice_id("Test Voice")
        voice_id2 = self.cloner._generate_voice_id("Test Voice")

        # Should generate different IDs (due to timestamp)
        self.assertNotEqual(voice_id1, voice_id2)

        # Should be filesystem safe
        self.assertTrue(voice_id1.replace("_", "").replace("-", "").isalnum())

    def test_voice_id_sanitization(self):
        """Test voice ID sanitization."""
        voice_id = self.cloner._generate_voice_id("Test Voice!@#$%^&*()")

        # Should only contain safe characters
        self.assertTrue(all(c.isalnum() or c in "_-" for c in voice_id))

    def test_clone_with_insufficient_samples(self):
        """Test cloning with insufficient audio samples."""
        # Only 1 sample (need at least 3)
        audio_samples = ["/path/to/audio1.wav"]

        config = CloningConfig(epochs=10)
        result = self.cloner.clone(audio_samples, "Test Voice", config)

        self.assertFalse(result.success)
        self.assertIn("Insufficient", result.message)

    def test_clone_success_flow(self):
        """Test successful cloning flow."""
        # Create mock audio files
        audio_samples = []
        for i in range(5):
            audio_path = Path(self.temp_dir) / f"audio{i}.wav"
            # Create minimal WAV file
            with open(audio_path, 'wb') as f:
                # Write minimal WAV header
                f.write(b'RIFF')
                f.write((36).to_bytes(4, 'little'))
                f.write(b'WAVEfmt ')
                f.write((16).to_bytes(4, 'little'))
                f.write((1).to_bytes(2, 'little'))  # PCM
                f.write((1).to_bytes(2, 'little'))  # Mono
                f.write((16000).to_bytes(4, 'little'))  # Sample rate
                f.write((32000).to_bytes(4, 'little'))  # Byte rate
                f.write((2).to_bytes(2, 'little'))  # Block align
                f.write((16).to_bytes(2, 'little'))  # Bits per sample
                f.write(b'data')
                f.write((0).to_bytes(4, 'little'))

            audio_samples.append(str(audio_path))

        config = CloningConfig(epochs=10, learning_rate=1e-4)

        progress_updates = []
        def progress_callback(progress):
            progress_updates.append(progress)

        trained_model_path = Path(self.temp_dir) / "trained-model.pt"
        trained_model_path.write_text("trained-model")

        with patch.object(self.cloner, "load_base_model", return_value=True):
            with patch.object(self.cloner, "_train_model", return_value=(trained_model_path, 0.01)):
                result = self.cloner.clone(
                    audio_samples,
                    "Test Voice",
                    config,
                    progress_callback
                )

        self.assertTrue(result.success)
        self.assertIsNotNone(result.voice_id)
        self.assertGreater(result.similarity_score, 0.0)
        self.assertGreater(len(progress_updates), 0)

    def test_clone_reports_dependency_error_when_base_model_unavailable(self):
        """Test cloning fails clearly when runtime dependencies are unavailable."""
        audio_path = Path(self.temp_dir) / "audio.wav"
        audio_path.write_bytes(b"RIFF\x24\x00\x00\x00WAVEfmt ")

        with patch.object(self.cloner, "load_base_model", side_effect=CloningDependencyError("missing torch")):
            result = self.cloner.clone([str(audio_path)] * 3, "Test Voice")

        self.assertFalse(result.success)
        self.assertIn("missing torch", result.error)

    def test_cloning_config_defaults(self):
        """Test CloningConfig default values."""
        config = CloningConfig()

        self.assertEqual(config.epochs, 100)
        self.assertEqual(config.learning_rate, 1e-4)
        self.assertEqual(config.batch_size, 8)
        self.assertTrue(config.use_lora)

    def test_list_cloned_voices(self):
        """Test listing cloned voices."""
        voices = self.cloner.list_cloned_voices()

        # Should return a list (may be empty)
        self.assertIsInstance(voices, list)

    def test_delete_voice_nonexistent(self):
        """Test deleting non-existent voice."""
        result = self.cloner.delete_voice("nonexistent_voice_id")

        self.assertFalse(result)

    def test_save_voice_metadata(self):
        """Test saving voice metadata."""
        voice_id = "test_voice_123"
        voice_name = "Test Voice"
        embedding = np.random.randn(256).astype(np.float32)

        # Create mock model path
        model_dir = Path.home() / ".ghatana" / "voices" / voice_id
        model_dir.mkdir(parents=True, exist_ok=True)
        model_path = model_dir / "model.pt"
        model_path.write_text("mock_model")

        embedding_path = self.cloner._save_voice_metadata(
            voice_id,
            voice_name,
            embedding,
            model_path,
            5,
            0.87
        )

        # Check embedding was saved
        self.assertTrue(embedding_path.exists())
        loaded_embedding = np.load(embedding_path)
        np.testing.assert_array_equal(loaded_embedding, embedding)

        # Check metadata was saved
        metadata_path = model_path.parent / "metadata.json"
        self.assertTrue(metadata_path.exists())

        with open(metadata_path) as f:
            metadata = json.load(f)

        self.assertEqual(metadata['voice_id'], voice_id)
        self.assertEqual(metadata['voice_name'], voice_name)
        self.assertEqual(metadata['training_samples'], 5)
        self.assertAlmostEqual(metadata['similarity_score'], 0.87)

        # Clean up
        import shutil
        shutil.rmtree(model_dir)

    def test_compute_similarity_score_uses_embedding_similarity(self):
        """Test similarity score is computed from real embedding comparisons."""
        model_path = Path(self.temp_dir) / "model.pt"
        model_path.write_text("trained-model")
        target_embedding = np.ones(256, dtype=np.float32)

        similarity = self.cloner._compute_similarity_score(
            "sample-a.wav",
            model_path,
            target_embedding,
        )

        self.assertGreaterEqual(similarity, 0.0)
        self.assertLessEqual(similarity, 1.0)
        self.assertNotEqual(similarity, 0.87)


class TestCloningResult(unittest.TestCase):
    """Test CloningResult dataclass."""

    def test_creation(self):
        """Test creating a CloningResult."""
        result = CloningResult(
            success=True,
            voice_id="test_voice_123",
            model_path="/path/to/model.pt",
            embedding_path="/path/to/embedding.npy",
            similarity_score=0.87,
            training_time_seconds=120.5,
            message="Success"
        )

        self.assertTrue(result.success)
        self.assertEqual(result.voice_id, "test_voice_123")
        self.assertEqual(result.similarity_score, 0.87)
        self.assertIsNone(result.error)


if __name__ == '__main__':
    unittest.main()

