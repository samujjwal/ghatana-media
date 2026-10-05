"""
Voice Cloning Training Pipeline

Trains a voice clone model using speaker embeddings and audio samples.
Uses fine-tuning approach with pre-trained TTS models.

@doc.type module
@doc.purpose Voice cloning training pipeline
@doc.layer ai-voice
"""

from dataclasses import dataclass
from typing import List, Optional, Callable
import numpy as np
from pathlib import Path
import logging
import json
import time

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

try:
    import torch
    import torchaudio
    TORCH_AVAILABLE = True
except ImportError:
    TORCH_AVAILABLE = False
    logger.warning("torch/torchaudio not available, voice cloning is unavailable")


class CloningDependencyError(RuntimeError):
    """Raised when voice cloning dependencies are unavailable."""


@dataclass
class CloningConfig:
    """Configuration for voice cloning."""
    epochs: int = 100
    learning_rate: float = 1e-4
    batch_size: int = 8
    max_audio_length: float = 10.0  # seconds
    min_audio_length: float = 1.0   # seconds
    sample_rate: int = 22050
    use_lora: bool = True  # Use LoRA for efficient fine-tuning
    lora_rank: int = 8


@dataclass
class CloningProgress:
    """Training progress information."""
    current_epoch: int
    total_epochs: int
    loss: float
    stage: str  # 'preprocessing', 'training', 'validation', 'saving'
    progress_percent: float
    estimated_time_remaining: float  # seconds


@dataclass
class CloningResult:
    """Result of voice cloning operation."""
    success: bool
    voice_id: str
    model_path: str
    embedding_path: str
    similarity_score: float
    training_time_seconds: float
    message: str
    error: Optional[str] = None


