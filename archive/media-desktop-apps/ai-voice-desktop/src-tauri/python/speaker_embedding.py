"""
Speaker Embedding Extraction Module

Extracts 256-dimensional speaker embeddings using ECAPA-TDNN model.
These embeddings capture the unique voice characteristics of a speaker
and are used for:
1. Voice cloning (training target)
2. TTS conditioning (inference)
3. Speaker verification (identity matching)

@doc.type module
@doc.purpose Speaker embedding extraction using ECAPA-TDNN
@doc.layer ai-voice
"""

from dataclasses import dataclass
from typing import List, Optional, Callable
import numpy as np
from pathlib import Path
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

try:
    import torch
    import torchaudio
    TORCH_AVAILABLE = True
except ImportError:
    TORCH_AVAILABLE = False
    logger.warning("torch/torchaudio not available, speaker embedding extraction is unavailable")


class EmbeddingDependencyError(RuntimeError):
    """Raised when speaker embedding dependencies are unavailable."""


@dataclass
class EmbeddingResult:
    """Result of speaker embedding extraction."""
    embedding: np.ndarray  # 256-dimensional vector
    confidence: float      # Quality/confidence score (0-1)
    duration_seconds: float
    sample_rate: int


@dataclass
class EmbeddingProgress:
    """Progress callback for batch embedding extraction."""
    current_file: int
    total_files: int
    current_filename: str
    status: str  # 'loading', 'processing', 'complete', 'error'
    error_message: Optional[str] = None


