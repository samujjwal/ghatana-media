"""
Unit tests for speaker embedding extraction.

@doc.type test
@doc.purpose Test speaker embedding functionality
@doc.layer ai-voice
"""

import unittest
import numpy as np
from pathlib import Path
import sys
from unittest.mock import patch

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src-tauri" / "python"))

from speaker_embedding import (
    SpeakerEmbeddingExtractor,
    EmbeddingDependencyError,
    EmbeddingResult,
)


class MockModelManager:
    """Mock ModelManager for testing."""

    def ensure_model(self, model_id):
        """Mock ensure_model method."""
        return Path("/mock/model/path")


class TestSpeakerEmbeddingExtractor(unittest.TestCase):
    """Test speaker embedding extraction."""

    def setUp(self):
        """Set up test fixtures."""
        self.model_manager = MockModelManager()
        self.extractor = SpeakerEmbeddingExtractor(self.model_manager, device="cpu")

    def test_initialization(self):
        """Test extractor initialization."""
        self.assertIsNotNone(self.extractor)
        self.assertEqual(self.extractor.device, "cpu")
        self.assertFalse(self.extractor._loaded)

    def test_device_resolution(self):
        """Test device resolution logic."""
        device = self.extractor._resolve_device("auto")
        self.assertIn(device, ["cuda", "cpu"])

        device = self.extractor._resolve_device("cpu")
        self.assertEqual(device, "cpu")

    def test_load_requires_real_dependencies(self):
        """Test loading fails explicitly without the real embedding runtime."""
        with self.assertRaises(EmbeddingDependencyError):
            self.extractor.load()

    def test_average_embedding(self):
        """Test averaging multiple embeddings."""
        results = [
            EmbeddingResult(
                embedding=np.random.randn(256).astype(np.float32),
                confidence=0.8,
                duration_seconds=3.0,
                sample_rate=16000
            )
            for _ in range(5)
        ]

        avg_embedding = self.extractor.average_embedding(results)

        self.assertEqual(avg_embedding.shape, (256,))
        # Should be normalized
        norm = np.linalg.norm(avg_embedding)
        self.assertAlmostEqual(norm, 1.0, places=5)

    def test_average_embedding_weighted_by_confidence(self):
        """Test that averaging weights by confidence."""
        # Create embeddings with different confidences
        high_conf_emb = np.ones(256, dtype=np.float32)
        low_conf_emb = np.zeros(256, dtype=np.float32)

        results = [
            EmbeddingResult(high_conf_emb, 1.0, 3.0, 16000),
            EmbeddingResult(low_conf_emb, 0.1, 3.0, 16000),
        ]

        avg = self.extractor.average_embedding(results)

        # Average should be closer to high confidence embedding
        # (after normalization)
        self.assertTrue(np.mean(avg) > 0)

    def test_compute_similarity(self):
        """Test similarity computation."""
        emb1 = np.random.randn(256).astype(np.float32)
        emb2 = emb1.copy()  # Identical
        emb3 = -emb1  # Opposite
        emb4 = np.random.randn(256).astype(np.float32)  # Random

        # Identical embeddings should have high similarity
        sim_identical = self.extractor.compute_similarity(emb1, emb2)
        self.assertGreater(sim_identical, 0.99)

        # Opposite embeddings should have low similarity
        sim_opposite = self.extractor.compute_similarity(emb1, emb3)
        self.assertLess(sim_opposite, 0.1)

        # Similarity should be in 0-1 range
        sim_random = self.extractor.compute_similarity(emb1, emb4)
        self.assertGreaterEqual(sim_random, 0.0)
        self.assertLessEqual(sim_random, 1.0)

    def test_extract_batch_progress(self):
        """Test batch extraction with progress callback."""
        audio_paths = [f"/path/to/audio{i}.wav" for i in range(5)]

        progress_updates = []

        def progress_callback(progress):
            progress_updates.append(progress)

        mocked_result = EmbeddingResult(
            embedding=np.ones(256, dtype=np.float32),
            confidence=0.9,
            duration_seconds=3.0,
            sample_rate=16000,
        )
        with patch.object(self.extractor, "extract", return_value=mocked_result):
            results = self.extractor.extract_batch(audio_paths, progress_callback)

        self.assertEqual(len(results), 5)
        self.assertGreater(len(progress_updates), 0)

        # Check final progress is complete
        final = progress_updates[-1]
        self.assertEqual(final.status, 'complete')
        self.assertEqual(final.current_file, 5)

    def test_extract_batch_handles_errors(self):
        """Test that batch extraction handles individual errors gracefully."""
        audio_paths = ["/nonexistent/file.wav"]

        with patch.object(self.extractor, "extract", side_effect=EmbeddingDependencyError("missing runtime")):
            results = self.extractor.extract_batch(audio_paths)

        # Should return a list with None for failed extractions
        self.assertEqual(len(results), 1)
        self.assertIsNone(results[0])


class TestEmbeddingResult(unittest.TestCase):
    """Test EmbeddingResult dataclass."""

    def test_creation(self):
        """Test creating an EmbeddingResult."""
        embedding = np.random.randn(256).astype(np.float32)
        result = EmbeddingResult(
            embedding=embedding,
            confidence=0.85,
            duration_seconds=5.0,
            sample_rate=16000
        )

        self.assertEqual(result.embedding.shape, (256,))
        self.assertEqual(result.confidence, 0.85)
        self.assertEqual(result.duration_seconds, 5.0)
        self.assertEqual(result.sample_rate, 16000)


if __name__ == '__main__':
    unittest.main()