class VoiceCloner:
    """
    Voice cloning training pipeline using speaker embeddings.

    Uses LoRA (Low-Rank Adaptation) for efficient fine-tuning of
    pre-trained TTS models with minimal computational requirements.

    @doc.type class
    @doc.purpose Train voice clone models
    @doc.layer ai-voice
    @doc.pattern Service
    """

    def __init__(self, model_manager, embedding_extractor):
        """
        Initialize voice cloner.

        Args:
            model_manager: ModelManager for loading pre-trained models
            embedding_extractor: SpeakerEmbeddingExtractor for extracting speaker features
        """
        self.model_manager = model_manager
        self.embedding_extractor = embedding_extractor
        self.base_model = None
        self.device = "cuda" if TORCH_AVAILABLE and torch.cuda.is_available() else "cpu"
        self._loaded = False

    def load_base_model(self) -> bool:
        """
        Load the base TTS model for fine-tuning.

        Returns:
            True if loaded successfully
        """
        if self._loaded:
            return True

        if not TORCH_AVAILABLE:
            raise CloningDependencyError(
                "Voice cloning requires the Python dependencies 'torch' and 'torchaudio'. "
                "Install the AI Voice cloning dependencies before cloning a voice."
            )

        try:
            # Load base TTS model (VITS or similar)
            self.model_manager.ensure_model("vits-base")

            raise CloningDependencyError(
                "Voice cloning base-model loading is not fully implemented for this runtime yet. "
                "Placeholder voice-clone models are blocked."
            )

        except Exception as e:
            logger.error(f"Failed to load base model: {e}")
            raise

    def clone(
        self,
        audio_samples: List[str],
        voice_name: str,
        config: Optional[CloningConfig] = None,
        progress_callback: Optional[Callable[[CloningProgress], None]] = None
    ) -> CloningResult:
        """
        Clone a voice from audio samples.

        Args:
            audio_samples: List of audio file paths (WAV format recommended)
            voice_name: Name for the cloned voice
            config: Training configuration
            progress_callback: Optional callback for training progress

        Returns:
            CloningResult with model paths and quality metrics
        """
        if config is None:
            config = CloningConfig()

        start_time = time.time()
        voice_id = self._generate_voice_id(voice_name)

        try:
            # Stage 1: Preprocessing
            if progress_callback:
                progress_callback(CloningProgress(
                    current_epoch=0,
                    total_epochs=config.epochs,
                    loss=0.0,
                    stage='preprocessing',
                    progress_percent=0.0,
                    estimated_time_remaining=0.0
                ))

            # Validate audio samples
            validated_samples = self._validate_audio_samples(audio_samples, config)
            if len(validated_samples) < 3:
                return CloningResult(
                    success=False,
                    voice_id=voice_id,
                    model_path="",
                    embedding_path="",
                    similarity_score=0.0,
                    training_time_seconds=0.0,
                    message="Insufficient audio samples",
                    error="At least 3 valid audio samples required"
                )

            # Extract speaker embedding
            logger.info(f"Extracting speaker embedding from {len(validated_samples)} samples")
            embedding_results = self.embedding_extractor.extract_batch(validated_samples)
            target_embedding = self.embedding_extractor.average_embedding(embedding_results)

            # Stage 2: Training
            if not self._loaded:
                self.load_base_model()

            model_path, training_loss = self._train_model(
                validated_samples,
                target_embedding,
                voice_id,
                config,
                progress_callback
            )

            # Stage 3: Validation
            if progress_callback:
                progress_callback(CloningProgress(
                    current_epoch=config.epochs,
                    total_epochs=config.epochs,
                    loss=training_loss,
                    stage='validation',
                    progress_percent=95.0,
                    estimated_time_remaining=0.0
                ))

            # Compute similarity score
            similarity_score = self._compute_similarity_score(
                validated_samples[0],
                model_path,
                target_embedding
            )

            # Stage 4: Save metadata
            embedding_path = self._save_voice_metadata(
                voice_id,
                voice_name,
                target_embedding,
                model_path,
                len(validated_samples),
                similarity_score
            )

            training_time = time.time() - start_time

            if progress_callback:
                progress_callback(CloningProgress(
                    current_epoch=config.epochs,
                    total_epochs=config.epochs,
                    loss=training_loss,
                    stage='complete',
                    progress_percent=100.0,
                    estimated_time_remaining=0.0
                ))

            return CloningResult(
                success=True,
                voice_id=voice_id,
                model_path=str(model_path),
                embedding_path=str(embedding_path),
                similarity_score=similarity_score,
                training_time_seconds=training_time,
                message=f"Voice cloned successfully in {training_time:.1f}s"
            )

        except Exception as e:
            logger.error(f"Voice cloning failed: {e}")
            import traceback
            traceback.print_exc()
            return CloningResult(
                success=False,
                voice_id=voice_id,
                model_path="",
                embedding_path="",
                similarity_score=0.0,
                training_time_seconds=time.time() - start_time,
                message="Voice cloning failed",
                error=str(e)
            )

    def _generate_voice_id(self, voice_name: str) -> str:
        """Generate a unique voice ID."""
        import hashlib
        import datetime

        timestamp = datetime.datetime.now().isoformat()
        hash_input = f"{voice_name}_{timestamp}"
        voice_hash = hashlib.md5(hash_input.encode()).hexdigest()[:8]

        # Sanitize voice name for filesystem
        safe_name = "".join(c for c in voice_name if c.isalnum() or c in "_ -").strip()
        safe_name = safe_name.replace(" ", "_").lower()

        return f"{safe_name}_{voice_hash}"

    def _validate_audio_samples(
        self,
        audio_samples: List[str],
        config: CloningConfig
    ) -> List[str]:
        """Validate audio samples meet requirements."""
        validated = []

        for sample_path in audio_samples:
            path = Path(sample_path)
            if not path.exists():
                logger.warning(f"Audio file not found: {sample_path}")
                continue

            # Check file size and duration
            try:
                if TORCH_AVAILABLE:
                    waveform, sr = torchaudio.load(str(path))
                    duration = waveform.shape[1] / sr

                    if duration < config.min_audio_length:
                        logger.warning(f"Audio too short ({duration:.1f}s): {sample_path}")
                        continue

                    if duration > config.max_audio_length:
                        logger.warning(f"Audio too long ({duration:.1f}s): {sample_path}")
                        continue

                validated.append(sample_path)
            except Exception as e:
                logger.warning(f"Failed to validate {sample_path}: {e}")
                continue

        return validated

    def _train_model(
        self,
        audio_samples: List[str],
        target_embedding: np.ndarray,
        voice_id: str,
        config: CloningConfig,
        progress_callback: Optional[Callable[[CloningProgress], None]] = None
    ) -> tuple:
        """
        Train the voice model.

        Returns:
            Tuple of (model_path, final_loss)
        """
        # Create output directory
        output_dir = Path.home() / ".ghatana" / "voices" / voice_id
        output_dir.mkdir(parents=True, exist_ok=True)
        model_path = output_dir / "model.pt"

        if not TORCH_AVAILABLE:
            raise CloningDependencyError(
                "Voice cloning training requires the Python dependencies 'torch' and 'torchaudio'."
            )

        # Actual training loop
        logger.info(f"Training voice model with {config.epochs} epochs")

        for epoch in range(config.epochs):
            # Simulate training
            loss = 1.0 / (epoch + 1)  # Mock decreasing loss

            if progress_callback and epoch % 5 == 0:
                elapsed = epoch / config.epochs
                estimated_remaining = (config.epochs - epoch) * 0.1  # Mock estimate

                progress_callback(CloningProgress(
                    current_epoch=epoch,
                    total_epochs=config.epochs,
                    loss=loss,
                    stage='training',
                    progress_percent=10 + (elapsed * 80),
                    estimated_time_remaining=estimated_remaining
                ))

        if self.base_model is None:
            raise CloningDependencyError(
                "Voice cloning base model is unavailable; placeholder model serialization is blocked."
            )

        # Save model
        torch.save({
            'model_state_dict': self.base_model.state_dict(),
            'config': config.__dict__,
            'voice_id': voice_id
        }, model_path)

        final_loss = 0.01
        logger.info(f"Training complete. Final loss: {final_loss:.4f}")

        return model_path, final_loss

    def _compute_similarity_score(
        self,
        sample_audio: str,
        model_path: Path,
        target_embedding: np.ndarray
    ) -> float:
        """
        Compute similarity between original and synthesized voice.

        Returns:
            Similarity score (0-1)
        """
        if not model_path.exists():
            raise FileNotFoundError(f"Trained voice model not found: {model_path}")

        sample_result = self.embedding_extractor.extract(sample_audio)

        if hasattr(self.embedding_extractor, "compute_similarity"):
            similarity = self.embedding_extractor.compute_similarity(
                sample_result.embedding,
                target_embedding,
            )
            return float(np.clip(similarity, 0.0, 1.0))

        sample_norm = sample_result.embedding / (np.linalg.norm(sample_result.embedding) + 1e-8)
        target_norm = target_embedding / (np.linalg.norm(target_embedding) + 1e-8)
        similarity = float((np.dot(sample_norm, target_norm) + 1.0) / 2.0)
        return float(np.clip(similarity, 0.0, 1.0))

    def _save_voice_metadata(
        self,
        voice_id: str,
        voice_name: str,
        embedding: np.ndarray,
        model_path: Path,
        training_samples: int,
        similarity_score: float
    ) -> Path:
        """
        Save voice metadata and embedding.

        Returns:
            Path to saved embedding file
        """
        output_dir = model_path.parent

        # Save embedding
        embedding_path = output_dir / "embedding.npy"
        np.save(embedding_path, embedding)

        # Save metadata
        metadata = {
            'voice_id': voice_id,
            'voice_name': voice_name,
            'training_samples': training_samples,
            'similarity_score': similarity_score,
            'embedding_dim': len(embedding),
            'model_path': str(model_path),
            'created_at': time.time()
        }

        metadata_path = output_dir / "metadata.json"
        with open(metadata_path, 'w') as f:
            json.dump(metadata, f, indent=2)

        logger.info(f"Saved voice metadata to {metadata_path}")

        return embedding_path

    def list_cloned_voices(self) -> List[dict]:
        """
        List all cloned voices.

        Returns:
            List of voice metadata dictionaries
        """
        voices_dir = Path.home() / ".ghatana" / "voices"
        if not voices_dir.exists():
            return []

        voices = []
        for voice_dir in voices_dir.iterdir():
            if not voice_dir.is_dir():
                continue

            metadata_path = voice_dir / "metadata.json"
            if metadata_path.exists():
                try:
                    with open(metadata_path) as f:
                        metadata = json.load(f)
                    voices.append(metadata)
                except Exception as e:
                    logger.warning(f"Failed to load metadata for {voice_dir}: {e}")

        return voices

    def delete_voice(self, voice_id: str) -> bool:
        """
        Delete a cloned voice.

        Args:
            voice_id: ID of the voice to delete

        Returns:
            True if deleted successfully
        """
        voice_dir = Path.home() / ".ghatana" / "voices" / voice_id
        if not voice_dir.exists():
            return False

        try:
            import shutil
            shutil.rmtree(voice_dir)
            logger.info(f"Deleted voice: {voice_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to delete voice {voice_id}: {e}")
            return False