class SpeakerEmbeddingExtractor:
    """
    Extracts speaker embeddings using ECAPA-TDNN pretrained on VoxCeleb.

    This is the core identity model - embeddings should be:
    - Consistent across recordings of the same speaker
    - Distinct between different speakers
    - Robust to background noise and recording conditions

    @doc.type class
    @doc.purpose Extract speaker identity embeddings
    @doc.layer ai-voice
    @doc.pattern Service
    """

    MODEL_ID = "ecapa-tdnn"
    EMBEDDING_DIM = 256
    TARGET_SAMPLE_RATE = 16000

    def __init__(self, model_manager, device: str = "auto"):
        """
        Initialize speaker embedding extractor.

        Args:
            model_manager: ModelManager instance for loading models
            device: Device to use ('auto', 'cuda', 'cpu')
        """
        self.model_manager = model_manager
        self.device = self._resolve_device(device)
        self.model = None
        self._loaded = False

    def _resolve_device(self, device: str) -> str:
        """Resolve device string to actual device."""
        if device == "auto":
            if TORCH_AVAILABLE and torch.cuda.is_available():
                return "cuda"
            return "cpu"
        return device

    def load(self) -> bool:
        """
        Load the ECAPA-TDNN model.

        Returns:
            True if loaded successfully, False otherwise
        """
        if self._loaded:
            return True

        if not TORCH_AVAILABLE:
            raise EmbeddingDependencyError(
                "Speaker embedding extraction requires the Python dependencies 'torch' and 'torchaudio'."
            )

        try:
            model_path = self.model_manager.ensure_model(self.MODEL_ID)

            # Load ECAPA-TDNN from speechbrain
            try:
                from speechbrain.inference.speaker import EncoderClassifier
                self.model = EncoderClassifier.from_hparams(
                    source=str(model_path),
                    run_opts={"device": self.device}
                )
                logger.info(f"Loaded ECAPA-TDNN model on {self.device}")
            except ImportError:
                raise EmbeddingDependencyError(
                    "Speaker embedding extraction requires the Python dependency 'speechbrain'. "
                    "Fallback embedding models are blocked."
                )

            self._loaded = True
            return True
        except Exception as e:
            logger.error(f"Failed to load speaker embedding model: {e}")
            raise

    def extract(self, audio_path: str) -> EmbeddingResult:
        """
        Extract speaker embedding from a single audio file.

        Args:
            audio_path: Path to audio file (WAV, MP3, FLAC, etc.)

        Returns:
            EmbeddingResult with 256-dim embedding and quality metrics
        """
        if not self._loaded:
            self.load()

        if not TORCH_AVAILABLE or self.model is None:
            raise EmbeddingDependencyError(
                "Speaker embedding model is unavailable. Mock speaker embeddings are blocked."
            )

        try:
            # Load and preprocess audio
            waveform, sr = torchaudio.load(audio_path)

            # Resample if needed
            if sr != self.TARGET_SAMPLE_RATE:
                resampler = torchaudio.transforms.Resample(sr, self.TARGET_SAMPLE_RATE)
                waveform = resampler(waveform)
                sr = self.TARGET_SAMPLE_RATE

            # Convert to mono if stereo
            if waveform.shape[0] > 1:
                waveform = torch.mean(waveform, dim=0, keepdim=True)

            # Extract embedding
            with torch.no_grad():
                if hasattr(self.model, 'encode_batch'):
                    # SpeechBrain model
                    embedding = self.model.encode_batch(waveform.to(self.device))
                    embedding = embedding.squeeze().cpu().numpy()
                else:
                    # Fallback model
                    embedding = self.model(waveform.to(self.device))
                    embedding = embedding.cpu().numpy()

            # Calculate confidence based on embedding norm
            # Higher norm typically indicates clearer speaker signal
            norm = np.linalg.norm(embedding)
            confidence = min(1.0, norm / 20.0)  # Normalize to 0-1

            duration = waveform.shape[1] / sr

            return EmbeddingResult(
                embedding=embedding,
                confidence=confidence,
                duration_seconds=duration,
                sample_rate=sr
            )
        except Exception as e:
            logger.error(f"Failed to extract embedding from {audio_path}: {e}")
            raise

    def extract_batch(
        self,
        audio_paths: List[str],
        progress_callback: Optional[Callable[[EmbeddingProgress], None]] = None
    ) -> List[EmbeddingResult]:
        """
        Extract embeddings from multiple audio files.

        Args:
            audio_paths: List of audio file paths
            progress_callback: Optional callback for progress updates

        Returns:
            List of EmbeddingResult objects
        """
        results = []
        total = len(audio_paths)

        for i, path in enumerate(audio_paths):
            if progress_callback:
                progress_callback(EmbeddingProgress(
                    current_file=i + 1,
                    total_files=total,
                    current_filename=Path(path).name,
                    status='processing'
                ))

            try:
                result = self.extract(path)
                results.append(result)
            except Exception as e:
                if progress_callback:
                    progress_callback(EmbeddingProgress(
                        current_file=i + 1,
                        total_files=total,
                        current_filename=Path(path).name,
                        status='error',
                        error_message=str(e)
                    ))
                # Append None for failed extractions
                results.append(None)

        if progress_callback:
            progress_callback(EmbeddingProgress(
                current_file=total,
                total_files=total,
                current_filename='',
                status='complete'
            ))

        return results

    def average_embedding(self, results: List[EmbeddingResult]) -> np.ndarray:
        """
        Average multiple embeddings to create a unified speaker representation.

        Args:
            results: List of EmbeddingResult objects

        Returns:
            Averaged embedding vector
        """
        valid_results = [r for r in results if r is not None]
        if not valid_results:
            raise ValueError("No valid embeddings to average")

        # Weight by confidence
        embeddings = np.array([r.embedding for r in valid_results])
        confidences = np.array([r.confidence for r in valid_results])

        # Weighted average
        weighted_sum = np.sum(embeddings * confidences[:, np.newaxis], axis=0)
        total_weight = np.sum(confidences)
        avg_embedding = weighted_sum / total_weight

        # Normalize to unit length
        avg_embedding = avg_embedding / (np.linalg.norm(avg_embedding) + 1e-8)

        return avg_embedding

    def compute_similarity(self, embedding1: np.ndarray, embedding2: np.ndarray) -> float:
        """
        Compute cosine similarity between two embeddings.

        Args:
            embedding1: First embedding vector
            embedding2: Second embedding vector

        Returns:
            Similarity score (0-1, higher is more similar)
        """
        # Normalize embeddings
        emb1_norm = embedding1 / (np.linalg.norm(embedding1) + 1e-8)
        emb2_norm = embedding2 / (np.linalg.norm(embedding2) + 1e-8)

        # Cosine similarity
        similarity = np.dot(emb1_norm, emb2_norm)

        # Convert to 0-1 range
        similarity = (similarity + 1) / 2

        return float(similarity)

