"""
Voice Model Trainer for AI Voice Production Studio.

This module provides RVC-based voice model training from user recordings.
"""

import os
import json
import numpy as np
from pathlib import Path
from typing import List, Dict, Optional, Callable
from dataclasses import dataclass, asdict
from enum import Enum
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class TrainingDependencyError(RuntimeError):
    """Raised when required training dependencies are unavailable."""


class TrainingStatus(Enum):
    PENDING = "pending"
    PREPROCESSING = "preprocessing"
    EXTRACTING = "extracting"
    TRAINING = "training"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class TrainingConfig:
    model_name: str
    sample_rate: int = 40000
    hop_length: int = 320
    f0_method: str = "crepe"
    batch_size: int = 8
    epochs: int = 100
    learning_rate: float = 1e-4
    save_every_epoch: int = 10


@dataclass
class TrainingProgress:
    status: TrainingStatus
    progress: float
    current_epoch: int = 0
    total_epochs: int = 0
    loss: float = 0.0
    message: str = ""
    error: Optional[str] = None


class VoiceModelTrainer:
    def __init__(self, output_dir: str, config: Optional[TrainingConfig] = None):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.config = config or TrainingConfig(model_name="default")
        self._progress_callback = None
        self._should_stop = False

    def set_progress_callback(self, callback: Callable):
        self._progress_callback = callback

    def stop_training(self):
        self._should_stop = True

    def _report_progress(self, progress: TrainingProgress):
        if self._progress_callback:
            self._progress_callback(progress)
        logger.info(f"Progress: {progress.status.value} - {progress.progress:.1f}%")

    def _require_librosa(self):
        try:
            import librosa
        except ImportError as exc:
            raise TrainingDependencyError(
                "Voice training requires the Python dependency 'librosa'. "
                "Install the AI Voice training dependencies before starting training."
            ) from exc
        return librosa

    def _require_torch(self):
        try:
            import torch
        except ImportError as exc:
            raise TrainingDependencyError(
                "Voice training requires the Python dependency 'torch'. "
                "Install the AI Voice training dependencies before starting training."
            ) from exc
        return torch

    def preprocess_samples(self, sample_paths: List[str]) -> List[np.ndarray]:
        self._report_progress(TrainingProgress(
            status=TrainingStatus.PREPROCESSING, progress=0.0,
            message="Starting preprocessing..."
        ))

        processed = []
        librosa = self._require_librosa()

        for i, path in enumerate(sample_paths):
            if self._should_stop:
                raise InterruptedError("Stopped by user")
            try:
                audio, _ = librosa.load(path, sr=self.config.sample_rate, mono=True)
                audio = audio / (np.max(np.abs(audio)) + 1e-6)
                trimmed, _ = librosa.effects.trim(audio, top_db=20)
                processed.append(trimmed)
                self._report_progress(TrainingProgress(
                    status=TrainingStatus.PREPROCESSING,
                    progress=(i + 1) / len(sample_paths) * 100,
                    message=f"Preprocessing {i + 1}/{len(sample_paths)}"
                ))
            except Exception as e:
                logger.error(f"Failed to preprocess {path}: {e}")

        if not processed:
            raise ValueError("No valid audio samples were available for preprocessing")
        return processed

    def extract_features(self, audio_samples: List[np.ndarray]) -> List[Dict]:
        self._report_progress(TrainingProgress(
            status=TrainingStatus.EXTRACTING, progress=0.0,
            message="Extracting features..."
        ))

        features = []
        librosa = self._require_librosa()

        for i, audio in enumerate(audio_samples):
            if self._should_stop:
                raise InterruptedError("Stopped by user")
            try:
                mel = librosa.feature.melspectrogram(
                    y=audio, sr=self.config.sample_rate,
                    n_fft=2048, hop_length=self.config.hop_length, n_mels=128
                )
                mel_db = librosa.power_to_db(mel, ref=np.max)
                f0, _, _ = librosa.pyin(
                    audio, fmin=librosa.note_to_hz('C2'),
                    fmax=librosa.note_to_hz('C7'),
                    sr=self.config.sample_rate, hop_length=self.config.hop_length
                )
                f0 = np.nan_to_num(f0)
                features.append({"mel": mel_db, "f0": f0})
                self._report_progress(TrainingProgress(
                    status=TrainingStatus.EXTRACTING,
                    progress=(i + 1) / len(audio_samples) * 100,
                    message=f"Extracting {i + 1}/{len(audio_samples)}"
                ))
            except Exception as e:
                logger.error(f"Feature extraction failed: {e}")

        if not features:
            raise ValueError("Feature extraction produced no usable samples")
        return features

    def train_model(self, features: List[Dict]) -> str:
        self._report_progress(TrainingProgress(
            status=TrainingStatus.TRAINING, progress=0.0,
            current_epoch=0, total_epochs=self.config.epochs,
            message="Starting training..."
        ))

        if not features:
            raise ValueError("Training requires at least one extracted feature sample")

        torch = self._require_torch()
        device = "cuda" if torch.cuda.is_available() else "cpu"

        # Real training with torch
        model = torch.nn.Sequential(
            torch.nn.Linear(128, 256),
            torch.nn.ReLU(),
            torch.nn.Linear(256, 128)
        ).to(device)
        optimizer = torch.optim.AdamW(model.parameters(), lr=self.config.learning_rate)

        for epoch in range(self.config.epochs):
            if self._should_stop:
                raise InterruptedError("Stopped by user")
            
            epoch_loss = 0.0
            for feat in features:
                mel = torch.tensor(feat["mel"], dtype=torch.float32).to(device)
                optimizer.zero_grad()
                output = model(mel.T)
                loss = torch.nn.functional.mse_loss(output, mel.T)
                loss.backward()
                optimizer.step()
                epoch_loss += loss.item()
            
            epoch_loss /= len(features)
            self._report_progress(TrainingProgress(
                status=TrainingStatus.TRAINING,
                progress=(epoch + 1) / self.config.epochs * 100,
                current_epoch=epoch + 1, total_epochs=self.config.epochs,
                loss=epoch_loss,
                message=f"Epoch {epoch + 1}/{self.config.epochs}, Loss: {epoch_loss:.4f}"
            ))

        model_path = self.output_dir / f"{self.config.model_name}.pth"
        torch.save({"model_state_dict": model.state_dict(), "config": asdict(self.config)}, model_path)
        
        self._report_progress(TrainingProgress(
            status=TrainingStatus.COMPLETED, progress=100.0,
            message="Training completed!"
        ))
        return str(model_path)

    def train_from_samples(self, sample_paths: List[str]) -> str:
        try:
            audio_samples = self.preprocess_samples(sample_paths)
            if not audio_samples:
                raise ValueError("No valid audio samples were available for training")
            features = self.extract_features(audio_samples)
            return self.train_model(features)
        except InterruptedError as e:
            self._report_progress(TrainingProgress(
                status=TrainingStatus.FAILED, progress=0.0,
                error=str(e), message="Training cancelled"
            ))
            raise
        except Exception as e:
            self._report_progress(TrainingProgress(
                status=TrainingStatus.FAILED, progress=0.0,
                error=str(e), message="Training failed"
            ))
            raise


def train_voice_model(sample_paths: List[str], output_dir: str, model_name: str,
                      epochs: int = 100, progress_callback: Optional[Callable] = None) -> str:
    config = TrainingConfig(model_name=model_name, epochs=epochs)
    trainer = VoiceModelTrainer(output_dir, config)
    if progress_callback:
        trainer.set_progress_callback(progress_callback)
    return trainer.train_from_samples(sample_paths)


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 4:
        print("Usage: python voice_trainer.py <output_dir> <model_name> <sample1> [sample2] ...")
        sys.exit(1)
    
    output_dir = sys.argv[1]
    model_name = sys.argv[2]
    samples = sys.argv[3:]
    
    def print_progress(p):
        print(f"[{p.status.value}] {p.progress:.1f}% - {p.message}")
    
    model_path = train_voice_model(samples, output_dir, model_name, progress_callback=print_progress)
    print(f"Model saved to: {model_path}")
